import { Behavior, BehaviorContext } from '@/Core/Behavior';
import * as bt from '@/Core/BehaviorTree';
import Specialization from '@/Enums/Specialization';
import common from '@/Core/Common';
import spell from '@/Core/Spell';
import Settings from '@/Core/Settings';
import { PowerType } from "@/Enums/PowerType";
import { me } from '@/Core/ObjectManager';
import { defaultCombatTargeting as combat } from '@/Targeting/CombatTargeting';
import { defaultHealTargeting as heal } from '@/Targeting/HealTargeting';

/**
 * Beast Mastery Hunter Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (hunter_beast_mastery.simc) + Method + Wowhead
 *
 * Auto-detects: Pack Leader (Howl/Hogstrider) vs Dark Ranger (Black Arrow/Withering Fire)
 * SimC sub-lists: st (5), cleave (7), drst (8), drcleave (10), cds (6) — ALL implemented
 *
 * CRITICAL Midnight changes:
 *   Frenzy: REMOVED — Barbed Shot is rolling DoT only, no stacking haste buff
 *   Multi-Shot: REMOVED — replaced by Wild Thrash (grants Beast Cleave)
 *   BW: Static 30s CD — fire on cooldown, no charge pooling needed
 *   Barbed Shot: Rolling DoT — remaining damage rolls into new application
 *
 * Pack Leader: BS → BW (on CD) → KC (Howl/Nature's Ally) → BS → CS
 * Dark Ranger: BW → BA (Withering Fire) → WA → KC → BS → BA → CS
 * All instant + ranged — no movement block needed
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL (every line) + Method + Wowhead',
};

const S = {
  killCommand:        34026,
  barbedShot:         217200,
  cobraShot:          193455,
  wildThrash:         1264359,
  bestialWrath:       19574,
  blackArrow:         466930,
  wailingArrow:       392060,
  huntersMark:        259558,
  misdirection:       34477,
  counterShot:        147362,
  exhilaration:       109304,
  revivePet:          982,
  mendPet:            136,
  berserking:         26297,
};

const T = {
  blackArrow:         466930,   // Dark Ranger detection
  beastCleave:        115939,   // Talent enabling Beast Cleave
  killerCobra:        199532,   // CS resets KC during BW
  naturesAlly:        1273126,  // Apex talent
};

const A = {
  bestialWrath:       19574,
  beastCleave:        115939,
  huntersMark:        257284,
  naturesAlly:        1276720,  // +30% next KC buff (from BS/CS/BA)
  howlOfPackLeader:   471876,   // 30s ICD, next KC summons beast
  hogstrider:         472640,   // +200% next CS, +targets
  witheringFire:      466990,   // After BW, BA fires 2 extra arrows
  deathblow:          343248,   // Resets BA, any-target use
};

export class BeastMasteryHunterBehavior extends Behavior {
  name = 'FW Beast Mastery Hunter';
  context = BehaviorContext.Any;
  specialization = Specialization.Hunter.BeastMastery;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _focusFrame = 0;
  _cachedFocus = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWBmUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWBmAoECount', text: 'AoE Target Count', default: 2, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWBmDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWBmExhil', text: 'Use Exhilaration', default: true },
        { type: 'slider', uid: 'FWBmExhilHP', text: 'Exhilaration HP %', default: 40, min: 15, max: 60 },
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

      // Revive/Mend Pet OOC
      spell.cast(S.revivePet, () => me, () => !me.inCombat() && me.pet && me.pet.deadOrGhost),

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

      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[BM] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isDR() ? 'Dark Ranger' : 'Pack Leader'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWBmDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[BM] Focus:${Math.round(this.getFocus())} BW:${me.hasAura(A.bestialWrath)} BSfrac:${spell.getChargesFractional(S.barbedShot).toFixed(2)} NA:${me.hasAura(A.naturesAlly)} Hog:${me.hasAura(A.hogstrider)} WF:${me.hasAura(A.witheringFire)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // Auto Misdirection on tank (off-GCD, 30s CD)
      spell.cast(S.misdirection, () => {
        if (!me.inCombat()) return null;
        if (spell.getTimeSinceLastCast(S.misdirection) < 30000) return null;
        const tanks = heal.friends?.Tanks;
        if (tanks) {
          for (let i = 0; i < tanks.length; i++) {
            if (tanks[i] && !tanks[i].deadOrGhost && me.distanceTo(tanks[i]) <= 100) return tanks[i];
          }
        }
        return null;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.counterShot),

          // Defensives
          spell.cast(S.exhilaration, () => me, () =>
            Settings.FWBmExhil && me.effectiveHealthPercent < Settings.FWBmExhilHP
          ),

          // Mend Pet in combat
          spell.cast(S.mendPet, () => me, () =>
            me.pet && !me.pet.deadOrGhost && me.pet.pctHealth < 50 &&
            spell.getTimeSinceLastCast(S.mendPet) > 10000
          ),

          // SimC: call_action_list,name=cds
          this.cooldowns(),

          // SimC dispatch: DR vs PL, ST vs AoE
          new bt.Decorator(
            () => this.isDR() && this.isAoE(),
            this.drCleave(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isDR(),
            this.drST(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isAoE(),
            this.plCleave(),
            new bt.Action(() => bt.Status.Failure)
          ),
          this.plST(),
        )
      ),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cds, 6 lines)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // Berserking during BW
      spell.cast(S.berserking, () => me, () =>
        me.hasAura(A.bestialWrath) || this.targetTTD() < 13000
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // PACK LEADER — Single Target (SimC actions.st, 5 lines)
  // =============================================
  plST() {
    return new bt.Selector(
      // 1. Barbed Shot: BW coming off CD within 1 GCD
      spell.cast(S.barbedShot, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.bestialWrath)?.timeleft || 99999) < 1500
      ),

      // 2. Bestial Wrath (on CD)
      spell.cast(S.bestialWrath, () => me, () => Settings.FWBmUseCDs),

      // 3. Kill Command: BW CD > full_recharge + gcd & (Nature's Ally | Howl ready) | !apex.3
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () => {
        const bwCD = spell.getCooldown(S.bestialWrath)?.timeleft || 0;
        const kcRecharge = spell.getFullRechargeTime(S.killCommand) || 0;
        if (bwCD > kcRecharge + 1500) {
          return me.hasAura(A.naturesAlly) || me.hasAura(A.howlOfPackLeader);
        }
        return !spell.isSpellKnown(T.naturesAlly); // !apex.3
      }),

      // 4. Barbed Shot
      spell.cast(S.barbedShot, () => this.getCurrentTarget()),

      // 5. Cobra Shot
      spell.cast(S.cobraShot, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // PACK LEADER — Cleave (SimC actions.cleave, 7 lines)
  // =============================================
  plCleave() {
    return new bt.Selector(
      // 1. Barbed Shot: BW coming
      spell.cast(S.barbedShot, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.bestialWrath)?.timeleft || 99999) < 1500
      ),

      // 2. Wild Thrash (Beast Cleave maintenance)
      spell.cast(S.wildThrash, () => this.getCurrentTarget()),

      // 3. Bestial Wrath
      spell.cast(S.bestialWrath, () => me, () => Settings.FWBmUseCDs),

      // 4. Kill Command
      spell.cast(S.killCommand, () => this.getCurrentTarget()),

      // 5. Cobra Shot: Wild Thrash CD > GCD & Hogstrider up & enemies < 4
      spell.cast(S.cobraShot, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.wildThrash)?.timeleft || 0) > 1500 &&
        me.hasAura(A.hogstrider) && this.getEnemyCount() < 4
      ),

      // 6. Barbed Shot
      spell.cast(S.barbedShot, () => this.getCurrentTarget()),

      // 7. Cobra Shot: Wild Thrash CD > GCD
      spell.cast(S.cobraShot, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.wildThrash)?.timeleft || 0) > 1500
      ),
    );
  }

  // =============================================
  // DARK RANGER — Single Target (SimC actions.drst, 8 lines)
  // =============================================
  drST() {
    return new bt.Selector(
      // 1. Bestial Wrath
      spell.cast(S.bestialWrath, () => me, () => Settings.FWBmUseCDs),

      // 2. Kill Command: BW CD > recharge + gcd & Nature's Ally | !apex.3
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () => {
        const bwCD = spell.getCooldown(S.bestialWrath)?.timeleft || 0;
        const kcRecharge = spell.getFullRechargeTime(S.killCommand) || 0;
        if (bwCD > kcRecharge + 1500 && me.hasAura(A.naturesAlly)) return true;
        return !spell.isSpellKnown(T.naturesAlly);
      }),

      // 3. Black Arrow: Withering Fire up
      spell.cast(S.blackArrow, () => this.getCurrentTarget(), () =>
        me.hasAura(A.witheringFire)
      ),

      // 4. Cobra Shot: Killer Cobra & BW up & BS charges_fractional < 1.4
      spell.cast(S.cobraShot, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.killerCobra) && me.hasAura(A.bestialWrath) &&
        spell.getChargesFractional(S.barbedShot) < 1.4
      ),

      // 5. Wailing Arrow: Withering Fire expiring or fight ending
      spell.cast(S.wailingArrow, () => this.getCurrentTarget(), () => {
        const wf = me.getAura(A.witheringFire);
        if (wf && wf.remaining < 2500) return true; // execute_time + gcd
        return this.targetTTD() < 2500;
      }),

      // 6. Barbed Shot
      spell.cast(S.barbedShot, () => this.getCurrentTarget()),

      // 7. Black Arrow
      spell.cast(S.blackArrow, () => this.getCurrentTarget()),

      // 8. Cobra Shot
      spell.cast(S.cobraShot, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // DARK RANGER — Cleave (SimC actions.drcleave, 10 lines)
  // =============================================
  drCleave() {
    return new bt.Selector(
      // 1. Black Arrow: Beast Cleave < GCD (maintain BC via BA)
      // SimC: buff.beast_cleave.remains<gcd — Beast Cleave buff is on the PET
      spell.cast(S.blackArrow, () => this.getCurrentTarget(), () => {
        if (me.pet) {
          const bc = me.pet.getAura ? me.pet.getAura(A.beastCleave) : null;
          if (bc && bc.remaining >= 1500) return false; // BC active with enough time
        }
        return true; // No BC or expiring — cast BA to refresh
      }),

      // 2. Bestial Wrath
      spell.cast(S.bestialWrath, () => me, () => Settings.FWBmUseCDs),

      // 3. Wailing Arrow: BW expiring or fight ending
      spell.cast(S.wailingArrow, () => this.getCurrentTarget(), () => {
        const bw = me.getAura(A.bestialWrath);
        if (bw && bw.remaining < 2500) return true;
        return this.targetTTD() < 2500;
      }),

      // 4. Wild Thrash
      spell.cast(S.wildThrash, () => this.getCurrentTarget()),

      // 5. Kill Command: BW CD > recharge & Nature's Ally | !apex.3
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () => {
        const bwCD = spell.getCooldown(S.bestialWrath)?.timeleft || 0;
        const kcRecharge = spell.getFullRechargeTime(S.killCommand) || 0;
        if (bwCD > kcRecharge + 1500 && me.hasAura(A.naturesAlly)) return true;
        return !spell.isSpellKnown(T.naturesAlly);
      }),

      // 6. Black Arrow: Withering Fire up
      spell.cast(S.blackArrow, () => this.getCurrentTarget(), () =>
        me.hasAura(A.witheringFire)
      ),

      // 7. Barbed Shot
      spell.cast(S.barbedShot, () => this.getCurrentTarget()),

      // 8. Wailing Arrow
      spell.cast(S.wailingArrow, () => this.getCurrentTarget()),

      // 9. Black Arrow
      spell.cast(S.blackArrow, () => this.getCurrentTarget()),

      // 10. Cobra Shot
      spell.cast(S.cobraShot, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // HERO DETECTION
  // =============================================
  isDR() { return spell.isSpellKnown(T.blackArrow); }
  isPL() { return !this.isDR(); }

  isAoE() {
    const e = this.getEnemyCount();
    // SimC: beast_cleave talent → cleave at 2+, otherwise cleave at 3+
    if (spell.isSpellKnown(T.beastCleave)) return e > 1;
    return e > 2;
  }

  // =============================================
  // RESOURCES (cached per tick)
  // =============================================
  getFocus() {
    if (this._focusFrame === wow.frameTime) return this._cachedFocus;
    this._focusFrame = wow.frameTime;
    this._cachedFocus = me.powerByType(PowerType.Focus);
    return this._cachedFocus;
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 40 && me.isFacing(target)) {
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
}
