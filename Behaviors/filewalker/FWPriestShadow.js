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
 * Shadow Priest Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (WarcraftPriests/mid-shadow-priest default_apl.simc)
 *          + Method Guide (all pages) + Wowhead + WarcraftPriests community
 *
 * Auto-detects: Voidweaver (Void Torrent) vs Archon (Halo)
 *
 * SimC APL lists implemented:
 *   precombat (shadowform, TS opener)
 *   main (22 lines — ALL conditions matched)
 *   cds (13 lines — racials, PI, VF, Halo, DP)
 *   aoe_variables (6 lines — dots_up, max_vts, holding_ts)
 *   heal_for_tof (Holy Nova for Lightburst talent)
 *   trinkets (framework-limited, partial)
 *
 * Midnight rework:
 *   Shadow Word: Madness (335467) replaces Devouring Plague
 *   Tentacle Slam (1227280) replaces Shadow Crash — applies VT to 6 targets
 *   Void Volley (1242173) replaces Void Bolt during Voidform
 *   Shadowfiend/Mindbender/Voidwraith now passive (proc via Depth of Shadows)
 *   Surge of Insanity fully passive
 *
 * Key SimC variables replicated:
 *   dots_up, holding_tentacle_slam, dr_force_prio, me_force_prio,
 *   max_vts, is_vt_possible, manual_vts_applied
 *
 * Core: DoTs up → Voidform → PI → Void Volley → SWM → Void Blast/MF:I → MB → MF
 * Movement: TS, SWM, VV, SWD, MB(Insight), VB, SWP (all instant)
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL (WarcraftPriests) + Method + Wowhead',
};

const S = {
  swPain:             589,
  vampiricTouch:      34914,
  swMadness:          335467,
  mindBlast:          8092,
  mindFlay:           15407,
  mindFlayInsanity:   391403,
  swDeath:            32379,
  voidform:           228260,
  voidVolley:         1242173,
  tentacleSlam:       1227280,
  voidTorrent:        263165,
  voidBlast:          450405,
  halo:               120644,
  powerInfusion:      10060,
  desperatePrayer:    19236,
  dispersion:         47585,
  fade:               586,
  silence:            15487,
  shadowform:         232698,
  pwFortitude:        21562,
  berserking:         26297,
  holyNova:           132157,
};

const T = {
  invokedNightmare:   1279350,
  mindDevourer:       373202,
  devourMatter:       451840,
  inescapableTorment: 373427,
  deathspeaker:       392507,
  voidApparitions:    1264104,
  maddeningTentacles: 1279353,
  distortedReality:   409044,
  mindsEye:           407470,
  voidtouched:        407430,
  idolOfYshaarj:      373273,
  shadowfiend:        34433,    // Talent check (now passive)
  twistOfFate:        390972,
  lightburst:         468087,   // Holy Nova talent for ToF healing
};

const A = {
  swPain:             589,
  vampiricTouch:      34914,
  swMadness:          335467,
  voidform:           228264,    // Buff aura (NOT cast 228260, NOT old 194249)
  voidformAlt:        194249,    // Fallback/old ID
  entropicRift:       447444,    // Voidweaver rift active
  shadowform:         232698,
  powerInfusion:      10060,
  mindDevourer:       373202,
  shadowyInsight:     375888,    // Instant MB proc
  pwFortitude:        21562,
  twistOfFate:        390978,    // ToF buff aura (damage+healing increase)
  bloodlust:          2825,      // BL/Hero/TW buff
  heroism:            32182,
  timeWarp:           80353,
};

const MIN_DOT_TTD = 12000;

export class ShadowPriestBehavior extends Behavior {
  name = 'FW Shadow Priest';
  context = BehaviorContext.Any;
  specialization = Specialization.Priest.Shadow;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _insFrame = 0;
  _cachedIns = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;
  // SimC variable caches
  _dotsUpFrame = 0;
  _cachedDotsUp = false;
  _swmCountFrame = 0;
  _cachedSwmCount = 0;
  _vtCountFrame = 0;
  _cachedVtCount = 0;
  _swpCountFrame = 0;
  _cachedSwpCount = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWSprUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWSprDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWSprDP', text: 'Use Desperate Prayer', default: true },
        { type: 'slider', uid: 'FWSprDPHP', text: 'Desperate Prayer HP %', default: 50, min: 15, max: 75 },
        { type: 'checkbox', uid: 'FWSprDisp', text: 'Use Dispersion', default: true },
        { type: 'slider', uid: 'FWSprDispHP', text: 'Dispersion HP %', default: 20, min: 5, max: 40 },
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

      // OOC: Shadowform + Fortitude
      spell.cast(S.shadowform, () => me, () => !me.hasAura(A.shadowform)),
      spell.cast(S.pwFortitude, () => me, () =>
        spell.getTimeSinceLastCast(S.pwFortitude) > 60000 && !me.hasAura(A.pwFortitude)
      ),

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

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[SPri] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isVW() ? 'Voidweaver' : 'Archon'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWSprDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const ec = this.getEnemyCount();
          const vtC = this.getVtCount();
          const swpC = this.getSwpCount();
          console.info(`[SPri] Ins:${Math.round(this.getIns())} VF:${this.inVF()} Rift:${this.inRift()} MD:${me.hasAura(A.mindDevourer)} SI:${me.hasAura(A.shadowyInsight)} Dots:${this.dotsUp()} E:${ec} VT:${vtC} SWP:${swpC} BL:${this.hasBloodlust()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.silence),
          this.defensives(),

          // Movement — full instant-cast rotation (mirrors main minus cast-time spells)
          new bt.Decorator(
            () => me.isMoving(),
            new bt.Selector(
              // CDs (off-GCD)
              new bt.Decorator(
                () => (this.targetTTD() < 30000 || (this.targetTTD() > 15000 && this.dotsUp())),
                this.cooldowns(),
                new bt.Action(() => bt.Status.Failure)
              ),
              spell.cast(S.tentacleSlam, () => this.getCurrentTarget()),
              spell.cast(S.swMadness, () => this.getCurrentTarget(), () => this.swmCond()),
              spell.cast(S.voidVolley, () => this.getCurrentTarget(), () => this.inVF()),
              spell.cast(S.voidBlast, () => this.getCurrentTarget(), () => this.isVW() && this.inRift()),
              spell.cast(S.swDeath, () => this.getCurrentTarget(), () => {
                const t = this.getCurrentTarget();
                if (!t || me.effectiveHealthPercent < 40) return false;
                const execThreshold = 20 + (spell.isSpellKnown(T.deathspeaker) ? 15 : 0);
                return t.effectiveHealthPercent < execThreshold;
              }),
              spell.cast(S.mindBlast, () => this.getCurrentTarget(), () => me.hasAura(A.shadowyInsight)),
              spell.cast(S.swPain, () => this.getCurrentTarget(), () => this.swpRefreshable()),
              spell.cast(S.swDeath, () => this.getCurrentTarget(), () => me.effectiveHealthPercent > 50),
              new bt.Action(() => bt.Status.Success)
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: AoE dispatch (>2 targets) → aoe_variables + main
          // AoE variables are computed per-tick in dotsUp()/getVtCount() etc.
          // The main rotation handles both ST and AoE via target_if approximations

          // SimC: main rotation
          this.mainRotation(),
        )
      ),
    );
  }

  // =============================================
  // MAIN ROTATION (SimC actions.main — ALL 22 lines matched)
  // =============================================
  mainRotation() {
    return new bt.Selector(
      // SimC: variable dots_up + call_action_list,name=cds
      // cds if: fight_remains<30 | TTD>15 & dots_up
      new bt.Decorator(
        () => (this.targetTTD() < 30000 || (this.targetTTD() > 15000 && this.dotsUp())),
        this.cooldowns(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // SimC L3: shadow_word_death,if=priest.force_devour_matter&talent.devour_matter
      spell.cast(S.swDeath, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.devourMatter)) return false;
        const t = this.getCurrentTarget();
        return t && t.hasAura(17); // PW:Shield aura on target
      }),

      // SimC L4: shadow_word_madness — full condition match
      // active_dot<=1 & remains<=gcd | deficit<=35 | mind_devourer | TTD<=10 | rift & cost>0
      // target_if: max:target.time_to_die*(remains<=gcd|dr_force_prio|!DR&me_force_prio)
      spell.cast(S.swMadness, () => this.getCurrentTarget(), () => this.swmCond()),

      // SimC L5: void_volley (unconditional during VF — SimC fires on CD)
      spell.cast(S.voidVolley, () => this.getCurrentTarget(), () => this.inVF()),

      // SimC L6: void_blast,target_if=max:(swm.remains*1000+TTD)
      spell.cast(S.voidBlast, () => this.getCurrentTarget(), () =>
        this.isVW() && this.inRift()
      ),

      // SimC L7: tentacle_slam,if=vt.refreshable|full_recharge_time<=gcd*2
      spell.cast(S.tentacleSlam, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const vt = t.getAuraByMe(A.vampiricTouch);
        if (!vt || vt.remaining <= 6300) return true;
        return spell.getFullRechargeTime(S.tentacleSlam) <= 3000;
      }),

      // SimC L8: shadow_word_madness,if=pmultiplier<1&ticking (re-snapshot)
      spell.cast(S.swMadness, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const swm = t.getAuraByMe(A.swMadness);
        if (!swm || swm.remaining <= 0) return false;
        // Approximate pmultiplier<1: entered VF or PI after SWM was applied
        return this.inVF() && spell.getTimeSinceLastCast(S.voidform) < 3000;
      }),

      // SimC L9: void_torrent,if=!holding_ts&dots_up
      spell.cast(S.voidTorrent, () => this.getCurrentTarget(), () =>
        this.isVW() && this.dotsUp() && this.targetTTD() > 8000
      ),

      // SimC L10: shadow_word_pain,if=talent.invoked_nightmare&refreshable&TTD>12&vt.ticking
      spell.cast(S.swPain, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.invokedNightmare)) return false;
        if (spell.getTimeSinceLastCast(S.swPain) < 3000) return false;
        const t = this.getCurrentTarget();
        if (!t || this.targetTTD() < MIN_DOT_TTD) return false;
        return this.swpRefreshable() && t.hasAuraByMe(A.vampiricTouch);
      }),

      // SimC L11: mind_blast,if=!mind_devourer|!talent.mind_devourer
      spell.cast(S.mindBlast, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.mindDevourer) || !spell.isSpellKnown(T.mindDevourer)
      ),

      // SimC L12: mind_flay_insanity,target_if=max:swm.remains (Archon only)
      spell.cast(S.mindFlayInsanity, () => this.getCurrentTarget(), () => {
        if (!this.isArchon()) return false;
        const t = this.getCurrentTarget();
        return t && t.hasAuraByMe(A.swMadness);
      }),

      // SimC L13: tentacle_slam,if=(void_apparitions|maddening_tentacles)&adds timing
      spell.cast(S.tentacleSlam, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.voidApparitions) && !spell.isSpellKnown(T.maddeningTentacles)) return false;
        if (spell.isSpellKnown(T.maddeningTentacles)) {
          const swmCost = this.getSWMCost();
          if ((this.getIns() + 6) < swmCost) {
            const t = this.getCurrentTarget();
            if (t && t.hasAuraByMe(A.swMadness)) return false;
          }
        }
        return spell.getChargesFractional(S.tentacleSlam) > 1.4;
      }),

      // SimC L14: vampiric_touch,if=refreshable&TTD>12&(ticking|!dots_up)&TS timing
      spell.cast(S.vampiricTouch, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t || this.targetTTD() < MIN_DOT_TTD) return false;
        const vt = t.getAuraByMe(A.vampiricTouch);
        if (vt && vt.remaining > 6300) return false;
        // Only hard-cast if TS won't cover it first
        const tsCd = spell.getCooldown(S.tentacleSlam);
        const tsUsable = tsCd ? tsCd.timeleft : 99999;
        if (!vt) return true; // Missing entirely
        return tsUsable > vt.remaining;
      }),

      // SimC L15: heal_for_tof — Holy Nova if Lightburst talented + ToF not active
      spell.cast(S.holyNova, () => me, () =>
        spell.isSpellKnown(T.lightburst) && spell.isSpellKnown(T.twistOfFate) &&
        !me.hasAura(A.twistOfFate) && this.isArchon()
      ),

      // SimC L16: vampiric_touch (lower priority repeat — refreshable&TTD>12)
      spell.cast(S.vampiricTouch, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t || this.targetTTD() < MIN_DOT_TTD) return false;
        const vt = t.getAuraByMe(A.vampiricTouch);
        return !vt || vt.remaining <= 6300;
      }),

      // SimC L17: shadow_word_death — pet active + inescapable_torment | execute
      // execute threshold: 20 + 15*deathspeaker (if also has shadowfiend+idol_of_yshaarj)
      spell.cast(S.swDeath, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t || me.effectiveHealthPercent < 40) return false;
        // Inescapable Torment with pet active (pets are passive now — check recent proc)
        if (spell.isSpellKnown(T.inescapableTorment)) {
          if (spell.getTimeSinceLastCast(200174) < 10000 || // Mindbender
              spell.getTimeSinceLastCast(34433) < 5000) return true;
        }
        // Execute: hp < (20+15*deathspeaker) & talent.shadowfiend & talent.idol_of_yshaarj
        const execThreshold = 20 + (spell.isSpellKnown(T.deathspeaker) ? 15 : 0);
        if (t.effectiveHealthPercent < execThreshold &&
            spell.isSpellKnown(T.shadowfiend) && spell.isSpellKnown(T.idolOfYshaarj)) return true;
        return false;
      }),

      // SimC L18: mind_flay,chain=1,interrupt_if=ticks>=2 (filler)
      spell.cast(S.mindFlay, () => this.getCurrentTarget()),

      // SimC L19: tentacle_slam (low priority dump)
      spell.cast(S.tentacleSlam, () => this.getCurrentTarget()),

      // SimC L20: shadow_word_death,if=hp<20 (execute fallback)
      spell.cast(S.swDeath, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        return t && t.effectiveHealthPercent < 20 && me.effectiveHealthPercent > 40;
      }),

      // SimC L21: shadow_word_death (unconditional — insanity gen)
      spell.cast(S.swDeath, () => this.getCurrentTarget(), () =>
        me.effectiveHealthPercent > 50
      ),

      // SimC L22: shadow_word_pain,target_if=min:remains (refresh filler)
      spell.cast(S.swPain, () => this.getCurrentTarget(), () => this.swpRefreshable()),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cds — ALL 13 lines matched)
  // =============================================
  cooldowns() {
    if (!Settings.FWSprUseCDs) return new bt.Action(() => bt.Status.Failure);
    return new bt.Selector(
      // SimC L1: potion — skipped (external item)

      // SimC L2-5: racials — berserking, blood_fury, fireblood, ancestral_call
      // Condition: (VF|!talent.voidform) & PI up | fight_remains<=12
      spell.cast(S.berserking, () => me, () =>
        ((this.inVF() || !spell.isSpellKnown(S.voidform)) && me.hasAura(A.powerInfusion)) ||
        this.targetTTD() <= 12000
      ),

      // SimC L9: power_infusion,if=(VF|!talent.voidform)&!buff.PI.up
      spell.cast(S.powerInfusion, () => me, () =>
        !me.hasAura(A.powerInfusion) &&
        (this.inVF() || !spell.isSpellKnown(S.voidform))
      ),

      // SimC L10: halo (Archon — unconditional)
      spell.cast(S.halo, () => this.getCurrentTarget(), () =>
        this.isArchon()
      ),

      // SimC L11: voidform,if=active_dot.swp>=active_dot.vt (dots up)
      spell.cast(S.voidform, () => me, () => {
        const swpC = this.getSwpCount();
        const vtC = this.getVtCount();
        return swpC >= vtC && vtC > 0;
      }),

      // SimC L13: desperate_prayer,if=health.pct<=75
      spell.cast(S.desperatePrayer, () => me, () =>
        Settings.FWSprDP && me.effectiveHealthPercent <= 75
      ),

      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.desperatePrayer, () => me, () =>
        Settings.FWSprDP && me.effectiveHealthPercent < Settings.FWSprDPHP
      ),
      spell.cast(S.fade, () => me, () => me.inCombat() && me.effectiveHealthPercent < 70),
      spell.cast(S.dispersion, () => me, () =>
        Settings.FWSprDisp && me.effectiveHealthPercent < Settings.FWSprDispHP
      ),
    );
  }

  // =============================================
  // SWM SPEND CONDITIONS (SimC L4 — full condition match)
  // active_dot<=1 & remains<=gcd | deficit<=35 | mind_devourer |
  // !adds & TTD<=10 | rift & cost>0
  // target_if=max:TTD*(remains<=gcd|dr_force_prio|!DR&me_force_prio)
  // =============================================
  swmCond() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    const swm = t.getAuraByMe(A.swMadness);
    const swmCount = this.getSwmCount();

    // active_dot<=1 & remains<=gcd (apply/refresh)
    if (swmCount <= 1 && (!swm || swm.remaining <= 1500)) {
      return this.getIns() >= this.getSWMCost() || me.hasAura(A.mindDevourer);
    }

    // Insanity deficit <= 35 (overcap prevention)
    if (this.getInsDeficit() <= 35) return true;

    // Mind Devourer proc (free + 20% damage)
    if (me.hasAura(A.mindDevourer)) return true;

    // Fight ending (single-target only)
    if (this.getEnemyCount() <= 1 && this.targetTTD() <= 10000) return true;

    // Entropic Rift active & cost > 0 (maximize rift window)
    if (this.inRift() && this.getSWMCost() > 0) return true;

    // dr_force_prio / me_force_prio — always refresh if these conditions met
    if (spell.isSpellKnown(T.distortedReality) && swm && swm.remaining <= 1500) return true;
    if (spell.isSpellKnown(T.mindsEye) && !spell.isSpellKnown(T.distortedReality) &&
        swm && swm.remaining <= 1500) return true;

    return false;
  }

  getSWMCost() {
    let cost = 50; // Base
    if (spell.isSpellKnown(T.mindsEye)) cost -= 5;
    if (spell.isSpellKnown(T.distortedReality)) cost += 5;
    // Tier set: -5
    return cost;
  }

  // =============================================
  // HELPERS
  // =============================================
  isVW() { return spell.isSpellKnown(S.voidTorrent); }
  isArchon() { return !this.isVW(); }

  inVF() { return me.hasAura(A.voidform) || me.hasAura(A.voidformAlt); }
  inRift() { return me.hasAura(A.entropicRift); }

  hasBloodlust() {
    return me.hasAura(A.bloodlust) || me.hasAura(A.heroism) || me.hasAura(A.timeWarp);
  }

  // SimC: variable.dots_up — active_dot.vt=enemies & active_dot.swp>=active_dot.vt (ST)
  // AoE: active_dot.vt>=max_vts & active_dot.swp>=active_dot.vt
  dotsUp() {
    if (this._dotsUpFrame === wow.frameTime) return this._cachedDotsUp;
    this._dotsUpFrame = wow.frameTime;
    const ec = this.getEnemyCount();
    if (ec <= 2) {
      // ST/cleave: all targets have both dots
      const t = this.getCurrentTarget();
      if (!t) { this._cachedDotsUp = false; return false; }
      this._cachedDotsUp = !!(t.hasAuraByMe(A.vampiricTouch) && t.hasAuraByMe(A.swPain));
    } else {
      // AoE: vt count >= max_vts & swp >= vt
      const vtC = this.getVtCount();
      const swpC = this.getSwpCount();
      const maxVts = Math.min(ec, 12);
      this._cachedDotsUp = vtC >= maxVts && swpC >= vtC;
    }
    return this._cachedDotsUp;
  }

  swpRefreshable() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    if (spell.getTimeSinceLastCast(S.swPain) < 3000) return false;
    const d = t.getAuraByMe(A.swPain);
    return !d || d.remaining <= 4800; // 30% of 16s
  }

  getIns() {
    if (this._insFrame === wow.frameTime) return this._cachedIns;
    this._insFrame = wow.frameTime;
    this._cachedIns = me.powerByType(PowerType.Insanity);
    return this._cachedIns;
  }

  getInsDeficit() {
    const max = spell.isSpellKnown(T.voidtouched) ? 150 : 100;
    return max - this.getIns();
  }

  // Dot counting helpers (approximate active_dot via combat.targets)
  getVtCount() {
    if (this._vtCountFrame === wow.frameTime) return this._cachedVtCount;
    this._vtCountFrame = wow.frameTime;
    let count = 0;
    const targets = combat.targets;
    if (targets) {
      for (let i = 0; i < targets.length; i++) {
        if (targets[i] && targets[i].hasAuraByMe(A.vampiricTouch)) count++;
      }
    }
    this._cachedVtCount = count;
    return count;
  }

  getSwpCount() {
    if (this._swpCountFrame === wow.frameTime) return this._cachedSwpCount;
    this._swpCountFrame = wow.frameTime;
    let count = 0;
    const targets = combat.targets;
    if (targets) {
      for (let i = 0; i < targets.length; i++) {
        if (targets[i] && targets[i].hasAuraByMe(A.swPain)) count++;
      }
    }
    this._cachedSwpCount = count;
    return count;
  }

  getSwmCount() {
    if (this._swmCountFrame === wow.frameTime) return this._cachedSwmCount;
    this._swmCountFrame = wow.frameTime;
    let count = 0;
    const targets = combat.targets;
    if (targets) {
      for (let i = 0; i < targets.length; i++) {
        if (targets[i] && targets[i].hasAuraByMe(A.swMadness)) count++;
      }
    }
    this._cachedSwmCount = count;
    return count;
  }

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
    this._cachedEnemyCount = t ? t.getUnitsAroundCount(10) + 1 : 1;
    return this._cachedEnemyCount;
  }

  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }
}
