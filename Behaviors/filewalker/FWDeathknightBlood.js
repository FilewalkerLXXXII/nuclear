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
 * Blood Death Knight Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (deathknight_blood.simc) + Method (all pages) + Wowhead + Maxroll
 *
 * Auto-detects: Deathbringer (Reaper's Mark) vs San'layn (Vampiric Strike)
 * Dispatches to: deathbringerRotation / sanGiftRotation / sanlaynRotation
 *
 * SimC action lists matched line-by-line:
 *   high_prio_actions (3 lines): Raise Dead, DS Coagulopathy, DRW gating
 *   deathbringer (12 lines): RM burst, Exterminate Marrowrend, DS RP dump, BS maintenance
 *   san_gift (9 lines): DRW window — Essence stacking, aggressive DS, Boiling Point
 *   sanlayn (14 lines): Outside DRW — BS maintenance, VS proc, Essence refresh
 *
 * Tank spec: defensives are CORE rotation (proactive, not emergency-only)
 * Resource: Runes (PowerType 5) + Runic Power (PowerType 6)
 * All melee instant — no movement block needed
 *
 * Consumption uses empower system (empower_to=1 always)
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL + Method + Wowhead + Maxroll',
};

const S = {
  // Core rotational
  heartStrike:        206930,
  marrowrend:         195182,
  deathStrike:        49998,
  bloodBoil:          50842,
  deathAndDecay:      43265,
  deathsCaress:       195292,
  consumption:        1263824,  // Midnight empowered ability
  // Defensive CDs
  dancingRuneWeapon:  49028,
  vampiricBlood:      55233,
  iceboundFortitude:  48792,
  antiMagicShell:     48707,
  antiMagicZone:      51052,
  runeTap:            194679,
  bonestorm:          194844,
  tombstone:          219809,
  bloodTap:           221699,
  // Utility
  mindFreeze:         47528,
  raiseDead:          46585,
  deathGrip:          49576,
  blooddrinker:       206931,
  // Deathbringer
  reapersMarkCast:    439843,
  // San'layn — Vampiric Strike replaces HS on proc
  vampiricStrike:     433895,
  // Racials
  berserking:         26297,
};

const A = {
  // Core buffs
  dancingRuneWeapon:  81256,
  boneShield:         195181,
  crimsonScourge:     81136,
  coagulopathy:       391481,
  boilingPoint:       1265790,
  boilingPointEcho:   1265968,
  icyTalons:          194879,
  vampiricBlood:      55233,
  deathAndDecay:      188290,   // Buff while standing in DnD
  // Debuffs
  bloodPlague:        55078,
  reapersMarkDebuff:  434765,
  // Deathbringer
  exterminate:        441378,
  // San'layn
  vampiricStrikeProc: 433899,   // VS proc — needs remaining>0 check (433899/433901 are both passives at 0ms)
  giftOfSanlayn:      434152,   // Active during DRW (San'layn)
  essenceBloodQueen:  433925,   // +1% Haste/stack, max 5-7, 20s
  inflictionOfSorrow: 434144,   // VS on BP target buff
  // Hero detection
  reapersMarkKnown:   439843,
};

export class BloodDeathknightBehavior extends Behavior {
  name = 'FW Blood Death Knight';
  context = BehaviorContext.Any;
  specialization = Specialization.DeathKnight.Blood;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _rpFrame = 0;
  _cachedRP = 0;
  _runeFrame = 0;
  _cachedRunes = 0;
  _bsFrame = 0;
  _cachedBS = null; // {stacks, remaining}
  _enemyFrame = 0;
  _cachedEnemyCount = 0;

  // Empower state (Consumption)
  _desiredEmpowerLevel = undefined;

  // State
  _versionLogged = false;
  _lastDebug = 0;
  _combatStartTime = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWBdkUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWBdkDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWBdkVB', text: 'Auto Vampiric Blood', default: true },
        { type: 'checkbox', uid: 'FWBdkIBF', text: 'Use Icebound Fortitude', default: true },
        { type: 'slider', uid: 'FWBdkIBFHP', text: 'IBF HP %', default: 40, min: 15, max: 60 },
        { type: 'checkbox', uid: 'FWBdkAMS', text: 'Use Anti-Magic Shell', default: true },
        { type: 'slider', uid: 'FWBdkAMSHP', text: 'AMS HP %', default: 70, min: 30, max: 90 },
        { type: 'slider', uid: 'FWBdkRuneTapHP', text: 'Rune Tap HP %', default: 65, min: 30, max: 80 },
      ],
    },
  ];

  // =============================================
  // BUILD — Main behavior tree
  // =============================================
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // Combat check
      new bt.Action(() => {
        if (me.inCombat()) {
          if (this._combatStartTime === 0) this._combatStartTime = wow.frameTime;
          return bt.Status.Failure;
        }
        this._combatStartTime = 0;
        return bt.Status.Success;
      }),

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

      // Handle empowered Consumption release (BEFORE waitForCastOrChannel)
      this.handleEmpoweredSpell(),
      common.waitForCastOrChannel(),

      // Version + Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[BloodDK] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | Hero: ${this.isDeathbringer() ? 'Deathbringer' : "San'layn"} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWBdkDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const bs = this.getBSData();
          console.info(`[BloodDK] HP:${Math.round(me.effectiveHealthPercent)}% RP:${Math.round(this.getRP())} Runes:${this.getRunes()} BS:${bs.stacks}/${Math.round(bs.remaining)}ms DRW:${this.inDRW()} Ext:${me.hasAura(A.exterminate)} Ess:${this.getEssenceStacks()} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.mindFreeze),

          // SimC root: Raise Dead (off-GCD)
          spell.cast(S.raiseDead, () => me),

          // SimC root: berserking,if=cooldown.drw.remains>78|fight_remains<=15
          spell.cast(S.berserking, () => me, () =>
            (spell.getCooldown(S.dancingRuneWeapon)?.timeleft || 0) > 78000 ||
            this.targetTTD() <= 15000
          ),

          // SimC root: vampiric_blood,if=!buff.vampiric_blood.up
          spell.cast(S.vampiricBlood, () => me, () =>
            Settings.FWBdkVB && !me.hasAura(A.vampiricBlood)
          ),

          // Defensives (HP-gated — IBF, AMS, Rune Tap)
          this.defensives(),

          // SimC: call_action_list,name=high_prio_actions
          this.highPriorityActions(),

          // Trinkets: align with DRW (SimC: DRW CD > 78s or fight ending)
          common.useTrinkets(() => this.getCurrentTarget(), () =>
            (spell.getCooldown(S.dancingRuneWeapon)?.timeleft || 0) > 78000 ||
            this.targetTTD() <= 15000
          ),

          // SimC dispatch: Deathbringer → San Gift → San'layn
          // ALL branches gated to prevent hero tree fallthrough
          new bt.Decorator(
            () => this.isDeathbringer(),
            this.deathbringerRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isSanlayn() && me.hasAura(A.giftOfSanlayn),
            this.sanGiftRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isSanlayn(),
            this.sanlaynRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),
        )
      )
    );
  }

  // =============================================
  // HIGH PRIORITY ACTIONS
  // SimC: actions.high_prio_actions (3 lines)
  // =============================================
  highPriorityActions() {
    return new bt.Selector(
      // 1. Death Strike if Coagulopathy about to expire
      // SimC: death_strike,if=buff.coagulopathy.up&buff.coagulopathy.remains<=gcd
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () => {
        const coag = me.getAura(A.coagulopathy);
        return coag && coag.remaining > 0 && coag.remaining <= 1500 && this.getRP() >= 40;
      }),

      // 2. Dancing Rune Weapon: !exterminate & !reapers_mark_debuff & !DRW & (fight>95|fight<25|time>300)
      // SimC: dancing_rune_weapon,if=!buff.exterminate.up&!debuff.reapers_mark_debuff.up&!buff.dancing_rune_weapon.up&(fight_remains>95|fight_remains<25|time>300)
      spell.cast(S.dancingRuneWeapon, () => me, () => {
        if (this.inDRW()) return false;
        // Deathbringer: don't overlap with Exterminate or Reaper's Mark
        if (this.isDeathbringer()) {
          if (me.hasAura(A.exterminate)) return false;
          const t = this.getCurrentTarget();
          if (t && t.getAuraByMe(A.reapersMarkDebuff)) return false;
        }
        // Tank CD — always use on CD in dungeons (no useCDs gate)
        return true;
      }),
    );
  }

  // =============================================
  // DEATHBRINGER ROTATION
  // SimC: actions.deathbringer (12 lines)
  // =============================================
  deathbringerRotation() {
    return new bt.Selector(
      // 1. Death Strike: RP deficit < 20 | (deficit < 26 & DRW)
      // SimC: death_strike,if=(runic_power.deficit<20|(runic_power.deficit<26&buff.dancing_rune_weapon.up))
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () => {
        const deficit = this.getRPDeficit();
        return deficit < 20 || (deficit < 26 && this.inDRW());
      }),

      // 2. Death and Decay: !buff.death_and_decay.up
      spell.cast(S.deathAndDecay, () => this.getCurrentTarget(), () =>
        !this.isDnDActive()
      ),

      // 3. Reaper's Mark (on CD)
      // SimC: reapers_mark (no condition)
      spell.cast(S.reapersMarkCast, () => this.getCurrentTarget()),

      // 4. Marrowrend: Exterminate active
      spell.cast(S.marrowrend, () => this.getCurrentTarget(), () =>
        me.hasAura(A.exterminate)
      ),

      // 5. Death's Caress: BS emergency (missing/expiring/low) & rune < 4
      // SimC: deaths_caress,if=(!buff.bone_shield.up|buff.bone_shield.remains<3|buff.bone_shield.stack<6)&rune<4
      spell.cast(S.deathsCaress, () => this.getCurrentTarget(), () => {
        const bs = this.getBSData();
        return (bs.stacks === 0 || bs.remaining < 3000 || bs.stacks < 6) &&
          this.getRunes() < 4;
      }),

      // 6. Marrowrend: BS missing/expiring/low
      // SimC: marrowrend,if=!buff.bone_shield.up|buff.bone_shield.remains<3|buff.bone_shield.stack<6
      spell.cast(S.marrowrend, () => this.getCurrentTarget(), () => {
        const bs = this.getBSData();
        return bs.stacks === 0 || bs.remaining < 3000 || bs.stacks < 6;
      }),

      // 7. Death Strike (general dump — SimC: death_strike, no condition = unconditional)
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () =>
        this.getRP() >= 40
      ),

      // 8. Blood Boil
      spell.cast(S.bloodBoil, () => this.getCurrentTarget()),

      // 9. Consumption (empower_to=1): !DRW
      // SimC: consumption,empower_to=1,if=!buff.dancing_rune_weapon.up
      new bt.Action(() => {
        if (this.inDRW()) return bt.Status.Failure;
        if (!this.getCurrentTarget()) return bt.Status.Failure;
        return this.castEmpowered(S.consumption, 1);
      }),

      // 10. Heart Strike
      this.castHS(() => this.getCurrentTarget()),

      // 11. Consumption (empower_to=1, fallback — no condition)
      new bt.Action(() => {
        if (!this.getCurrentTarget()) return bt.Status.Failure;
        return this.castEmpowered(S.consumption, 1);
      }),
    );
  }

  // =============================================
  // SAN'LAYN GIFT ROTATION (DRW active)
  // SimC: actions.san_gift (9 lines)
  // =============================================
  sanGiftRotation() {
    return new bt.Selector(
      // 1. Heart Strike: Essence about to drop (remains < 1.5s AND has stacks)
      // SimC: heart_strike,if=buff.essence_of_the_blood_queen.remains<1.5&buff.essence_of_the_blood_queen.remains
      this.castHS(() => this.getCurrentTarget(), () => {
        const ess = me.getAura(A.essenceBloodQueen);
        return ess && ess.remaining > 0 && ess.remaining < 1500;
      }),

      // 2. Death Strike: RP deficit < 36 (wider during Gift)
      // SimC: death_strike,if=runic_power.deficit<36
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () =>
        this.getRPDeficit() < 36
      ),

      // 3. Blood Boil: DRW copy not ticking BP
      // SimC: blood_boil,if=!drw.bp_ticking
      spell.cast(S.bloodBoil, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const bp = t.getAuraByMe(A.bloodPlague);
        return !bp || bp.remaining < 3000;
      }),

      // 4. DnD: Crimson Scourge proc
      // SimC: any_dnd,if=buff.crimson_scourge.remains
      spell.cast(S.deathAndDecay, () => this.getCurrentTarget(), () =>
        me.hasAura(A.crimsonScourge)
      ),

      // 5. Heart Strike: Essence stacks < 7
      // SimC: heart_strike,if=buff.essence_of_the_blood_queen.stack<7
      this.castHS(() => this.getCurrentTarget(), () =>
        this.getEssenceStacks() < 7
      ),

      // 6. Death Strike (dump — SimC: death_strike, no condition = unconditional)
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () =>
        this.getRP() >= 40
      ),

      // 7. Blood Boil: Boiling Point up & !Boiling Point Echo
      // SimC: blood_boil,if=buff.boiling_point.up&!buff.boiling_point_echo.up
      spell.cast(S.bloodBoil, () => this.getCurrentTarget(), () => {
        if (!this.hasBoilingPoint()) return false;
        if (A.boilingPointEcho && me.hasAura(A.boilingPointEcho)) return false;
        return true;
      }),

      // 8. Heart Strike (filler)
      this.castHS(() => this.getCurrentTarget()),

      // 9. Blood Boil (filler)
      spell.cast(S.bloodBoil, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // SAN'LAYN ROTATION (outside DRW)
  // SimC: actions.sanlayn (14 lines)
  // =============================================
  sanlaynRotation() {
    return new bt.Selector(
      // 1. Death's Caress: BS emergency (missing / < 1.5s / stacks <= 1)
      // SimC: deaths_caress,if=!buff.bone_shield.up|buff.bone_shield.remains<1.5|buff.bone_shield.stack<=1
      spell.cast(S.deathsCaress, () => this.getCurrentTarget(), () => {
        const bs = this.getBSData();
        return bs.stacks === 0 || bs.remaining < 1500 || bs.stacks <= 1;
      }),

      // 2. Blood Boil: Blood Plague < 3s
      // SimC: blood_boil,if=dot.blood_plague.remains<3
      spell.cast(S.bloodBoil, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const bp = t.getAuraByMe(A.bloodPlague);
        return !bp || bp.remaining < 3000;
      }),

      // 3. Heart Strike: Essence about to drop & VS proc ready
      // SimC: heart_strike,if=(buff.essence_of_the_blood_queen.remains<1.5&buff.essence_of_the_blood_queen.remains&buff.vampiric_strike.remains)
      this.castHS(() => this.getCurrentTarget(), () => {
        const ess = me.getAura(A.essenceBloodQueen);
        return ess && ess.remaining > 0 && ess.remaining < 1500 &&
          this.hasVSProc();
      }),

      // 4. Death Strike: RP deficit < 20
      // SimC: death_strike,if=runic_power.deficit<20
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () =>
        this.getRPDeficit() < 20
      ),

      // 5. Death's Caress: BS < 6
      // SimC: deaths_caress,if=buff.bone_shield.stack<6
      spell.cast(S.deathsCaress, () => this.getCurrentTarget(), () =>
        this.getBSData().stacks < 6
      ),

      // 6. Marrowrend: BS < 6
      // SimC: marrowrend,if=buff.bone_shield.stack<6
      spell.cast(S.marrowrend, () => this.getCurrentTarget(), () =>
        this.getBSData().stacks < 6
      ),

      // 7. DnD: Crimson Scourge proc
      // SimC: any_dnd,if=buff.crimson_scourge.remains
      spell.cast(S.deathAndDecay, () => this.getCurrentTarget(), () =>
        me.hasAura(A.crimsonScourge)
      ),

      // 8. Heart Strike: Vampiric Strike proc active
      // SimC: heart_strike,if=buff.vampiric_strike.up
      this.castHS(() => this.getCurrentTarget(), () =>
        this.hasVSProc()
      ),

      // 9. Death Strike (general dump — SimC: death_strike, no condition = unconditional)
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () =>
        this.getRP() >= 40
      ),

      // 10. Blood Boil: Boiling Point up & !Echo
      // SimC: blood_boil,if=buff.boiling_point.up&!buff.boiling_point_echo.up
      spell.cast(S.bloodBoil, () => this.getCurrentTarget(), () => {
        if (!this.hasBoilingPoint()) return false;
        if (A.boilingPointEcho && me.hasAura(A.boilingPointEcho)) return false;
        return true;
      }),

      // 11. Consumption (empower_to=1)
      new bt.Action(() => {
        if (!this.getCurrentTarget()) return bt.Status.Failure;
        return this.castEmpowered(S.consumption, 1);
      }),

      // 12. Heart Strike: rune >= 2
      // SimC: heart_strike,if=rune>=2
      this.castHS(() => this.getCurrentTarget(), () =>
        this.getRunes() >= 2
      ),

      // 13. Blood Boil (filler)
      spell.cast(S.bloodBoil, () => this.getCurrentTarget()),

      // 14. Heart Strike (filler)
      this.castHS(() => this.getCurrentTarget()),
    );
  }

  // =============================================
  // DEFENSIVES (HP-gated, separate from rotation)
  // =============================================
  defensives() {
    return new bt.Selector(
      // IBF: heavy damage / stun immunity
      spell.cast(S.iceboundFortitude, () => me, () =>
        Settings.FWBdkIBF && me.effectiveHealthPercent < Settings.FWBdkIBFHP
      ),

      // AMS: absorb magic damage + generate RP
      spell.cast(S.antiMagicShell, () => me, () =>
        Settings.FWBdkAMS && me.effectiveHealthPercent < Settings.FWBdkAMSHP
      ),

      // Rune Tap: short mitigation (costs 1 rune)
      spell.cast(S.runeTap, () => me, () =>
        me.effectiveHealthPercent < Settings.FWBdkRuneTapHP && this.getRunes() >= 1
      ),

      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // CONSUMPTION EMPOWER (empower_to=1)
  // =============================================
  castEmpowered(spellId, level) {
    this._desiredEmpowerLevel = level;
    const result = spell.cast(spellId, () => this.getCurrentTarget()).execute({});
    if (result !== bt.Status.Success) {
      this._desiredEmpowerLevel = undefined;
    }
    return result === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
  }

  handleEmpoweredSpell() {
    return new bt.Action(() => {
      if (this._desiredEmpowerLevel === undefined) return bt.Status.Failure;
      if (!me.isCastingOrChanneling) {
        this._desiredEmpowerLevel = undefined;
        return bt.Status.Failure;
      }
      if (me.spellInfo && me.spellInfo.empowerLevel >= this._desiredEmpowerLevel) {
        const currentSpell = spell.getSpell(me.spellInfo.spellChannelId);
        if (currentSpell) {
          currentSpell.cast(me.targetUnit);
          this._desiredEmpowerLevel = undefined;
        }
        return bt.Status.Success;
      }
      return bt.Status.Success; // Still charging — block other actions
    });
  }

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isDeathbringer() { return spell.isSpellKnown(S.reapersMarkCast); }
  isSanlayn() { return !this.isDeathbringer(); }

  // =============================================
  // BUFF / STATE CHECKS
  // =============================================
  inDRW() { return me.hasAura(A.dancingRuneWeapon); }

  // VS proc: try Vampiric Strike first (proc active), fall back to Heart Strike
  castHS(targetFn, conditionFn) {
    return new bt.Selector(
      spell.cast(S.vampiricStrike, targetFn, conditionFn),
      spell.cast(S.heartStrike, targetFn, conditionFn),
    );
  }

  // VS proc and Boiling Point use passive aura IDs — must check remaining > 0 to detect active buff
  hasVSProc() {
    // Try both known IDs — the one with remaining > 0 is the actual proc
    const a1 = me.getAura(A.vampiricStrikeProc);
    if (a1 && a1.remaining > 0) return true;
    const a2 = me.getAura(433901);
    if (a2 && a2.remaining > 0) return true;
    // Fallback: check if the VS spell itself is castable (it replaces Heart Strike)
    return spell.isSpellKnown(S.vampiricStrike) && !spell.isOnCooldown(S.vampiricStrike);
  }

  hasBoilingPoint() {
    const a = me.getAura(A.boilingPoint);
    return a && a.remaining > 0;
  }

  isDnDActive() {
    return me.hasAura(A.deathAndDecay) ||
      spell.getTimeSinceLastCast(S.deathAndDecay) < 10000;
  }

  getEssenceStacks() {
    const aura = me.getAura(A.essenceBloodQueen);
    return aura ? aura.stacks : 0;
  }

  // =============================================
  // RESOURCE HELPERS (cached per tick)
  // =============================================
  getRP() {
    if (this._rpFrame === wow.frameTime) return this._cachedRP;
    this._rpFrame = wow.frameTime;
    this._cachedRP = me.powerByType(PowerType.RunicPower);
    return this._cachedRP;
  }

  getRPDeficit() { return 125 - this.getRP(); }

  getRunes() {
    if (this._runeFrame === wow.frameTime) return this._cachedRunes;
    this._runeFrame = wow.frameTime;
    this._cachedRunes = me.powerByType(PowerType.Runes);
    return this._cachedRunes;
  }

  getBSData() {
    if (this._bsFrame === wow.frameTime) return this._cachedBS;
    this._bsFrame = wow.frameTime;
    const aura = me.getAura(A.boneShield);
    this._cachedBS = aura ? { stacks: aura.stacks || 0, remaining: aura.remaining || 0 }
      : { stacks: 0, remaining: 0 };
    return this._cachedBS;
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

  useCDs() { return Settings.FWBdkUseCDs; }
}
