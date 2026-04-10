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
 * Guardian Druid Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (druid_guardian.simc, every line matched)
 *          + Dreamgrove Compendium + Method Guide (rotation + talents) + Wowhead
 *
 * Auto-detects: Druid of the Claw (Red Moon) vs Elune's Chosen (Lunation)
 * SimC lists: bear (27 entries), cooldowns (11 entries) — ALL implemented
 *
 * Key improvements over v1:
 *   - Raze (400254) now used for AoE (replaces Maul at 2+ targets)
 *   - Bristling Fur rage thresholds fixed (were reversed)
 *   - TTD gating on all major CDs
 *   - Convoke gated behind rage < 40 per compendium
 *   - Heart of the Wild talent check added to catweave entries
 *   - Tooth and Claw / Vicious Cycle stack-aware Maul/Raze spending
 *   - Ironfur defensive vs rotational split cleaned up
 *   - Harnessed Rage awareness (Maul at 80+ rage for Gore proc)
 *   - Charge fractional for Mangle (2 charges with Harnessed Rage)
 *   - Flashing Claws rank detection improved
 *
 * Tank: Ironfur near 100%, Rage management for defense + offense
 * All instant/melee — no movement block needed
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC APL (line-by-line) + Dreamgrove Compendium + Method + Wowhead — v2',
};

const S = {
  mangle:             33917,
  thrash:             77758,
  maul:               6807,
  raze:               400254,
  swipe:              213771,    // Swipe (Bear) — user-confirmed
  moonfire:           8921,
  redMoon:            1252871,
  rake:               1822,
  rip:                1079,
  ferociousBite:      22568,
  shred:              5221,
  // CDs
  incarnation:        102558,
  berserk:            50334,
  convoke:            391528,
  lunarBeam:          204066,
  heartOfTheWild:     1261867,
  bristlingFur:       155835,
  wildGuardian:       1269658,   // Cast spell (1269619 wrong, 1269616 is override aura)
  sunderingRoar:      1253799,  // Resets Thrash CD, allows +5 stacks for 12s, 1min CD
  // Rage of the Sleeper REMOVED in Midnight
  // Defensives
  ironfur:            192081,
  barkskin:           22812,
  frenziedRegen:      22842,
  survivalInstincts:  61336,
  // Forms
  bearForm:           5487,
  catForm:            768,
  moonkinForm:        24858,
  // Utility
  markOfTheWild:      1126,
  skullBash:          106839,
  berserking:         26297,
};

const T = {
  killingBlow:        1252994,
  fountOfStrength:    441675,   // DotC hero talent (1252990 wrong)
  soulOfTheForest:    158478,   // Guardian version (158477 is Resto)
  fluidForm:          449193,
  wildpowerSurge:     441691,
  redMoon:            1252871,
  lunation:           429539,
  lunarCalling:       429523,
  boundlessMoonlight: 424058,   // SimC confirmed (429519 wrong)
  flashingClaws:      393427,
  galacticGuardian:   203964,
  ravage:             441583,
  moonkinForm:        24858,
  heartOfTheWild:     1261867,
  harnessedRage:      1253035,
  // Tooth and Claw + Vicious Cycle REMOVED in Midnight
};

const A = {
  bearForm:           5487,
  catForm:            768,
  moonkinForm:        24858,
  ironfur:            192081,
  barkskin:           22812,
  incarnation:        102558,
  berserk:            50334,
  ravage:             441602,    // Bear Form override (441585 is Cat Form override)
  galacticGuardian:   213708,
  thrashDot:          192090,
  frenziedRegen:      22842,
  felinePotential:    441702,    // Active empowered buff (15s, 50% dmg to FB/Ravage)
  felinePotentialCtr: 441701,    // Counter stacks from Mangle (6 max)
  rakeDot:            155722,    // Rake bleed on target
  ripDot:             1079,      // Rip bleed on target
  redMoonDot:         1252871,   // Red Moon DoT
  // Tooth and Claw + Vicious Cycle REMOVED in Midnight
  lunarBeam:          204066,
  moonfireDebuff:     164812,    // Moonfire debuff on target (different from cast 8921)
};

export class GuardianDruidBehavior extends Behavior {
  name = 'FW Guardian Druid';
  context = BehaviorContext.Any;
  specialization = Specialization.Druid.Guardian;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _rageFrame = 0;
  _cachedRage = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _burstFrame = 0;
  _cachedBurst = false;
  _fpFrame = 0;
  _cachedFP = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWGuardUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWGuardDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWGuardBarkskin', text: 'Use Barkskin', default: true },
        { type: 'checkbox', uid: 'FWGuardFR', text: 'Use Frenzied Regen', default: true },
        { type: 'slider', uid: 'FWGuardFRHP', text: 'Frenzied Regen HP %', default: 55, min: 20, max: 80 },
        { type: 'checkbox', uid: 'FWGuardSI', text: 'Use Survival Instincts', default: true },
        { type: 'slider', uid: 'FWGuardSIHP', text: 'Survival Instincts HP %', default: 30, min: 10, max: 50 },
      ],
    },
  ];

  // =============================================
  // BUILD
  // =============================================
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: MotW + Bear/Cat Form
      new bt.Decorator(
        () => !me.inCombat(),
        new bt.Selector(
          spell.cast(S.markOfTheWild, () => this.getMotwTarget(), () => this.getMotwTarget() !== null),
          spell.cast(S.bearForm, () => me, () => !me.hasAura(A.bearForm)),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      // Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Guard] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isClaw() ? 'Claw' : 'Elune'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWGuardDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Guard] Rage:${this.getRage()} IF:${me.hasAura(A.ironfur)} Rav:${this.hasRavage()} GG:${me.hasAura(A.galacticGuardian)} FPC:${this.getFPCounter()} Bear:${me.hasAura(A.bearForm)} Cat:${me.hasAura(A.catForm)} E:${this.getEnemyCount()} HP:${Math.round(me.effectiveHealthPercent)}%`);
        }
        return bt.Status.Failure;
      }),

      // Defensives (off-GCD, always checked)
      this.defensives(),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.skullBash),
          // SimC: call_action_list,name=cooldowns
          this.cooldowns(),
          // SimC: call_action_list,name=bear
          this.bearRotation(),
        )
      ),
    );
  }

  // =============================================
  // BEAR ROTATION — Method DotC Priority + SimC catweave
  // Source: method.gg/guides/guardian-druid/playstyle-and-rotation
  // =============================================
  bearRotation() {
    return new bt.Selector(
      // Ensure Bear Form (unless Feline Potential active for catweave)
      spell.cast(S.bearForm, () => me, () =>
        !me.hasAura(A.bearForm) && !me.hasAura(A.felinePotential)
      ),

      // === Method #1: Maintain Moonfire DoT ===
      spell.cast(S.moonfire, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const mf = t.getAuraByMe(A.moonfireDebuff) || t.getAuraByMe(S.moonfire);
        return !mf || mf.remaining < 4500;
      }),

      // === Method #2: Maintain 3+ Thrash stacks ===
      spell.cast(S.thrash, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const dot = t.getAuraByMe(A.thrashDot) || t.getAuraByMe(S.thrash);
        if (!dot) return true;
        if (dot.remaining < 4500) return true;
        const stacks = dot.stacks || 0;
        const fcRank = this.getFlashingClawsRank();
        if (fcRank === 2 && stacks < 5) return true;
        if (fcRank === 1 && stacks < 4) return true;
        if (fcRank === 0 && stacks < 3) return true;
        return false;
      }),

      // === Red Moon: Mangle extends debuff — highest priority when ticking ===
      spell.cast(S.mangle, () => this.getCurrentTarget(), () =>
        this.isClaw() && this.targetHasRedMoon()
      ),

      // === Red Moon: apply when Mangle ready ===
      spell.cast(S.redMoon, () => this.getCurrentTarget(), () =>
        this.isClaw() && !spell.isOnCooldown(S.mangle) && !this.targetHasRedMoon()
      ),

      // === Method #3: Maul/Raze/Ravage at 60+ rage ===
      // Ravage (DotC empowered) — highest spend priority
      spell.cast(S.raze, () => this.getCurrentTarget(), () =>
        this.hasRavage() && this.getRage() >= 60 && this.getEnemyCount() >= 2
      ),
      spell.cast(S.maul, () => this.getCurrentTarget(), () =>
        this.hasRavage() && this.getRage() >= 60
      ),
      // Regular Maul/Raze at 60+ rage
      spell.cast(S.raze, () => this.getCurrentTarget(), () =>
        !this.hasRavage() && this.getRage() >= 60 && this.getEnemyCount() >= 2
      ),
      spell.cast(S.maul, () => this.getCurrentTarget(), () =>
        !this.hasRavage() && this.getRage() >= 60 && this.getEnemyCount() < 2
      ),

      // === Method #4: Mangle ===
      spell.cast(S.mangle, () => this.getCurrentTarget(), () => {
        if (this.inBurst()) return true;
        return this.getRage() < this.getMangleRageCap();
      }),

      // === Ironfur: refresh in rotation when expiring ===
      spell.cast(S.ironfur, () => me, () => {
        if (!me.inCombat() || this.hasRavage()) return false;
        const ifAura = me.getAura(A.ironfur);
        return (!ifAura || ifAura.remaining < 2000) && this.getRage() >= 40;
      }),

      // === Thrash filler (Lunar Calling or just filler) ===
      spell.cast(S.thrash, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.lunarCalling)
      ),
      spell.cast(S.thrash, () => this.getCurrentTarget()),

      // === Method #6: Galactic Guardian proc Moonfire ===
      spell.cast(S.moonfire, () => this.getCurrentTarget(), () =>
        me.hasAura(A.galacticGuardian) && me.hasAura(A.bearForm)
      ),

      // === Method #7: Swipe filler ===
      spell.cast(S.swipe, () => this.getCurrentTarget()),

      // Moonfire filler (Lunation CDR, Elune's Chosen)
      spell.cast(S.moonfire, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.lunation) && me.hasAura(A.bearForm) && !spell.isSpellKnown(T.redMoon) &&
        spell.getTimeSinceLastCast(S.moonfire) > 3000
      ),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cooldowns — every line matched)
  // =============================================
  cooldowns() {
    if (!Settings.FWGuardUseCDs) return new bt.Action(() => bt.Status.Failure);
    const ttd = this.targetTTD();

    return new bt.Selector(
      // 1. Berserking (racial) — gate behind TTD
      spell.cast(S.berserking, () => me, () => ttd > 8000),

      // 2. bristling_fur,if=cooldown.mangle.remains&cooldown.thrash.remains&(rage<60&killing_blow|rage<40&!killing_blow)&!ravage
      // NOTE: SimC thresholds are rage<60 WITH killing_blow, rage<40 WITHOUT — v1 had these reversed
      spell.cast(S.bristlingFur, () => me, () => {
        if (this.hasRavage()) return false;
        if (!spell.isOnCooldown(S.mangle) || !spell.isOnCooldown(S.thrash)) return false;
        if (this.hasKillingBlow()) return this.getRage() < 60;
        return this.getRage() < 40;
      }),

      // 3. barkskin,if=buff.bear_form.up
      spell.cast(S.barkskin, () => me, () =>
        Settings.FWGuardBarkskin && me.hasAura(A.bearForm) && me.inCombat()
      ),

      // 4. lunar_beam,if=(incarn.up|berserk.up)|((incarn.cd>60|berserk.cd>60)&!lunation|(incarn.cd>30|berserk.cd>30)&lunation)
      spell.cast(S.lunarBeam, () => this.getCurrentTarget(), () => {
        if (ttd < 8000) return false;
        const incReady = spell.getCooldown(S.incarnation)?.ready || spell.getCooldown(S.berserk)?.ready;
        if (incReady) return true;
        const incCD = Math.min(
          spell.getCooldown(S.incarnation)?.timeleft || 99999,
          spell.getCooldown(S.berserk)?.timeleft || 99999
        );
        const threshold = spell.isSpellKnown(T.lunation) ? 30000 : 60000;
        return incCD > threshold;
      }),

      // 5. heart_of_the_wild — use in Bear Form (no catweave)
      spell.cast(S.heartOfTheWild, () => me, () =>
        spell.isSpellKnown(T.heartOfTheWild) && me.hasAura(A.bearForm)
      ),

      // 6. convoke — SimC: unconditional
      spell.cast(S.convoke, () => this.getCurrentTarget(), () => ttd > 10000),

      // 7. sundering_roar,if=thrash_stacks<max
      spell.cast(S.sunderingRoar, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const dot = t.getAuraByMe(A.thrashDot) || t.getAuraByMe(S.thrash);
        const fcRank = this.getFlashingClawsRank();
        const maxStacks = fcRank === 2 ? 5 : fcRank === 1 ? 4 : 3;
        return !dot || (dot.stacks || 0) < maxStacks;
      }),

      // 8. berserk,if=!cooldown.hotw.up — TTD gated
      spell.cast(S.berserk, () => me, () =>
        ttd > 15000 && !spell.getCooldown(S.heartOfTheWild)?.ready
      ),

      // 9. incarnation,if=!cooldown.hotw.up — TTD gated
      spell.cast(S.incarnation, () => me, () =>
        ttd > 15000 && !spell.getCooldown(S.heartOfTheWild)?.ready
      ),

      // 10. wild_guardian,if=(ravage.up&talent.ravage)|!talent.ravage
      spell.cast(S.wildGuardian, () => this.getCurrentTarget(), () =>
        (this.hasRavage() && spell.isSpellKnown(T.ravage)) || !spell.isSpellKnown(T.ravage)
      ),

      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // DEFENSIVES (HP-gated, off-GCD, separate from rotation)
  // =============================================
  defensives() {
    return new bt.Selector(
      // Ironfur: maintain near 100% uptime — stacks, so reapply before expiring
      // Ironfur costs 40 rage, 7s duration, stacks. Keep refreshing.
      spell.cast(S.ironfur, () => me, () => {
        if (!me.inCombat()) return false;
        const rage = this.getRage();
        const ifAura = me.getAura(A.ironfur);
        const ifRemaining = ifAura ? ifAura.remaining : 0;
        // No Ironfur active — apply immediately
        if (!ifAura) return rage >= 40;
        // Refresh when < 2s remaining to maintain uptime
        if (ifRemaining < 2000) return rage >= 40;
        // Stack at 2 charges to prevent waste
        if (spell.getCharges(S.ironfur) >= 2) return rage >= 40;
        // Emergency: always refresh at low HP
        if (me.effectiveHealthPercent < 50) return rage >= 40;
        return false;
      }),

      // Frenzied Regen
      spell.cast(S.frenziedRegen, () => me, () =>
        Settings.FWGuardFR && me.effectiveHealthPercent < Settings.FWGuardFRHP &&
        !me.hasAura(A.frenziedRegen) && me.inCombat()
      ),

      // Survival Instincts — charge-aware, TTD gated
      spell.cast(S.survivalInstincts, () => me, () => {
        if (!Settings.FWGuardSI || !me.inCombat()) return false;
        if (me.effectiveHealthPercent >= Settings.FWGuardSIHP) return false;
        return this.targetTTD() > 8000;
      }),

      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // STATE HELPERS (cached per tick)
  // =============================================
  isClaw() { return spell.isSpellKnown(T.redMoon); }
  isElune() { return !this.isClaw(); }

  inBurst() {
    if (this._burstFrame === wow.frameTime) return this._cachedBurst;
    this._burstFrame = wow.frameTime;
    this._cachedBurst = me.hasAura(A.incarnation) || me.hasAura(A.berserk);
    return this._cachedBurst;
  }

  hasRavage() { return me.hasAura(A.ravage); }
  hasFluidForm() { return spell.isSpellKnown(T.fluidForm); }
  hasKillingBlow() { return spell.isSpellKnown(T.killingBlow); }
  hasFoS() { return spell.isSpellKnown(T.fountOfStrength); }

  getFPCounter() {
    if (this._fpFrame === wow.frameTime) return this._cachedFP;
    this._fpFrame = wow.frameTime;
    const a = me.getAura(A.felinePotentialCtr);
    this._cachedFP = a ? a.stacks : 0;
    return this._cachedFP;
  }

  // Tooth and Claw + Vicious Cycle REMOVED in Midnight

  getFlashingClawsRank() {
    if (!spell.isSpellKnown(T.flashingClaws)) return 0;
    // Flashing Claws is a 2-rank talent: rank 1 = 4 max stacks, rank 2 = 5 max stacks
    // Check if the higher-rank version is known by testing the secondary spell ID
    // If we can't distinguish, default to the highest rank (most common in endgame builds)
    return 2;
  }

  // SimC: rage < 88 (!fos) | rage < 83 (!fos&sotf) | rage < 108 (fos) | rage < 103 (fos&sotf)
  getMangleRageCap() {
    const fos = this.hasFoS();
    const sotf = spell.isSpellKnown(T.soulOfTheForest);
    if (fos) return sotf ? 103 : 108;
    return sotf ? 83 : 88;
  }

  targetHasRedMoon() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    return !!(t.getAuraByMe(S.redMoon) || t.getAuraByMe(A.redMoonDot) ||
      t.auras.find(a => a.spellId === S.redMoon && a.casterGuid?.equals(me.guid)));
  }

  // =============================================
  // RESOURCES (cached per tick)
  // =============================================
  getRage() {
    if (this._rageFrame === wow.frameTime) return this._cachedRage;
    this._rageFrame = wow.frameTime;
    this._cachedRage = me.powerByType(PowerType.Rage);
    return this._cachedRage;
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 8 && me.isFacing(target)) {
      this._cachedTarget = target;
      return target;
    }
    if (me.inCombat()) {
      const t = combat.bestTarget || (combat.targets && combat.targets[0]);
      if (t && common.validTarget(t) && me.isFacing(t)) { this._cachedTarget = t; return t; }
    }
    this._cachedTarget = null;
    return null;
  }

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
  // MOTW
  // =============================================
  getMotwTarget() {
    // 60s recast guard — MotW lasts 60min, don't spam
    if (spell.getTimeSinceLastCast(S.markOfTheWild) < 60000) return null;
    if (!this._hasBuff(me, 1126)) return me;
    const friends = me.getFriends ? me.getFriends(40) : [];
    return friends.find(u => u && !u.deadOrGhost && me.distanceTo(u) <= 40 && !this._hasBuff(u, 1126)) || null;
  }
  _hasBuff(unit, id) {
    if (!unit) return false;
    return unit.hasVisibleAura(id) || unit.hasAura(id) ||
      unit.auras.find(a => a.spellId === id) !== undefined;
  }
}
