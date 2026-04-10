import { Behavior, BehaviorContext } from '@/Core/Behavior';
import * as bt from '@/Core/BehaviorTree';
import Specialization from '@/Enums/Specialization';
import common from '@/Core/Common';
import spell from '@/Core/Spell';
import Settings from '@/Core/Settings';
import { PowerType } from "@/Enums/PowerType";
import { me } from '@/Core/ObjectManager';
import { defaultCombatTargeting as combat } from '@/Targeting/CombatTargeting';

/**
 * Demonology Warlock Behavior - Midnight 12.0.1
 * SimC APL: simc/midnight/warlock_demonology.simc (30+ APL lines)
 * Sources: SimC APL + Wowhead + class theorycraft
 *
 * Auto-detects: Diabolist (Diabolic Ritual) vs Soul Harvester (Demonic Soul)
 * Dispatches to: actions.diabolist / actions.soulharvest
 *
 * Resource: Soul Shards (PowerType 7), max 5
 * Core loop: Build shards → summon demons → Tyrant empowers all active demons
 *
 * Diabolist: Diabolic Ritual cycles (Overlord → Mother of Chaos → Pit Lord)
 *   → Infernal Bolt (instant 3 shards), Ruination (AoE + 3 imps)
 *   → Tyrant at 5 shards
 * Soul Harvester: Demonic Soul (Tyrant grants 3 shards w/ Succulent Souls)
 *   → Unconditional Tyrant/Dreadstalkers, spend freely
 *   → Doom targeting (apply via Demonbolt to new targets)
 *
 * Key SimC conditions:
 *   - RoT (Reign of Tyranny): gate Dreadstalkers on Tyrant CD timing
 *   - wild_imps.stack>=6 for Implosion
 *   - Doom target_if for Demonbolt spread
 *   - Power Siphon at core<=1
 *   - Dominion of Argus: spam HoG
 */

const S = {
  // Builders
  shadowBolt:         686,
  demonbolt:          264178,
  // Spenders
  handOfGuldan:       105174,
  callDreadstalkers:  104316,
  // Major CDs
  summonDemonicTyrant: 265187,
  summonDoomguard:    1276672,
  grimoireImpLord:    1276452,
  grimoireFelRavager: 1276467,
  // Utility
  powerSiphon:        264130,
  implosion:          196277,
  // Diabolist
  infernalBolt:       434506,   // Cast spell (433891 is buff indicator)
  ruination:          434635,
  // Defensives
  unendingResolve:    104773,
  darkPact:           108416,
  // Interrupt
  axeToss:            119914,
  // Pet
  summonFelguard:     30146,
  // Racials
  berserking:         26297,
};

const A = {
  // Core procs
  demonicCore:        264173,
  // Diabolist ritual phases
  ritualOverlord:     431944,
  ritualMotherChaos:  432815,
  ritualPitLord:      432816,
  // Diabolist Demonic Art procs
  artOverlord:        428524,
  artMotherChaos:     432794,
  artPitLord:         432795,
  // Dominion of Argus
  dominionOfArgus:    1276163,
  // Doom debuff
  doom:               460553,   // Debuff aura on target (460551 is talent passive)
  // Wild Imps tracking (buff on player)
  wildImps:           265369,
  // Tyrant active (approximate via cast tracking)
  tyrantActive:       265187,
  // Hero detection
  diabolicRitual:     428514,
  demonicSoul:        449614,
  // Procs
  infernalBoltReady:  433891,   // Buff: Infernal Bolt is castable
  ruinationReady:     433885,   // Buff: Ruination is castable (replaces HoG)
  tyrantsOblation:    1276767,  // Player haste buff during Tyrant
  // Talents
  reignOfTyranny:     1276748,
  toHellAndBack:      445960,
};

export class DemonologyWarlockBehavior extends Behavior {
  name = 'FW Demonology Warlock';
  context = BehaviorContext.Any;
  specialization = Specialization.Warlock.Demonology;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _shardFrame = 0;
  _cachedShards = 0;
  _coreFrame = 0;
  _cachedCore = null;
  _domFrame = 0;
  _cachedDominion = false;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _impsFrame = 0;
  _cachedImps = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWDemoAutoCDs', text: 'Auto Cooldowns (ignore burst keybind)', default: false },
        { type: 'checkbox', uid: 'FWDemoDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWDemoUnending', text: 'Use Unending Resolve', default: true },
        { type: 'slider', uid: 'FWDemoUnendingHP', text: 'Unending Resolve HP %', default: 35, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWDemoDarkPact', text: 'Use Dark Pact', default: true },
        { type: 'slider', uid: 'FWDemoDarkPactHP', text: 'Dark Pact HP %', default: 50, min: 15, max: 70 },
      ],
    },
  ];

  // ===== Hero Talent Detection =====
  isDiabolist() {
    return spell.isSpellKnown(428514); // Diabolic Ritual
  }

  isSoulHarvester() {
    return !this.isDiabolist();
  }

  useCDs() { return combat.burstToggle || Settings.FWDemoAutoCDs; }

  // ===== Per-Tick Caching =====
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 40 && me.isFacing(target)) {
      this._cachedTarget = target;
      return target;
    }
    const t = combat.bestTarget || (combat.targets && combat.targets[0]) || null;
    this._cachedTarget = (t && me.isFacing(t)) ? t : null;
    return this._cachedTarget;
  }

  getShards() {
    if (this._shardFrame === wow.frameTime) return this._cachedShards;
    this._shardFrame = wow.frameTime;
    this._cachedShards = me.powerByType(PowerType.SoulShards);
    return this._cachedShards;
  }

  getCoreAura() {
    if (this._coreFrame === wow.frameTime) return this._cachedCore;
    this._coreFrame = wow.frameTime;
    this._cachedCore = me.getAura(A.demonicCore);
    return this._cachedCore;
  }

  getCoreStacks() {
    const core = this.getCoreAura();
    return core ? core.stacks : 0;
  }

  hasDominion() {
    if (this._domFrame === wow.frameTime) return this._cachedDominion;
    this._domFrame = wow.frameTime;
    this._cachedDominion = me.hasAura(A.dominionOfArgus);
    return this._cachedDominion;
  }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemyCount;
    this._enemyFrame = wow.frameTime;
    const target = this.getCurrentTarget();
    this._cachedEnemyCount = target ? target.getUnitsAroundCount(10) + 1 : 1;
    return this._cachedEnemyCount;
  }

  getWildImpStacks() {
    if (this._impsFrame === wow.frameTime) return this._cachedImps;
    this._impsFrame = wow.frameTime;
    const aura = me.getAura(A.wildImps);
    this._cachedImps = aura ? aura.stacks : 0;
    return this._cachedImps;
  }

  // ===== Helpers =====
  targetTTD() {
    const target = this.getCurrentTarget();
    if (!target || !target.timeToDeath) return 99999;
    return target.timeToDeath();
  }

  isTyrantActive() {
    return spell.getTimeSinceLastCast(S.summonDemonicTyrant) < 15000;
  }

  getTyrantCDRemains() {
    const cd = spell.getCooldown(S.summonDemonicTyrant);
    return cd ? cd.timeleft : 0;
  }

  hasReignOfTyranny() {
    return spell.isSpellKnown(A.reignOfTyranny);
  }

  hasDoom() {
    return spell.isSpellKnown(460551);
  }

  hasToHellAndBack() {
    return spell.isSpellKnown(A.toHellAndBack);
  }

  // Target without Doom debuff (for Demonbolt spread)
  getTargetWithoutDoom() {
    if (!this.hasDoom()) return null;
    if (!combat.targets) return this.getCurrentTarget();
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (unit && common.validTarget(unit) && me.distanceTo(unit) <= 40 &&
          !unit.hasAuraByMe(A.doom)) {
        return unit;
      }
    }
    return null;
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: Summon Felguard
      spell.cast(S.summonFelguard, () => me, () => {
        return !me.pet || me.pet.deadOrGhost;
      }),

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Dead target → auto-pick
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const newTarget = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (newTarget) wow.GameUI.setTarget(newTarget);
        }
        return bt.Status.Failure;
      }),

      // Null target bail
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),

      common.waitForCastOrChannel(),

      // Version + debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isDiabolist() ? 'Diabolist' : 'Soul Harvester';
          console.info(`[DemoLock] Midnight 12.0.1 | Hero: ${hero}`);
        }
        if (Settings.FWDemoDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[DemoLock] Shards:${this.getShards()} Core:${this.getCoreStacks()} Dom:${this.hasDominion()} Tyrant:${this.isTyrantActive()} TyrantCD:${this.getTyrantCDRemains()} Imps:${this.getWildImpStacks()} Enemies:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt (Axe Toss)
          spell.interrupt(S.axeToss),

          // Defensives
          this.defensives(),

          // Movement block
          this.movementRotation(),

          // Racials: during Tyrant or fight ending
          // SimC: call_action_list,name=racials,if=pet.demonic_tyrant.active|fight_remains<22
          spell.cast(S.berserking, () => me, () => {
            return this.isTyrantActive() || this.targetTTD() < 22000;
          }),

          // Hero-specific dispatch
          new bt.Decorator(
            () => this.isDiabolist(),
            this.diabolistRotation()
          ),
          this.soulHarvesterRotation(),
        )
      ),
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      spell.cast(S.unendingResolve, () => me, () => {
        return Settings.FWDemoUnending && me.effectiveHealthPercent < Settings.FWDemoUnendingHP;
      }),
      spell.cast(S.darkPact, () => me, () => {
        return Settings.FWDemoDarkPact && me.effectiveHealthPercent < Settings.FWDemoDarkPactHP;
      }),
    );
  }

  // ===== MOVEMENT =====
  movementRotation() {
    return new bt.Decorator(
      () => me.isMoving(),
      new bt.Selector(
        // Demonbolt with Core proc (instant)
        spell.cast(S.demonbolt, () => this.getCurrentTarget(), () => {
          return this.getCoreStacks() >= 1 && this.getShards() < 4 &&
            this.getCurrentTarget() !== null;
        }),
        // Infernal Bolt (instant, Diabolist — no shard gate in movement)
        spell.cast(S.infernalBolt, () => this.getCurrentTarget(), () => {
          return this.isDiabolist() && this.getCurrentTarget() !== null;
        }),
        // Ruination (instant)
        spell.cast(S.ruination, () => this.getCurrentTarget(), () => {
          return this.isDiabolist() && this.getCurrentTarget() !== null;
        }),
        // Power Siphon (instant, generate Core)
        spell.cast(S.powerSiphon, () => me, () => {
          return this.getCoreStacks() <= 1;
        }),
        // Implosion (instant AoE)
        spell.cast(S.implosion, () => this.getCurrentTarget(), () => {
          return this.getEnemyCount() >= 2 && this.getWildImpStacks() >= 6 &&
            this.getCurrentTarget() !== null;
        }),
        // Summon Doomguard (instant, unconditional)
        spell.cast(S.summonDoomguard, () => this.getCurrentTarget(), () => {
          return this.getCurrentTarget() !== null;
        }),
        // Grimoire summons (instant, unconditional)
        spell.cast(S.grimoireImpLord, () => this.getCurrentTarget(), () => {
          return this.getCurrentTarget() !== null;
        }),
        spell.cast(S.grimoireFelRavager, () => this.getCurrentTarget(), () => {
          return this.getCurrentTarget() !== null;
        }),
        // Block cast-time spells
        new bt.Action(() => bt.Status.Success),
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== DIABOLIST ROTATION (SimC: actions.diabolist — 16 lines) =====
  diabolistRotation() {
    return new bt.Selector(
      // 1. power_siphon,if=buff.demonic_core.stack<=1|fight_remains<10
      spell.cast(S.powerSiphon, () => me, () => {
        return this.getCoreStacks() <= 1 || this.targetTTD() < 10000;
      }),

      // 2. hand_of_guldan,if=buff.dominion_of_argus.up
      spell.cast(S.handOfGuldan, () => this.getCurrentTarget(), () => {
        return this.hasDominion() && this.getShards() >= 3 &&
          this.getCurrentTarget() !== null;
      }),

      // 3. grimoire_imp_lord (unconditional in SimC)
      spell.cast(S.grimoireImpLord, () => this.getCurrentTarget(), () => {
        return this.useCDs() && this.getCurrentTarget() !== null;
      }),

      // 4. grimoire_fel_ravager (unconditional in SimC)
      spell.cast(S.grimoireFelRavager, () => this.getCurrentTarget(), () => {
        return this.useCDs() && this.getCurrentTarget() !== null;
      }),

      // 5. summon_doomguard (unconditional in SimC)
      spell.cast(S.summonDoomguard, () => this.getCurrentTarget(), () => {
        return this.useCDs() && this.getCurrentTarget() !== null;
      }),

      // 6. call_dreadstalkers,if=talent.reign_of_tyranny&(cooldown.summon_demonic_tyrant.remains>=20+gcd|cooldown.summon_demonic_tyrant.remains<=12-gcd)
      spell.cast(S.callDreadstalkers, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget() || this.getShards() < 2) return false;
        if (!this.hasReignOfTyranny()) return false;
        const tyrantRemains = this.getTyrantCDRemains();
        const gcd = 1500;
        return tyrantRemains >= (20000 + gcd) || tyrantRemains <= (12000 - gcd);
      }),

      // 7. call_dreadstalkers,if=!talent.reign_of_tyranny
      spell.cast(S.callDreadstalkers, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget() || this.getShards() < 2) return false;
        return !this.hasReignOfTyranny();
      }),

      // 8. summon_demonic_tyrant,if=soul_shard=5 (self-cast)
      spell.cast(S.summonDemonicTyrant, () => me, () => {
        if (!this.useCDs()) return false;
        return this.getShards() >= 5 && this.targetTTD() > 15000;
      }),

      // 9. implosion,if=buff.wild_imps.stack>=6&(active_enemies>2|talent.to_hell_and_back.enabled)
      spell.cast(S.implosion, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getWildImpStacks() < 6) return false;
        return this.getEnemyCount() > 2 || this.hasToHellAndBack();
      }),

      // 10. ruination (unconditional in SimC)
      spell.cast(S.ruination, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // 11. hand_of_guldan,if=soul_shard>=3&cooldown.summon_demonic_tyrant.remains>5|soul_shard=5
      spell.cast(S.handOfGuldan, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getShards() >= 5) return true;
        if (this.getShards() >= 3 && this.getTyrantCDRemains() > 5000) return true;
        return false;
      }),

      // 12. infernal_bolt,if=soul_shard<3 (no art proc check — it's a normal Diabolist spell)
      spell.cast(S.infernalBolt, () => this.getCurrentTarget(), () => {
        return this.getShards() < 3 && this.getCurrentTarget() !== null;
      }),

      // 13. demonbolt,target_if=(!debuff.doom.up),if=soul_shard<4&buff.demonic_core.react&talent.doom
      spell.cast(S.demonbolt, () => {
        if (!this.hasDoom() || this.getCoreStacks() < 1 || this.getShards() >= 4) return null;
        return this.getTargetWithoutDoom();
      }),

      // 14. demonbolt,if=soul_shard<4&buff.demonic_core.react
      spell.cast(S.demonbolt, () => this.getCurrentTarget(), () => {
        return this.getCoreStacks() >= 1 && this.getShards() < 4 &&
          this.getCurrentTarget() !== null;
      }),

      // 15. shadow_bolt
      spell.cast(S.shadowBolt, () => this.getCurrentTarget()),

      // 16. infernal_bolt (fallback — no shard condition)
      spell.cast(S.infernalBolt, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),
    );
  }

  // ===== SOUL HARVESTER ROTATION (SimC: actions.soulharvest — 14 lines) =====
  soulHarvesterRotation() {
    return new bt.Selector(
      // 1. power_siphon,if=buff.demonic_core.stack<=1|fight_remains<10
      spell.cast(S.powerSiphon, () => me, () => {
        return this.getCoreStacks() <= 1 || this.targetTTD() < 10000;
      }),

      // 2. hand_of_guldan,if=buff.dominion_of_argus.up
      spell.cast(S.handOfGuldan, () => this.getCurrentTarget(), () => {
        return this.hasDominion() && this.getShards() >= 3 &&
          this.getCurrentTarget() !== null;
      }),

      // 3. grimoire_imp_lord (unconditional in SimC)
      spell.cast(S.grimoireImpLord, () => this.getCurrentTarget(), () => {
        return this.useCDs() && this.getCurrentTarget() !== null;
      }),

      // 4. grimoire_fel_ravager (unconditional in SimC)
      spell.cast(S.grimoireFelRavager, () => this.getCurrentTarget(), () => {
        return this.useCDs() && this.getCurrentTarget() !== null;
      }),

      // 5. summon_doomguard (unconditional in SimC)
      spell.cast(S.summonDoomguard, () => this.getCurrentTarget(), () => {
        return this.useCDs() && this.getCurrentTarget() !== null;
      }),

      // 6. call_dreadstalkers (unconditional for Soul Harvester)
      spell.cast(S.callDreadstalkers, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.getShards() >= 2;
      }),

      // 7. summon_demonic_tyrant (unconditional — self-cast)
      spell.cast(S.summonDemonicTyrant, () => me, () => {
        return this.useCDs() && this.targetTTD() > 15000;
      }),

      // 8. implosion,if=buff.wild_imps.stack>=6&(active_enemies>2|talent.to_hell_and_back.enabled)
      spell.cast(S.implosion, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getWildImpStacks() < 6) return false;
        return this.getEnemyCount() > 2 || this.hasToHellAndBack();
      }),

      // 9. hand_of_guldan (unconditional — spend freely)
      spell.cast(S.handOfGuldan, () => this.getCurrentTarget(), () => {
        return this.getShards() >= 3 && this.getCurrentTarget() !== null;
      }),

      // 10. infernal_bolt,if=soul_shard<3 (no art proc check)
      spell.cast(S.infernalBolt, () => this.getCurrentTarget(), () => {
        return this.getShards() < 3 && this.getCurrentTarget() !== null;
      }),

      // 11. demonbolt,target_if=(!debuff.doom.up),if=soul_shard<4&buff.demonic_core.stack>=1&talent.doom
      spell.cast(S.demonbolt, () => {
        if (!this.hasDoom() || this.getCoreStacks() < 1 || this.getShards() >= 4) return null;
        return this.getTargetWithoutDoom();
      }),

      // 12. demonbolt,if=soul_shard<4&buff.demonic_core.stack>=2&!talent.doom
      spell.cast(S.demonbolt, () => this.getCurrentTarget(), () => {
        return this.getCoreStacks() >= 2 && this.getShards() < 4 &&
          !this.hasDoom() && this.getCurrentTarget() !== null;
      }),

      // 13. demonbolt,if=soul_shard<4&buff.demonic_core.react
      spell.cast(S.demonbolt, () => this.getCurrentTarget(), () => {
        return this.getCoreStacks() >= 1 && this.getShards() < 4 &&
          this.getCurrentTarget() !== null;
      }),

      // 14. shadow_bolt
      spell.cast(S.shadowBolt, () => this.getCurrentTarget()),
    );
  }
}
