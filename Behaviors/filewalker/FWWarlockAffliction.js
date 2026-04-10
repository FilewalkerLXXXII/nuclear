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
 * Affliction Warlock Behavior - Midnight 12.0.1
 * Full rewrite matched line-by-line to SimC APL:
 *   simc/midnight/ActionPriorityLists/default/warlock_affliction.simc
 *
 * Sources: SimC APL + Method Guide + Wowhead Guide
 *
 * Auto-detects: Hellcaller (Wither/Malevolence) vs Soul Harvester (Corruption/Dark Harvest)
 *
 * SimC action lists implemented:
 *   actions (default) — variable setup, end_of_fight, ogcd, hero dispatch, shared fillers
 *   actions.variables — cds_active
 *   actions.end_of_fight — UA dump, NF consumption
 *   actions.ogcd — racials gated on darkglare
 *   actions.hellcaller → HC_st / HC_cleave / HC_aoe
 *   actions.soul_harvester → SH_st / SH_cleave / SH_aoe
 *
 * Resource: Soul Shards (PowerType 7), max 5
 * Movement: Agony + Corruption/Wither instant, Nightfall SB instant, block cast-time
 */

const S = {
  // Core DoTs
  agony:              980,
  corruption:         172,
  wither:             445468,
  unstableAffliction: 30108,
  haunt:              48181,
  // Fillers
  shadowBolt:         686,
  drainSoul:          198590,
  maleficGrasp:       1261149,
  // AoE
  seedOfCorruption:   27243,
  // CDs
  summonDarkglare:    205180,
  darkHarvest:        1257052,
  malevolence:        442726,
  // Defensives
  unendingResolve:    104773,
  darkPact:           108416,
  // Utility
  summonPet:          688,
  grimoireOfSac:      108503,
  // Interrupt
  spellLock:          119910,
  // Racials
  berserking:         26297,
};

const A = {
  // DoT debuffs (may differ from cast IDs)
  agony:              980,
  corruption:         172,
  witherDebuff:       445465,
  unstableAffliction: 30108,
  haunt:              48181,
  // Procs
  nightfall:          264571,
  shardInstability:   1260264,
  cascadingCalamity:  1261124,
  shadowEmbrace:      32388,
  // CDs
  darkglare:          205180,
  malevolence:        442726,
  // Seed tracking
  seedOfCorruption:   27243,
};

// Talent IDs for talent-aware gating
const T = {
  maleficGrasp:       1261149,
  summonDarkglare:    205180,
  sowTheSeeds:        196226,
  patientZero:        1280553,
  shardInstability:   1260264,
  cascadingCalamity:  1261124,
  nocturnalYield:     1263502,
  grimoireOfSac:      108503,
};

export class AfflictionWarlockBehavior extends Behavior {
  name = 'FW Affliction Warlock';
  context = BehaviorContext.Any;
  specialization = Specialization.Warlock.Affliction;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _shardFrame = 0;
  _cachedShards = 0;
  _nfFrame = 0;
  _cachedNF = null;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWAffUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWAffDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWAffUnending', text: 'Use Unending Resolve', default: true },
        { type: 'slider', uid: 'FWAffUnendingHP', text: 'Unending Resolve HP %', default: 35, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWAffDarkPact', text: 'Use Dark Pact', default: true },
        { type: 'slider', uid: 'FWAffDarkPactHP', text: 'Dark Pact HP %', default: 50, min: 15, max: 70 },
      ],
    },
  ];

  // ===== Hero Detection =====
  isHellcaller() {
    return spell.isSpellKnown(S.wither);
  }

  isSoulHarvester() {
    return !this.isHellcaller();
  }

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

  getNightfallAura() {
    if (this._nfFrame === wow.frameTime) return this._cachedNF;
    this._nfFrame = wow.frameTime;
    this._cachedNF = me.getAura(A.nightfall);
    return this._cachedNF;
  }

  getNightfallStacks() {
    const aura = this.getNightfallAura();
    return aura ? aura.stacks : 0;
  }

  getNightfallRemaining() {
    const aura = this.getNightfallAura();
    return aura ? aura.remaining : 0;
  }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemyCount;
    this._enemyFrame = wow.frameTime;
    const target = this.getCurrentTarget();
    this._cachedEnemyCount = target ? target.getUnitsAroundCount(10) + 1 : 1;
    return this._cachedEnemyCount;
  }

  // ===== Helpers =====
  targetTTD() {
    const target = this.getCurrentTarget();
    if (!target || !target.timeToDeath) return 99999;
    return target.timeToDeath();
  }

  // SimC: variable.cds_active = !talent.summon_darkglare | cooldown.summon_darkglare.remains>20 | pet.darkglare.remains
  cdsActive() {
    if (!spell.isSpellKnown(S.summonDarkglare)) return true;
    const dgCD = spell.getCooldown(S.summonDarkglare);
    if (dgCD && dgCD.timeleft > 20000) return true;
    if (this.isDarkglareActive()) return true;
    return false;
  }

  isDarkglareActive() {
    return spell.getTimeSinceLastCast(S.summonDarkglare) < 20000;
  }

  darkglareRemaining() {
    const since = spell.getTimeSinceLastCast(S.summonDarkglare);
    if (since > 20000) return 0;
    return 20000 - since;
  }

  getCorruptionDebuffId() {
    return this.isHellcaller() ? A.witherDebuff : A.corruption;
  }

  getCorruptionCastId() {
    return this.isHellcaller() ? S.wither : S.corruption;
  }

  isDoTRefreshable(target, auraId) {
    if (!target) return true;
    const debuff = target.getAuraByMe(auraId);
    if (!debuff) return true;
    return debuff.remaining < debuff.duration * 0.3;
  }

  getDebuffRemaining(target, auraId) {
    if (!target) return 0;
    const debuff = target.getAuraByMe(auraId);
    return debuff ? debuff.remaining : 0;
  }

  // SimC: buff.nightfall.react=max_stack | buff.nightfall.remains<execute_time*max_stack
  shouldConsumeNightfall() {
    const stacks = this.getNightfallStacks();
    if (stacks <= 0) return false;
    if (stacks >= 2) return true;
    return this.getNightfallRemaining() < 3000;
  }

  getActiveAgonyCount() {
    if (!combat.targets) return 0;
    let count = 0;
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (unit && common.validTarget(unit) && unit.getAuraByMe(A.agony)) {
        count++;
      }
    }
    return count;
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: Summon pet
      spell.cast(S.summonPet, () => me, () => {
        if (me.inCombat()) return false;
        return (!me.pet || me.pet.deadOrGhost) && !spell.isSpellKnown(T.grimoireOfSac);
      }),

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Dead target auto-pick
      new bt.Action(() => {
        if (!me.target || !common.validTarget(me.target)) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),

      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),

      common.waitForCastOrChannel(),

      // Version + debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isHellcaller() ? 'Hellcaller' : 'Soul Harvester';
          console.info(`[AffliLock] Midnight 12.0.1 | Hero: ${hero} | SimC APL matched`);
        }
        if (Settings.FWAffDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[AffliLock] Shards:${this.getShards()} NF:${this.getNightfallStacks()} DG:${this.isDarkglareActive()} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.spellLock),
          this.defensives(),
          this.movementRotation(),

          // SimC actions — call sub-lists in order
          this.endOfFight(),
          this.ogcd(),

          // Hero dispatch
          new bt.Decorator(
            () => this.isSoulHarvester(),
            this.soulHarvesterDispatch()
          ),
          new bt.Decorator(
            () => this.isHellcaller(),
            this.hellcallerDispatch()
          ),

          // Shared fillers
          this.sharedFillers(),
        )
      ),
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      spell.cast(S.unendingResolve, () => me, () => {
        return Settings.FWAffUnending && me.effectiveHealthPercent < Settings.FWAffUnendingHP;
      }),
      spell.cast(S.darkPact, () => me, () => {
        return Settings.FWAffDarkPact && me.effectiveHealthPercent < Settings.FWAffDarkPactHP;
      }),
    );
  }

  // ===== MOVEMENT =====
  movementRotation() {
    return new bt.Decorator(
      () => me.isMoving(),
      new bt.Selector(
        // Agony refresh (instant)
        spell.cast(S.agony, () => this.getCurrentTarget(), () => {
          const target = this.getCurrentTarget();
          return target && this.isDoTRefreshable(target, A.agony);
        }),
        // Corruption/Wither refresh (instant)
        spell.cast(this.getCorruptionCastId(), () => this.getCurrentTarget(), () => {
          const target = this.getCurrentTarget();
          return target && this.isDoTRefreshable(target, this.getCorruptionDebuffId());
        }),
        // Haunt (instant)
        spell.cast(S.haunt, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),
        // Unstable Affliction (instant)
        spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
          if (!this.getCurrentTarget()) return false;
          if (this.getShards() < 1) return false;
          if (this.isDarkglareActive()) return true;
          if (this.getShards() > 4) return true;
          if (me.hasAura(A.shardInstability)) return true;
          return false;
        }),
        // Dark Harvest (instant)
        spell.cast(S.darkHarvest, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),
        // Malevolence (instant, Hellcaller)
        spell.cast(S.malevolence, () => me, () => {
          return this.isHellcaller() && Settings.FWAffUseCDs;
        }),
        // Summon Darkglare (instant CD)
        spell.cast(S.summonDarkglare, () => me, () => {
          return Settings.FWAffUseCDs && this.targetTTD() > 15000;
        }),
        // Nightfall SB (instant with proc)
        spell.cast(S.shadowBolt, () => this.getCurrentTarget(), () => {
          return this.shouldConsumeNightfall() && !spell.isSpellKnown(S.drainSoul);
        }),
        // Seed of Corruption (instant, AoE)
        spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
          return this.getEnemyCount() > 1 && this.getCurrentTarget() !== null;
        }),
        new bt.Action(() => bt.Status.Success),
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== END OF FIGHT (SimC actions.end_of_fight) =====
  endOfFight() {
    return new bt.Selector(
      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getShards() < 1) return false;
        if (this.targetTTD() >= 8000) return false;
        return !spell.isSpellKnown(T.patientZero) && !spell.isSpellKnown(T.sowTheSeeds);
      }),
      spell.cast(S.drainSoul, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(S.drainSoul) && this.getNightfallStacks() >= 1 && this.targetTTD() < 5000;
      }),
      spell.cast(S.shadowBolt, () => this.getCurrentTarget(), () => {
        return !spell.isSpellKnown(S.drainSoul) && this.getNightfallStacks() >= 1 && this.targetTTD() < 5000;
      }),
    );
  }

  // ===== OGCD (SimC actions.ogcd) =====
  ogcd() {
    return new bt.Selector(
      // SimC: berserking,if=!talent.summon_darkglare|pet.darkglare.active|fight_remains<14
      spell.cast(S.berserking, () => me, () => {
        if (!spell.isSpellKnown(S.summonDarkglare)) return true;
        if (this.isDarkglareActive()) return true;
        if (this.targetTTD() < 14000) return true;
        return false;
      }),
    );
  }

  // ===== HELLCALLER DISPATCH =====
  hellcallerDispatch() {
    return new bt.Selector(
      new bt.Decorator(() => this.getEnemyCount() === 1, this.HC_st()),
      new bt.Decorator(() => this.getEnemyCount() === 2, this.HC_cleave()),
      new bt.Decorator(() => this.getEnemyCount() > 2, this.HC_aoe()),
    );
  }

  // ===== SOUL HARVESTER DISPATCH =====
  soulHarvesterDispatch() {
    return new bt.Selector(
      new bt.Decorator(() => this.getEnemyCount() === 1, this.SH_st()),
      new bt.Decorator(() => this.getEnemyCount() === 2, this.SH_cleave()),
      new bt.Decorator(() => this.getEnemyCount() > 2, this.SH_aoe()),
    );
  }

  // ===== HC_st (SimC actions.HC_st — 9 lines) =====
  HC_st() {
    return new bt.Selector(
      spell.cast(S.haunt, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      spell.cast(S.agony, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        return target && this.isDoTRefreshable(target, A.agony);
      }),

      spell.cast(S.wither, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        return target && this.isDoTRefreshable(target, A.witherDebuff);
      }),

      // dark_harvest,if=execute_time<(dot.agony.remains<?dot.corruption.remains)
      spell.cast(S.darkHarvest, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        if (!target) return false;
        const agonyRem = this.getDebuffRemaining(target, A.agony);
        const dotRem = this.getDebuffRemaining(target, A.witherDebuff);
        return Math.min(agonyRem, dotRem) > 3000;
      }),

      // agony,if=dot.agony.remains<20&cooldown.summon_darkglare.remains<gcd
      spell.cast(S.agony, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        if (!target) return false;
        const agonyRem = this.getDebuffRemaining(target, A.agony);
        const dgCD = spell.getCooldown(S.summonDarkglare);
        return agonyRem < 20000 && dgCD && dgCD.timeleft < 1500;
      }),

      // SimC: summon_darkglare (self-cast)
      spell.cast(S.summonDarkglare, () => me, () => {
        return Settings.FWAffUseCDs && this.targetTTD() > 15000;
      }),

      // SimC: malevolence (self-cast)
      spell.cast(S.malevolence, () => me, () => {
        return Settings.FWAffUseCDs && this.targetTTD() > 10000;
      }),

      // malefic_grasp,if=talent.malefic_grasp&pet.darkglare.active&pet.darkglare.remains<gcd
      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.maleficGrasp)) return false;
        if (!this.isDarkglareActive()) return false;
        return this.darkglareRemaining() < 1500;
      }),

      // unstable_affliction with full SimC conditions
      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isDarkglareActive()) return true;
        if (me.hasAura(A.malevolence)) return true;
        if (this.getShards() > 4) return true;
        if (spell.isSpellKnown(T.shardInstability) && me.hasAura(A.shardInstability)) return true;
        const cc = me.getAura(A.cascadingCalamity);
        if (cc && cc.remaining < 1500) return true;
        return false;
      }),
    );
  }

  // ===== HC_cleave (SimC actions.HC_cleave — 10 lines) =====
  HC_cleave() {
    return new bt.Selector(
      spell.cast(S.haunt, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      // SimC: seed_of_corruption,if=talent.sow_the_seeds&!dot.wither.ticking&!dot.seed_of_corruption.ticking&!prev.seed_of_corruption&!action.seed_of_corruption.in_flight
      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.sowTheSeeds)) return false;
        const target = this.getCurrentTarget();
        if (!target) return false;
        if (target.getAuraByMe(A.witherDebuff)) return false;
        if (target.getAuraByMe(A.seedOfCorruption)) return false;
        if (spell.getTimeSinceLastCast(S.seedOfCorruption) < 2000) return false;
        return true;
      }),

      // wither,target_if=min:remains,if=remains<5
      spell.cast(S.wither, () => this.findLowestDoTTarget(A.witherDebuff, 5000), () => {
        return this.findLowestDoTTarget(A.witherDebuff, 5000) !== null;
      }),

      spell.cast(S.agony, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        return target && this.isDoTRefreshable(target, A.agony);
      }),

      spell.cast(S.darkHarvest, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      // SimC: summon_darkglare (self-cast)
      spell.cast(S.summonDarkglare, () => me, () => {
        return Settings.FWAffUseCDs && this.targetTTD() > 15000;
      }),

      // SimC: malevolence (self-cast)
      spell.cast(S.malevolence, () => me, () => {
        return Settings.FWAffUseCDs && this.targetTTD() > 10000;
      }),

      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.maleficGrasp)) return false;
        if (!this.isDarkglareActive()) return false;
        return this.darkglareRemaining() < 1500;
      }),

      // UA with !patient_zero&!sow_the_seeds gate
      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (spell.isSpellKnown(T.patientZero) || spell.isSpellKnown(T.sowTheSeeds)) return false;
        if (this.isDarkglareActive()) return true;
        if (me.hasAura(A.malevolence)) return true;
        if (this.getShards() > 4) return true;
        if (me.hasAura(A.shardInstability)) return true;
        const cc = me.getAura(A.cascadingCalamity);
        if (cc && cc.remaining < 1500) return true;
        return false;
      }),

      // seed_of_corruption,if=talent.patient_zero&talent.sow_the_seeds
      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.patientZero) && spell.isSpellKnown(T.sowTheSeeds);
      }),

      // UA for shard_instability/cascading_calamity procs
      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (me.hasAura(A.shardInstability)) return true;
        if (spell.isSpellKnown(T.cascadingCalamity)) {
          const cc = me.getAura(A.cascadingCalamity);
          if (cc && cc.remaining < 1500) return true;
        }
        return false;
      }),
    );
  }

  // ===== HC_aoe (SimC actions.HC_aoe — 11 lines) =====
  HC_aoe() {
    return new bt.Selector(
      // SimC: haunt,if=cooldown.haunt.ready
      spell.cast(S.haunt, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      // SimC: seed_of_corruption,if=(!dot.wither.ticking|dot.wither.refreshable)&!dot.seed_of_corruption.ticking&!prev.seed_of_corruption&!action.seed_of_corruption.in_flight
      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        if (!target) return false;
        const wither = target.getAuraByMe(A.witherDebuff);
        if (wither && !this.isDoTRefreshable(target, A.witherDebuff)) return false;
        if (target.getAuraByMe(A.seedOfCorruption)) return false;
        if (spell.getTimeSinceLastCast(S.seedOfCorruption) < 2000) return false;
        return true;
      }),

      spell.cast(S.darkHarvest, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      // agony,target_if=min:remains,if=active_dot.agony<active_enemies&remains<5
      spell.cast(S.agony, () => this.findAgonyTarget(), () => this.findAgonyTarget() !== null),

      // SimC: summon_darkglare (self-cast)
      spell.cast(S.summonDarkglare, () => me, () => {
        return Settings.FWAffUseCDs && this.targetTTD() > 15000;
      }),

      // SimC: malevolence (self-cast)
      spell.cast(S.malevolence, () => me, () => Settings.FWAffUseCDs),

      // seed_of_corruption,if=talent.sow_the_seeds
      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.sowTheSeeds) && this.getCurrentTarget() !== null;
      }),

      // UA,if=(...conditions...)&!talent.sow_the_seeds
      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (spell.isSpellKnown(T.sowTheSeeds)) return false;
        if (this.isDarkglareActive()) return true;
        if (me.hasAura(A.malevolence)) return true;
        if (this.getShards() > 4) return true;
        if (me.hasAura(A.shardInstability)) return true;
        const cc = me.getAura(A.cascadingCalamity);
        if (cc && cc.remaining < 1500) return true;
        return false;
      }),

      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && me.hasAura(A.shardInstability);
      }),

      // agony,target_if=min:remains,if=remains<duration*0.5
      spell.cast(S.agony, () => this.findAgonyRefreshTarget(), () => this.findAgonyRefreshTarget() !== null),

      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.maleficGrasp) && this.isDarkglareActive();
      }),
    );
  }

  // ===== SH_st (SimC actions.SH_st — 8 lines) =====
  SH_st() {
    return new bt.Selector(
      spell.cast(S.haunt, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.getNightfallStacks() < 2;
      }),

      spell.cast(S.agony, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        return target && this.isDoTRefreshable(target, A.agony);
      }),

      spell.cast(S.corruption, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        return target && this.isDoTRefreshable(target, A.corruption);
      }),

      // SimC: summon_darkglare,if=soul_shard<3|cooldown.dark_harvest.remains (self-cast)
      spell.cast(S.summonDarkglare, () => me, () => {
        if (!Settings.FWAffUseCDs || this.targetTTD() < 15000) return false;
        if (this.getShards() < 3) return true;
        const dhCD = spell.getCooldown(S.darkHarvest);
        return dhCD && dhCD.timeleft > 0;
      }),

      // dark_harvest,if=soul_shard<3&execute_time<min(agony,corruption)&buff.cascading_calamity.remains
      spell.cast(S.darkHarvest, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        if (!target || this.getShards() >= 3) return false;
        const minRem = Math.min(
          this.getDebuffRemaining(target, A.agony),
          this.getDebuffRemaining(target, A.corruption)
        );
        if (minRem <= 3000) return false;
        return me.hasAura(A.cascadingCalamity);
      }),

      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.maleficGrasp) || !this.isDarkglareActive()) return false;
        return this.darkglareRemaining() < 1500;
      }),

      // Nightfall at >1 stack
      spell.cast(S.drainSoul, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(S.drainSoul) && this.getNightfallStacks() > 1;
      }),
      spell.cast(S.shadowBolt, () => this.getCurrentTarget(), () => {
        return !spell.isSpellKnown(S.drainSoul) && this.getNightfallStacks() > 1;
      }),

      // UA with full conditions
      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isDarkglareActive()) return true;
        if (this.getShards() > 1) return true;
        if (spell.isSpellKnown(T.shardInstability) && me.hasAura(A.shardInstability)) return true;
        const cc = me.getAura(A.cascadingCalamity);
        if (cc && cc.remaining < 1500) return true;
        return false;
      }),
    );
  }

  // ===== SH_cleave (SimC actions.SH_cleave — 8 lines) =====
  SH_cleave() {
    return new bt.Selector(
      spell.cast(S.haunt, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.getNightfallStacks() < 2;
      }),

      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        if (!target) return false;
        const corr = target.getAuraByMe(A.corruption);
        if (corr && !this.isDoTRefreshable(target, A.corruption)) return false;
        if (target.getAuraByMe(A.seedOfCorruption)) return false;
        if (spell.getTimeSinceLastCast(S.seedOfCorruption) < 2000) return false;
        return true;
      }),

      spell.cast(S.darkHarvest, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      spell.cast(S.agony, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        return target && this.isDoTRefreshable(target, A.agony);
      }),

      // SimC: summon_darkglare (self-cast)
      spell.cast(S.summonDarkglare, () => me, () => {
        return Settings.FWAffUseCDs && this.targetTTD() > 15000;
      }),

      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.maleficGrasp) || !this.isDarkglareActive()) return false;
        return this.darkglareRemaining() < 1500;
      }),

      // UA,if=pet.darkglare.active|(!talent.patient_zero&!talent.sow_the_seeds)
      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isDarkglareActive()) return true;
        return !spell.isSpellKnown(T.patientZero) && !spell.isSpellKnown(T.sowTheSeeds);
      }),

      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),
    );
  }

  // ===== SH_aoe (SimC actions.SH_aoe — 9 lines) =====
  SH_aoe() {
    return new bt.Selector(
      spell.cast(S.haunt, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.getNightfallStacks() < 2;
      }),

      // SimC: seed_of_corruption,if=(!dot.corruption.ticking|dot.corruption.refreshable)&!dot.seed_of_corruption.ticking&!prev.seed_of_corruption&!action.seed_of_corruption.in_flight
      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        if (!target) return false;
        const corr = target.getAuraByMe(A.corruption);
        if (corr && !this.isDoTRefreshable(target, A.corruption)) return false;
        if (target.getAuraByMe(A.seedOfCorruption)) return false;
        if (spell.getTimeSinceLastCast(S.seedOfCorruption) < 2000) return false;
        return true;
      }),

      spell.cast(S.darkHarvest, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      // SimC: agony,target_if=min:remains,if=active_dot.agony<5&remains<5
      spell.cast(S.agony, () => this.findAgonyTarget(5), () => this.findAgonyTarget(5) !== null),

      // SimC: summon_darkglare (self-cast)
      spell.cast(S.summonDarkglare, () => me, () => {
        return Settings.FWAffUseCDs && this.targetTTD() > 15000;
      }),

      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.sowTheSeeds) && this.getCurrentTarget() !== null;
      }),

      spell.cast(S.unstableAffliction, () => this.getCurrentTarget(), () => {
        return !spell.isSpellKnown(T.sowTheSeeds) && this.getCurrentTarget() !== null;
      }),

      spell.cast(S.agony, () => this.findAgonyRefreshTarget(), () => this.findAgonyRefreshTarget() !== null),

      // SimC: malefic_grasp,if=talent.malefic_grasp&pet.darkglare.active&pet.darkglare.remains<gcd
      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.maleficGrasp) || !this.isDarkglareActive()) return false;
        return this.darkglareRemaining() < 1500;
      }),
    );
  }

  // ===== SHARED FILLERS (SimC default list bottom) =====
  sharedFillers() {
    return new bt.Selector(
      // Nocturnal Yield SoC with Nightfall
      spell.cast(S.seedOfCorruption, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.nocturnalYield) || this.getEnemyCount() <= 1) return false;
        return this.shouldConsumeNightfall();
      }),

      // Malefic Grasp during Darkglare with Nightfall
      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.maleficGrasp) || !this.isDarkglareActive()) return false;
        return this.shouldConsumeNightfall();
      }),

      // Drain Soul with Nightfall consumption
      spell.cast(S.drainSoul, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(S.drainSoul) && this.shouldConsumeNightfall();
      }),

      // Shadow Bolt with Nightfall consumption
      spell.cast(S.shadowBolt, () => this.getCurrentTarget(), () => {
        if (spell.isSpellKnown(S.drainSoul)) return false;
        return this.shouldConsumeNightfall();
      }),

      // Malefic Grasp chain during Darkglare
      spell.cast(S.maleficGrasp, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.maleficGrasp) && this.isDarkglareActive();
      }),

      // Drain Soul (chain filler)
      spell.cast(S.drainSoul, () => this.getCurrentTarget(), () => spell.isSpellKnown(S.drainSoul)),

      // Shadow Bolt (unconditional filler)
      spell.cast(S.shadowBolt, () => this.getCurrentTarget()),
    );
  }

  // ===== TARGET FINDING HELPERS =====

  findAgonyTarget(maxDots) {
    const max = maxDots || this.getEnemyCount();
    const activeCount = this.getActiveAgonyCount();
    if (activeCount >= max) return null;
    if (!combat.targets) return this.getCurrentTarget();

    let bestTarget = null;
    let bestRemaining = 999999;
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
      const agony = unit.getAuraByMe(A.agony);
      const rem = agony ? agony.remaining : 0;
      if (rem < 5000 && rem < bestRemaining) {
        bestRemaining = rem;
        bestTarget = unit;
      }
    }
    return bestTarget;
  }

  findAgonyRefreshTarget() {
    if (!combat.targets) return null;
    let bestTarget = null;
    let bestRemaining = 999999;
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
      const agony = unit.getAuraByMe(A.agony);
      if (!agony) continue;
      if (agony.remaining < agony.duration * 0.5 && agony.remaining < bestRemaining) {
        bestRemaining = agony.remaining;
        bestTarget = unit;
      }
    }
    return bestTarget;
  }

  findLowestDoTTarget(auraId, threshold) {
    if (!combat.targets) return this.getCurrentTarget();
    let bestTarget = null;
    let bestRemaining = 999999;
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
      if (unit.timeToDeath && unit.timeToDeath() < 8000) continue;
      const aura = unit.getAuraByMe(auraId);
      const rem = aura ? aura.remaining : 0;
      if (rem < threshold && rem < bestRemaining) {
        bestRemaining = rem;
        bestTarget = unit;
      }
    }
    return bestTarget;
  }
}
