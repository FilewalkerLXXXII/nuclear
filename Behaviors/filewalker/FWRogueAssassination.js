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
 * Assassination Rogue Behavior - Midnight 12.0.1
 * Line-by-line match to SimC APL (midnight branch):
 *   actions.precombat, actions (default), actions.cds, actions.core_dot,
 *   actions.generate, actions.spend, actions.vanish, actions.misc_cds
 *
 * Auto-detects: Deathstalker (457052) vs Fatebound (452536)
 * Resource: Energy (PowerType 3) + Combo Points (PowerType 4)
 * All melee instant -- no movement block needed
 *
 * Key mechanics:
 *   - Garrote + Rupture DoTs with pandemic + pmultiplier snapshot tracking
 *   - Deathmark -> Kingsbane burst window with Envenom uptime
 *   - Vanish for Improved Garrote snapshot (pmultiplier tracking)
 *   - Darkest Night empowered Envenom at max CP
 *   - Implacable Tracker stack management (<4 -> spend)
 *   - Crimson Tempest for bleed spreading in AoE (active_dot tracking)
 *   - Shiv with Toxic Stiletto + Darkest Night edge case
 *   - Slice and Dice maintenance
 *   - Bloodlust awareness for potion timing
 */

const S = {
  // Builders
  mutilate:           1329,
  ambush:             8676,
  fanOfKnives:        51723,
  // Finishers
  envenom:            32645,
  rupture:            1943,
  crimsonTempest:     1247227,
  // DoTs
  garrote:            703,
  // CDs
  deathmark:          360194,
  kingsbane:          385627,
  shiv:               5938,
  thistleTea:         381623,
  coldBlood:          382245,
  vanish:             1856,
  stealth:            1784,
  sliceAndDice:       315496,
  // Utility
  kick:               1766,
  shadowstep:         36554,
  berserking:         26297,
};

const A = {
  // DoT debuffs (on target)
  garrote:            703,
  rupture:            1943,
  crimsonTempest:     1247227,
  // Buffs (on self)
  envenom:            32645,
  sliceAndDice:       315496,
  stealth:            1784,
  vanishBuff:         11327,
  subterfuge:         115192,
  // Talent buffs
  improvedGarrote:    392401,
  blindside:          121153,
  coldBlood:          382245,
  // Bloodlust
  bloodlust:          2825,
  heroism:            32182,
  timewarp:           80353,
  // Deathstalker hero
  deathstalkersMark:  457129,   // Debuff on target (3 stacks)
  darkestNight:       457058,   // Empowered Envenom buff (Wowhead confirmed)
  clearTheWitnesses:  457178,
  lingeringDarkness:  457273,
  // Fatebound hero
  fateCoinsHeads:     452923,
  fateCoinsTails:     452917,
  // Deathmark debuff on target
  deathmark:          360194,
  // Kingsbane debuff on target
  kingsbane:          385627,
  // Shiv debuff on target
  shiv:               319504,
  // Apex talent
  implacableTracker:  1265385,
  // Hero detection passives
  deathstalkerKnown:  457052,
  fateboundKnown:     452536,
};

// Talent spell IDs for talent checks
const T = {
  improvedGarrote:    392401,
  blindside:          381849,
  razorWire:          1254087,
  crimsonTempest:     121411,
  toxicStiletto:      1267182,
};

export class AssassinationRogueBehavior extends Behavior {
  name = 'FW Assassination Rogue';
  context = BehaviorContext.Any;
  specialization = Specialization.Rogue.Assassination;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _energyFrame = 0;
  _cachedEnergy = 0;
  _cpFrame = 0;
  _cachedCP = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  // pmultiplier tracking: was garrote cast from stealth/improved garrote?
  _lastGarroteFromStealth = false;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWAssaUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWAssaAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWAssaDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isDeathstalker() { return spell.isSpellKnown(A.deathstalkerKnown); }
  isFatebound() { return !this.isDeathstalker(); }

  // =============================================
  // CACHED RESOURCE ACCESSORS
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const t = me.target;
    if (t && common.validTarget(t) && me.distanceTo(t) <= 8 && me.isFacing(t)) {
      this._cachedTarget = t;
      return t;
    }
    if (me.inCombat()) {
      const ct = combat.bestTarget || (combat.targets && combat.targets[0]);
      if (ct && common.validTarget(ct) && me.distanceTo(ct) <= 8 && me.isFacing(ct)) {
        this._cachedTarget = ct;
        return ct;
      }
    }
    this._cachedTarget = null;
    return null;
  }

  getEnergy() {
    if (this._energyFrame === wow.frameTime) return this._cachedEnergy;
    this._energyFrame = wow.frameTime;
    this._cachedEnergy = me.powerByType(PowerType.Energy);
    return this._cachedEnergy;
  }

  getEnergyMax() { return me.maxPowerByType ? me.maxPowerByType(PowerType.Energy) : 100; }
  getEnergyPct() { return (this.getEnergy() / this.getEnergyMax()) * 100; }

  getCP() {
    if (this._cpFrame === wow.frameTime) return this._cachedCP;
    this._cpFrame = wow.frameTime;
    this._cachedCP = me.powerByType(PowerType.ComboPoints);
    return this._cachedCP;
  }

  getCPMax() { return me.maxPowerByType ? me.maxPowerByType(PowerType.ComboPoints) : 5; }
  getCPDeficit() { return this.getCPMax() - this.getCP(); }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemyCount;
    this._enemyFrame = wow.frameTime;
    const t = this.getCurrentTarget();
    this._cachedEnemyCount = t ? t.getUnitsAroundCount(8) + 1 : 1;
    return this._cachedEnemyCount;
  }

  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }

  // =============================================
  // SIMC VARIABLES
  // =============================================
  // variable.single_target = spell_targets.fan_of_knives=1
  isSingleTarget() { return this.getEnemyCount() <= 1; }

  // Stealth check (stealthed.rogue)
  inStealth() {
    return me.hasAura(A.stealth) || me.hasAura(A.vanishBuff) || me.hasAura(A.subterfuge);
  }

  hasDarkestNight() { return me.hasAura(A.darkestNight); }
  hasBlindside() { return me.hasAura(A.blindside); }

  // Implacable Tracker stacks
  getImplacableStacks() {
    const a = me.getAura(A.implacableTracker);
    return a ? a.stacks : 0;
  }

  // pmultiplier tracking: approximation via last garrote cast state
  // pmultiplier<=1 means garrote was NOT cast with Improved Garrote active
  garroteNeedsReapply() {
    return !this._lastGarroteFromStealth;
  }

  // Track garrote casts -- call before garrote cast succeeds
  _updateGarroteSnapshot() {
    this._lastGarroteFromStealth = this.inStealth() || me.hasAura(A.improvedGarrote);
  }

  // Bloodlust check
  hasBloodlust() {
    return me.hasAura(A.bloodlust) || me.hasAura(A.heroism) || me.hasAura(A.timewarp);
  }

  // =============================================
  // BUILD -- Main behavior tree
  // =============================================
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),
      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),
      // Auto-target
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),
      // Null target bail
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      // Version + Debug logging
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[AssaRogue] Midnight 12.0.1 | Hero: ${this.isDeathstalker() ? 'Deathstalker' : 'Fatebound'}`);
        }
        if (Settings.FWAssaDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const t = this.getCurrentTarget();
          const garR = t ? (t.getAuraByMe(A.garrote)?.remaining || 0) : 0;
          const rupR = t ? (t.getAuraByMe(A.rupture)?.remaining || 0) : 0;
          console.info(`[Assa] E:${Math.round(this.getEnergy())} CP:${this.getCP()}/${this.getCPMax()} Gar:${Math.round(garR)} Rup:${Math.round(rupR)} DN:${this.hasDarkestNight()} IT:${this.getImplacableStacks()} PM:${this._lastGarroteFromStealth} Enemies:${this.getEnemyCount()}`);
        }
        // Track pmultiplier: if garrote was recently cast, update snapshot
        if (spell.getTimeSinceLastCast(S.garrote) < 500) {
          this._updateGarroteSnapshot();
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // SimC: actions+=/kick
          spell.interrupt(S.kick),

          // SimC: actions+=/thistle_tea,if=energy.pct<50&fight_remains<10
          spell.cast(S.thistleTea, () => me, () =>
            this.getEnergyPct() < 50 && this.targetTTD() < 10000
          ),

          // SimC: actions+=/call_action_list,name=cds
          this.cooldowns(),

          // SimC: actions+=/call_action_list,name=core_dot
          this.coreDots(),

          // SimC: actions+=/call_action_list,name=generate,if=!buff.darkest_night.up&combo_points<5|buff.darkest_night.up&combo_points.deficit>0|(talent.crimson_tempest&spell_targets.fan_of_knives>=5&(active_dot.garrote<spell_targets|active_dot.rupture<spell_targets))
          new bt.Decorator(
            () => {
              if (!this.hasDarkestNight() && this.getCP() < 5) return true;
              if (this.hasDarkestNight() && this.getCPDeficit() > 0) return true;
              if (spell.isSpellKnown(T.crimsonTempest) && this.getEnemyCount() >= 5) return true;
              return false;
            },
            this.generate(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: actions+=/call_action_list,name=spend,if=!buff.darkest_night.up&combo_points>=5|buff.darkest_night.up&combo_points.deficit=0
          new bt.Decorator(
            () => {
              if (!this.hasDarkestNight() && this.getCP() >= 5) return true;
              if (this.hasDarkestNight() && this.getCPDeficit() === 0) return true;
              return false;
            },
            this.spend(),
            new bt.Action(() => bt.Status.Failure)
          ),
        )
      ),
    );
  }

  // =============================================
  // CDS -- SimC: actions.cds
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // SimC: deathmark,if=dot.garrote.ticking&dot.rupture.ticking&cooldown.kingsbane.remains<=2&buff.envenom.up
      spell.cast(S.deathmark, () => this.getCurrentTarget(), () => {
        if (!Settings.FWAssaUseCDs) return false;
        const t = this.getCurrentTarget();
        if (!t) return false;
        if (this.targetTTD() < 15000) return false;
        const garTicking = t.getAuraByMe(A.garrote) !== undefined;
        const rupTicking = t.getAuraByMe(A.rupture) !== undefined;
        const kbCD = spell.getCooldown(S.kingsbane)?.timeleft || 0;
        const kbReady = kbCD <= 2000 || !spell.isSpellKnown(S.kingsbane);
        const envUp = me.hasAura(A.envenom);
        return garTicking && rupTicking && kbReady && envUp;
      }),

      // SimC: misc_cds -- potion,if=buff.bloodlust.react|fight_remains<30|debuff.deathmark.up
      // (potion handled externally, but we check bloodlust for other sync)

      // SimC: misc_cds -- berserking,if=debuff.deathmark.up (use_off_gcd=1)
      spell.cast(S.berserking, () => me, () => {
        const t = this.getCurrentTarget();
        return t && t.getAuraByMe(A.deathmark) !== undefined;
      }),

      // SimC: kingsbane,if=dot.garrote.ticking&dot.rupture.ticking&(dot.deathmark.ticking|cooldown.deathmark.remains>52)
      spell.cast(S.kingsbane, () => this.getCurrentTarget(), () => {
        if (!Settings.FWAssaUseCDs) return false;
        const t = this.getCurrentTarget();
        if (!t) return false;
        const garTicking = t.getAuraByMe(A.garrote) !== undefined;
        const rupTicking = t.getAuraByMe(A.rupture) !== undefined;
        const dmTicking = t.getAuraByMe(A.deathmark) !== undefined;
        const dmCD = spell.getCooldown(S.deathmark)?.timeleft || 0;
        return garTicking && rupTicking && (dmTicking || dmCD > 52000);
      }),

      // SimC: vanish conditions (only when !stealthed.rogue)
      new bt.Decorator(
        () => !this.inStealth() && Settings.FWAssaUseCDs,
        this.vanishActions(),
        new bt.Action(() => bt.Status.Failure)
      ),
    );
  }

  // =============================================
  // VANISH -- SimC: actions.vanish (2 lines)
  // =============================================
  vanishActions() {
    return new bt.Selector(
      // SimC: vanish,if=variable.single_target&talent.improved_garrote&dot.garrote.pmultiplier<=1&!cooldown.deathmark.ready
      spell.cast(S.vanish, () => me, () => {
        if (!spell.isSpellKnown(T.improvedGarrote)) return false;
        if (!this.isSingleTarget()) return false;
        const t = this.getCurrentTarget();
        if (!t) return false;
        // pmultiplier<=1: garrote was not cast with Improved Garrote
        if (!this.garroteNeedsReapply()) return false;
        const dmReady = spell.getCooldown(S.deathmark)?.ready || false;
        return !dmReady;
      }),

      // SimC: vanish,if=!variable.single_target&talent.improved_garrote&dot.garrote.pmultiplier<=1
      spell.cast(S.vanish, () => me, () => {
        if (!spell.isSpellKnown(T.improvedGarrote)) return false;
        if (this.isSingleTarget()) return false;
        // pmultiplier<=1: garrote was not cast with Improved Garrote
        return this.garroteNeedsReapply();
      }),
    );
  }

  // =============================================
  // CORE DOTS -- SimC: actions.core_dot (3 lines)
  // =============================================
  coreDots() {
    return new bt.Selector(
      // Maintain Slice and Dice (not in SimC APL explicitly but required for the framework)
      spell.cast(S.sliceAndDice, () => me, () => {
        if (this.getCP() < 1) return false;
        const snd = me.getAura(A.sliceAndDice);
        if (!snd) return true;
        // Refresh at pandemic (30% of duration at 5CP = 36s, pandemic = 10.8s)
        return snd.remaining < 10800;
      }),

      // SimC: garrote,if=(buff.improved_garrote.up|stealthed.rogue)&(pmultiplier<=1|remains<=14+6*talent.razor_wire+4*!variable.single_target)
      spell.cast(S.garrote, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        if (this.targetTTD() < 12000) return false;
        const hasImpGar = me.hasAura(A.improvedGarrote) || this.inStealth();
        if (!hasImpGar) return false;
        const gar = t.getAuraByMe(A.garrote);
        if (!gar) return true;
        const razorWire = spell.isSpellKnown(T.razorWire) ? 1 : 0;
        const stMult = this.isSingleTarget() ? 0 : 1;
        // pmultiplier<=1 OR remains<=threshold
        if (this.garroteNeedsReapply()) return true;
        const threshold = 14000 + 6000 * razorWire + 4000 * stMult;
        return gar.remaining <= threshold;
      }),

      // SimC: garrote,if=combo_points.deficit>=1&(pmultiplier<=1|!variable.single_target)&refreshable&target.time_to_die-remains>12
      // Garrote base duration 18s, pandemic = 30% = 5.4s
      spell.cast(S.garrote, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        if (this.getCPDeficit() < 1) return false;
        // pmultiplier<=1 OR not single target
        if (!this.garroteNeedsReapply() && this.isSingleTarget()) return false;
        const gar = t.getAuraByMe(A.garrote);
        if (!gar) return this.targetTTD() > 12000;
        if (gar.remaining > 5400) return false; // Not refreshable (pandemic: 30% of 18s)
        const tRemains = gar.remaining || 0;
        return (this.targetTTD() - tRemains) > 12000;
      }),

      // SimC: rupture,if=combo_points>=5&refreshable&target.time_to_die-remains>12&(!buff.darkest_night.up|!dot.rupture.ticking)
      // Rupture at 5CP: base 24s, pandemic = 30% = 7.2s
      spell.cast(S.rupture, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        if (this.getCP() < 5) return false;
        const rup = t.getAuraByMe(A.rupture);
        // !buff.darkest_night.up|!dot.rupture.ticking
        if (this.hasDarkestNight() && rup && rup.remaining > 0) return false;
        if (rup && rup.remaining > 7200) return false; // Not refreshable
        const tRemains = rup ? rup.remaining : 0;
        return (this.targetTTD() - tRemains) > 12000;
      }),
    );
  }

  // =============================================
  // GENERATE -- SimC: actions.generate (5 lines)
  // =============================================
  generate() {
    return new bt.Selector(
      // SimC: crimson_tempest,if=!variable.single_target&(active_dot.garrote<spell_targets|active_dot.rupture<spell_targets)
      spell.cast(S.crimsonTempest, () => this.getCurrentTarget(), () => {
        if (this.isSingleTarget()) return false;
        if (!spell.isSpellKnown(T.crimsonTempest)) return false;
        // active_dot tracking: approximate -- if enemies > 1 and we have CT talent, use it for bleed spreading
        return this.getEnemyCount() >= 2;
      }),

      // SimC: shiv,if=buff.darkest_night.up&combo_points.deficit=1&spell_targets<=3&talent.toxic_stiletto
      spell.cast(S.shiv, () => this.getCurrentTarget(), () => {
        if (!this.hasDarkestNight()) return false;
        if (this.getCPDeficit() !== 1) return false;
        if (this.getEnemyCount() > 3) return false;
        return spell.isSpellKnown(T.toxicStiletto);
      }),

      // SimC: ambush,if=spell_targets<=1+talent.blindside
      spell.cast(S.ambush, () => this.getCurrentTarget(), () => {
        if (!this.hasBlindside() && !this.inStealth()) return false;
        const threshold = 1 + (spell.isSpellKnown(T.blindside) ? 1 : 0);
        return this.getEnemyCount() <= threshold;
      }),

      // SimC: mutilate,if=spell_targets<=1+talent.blindside
      spell.cast(S.mutilate, () => this.getCurrentTarget(), () => {
        const threshold = 1 + (spell.isSpellKnown(T.blindside) ? 1 : 0);
        return this.getEnemyCount() <= threshold;
      }),

      // SimC: fan_of_knives,if=spell_targets>1+talent.blindside
      spell.cast(S.fanOfKnives, () => this.getCurrentTarget(), () => {
        const threshold = 1 + (spell.isSpellKnown(T.blindside) ? 1 : 0);
        return this.getEnemyCount() > threshold;
      }),
    );
  }

  // =============================================
  // SPEND -- SimC: actions.spend (2 lines)
  // =============================================
  spend() {
    return new bt.Selector(
      // SimC: envenom,if=buff.implacable_tracker.stack<4
      spell.cast(S.envenom, () => this.getCurrentTarget(), () => {
        return this.getImplacableStacks() < 4;
      }),

      // SimC: envenom,if=energy.pct>70
      spell.cast(S.envenom, () => this.getCurrentTarget(), () => {
        return this.getEnergyPct() > 70;
      }),
    );
  }
}
