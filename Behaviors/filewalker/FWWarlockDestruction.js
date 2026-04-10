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
 * Destruction Warlock Behavior - Midnight 12.0.1
 * SimC APL: simc/midnight/warlock_destruction.simc (50+ APL lines)
 * Sources: SimC APL + Wowhead + class theorycraft
 *
 * Auto-detects: Hellcaller (Wither) vs Diabolist (Diabolic Ritual)
 * Dispatches to: ST rotation / aoe_hc / aoe_dia (at 2+ targets)
 *
 * Resource: Soul Shards (PowerType 7), max 5 (fractional — 10 fragments = 1 shard)
 * Burst: Summon Infernal → Malevolence (HC) / Ritual cycle (Dia) → Chaos Bolt dump
 *
 * Hellcaller: Wither (instant, replaces Immolate), Malevolence 1min burst,
 *   Blackened Soul (shard spending adds Wither stacks)
 * Diabolist: Ritual cycle (Overlord → Mother → Pit Lord),
 *   Infernal Bolt (instant 2 shards), Ruination (AoE meteor)
 *
 * Key SimC variables replicated:
 *   infernal_active = pet.infernal.active | (CD duration - CD remains) < 20
 *   ritual_length = sum of ritual buff remains
 *   demonic_art = any art proc active
 *
 * SimC conditions matched:
 *   - Internal Combustion DoT refresh (remains-5 if CB in flight)
 *   - Havoc target_if targeting
 *   - active_dot tracking for Immolate/Wither spread
 *   - Backdraft stack management
 *   - Ritual length gating for Chaos Bolt timing
 */

const S = {
  // Core
  chaosBolt:          116858,
  incinerate:         29722,
  immolate:           348,
  conflagrate:        17962,
  rainOfFire:         5740,
  shadowburn:         17877,
  soulFire:           6353,
  // CDs
  summonInfernal:     1122,
  channelDemonfire:   196447,
  cataclysm:          152108,
  havoc:              80240,
  dimensionalRift:    196586,
  // Hellcaller
  wither:             445468,
  malevolence:        442726,
  // Diabolist
  infernalBolt:       434506,
  ruination:          434635,
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
  // Core procs
  backdraft:          196406,
  flashpoint:         387263,
  ritualOfRuin:       364349,
  impendingRuin:      364348,
  fiendishCruelty:    1245633,
  conflagOfChaos:     387108,
  chaoticInferno:     387275,
  // DoT debuffs
  immolate:           348,
  witherDebuff:       445465,
  // Hellcaller
  malevolence:        442726,
  // Diabolist ritual phases
  ritualOverlord:     431944,
  ritualMotherChaos:  432815,
  ritualPitLord:      432816,
  artOverlord:        428524,
  artMotherChaos:     432794,
  artPitLord:         432795,
  ruinationProc:      433885,
  infernalBoltProc:   433891,
  // Havoc
  havoc:              80240,
  // Hero detection
  witherKnown:        445468,
  diabolicRitual:     428514,
  // Talents
  internalCombustion: 266134,
  lakeOfFire:         452102,
  backdraftTalent:    196406,
  avatarOfDestruction: 432056,
  destructiveRapidity: 446988,
  fireAndBrimstone:   196408,
};

export class DestructionWarlockBehavior extends Behavior {
  name = 'FW Destruction Warlock';
  context = BehaviorContext.Any;
  specialization = Specialization.Warlock.Destruction;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _shardFrame = 0;
  _cachedShards = 0;
  _bdFrame = 0;
  _cachedBackdraft = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _ritualFrame = 0;
  _cachedRitualLength = 0;
  _infFrame = 0;
  _cachedInfernalActive = false;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWDestUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWDestDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWDestUnending', text: 'Use Unending Resolve', default: true },
        { type: 'slider', uid: 'FWDestUnendingHP', text: 'Unending Resolve HP %', default: 35, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWDestDarkPact', text: 'Use Dark Pact', default: true },
        { type: 'slider', uid: 'FWDestDarkPactHP', text: 'Dark Pact HP %', default: 50, min: 15, max: 70 },
      ],
    },
  ];

  // ===== Hero Talent Detection =====
  isHellcaller() {
    return spell.isSpellKnown(S.wither);
  }

  isDiabolist() {
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

  getBackdraftStacks() {
    if (this._bdFrame === wow.frameTime) return this._cachedBackdraft;
    this._bdFrame = wow.frameTime;
    const aura = me.getAura(A.backdraft);
    this._cachedBackdraft = aura ? aura.stacks : 0;
    return this._cachedBackdraft;
  }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemyCount;
    this._enemyFrame = wow.frameTime;
    const target = this.getCurrentTarget();
    this._cachedEnemyCount = target ? target.getUnitsAroundCount(10) + 1 : 1;
    return this._cachedEnemyCount;
  }

  // SimC: variable.ritual_length = sum of ritual buff remains
  getRitualLength() {
    if (this._ritualFrame === wow.frameTime) return this._cachedRitualLength;
    this._ritualFrame = wow.frameTime;
    let total = 0;
    const r1 = me.getAura(A.ritualOverlord);
    const r2 = me.getAura(A.ritualMotherChaos);
    const r3 = me.getAura(A.ritualPitLord);
    if (r1) total += r1.remaining;
    if (r2) total += r2.remaining;
    if (r3) total += r3.remaining;
    this._cachedRitualLength = total;
    return total;
  }

  // SimC: variable.infernal_active = pet.infernal.active|(cooldown.summon_infernal.duration-cooldown.summon_infernal.remains)<20
  isInfernalActive() {
    if (this._infFrame === wow.frameTime) return this._cachedInfernalActive;
    this._infFrame = wow.frameTime;
    // Method 1: pet was recently summoned (30s duration)
    const timeSince = spell.getTimeSinceLastCast(S.summonInfernal);
    if (timeSince < 30000) {
      this._cachedInfernalActive = true;
      return true;
    }
    // Method 2: SimC (cd_duration - cd_remains) < 20 — i.e. we recently used it
    const cd = spell.getCooldown(S.summonInfernal);
    if (cd && cd.duration > 0) {
      const elapsed = cd.duration - cd.timeleft;
      if (elapsed < 20000) {
        this._cachedInfernalActive = true;
        return true;
      }
    }
    this._cachedInfernalActive = false;
    return false;
  }

  // ===== Helpers =====
  targetTTD() {
    const target = this.getCurrentTarget();
    if (!target || !target.timeToDeath) return 99999;
    return target.timeToDeath();
  }

  hasDemonicArt() {
    return me.hasAura(A.artOverlord) || me.hasAura(A.artMotherChaos) || me.hasAura(A.artPitLord);
  }

  hasRuinationProc() {
    return me.hasAura(A.artPitLord) || me.hasAura(A.ruinationProc);
  }

  hasInfernalBoltProc() {
    return me.hasAura(A.artMotherChaos) || me.hasAura(A.infernalBoltProc);
  }

  getDoTId() {
    return this.isHellcaller() ? A.witherDebuff : A.immolate;
  }

  getDoTCastId() {
    return this.isHellcaller() ? S.wither : S.immolate;
  }

  // DoT remaining on target
  getDoTRemaining(target) {
    if (!target) target = this.getCurrentTarget();
    if (!target) return 0;
    const debuff = target.getAuraByMe(this.getDoTId());
    return debuff ? debuff.remaining : 0;
  }

  // SimC: refreshable with Internal Combustion awareness
  // (dot.X.remains - 5*(chaos_bolt.in_flight & talent.internal_combustion)) < dot.X.duration*0.3
  // Also: (dot.X.remains - CB.execute_time) < 5 & talent.internal_combustion & CB.usable
  isDoTRefreshable(target) {
    if (!target) target = this.getCurrentTarget();
    if (!target) return false;
    if (this.targetTTD() < 8000) return false;
    const dotId = this.getDoTId();
    const debuff = target.getAuraByMe(dotId);
    if (!debuff) return true;
    let remains = debuff.remaining;
    // Internal Combustion: CB in flight consumes 5s of DoT
    if (spell.isSpellKnown(A.internalCombustion)) {
      const cbTimeSince = spell.getTimeSinceLastCast(S.chaosBolt);
      if (cbTimeSince < 2000) remains -= 5000; // CB recently cast, likely in flight
    }
    if (remains < debuff.duration * 0.3) return true;
    // Also: if IC talented and CB usable, check if remains-execute_time < 5s
    if (spell.isSpellKnown(A.internalCombustion) && !spell.isOnCooldown(S.chaosBolt) && this.getShards() >= 2) {
      if ((remains - 2500) < 5000) return true; // CB execute time ~2.5s
    }
    return false;
  }

  // Soul Fire / Cataclysm gating for DoT refresh
  // !talent.soul_fire | cooldown.soul_fire.remains + cast_time > dot.remains - 5*IC
  shouldNotWaitForSoulFire(target) {
    if (!spell.isSpellKnown(S.soulFire)) return true;
    const sfCD = spell.getCooldown(S.soulFire);
    const sfRemains = sfCD ? sfCD.timeleft : 0;
    const dotRemains = this.getDoTRemaining(target);
    const icAdj = spell.isSpellKnown(A.internalCombustion) ? 5000 : 0;
    return (sfRemains + 2000) > (dotRemains - icAdj);
  }

  shouldNotWaitForCataclysm(target) {
    if (!spell.isSpellKnown(S.cataclysm)) return true;
    const catCD = spell.getCooldown(S.cataclysm);
    const catRemains = catCD ? catCD.timeleft : 0;
    const dotRemains = this.getDoTRemaining(target);
    return (catRemains + 1500) > dotRemains;
  }

  // Active DoT count for multi-target spread
  getActiveDoTCount() {
    if (!combat.targets) return 0;
    let count = 0;
    const dotId = this.getDoTId();
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (unit && common.validTarget(unit) && unit.hasAuraByMe(dotId)) count++;
    }
    return count;
  }

  // Havoc target: secondary target with longest DoT remaining, not current target
  getHavocTarget() {
    if (!combat.targets) return null;
    const currentTarget = this.getCurrentTarget();
    let bestTarget = null;
    let bestScore = -999999;
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
      if (unit === currentTarget) continue;
      if (unit.timeToDeath && unit.timeToDeath() < 8000) continue;
      // SimC: target_if=min:((-target.time_to_die)<?-15)+dot.X.remains+99*(self.target=target)
      const ttd = unit.timeToDeath ? unit.timeToDeath() : 99999;
      const dotRem = this.getDoTRemaining(unit);
      const score = Math.min(-ttd, -15000) + dotRem;
      if (score > bestScore || !bestTarget) {
        bestTarget = unit;
        bestScore = score;
      }
    }
    return bestTarget;
  }

  // Is havoc active on any target?
  isHavocActive() {
    if (!combat.targets) return false;
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (unit && unit.hasAuraByMe(A.havoc)) return true;
    }
    return false;
  }

  // Conflagrate target for DoT spread (target with most DoT remaining that has refreshable targets nearby)
  getConflagSpreadTarget() {
    if (!combat.targets) return this.getCurrentTarget();
    const dotId = this.getDoTId();
    let bestTarget = null;
    let bestRemains = -1;
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
      if (unit.hasAuraByMe(A.havoc)) continue; // skip havoc targets
      const debuff = unit.getAuraByMe(dotId);
      const rem = debuff ? debuff.remaining : 0;
      if (rem > bestRemains) {
        bestTarget = unit;
        bestRemains = rem;
      }
    }
    return bestTarget;
  }

  // Number of refreshable DoTs (for Conflag spread gating)
  getRefreshableDoTCount() {
    if (!combat.targets) return 0;
    let count = 0;
    const dotId = this.getDoTId();
    for (let i = 0; i < combat.targets.length; i++) {
      const unit = combat.targets[i];
      if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
      const debuff = unit.getAuraByMe(dotId);
      if (!debuff || debuff.remaining < debuff.duration * 0.3) count++;
    }
    return count;
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: Summon pet (if not using Grimoire of Sacrifice)
      spell.cast(S.summonPet, () => me, () => {
        return (!me.pet || me.pet.deadOrGhost) && !spell.isSpellKnown(S.grimoireOfSac);
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
          const hero = this.isHellcaller() ? 'Hellcaller' : 'Diabolist';
          console.info(`[DestroLock] Midnight 12.0.1 | Hero: ${hero}`);
        }
        if (Settings.FWDestDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[DestroLock] Shards:${this.getShards()} BD:${this.getBackdraftStacks()} Inf:${this.isInfernalActive()} Ritual:${this.getRitualLength()} Enemies:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.spellLock),

          // Defensives
          this.defensives(),

          // Movement block
          this.movementRotation(),

          // SimC: ogcd (racials + Berserking during Infernal)
          this.ogcd(),

          // AoE routing: 2+ targets → aoe_hc or aoe_dia
          new bt.Decorator(
            () => this.getEnemyCount() >= 2 && this.isHellcaller(),
            this.aoeHellcaller()
          ),
          new bt.Decorator(
            () => this.getEnemyCount() >= 2 && this.isDiabolist(),
            this.aoeDiabolist()
          ),

          // ST rotation
          this.stRotation(),
        )
      ),
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      spell.cast(S.unendingResolve, () => me, () => {
        return Settings.FWDestUnending && me.effectiveHealthPercent < Settings.FWDestUnendingHP;
      }),
      spell.cast(S.darkPact, () => me, () => {
        return Settings.FWDestDarkPact && me.effectiveHealthPercent < Settings.FWDestDarkPactHP;
      }),
    );
  }

  // ===== MOVEMENT =====
  movementRotation() {
    return new bt.Decorator(
      () => me.isMoving(),
      new bt.Selector(
        // Wither (instant — Hellcaller)
        spell.cast(S.wither, () => this.getCurrentTarget(), () => {
          return this.isHellcaller() && this.getCurrentTarget() !== null &&
            this.isDoTRefreshable();
        }),
        // Conflagrate (instant, 2+ charges)
        spell.cast(S.conflagrate, () => this.getCurrentTarget(), () => {
          return this.getCurrentTarget() !== null && this.getShards() < 4.5;
        }),
        // Shadowburn (instant)
        spell.cast(S.shadowburn, () => this.getCurrentTarget(), () => {
          const target = this.getCurrentTarget();
          if (!target) return false;
          return me.hasAura(A.fiendishCruelty) || target.effectiveHealthPercent < 20;
        }),
        // Dimensional Rift (instant, 3 charges)
        spell.cast(S.dimensionalRift, () => this.getCurrentTarget(), () => {
          return this.getCurrentTarget() !== null;
        }),
        // Infernal Bolt (Diabolist, instant)
        spell.cast(S.infernalBolt, () => this.getCurrentTarget(), () => {
          return this.isDiabolist() && this.getCurrentTarget() !== null;
        }),
        // Ruination (Diabolist, instant)
        spell.cast(S.ruination, () => this.getCurrentTarget(), () => {
          return this.isDiabolist() && this.getCurrentTarget() !== null;
        }),
        // Summon Infernal (off-GCD / instant)
        spell.cast(S.summonInfernal, () => me, () => {
          return Settings.FWDestUseCDs && this.targetTTD() > 15000;
        }),
        // Malevolence (instant, Hellcaller)
        spell.cast(S.malevolence, () => me, () => {
          return this.isHellcaller() && Settings.FWDestUseCDs;
        }),
        // Block cast-time spells
        new bt.Action(() => bt.Status.Success),
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== SimC: actions.ogcd =====
  ogcd() {
    return new bt.Selector(
      // SimC: berserking,if=variable.infernal_active|!talent.summon_infernal|(fight_remains<(cooldown.summon_infernal.remains_expected+cooldown.berserking.duration)&(fight_remains>cooldown.berserking.duration))|fight_remains<cooldown.summon_infernal.remains_expected
      spell.cast(S.berserking, () => me, () => {
        if (this.isInfernalActive()) return true;
        if (!spell.isSpellKnown(S.summonInfernal)) return true;
        const infCD = spell.getCooldown(S.summonInfernal);
        const infRemains = infCD ? infCD.timeleft : 0;
        const berskDur = 10000;
        const ttd = this.targetTTD();
        // fight_remains<(infernal_cd+berserking_dur)&fight_remains>berserking_dur
        if (ttd < (infRemains + berskDur) && ttd > berskDur) return true;
        // fight_remains<infernal_cd
        if (ttd < infRemains) return true;
        return false;
      }),
    );
  }

  // ===== ST ROTATION (SimC: actions — 14 lines) =====
  stRotation() {
    return new bt.Selector(
      // 1. soul_fire,if=soul_shard<=4
      spell.cast(S.soulFire, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.getShards() <= 4;
      }),

      // 2. chaos_bolt,if=talent.diabolic_ritual&(demonic_art|(variable.ritual_length<action.chaos_bolt.execute_time))&target.health.pct>20
      spell.cast(S.chaosBolt, () => this.getCurrentTarget(), () => {
        if (!this.isDiabolist()) return false;
        const target = this.getCurrentTarget();
        if (!target || target.effectiveHealthPercent <= 20) return false;
        if (this.hasDemonicArt()) return true;
        const ritualLen = this.getRitualLength();
        return ritualLen > 0 && ritualLen < 2500; // < CB execute time ~2.5s
      }),

      // 3. conflagrate,if=soul_shard<=4.2&buff.backdraft.stack<1
      spell.cast(S.conflagrate, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null &&
          this.getShards() <= 4.2 && this.getBackdraftStacks() < 1;
      }),

      // 4. summon_infernal (self-cast, unconditional in SimC)
      spell.cast(S.summonInfernal, () => me, () => {
        return Settings.FWDestUseCDs && this.targetTTD() > 15000;
      }),

      // 5. malevolence
      spell.cast(S.malevolence, () => me, () => {
        return this.isHellcaller() && Settings.FWDestUseCDs &&
          me.inCombat() && this.targetTTD() > 10000;
      }),

      // 6. incinerate,if=buff.chaotic_inferno_buff.up&soul_shard<=4.6
      spell.cast(S.incinerate, () => this.getCurrentTarget(), () => {
        return me.hasAura(A.chaoticInferno) && this.getShards() <= 4.6 &&
          this.getCurrentTarget() !== null;
      }),

      // 7. shadowburn,if=((!demonic_art&(variable.ritual_length>2|talent.wither))|target.health.pct<=20)
      //    &(buff.fiendish_cruelty.up|talent.conflagration_of_chaos)
      //    &(!talent.wither|soul_shard>=4|buff.malevolence.up|pet.infernal.active|fight_remains<=15)
      spell.cast(S.shadowburn, () => this.getCurrentTarget(), () => {
        const target = this.getCurrentTarget();
        if (!target) return false;
        // First condition: (!demonic_art & (ritual>2 | wither)) | hp<=20
        const cond1 = (!this.hasDemonicArt() && (this.getRitualLength() > 2000 || this.isHellcaller())) ||
          target.effectiveHealthPercent <= 20;
        if (!cond1) return false;
        // Second condition: fiendish_cruelty or conflag_of_chaos talented
        if (!me.hasAura(A.fiendishCruelty) && !spell.isSpellKnown(A.conflagOfChaos)) return false;
        // Third condition: !wither | shards>=4 | malevolence | infernal | fight<=15
        if (this.isHellcaller()) {
          return this.getShards() >= 4 || me.hasAura(A.malevolence) ||
            this.isInfernalActive() || this.targetTTD() <= 15000;
        }
        return true;
      }),

      // 8. wither (Hellcaller DoT refresh with IC awareness + Soul Fire/Cataclysm gating)
      spell.cast(S.wither, () => this.getCurrentTarget(), () => {
        if (!this.isHellcaller()) return false;
        const target = this.getCurrentTarget();
        if (!target) return false;
        if (!this.isDoTRefreshable(target)) return false;
        if (!this.shouldNotWaitForSoulFire(target)) return false;
        if (!this.shouldNotWaitForCataclysm(target)) return false;
        return true;
      }),

      // 9. immolate (Diabolist DoT refresh with IC awareness + Soul Fire/Cataclysm gating)
      spell.cast(S.immolate, () => this.getCurrentTarget(), () => {
        if (this.isHellcaller()) return false;
        const target = this.getCurrentTarget();
        if (!target) return false;
        if (spell.getTimeSinceLastCast(S.immolate) < 3000) return false;
        if (!this.isDoTRefreshable(target)) return false;
        if (!this.shouldNotWaitForSoulFire(target)) return false;
        if (!this.shouldNotWaitForCataclysm(target)) return false;
        return true;
      }),

      // 10. ruination (unconditional in SimC)
      spell.cast(S.ruination, () => this.getCurrentTarget(), () => {
        return this.isDiabolist() && this.getCurrentTarget() !== null;
      }),

      // 11. cataclysm,if=talent.lake_of_fire
      spell.cast(S.cataclysm, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(A.lakeOfFire) && this.getCurrentTarget() !== null;
      }),

      // 12. chaos_bolt — Hellcaller: shards>=4|malevolence|infernal|fight<=15
      //                  Diabolist: ritual_length>4
      spell.cast(S.chaosBolt, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isHellcaller()) {
          return this.getShards() >= 4 || me.hasAura(A.malevolence) ||
            this.isInfernalActive() || this.targetTTD() <= 15000;
        }
        return this.getRitualLength() > 4000;
      }),

      // 13. infernal_bolt,if=soul_shard<=3 (no proc check — normal Diabolist spell)
      spell.cast(S.infernalBolt, () => this.getCurrentTarget(), () => {
        return this.isDiabolist() && this.getShards() <= 3 &&
          this.getCurrentTarget() !== null;
      }),

      // 14. channel_demonfire
      spell.cast(S.channelDemonfire, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.getDoTRemaining() > 3000;
      }),

      // 15. incinerate filler
      spell.cast(S.incinerate, () => this.getCurrentTarget()),
    );
  }

  // ===== AoE HELLCALLER (SimC: actions.aoe_hc — 14 lines) =====
  aoeHellcaller() {
    return new bt.Selector(
      // 1. summon_infernal (self-cast)
      spell.cast(S.summonInfernal, () => me, () => {
        return Settings.FWDestUseCDs && this.targetTTD() > 15000;
      }),

      // 2. malevolence (self-cast)
      spell.cast(S.malevolence, () => me, () => {
        return Settings.FWDestUseCDs && me.inCombat();
      }),

      // 3. rain_of_fire,if=(soul_shard>=(4.0-0.1*active_dot.wither))&active_enemies>=4
      spell.cast(S.rainOfFire, () => this.getCurrentTarget(), () => {
        if (this.getEnemyCount() < 4) return false;
        const threshold = 4.0 - 0.1 * this.getActiveDoTCount();
        return this.getShards() >= threshold;
      }),

      // 4. conflagrate,target_if=max:(dot.wither.remains-99*debuff.havoc.remains),if=dot_refreshable_count.wither>0&!dot.wither.refreshable
      spell.cast(S.conflagrate, () => this.getConflagSpreadTarget(), () => {
        if (this.getRefreshableDoTCount() <= 0) return false;
        const target = this.getCurrentTarget();
        return target !== null && !this.isDoTRefreshable(target);
      }),

      // 5. shadowburn,target_if=min:(time_to_die+999*debuff.havoc.remains),if=buff.malevolence.up|buff.fiendish_cruelty.up|active_enemies<=3|
      //    (talent.conflagration_of_chaos&((active_enemies<=5&talent.destructive_rapidity)|(active_enemies<=6&!talent.destructive_rapidity)))
      spell.cast(S.shadowburn, () => this.getCurrentTarget(), () => {
        if (me.hasAura(A.malevolence)) return true;
        if (me.hasAura(A.fiendishCruelty)) return true;
        if (this.getEnemyCount() <= 3) return true;
        if (spell.isSpellKnown(A.conflagOfChaos)) {
          const enemies = this.getEnemyCount();
          if (spell.isSpellKnown(A.destructiveRapidity) && enemies <= 5) return true;
          if (!spell.isSpellKnown(A.destructiveRapidity) && enemies <= 6) return true;
        }
        return false;
      }),

      // 6. cataclysm (unconditional in AoE — raid_event.adds.in>15 not trackable)
      spell.cast(S.cataclysm, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // 7. havoc,target_if=...,if=(!cooldown.summon_infernal.up|!talent.summon_infernal)&target.time_to_die>8&(cooldown.malevolence.remains>15|!talent.malevolence)|time<5
      spell.cast(S.havoc, () => this.getHavocTarget(), () => {
        const havocTarget = this.getHavocTarget();
        if (!havocTarget) return false;
        // SimC: (!cooldown.summon_infernal.up|!talent.summon_infernal)
        if (spell.isSpellKnown(S.summonInfernal) && !spell.isOnCooldown(S.summonInfernal)) return false;
        // SimC: (cooldown.malevolence.remains>15|!talent.malevolence)
        if (spell.isSpellKnown(S.malevolence)) {
          const malCD = spell.getCooldown(S.malevolence);
          const malRemains = malCD ? malCD.timeleft : 99999;
          if (malRemains <= 15000) return false;
        }
        return true;
      }),

      // 8. rain_of_fire,if=active_enemies>=4 (unconditional — shard gate only)
      spell.cast(S.rainOfFire, () => this.getCurrentTarget(), () => {
        return this.getEnemyCount() >= 4 && this.getShards() >= 3;
      }),

      // 9. chaos_bolt,if=active_enemies<=(3+(havoc_active*!talent.destructive_rapidity))
      spell.cast(S.chaosBolt, () => this.getCurrentTarget(), () => {
        let maxEnemies = 3;
        if (this.isHavocActive() && !spell.isSpellKnown(A.destructiveRapidity)) maxEnemies++;
        return this.getEnemyCount() <= maxEnemies && this.getShards() >= 2;
      }),

      // 10. soul_fire,target_if=min:...,if=soul_shard<4&(active_enemies<=8|talent.avatar_of_destruction)
      spell.cast(S.soulFire, () => this.getCurrentTarget(), () => {
        if (this.getShards() >= 4) return false;
        return this.getEnemyCount() <= 8 || spell.isSpellKnown(A.avatarOfDestruction);
      }),

      // 11. wither,target_if=min:dot.wither.remains,if=dot.wither.refreshable&(!talent.cataclysm|cooldown.cataclysm.remains>dot.wither.remains)&active_dot.wither<=active_enemies&target.time_to_die>8
      spell.cast(S.wither, () => {
        if (!combat.targets) return this.getCurrentTarget();
        let bestTarget = null;
        let bestRemains = 999999;
        for (let i = 0; i < combat.targets.length; i++) {
          const unit = combat.targets[i];
          if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
          if (unit.timeToDeath && unit.timeToDeath() < 8000) continue;
          const debuff = unit.getAuraByMe(A.witherDebuff);
          const rem = debuff ? debuff.remaining : 0;
          if (this.isDoTRefreshable(unit) && rem < bestRemains) {
            bestTarget = unit;
            bestRemains = rem;
          }
        }
        return bestTarget;
      }, () => {
        if (!this.shouldNotWaitForCataclysm()) return false;
        return this.getActiveDoTCount() <= this.getEnemyCount();
      }),

      // 12. incinerate,if=talent.fire_and_brimstone&buff.backdraft.up
      spell.cast(S.incinerate, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(A.fireAndBrimstone) && this.getBackdraftStacks() >= 1;
      }),

      // 13. conflagrate,target_if=max:(dot.wither.remains-99*debuff.havoc.remains),if=buff.backdraft.stack<2|!talent.backdraft
      spell.cast(S.conflagrate, () => this.getConflagSpreadTarget(), () => {
        return this.getBackdraftStacks() < 2 || !spell.isSpellKnown(A.backdraftTalent);
      }),

      // 14. incinerate filler
      spell.cast(S.incinerate, () => this.getCurrentTarget()),
    );
  }

  // ===== AoE DIABOLIST (SimC: actions.aoe_dia — 14 lines) =====
  aoeDiabolist() {
    return new bt.Selector(
      // 1. summon_infernal (self-cast)
      spell.cast(S.summonInfernal, () => me, () => {
        return Settings.FWDestUseCDs && this.targetTTD() > 15000;
      }),

      // 2. chaos_bolt,if=talent.diabolic_ritual&(demonic_art|(variable.ritual_length<CB.execute_time))&target.health.pct>20&active_enemies<=4
      spell.cast(S.chaosBolt, () => this.getCurrentTarget(), () => {
        if (this.getEnemyCount() > 4) return false;
        const target = this.getCurrentTarget();
        if (!target || target.effectiveHealthPercent <= 20) return false;
        if (this.hasDemonicArt()) return true;
        const ritualLen = this.getRitualLength();
        return ritualLen > 0 && ritualLen < 2500;
      }),

      // 3. rain_of_fire,if=((soul_shard>=(3.5-0.1*active_dot.immolate))|buff.alythesss_ire.up)&active_enemies>=4
      spell.cast(S.rainOfFire, () => this.getCurrentTarget(), () => {
        if (this.getEnemyCount() < 4) return false;
        const threshold = 3.5 - 0.1 * this.getActiveDoTCount();
        return this.getShards() >= threshold;
      }),

      // 4. conflagrate,target_if=max:(dot.immolate.remains-99*debuff.havoc.remains),if=dot_refreshable_count.immolate>0&!dot.immolate.refreshable
      spell.cast(S.conflagrate, () => this.getConflagSpreadTarget(), () => {
        if (this.getRefreshableDoTCount() <= 0) return false;
        const target = this.getCurrentTarget();
        return target !== null && !this.isDoTRefreshable(target);
      }),

      // 5. shadowburn,target_if=min:(time_to_die+999*debuff.havoc.remains),if=(active_enemies<=(3+buff.fiendish_cruelty.up))|
      //    (talent.conflagration_of_chaos&active_enemies<=(6-talent.destructive_rapidity+buff.fiendish_cruelty.up))
      spell.cast(S.shadowburn, () => this.getCurrentTarget(), () => {
        const enemies = this.getEnemyCount();
        const hasCruelty = me.hasAura(A.fiendishCruelty) ? 1 : 0;
        if (enemies <= 3 + hasCruelty) return true;
        if (spell.isSpellKnown(A.conflagOfChaos)) {
          const drTalent = spell.isSpellKnown(A.destructiveRapidity) ? 1 : 0;
          if (enemies <= 6 - drTalent + hasCruelty) return true;
        }
        return false;
      }),

      // 6. ruination (unconditional in SimC)
      spell.cast(S.ruination, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // 7. cataclysm,if=raid_event.adds.in>15|talent.lake_of_fire (unconditional in AoE)
      spell.cast(S.cataclysm, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // 8. havoc,target_if=...,if=(!cooldown.summon_infernal.up|!talent.summon_infernal)&target.time_to_die>8|time<5
      spell.cast(S.havoc, () => this.getHavocTarget(), () => {
        const havocTarget = this.getHavocTarget();
        if (!havocTarget) return false;
        // SimC: (!cooldown.summon_infernal.up|!talent.summon_infernal)
        if (spell.isSpellKnown(S.summonInfernal) && !spell.isOnCooldown(S.summonInfernal)) return false;
        return true;
      }),

      // 9. infernal_bolt,if=soul_shard<3 (no proc check)
      spell.cast(S.infernalBolt, () => this.getCurrentTarget(), () => {
        return this.getShards() < 3 && this.getCurrentTarget() !== null;
      }),

      // 10. chaos_bolt,if=active_enemies<=3&variable.ritual_length>4
      spell.cast(S.chaosBolt, () => this.getCurrentTarget(), () => {
        return this.getEnemyCount() <= 3 && this.getRitualLength() > 4000 && this.getShards() >= 2;
      }),

      // 11. soul_fire,target_if=min:...,if=soul_shard<4&(talent.avatar_of_destruction&active_enemies<=10|active_enemies<=5)
      spell.cast(S.soulFire, () => this.getCurrentTarget(), () => {
        if (this.getShards() >= 4) return false;
        const enemies = this.getEnemyCount();
        if (spell.isSpellKnown(A.avatarOfDestruction) && enemies <= 10) return true;
        return enemies <= 5;
      }),

      // 12. immolate,target_if=min:dot.immolate.remains,if=dot.immolate.refreshable&(!talent.cataclysm|cooldown.cataclysm.remains>dot.immolate.remains)&active_dot.immolate<=5&!talent.cataclysm&target.time_to_die>18
      spell.cast(S.immolate, () => {
        if (!combat.targets) return this.getCurrentTarget();
        let bestTarget = null;
        let bestRemains = 999999;
        for (let i = 0; i < combat.targets.length; i++) {
          const unit = combat.targets[i];
          if (!unit || !common.validTarget(unit) || me.distanceTo(unit) > 40) continue;
          if (unit.timeToDeath && unit.timeToDeath() < 18000) continue;
          const debuff = unit.getAuraByMe(A.immolate);
          const rem = debuff ? debuff.remaining : 0;
          if (this.isDoTRefreshable(unit) && rem < bestRemains) {
            bestTarget = unit;
            bestRemains = rem;
          }
        }
        return bestTarget;
      }, () => {
        if (spell.getTimeSinceLastCast(S.immolate) < 3000) return false;
        if (this.getActiveDoTCount() > 5) return false;
        if (spell.isSpellKnown(S.cataclysm)) return false; // !talent.cataclysm
        return true;
      }),

      // 13. conflagrate,target_if=max:(dot.immolate.remains-99*debuff.havoc.remains),if=buff.backdraft.stack<2|!talent.backdraft
      spell.cast(S.conflagrate, () => this.getConflagSpreadTarget(), () => {
        return this.getBackdraftStacks() < 2 || !spell.isSpellKnown(A.backdraftTalent);
      }),

      // 14. incinerate filler
      spell.cast(S.incinerate, () => this.getCurrentTarget()),
    );
  }
}
