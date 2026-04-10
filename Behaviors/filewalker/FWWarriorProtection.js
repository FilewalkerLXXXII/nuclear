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
 * Protection Warrior Behavior - Midnight 12.0.1
 * Full rewrite matched line-by-line to SimC APL: warrior_protection.simc
 * Sources: SimC APL + Method Guide + Wowhead
 *
 * Auto-detects: Colossus (Demolish) vs Mountain Thane (Lightning Strikes)
 *
 * Tank: Shield Block uptime is #1 priority, Ignore Pain off-GCD rage dump
 * Resource: Rage (PowerType 1), max 100
 * All melee instant — no movement block needed
 *
 * SimC action lists replicated:
 *   main (20+ lines with full Ignore Pain conditions)
 *   aoe (10 lines), colossus_st (10 lines), thane_st (11 lines)
 *   variables (1 line)
 *
 * Key additions vs previous version:
 *   - Full SimC Ignore Pain conditions (rage deficit thresholds per CD state)
 *   - Heavy Repercussions + Practiced Strikes talent-aware IP conditions
 *   - Violent Outburst + Seeing Red tracking for Shield Slam priority
 *   - Execute phase variable (Massacre <35% or <20%)
 *   - Javelineer talent Wrecking Throw / Shattering Throw
 *   - Heavy Handed talent for AoE Execute
 *   - Barbaric Training rage threshold for Revenge
 *   - Champions Leap (Shield Charge)
 *   - Per-tick caching on all aura lookups
 */

const S = {
  // Core rotational
  shieldSlam:         23922,
  thunderClap:        6343,
  revenge:            6572,
  devastate:          20243,
  execute:            163201,
  // Defensive
  shieldBlock:        2565,
  ignorePain:         190456,
  // CDs
  avatar:             107574,
  ravager:            228920,
  shieldCharge:       385952,
  demoshout:          1160,
  championsSpear:     376079,
  shieldWall:         871,
  lastStand:          12975,
  spellReflection:    23920,
  // Colossus
  demolish:           436358,
  // Mountain Thane
  thunderBlast:       435222,   // Cast spell (435607 is talent passive)
  // Utility
  charge:             100,
  taunt:              355,
  pummel:             6552,
  wreckingThrow:      384110,
  shatteringThrow:    64382,
  battleShout:        6673,
  // Racials
  berserking:         26297,
};

const A = {
  // Core buffs/procs
  shieldBlock:        132404,
  avatar:             107574,
  ravager:            228920,
  revengeProc:        5302,
  suddenDeath:        52437,    // Proc buff (SimC: find_spell(52437))
  violentOutburst:    386478,   // Proc buff (386477 is talent passive)
  seeingRed:          386486,
  // Colossus
  colossalMight:      440989,   // Stacking buff (429634 is talent passive)
  // Thane
  thunderBlast:       435615,   // Proc buff (435607 is talent passive)
  burstOfPower:       437121,   // Stacking buff (437118 is talent passive)
  // DoTs
  rendDot:            394062,
  // Hero detection
  demolishKnown:      436358,
  lightningStrikes:   434969,
};

// Talent IDs
const T = {
  boomingVoice:       202743,
  heavyRepercussions: 203177,
  practicedStrikes:   458254,
  javelineer:         383155,
  deepWounds:         1261060,
  massacre:           281001,
  heavyHanded:        456120,
  barbaricTraining:   390674,
  demolish:           436358,
  lightningStrikes:   434969,
};

export class ProtectionWarriorBehavior extends Behavior {
  name = 'FW Protection Warrior';
  context = BehaviorContext.Any;
  specialization = Specialization.Warrior.Protection;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _rageFrame = 0;
  _cachedRage = 0;
  _enemyFrame = 0;
  _cachedEnemies = 1;
  _auraFrame = 0;
  _cachedSBRemaining = 0;
  _cachedAvatar = false;
  _cachedRavager = false;
  _cachedRevengeProc = false;
  _cachedSuddenDeath = false;
  _cachedViolentOutburst = false;
  _cachedSeeingRed = null;
  _cachedColossalMight = 0;
  _cachedTBStacks = 0;
  _cachedRendRemaining = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWProtWUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWProtWDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWProtWSW', text: 'Use Shield Wall', default: true },
        { type: 'slider', uid: 'FWProtWSWHP', text: 'Shield Wall HP %', default: 35, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWProtWLS', text: 'Use Last Stand', default: true },
        { type: 'slider', uid: 'FWProtWLSHP', text: 'Last Stand HP %', default: 40, min: 15, max: 60 },
        { type: 'checkbox', uid: 'FWProtWSR', text: 'Use Spell Reflection', default: true },
      ],
    },
  ];

  // ===== Hero Detection =====
  isColossus() { return spell.isSpellKnown(T.demolish); }
  isMountainThane() { return !this.isColossus(); }

  // ===== Per-tick Caching =====
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const t = me.target;
    if (t && common.validTarget(t) && me.distanceTo(t) <= 8 && me.isFacing(t)) { this._cachedTarget = t; return t; }
    const ct = combat.bestTarget || (combat.targets && combat.targets[0]) || null;
    this._cachedTarget = (ct && me.isFacing(ct)) ? ct : null;
    return this._cachedTarget;
  }

  getRage() {
    if (this._rageFrame === wow.frameTime) return this._cachedRage;
    this._rageFrame = wow.frameTime;
    this._cachedRage = me.powerByType(PowerType.Rage);
    return this._cachedRage;
  }

  getRageDeficit() { return 100 - this.getRage(); }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemies;
    this._enemyFrame = wow.frameTime;
    const t = this.getCurrentTarget();
    this._cachedEnemies = t ? t.getUnitsAroundCount(8) + 1 : 1;
    return this._cachedEnemies;
  }

  _refreshAuraCache() {
    if (this._auraFrame === wow.frameTime) return;
    this._auraFrame = wow.frameTime;
    const sbAura = me.getAura(A.shieldBlock);
    this._cachedSBRemaining = sbAura ? sbAura.remaining : 0;
    this._cachedAvatar = me.hasAura(A.avatar);
    this._cachedRavager = me.hasAura(A.ravager);
    this._cachedRevengeProc = me.hasAura(A.revengeProc);
    this._cachedSuddenDeath = me.hasAura(A.suddenDeath);
    this._cachedViolentOutburst = me.hasAura(A.violentOutburst);
    this._cachedSeeingRed = me.getAura(A.seeingRed);
    const cmAura = me.getAura(A.colossalMight);
    this._cachedColossalMight = cmAura ? cmAura.stacks : 0;
    const tbAura = me.getAura(A.thunderBlast);
    this._cachedTBStacks = tbAura ? tbAura.stacks : 0;
    const t = this.getCurrentTarget();
    const rendAura = t ? (t.getAuraByMe(A.rendDot) || t.getAuraByMe(S.thunderClap)) : null;
    this._cachedRendRemaining = rendAura ? rendAura.remaining : 0;
  }

  getShieldBlockRemaining() { this._refreshAuraCache(); return this._cachedSBRemaining; }
  hasShieldBlock() { return this.getShieldBlockRemaining() > 0; }
  hasAvatar() { this._refreshAuraCache(); return this._cachedAvatar; }
  hasRavager() { this._refreshAuraCache(); return this._cachedRavager; }
  hasRevengeProc() { this._refreshAuraCache(); return this._cachedRevengeProc; }
  hasSuddenDeath() { this._refreshAuraCache(); return this._cachedSuddenDeath; }
  hasViolentOutburst() { this._refreshAuraCache(); return this._cachedViolentOutburst; }
  getSeeingRedStacks() { this._refreshAuraCache(); return this._cachedSeeingRed ? this._cachedSeeingRed.stacks : 0; }
  getColossalMight() { this._refreshAuraCache(); return this._cachedColossalMight; }
  getThunderBlastStacks() { this._refreshAuraCache(); return this._cachedTBStacks; }
  getRendRemaining() { this._refreshAuraCache(); return this._cachedRendRemaining; }

  // ===== Helpers =====
  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }

  inExecutePhase() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    const threshold = spell.isSpellKnown(T.massacre) ? 35 : 20;
    return t.effectiveHealthPercent < threshold;
  }

  // ===== BUILD =====
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
      // No target — block
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),
      // Version log + debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[ProtWarr] Midnight 12.0.1 | Hero: ${this.isColossus() ? 'Colossus' : 'Mountain Thane'}`);
        }
        if (Settings.FWProtWDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[ProtWarr] HP:${Math.round(me.effectiveHealthPercent)}% Rage:${Math.round(this.getRage())} SB:${this.hasShieldBlock()}(${Math.round(this.getShieldBlockRemaining()/1000)}s) CM:${this.getColossalMight()} TB:${this.getThunderBlastStacks()}`);
        }
        return bt.Status.Failure;
      }),
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.pummel),
          // Emergency defensives FIRST
          this.defensives(),
          // Ignore Pain — off-GCD rage dump (full SimC conditions)
          this.ignorePainLogic(),
          // Avatar,if=buff.thunder_blast.down|buff.thunder_blast.stack<=2
          spell.cast(S.avatar, () => me, () => {
            if (!Settings.FWProtWUseCDs) return false;
            return this.getThunderBlastStacks() <= 2;
          }),
          // Shield Wall (SimC just says use it — we gate behind settings)
          // Already in defensives()
          // Berserking
          spell.cast(S.berserking, () => me, () => this.hasAvatar()),
          // Ravager
          spell.cast(S.ravager, () => this.getCurrentTarget(), () => Settings.FWProtWUseCDs),
          // Demoralizing Shout,if=talent.booming_voice
          spell.cast(S.demoshout, () => me, () => spell.isSpellKnown(T.boomingVoice)),
          // Champions Leap (Shield Charge)
          spell.cast(S.shieldCharge, () => this.getCurrentTarget()),
          // Champions Spear
          spell.cast(S.championsSpear, () => this.getCurrentTarget()),
          // thunder_blast,if=spell_targets>=2&buff.thunder_blast.stack=2
          spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => {
            return this.getEnemyCount() >= 2 && this.getThunderBlastStacks() >= 2;
          }),
          // demolish,if=buff.colossal_might.stack>=3
          spell.cast(S.demolish, () => this.getCurrentTarget(), () => this.getColossalMight() >= 3),
          // shield_charge
          // (already above — SimC has champions_leap which maps to Shield Charge)
          // shield_block,if=buff.shield_block.remains<=10
          spell.cast(S.shieldBlock, () => me, () => {
            return this.getShieldBlockRemaining() <= 10000 && this.getRage() >= 30;
          }),
          // Route: AoE (3+) vs hero-specific ST
          new bt.Decorator(() => this.getEnemyCount() >= 3, this.aoeRotation()),
          new bt.Decorator(() => this.isColossus(), this.colossusST()),
          this.thaneST(),
        )
      ),
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      spell.cast(S.shieldWall, () => me, () => {
        return Settings.FWProtWSW && me.effectiveHealthPercent < Settings.FWProtWSWHP;
      }),
      spell.cast(S.lastStand, () => me, () => {
        return Settings.FWProtWLS && me.effectiveHealthPercent < Settings.FWProtWLSHP;
      }),
      spell.cast(S.spellReflection, () => me, () => {
        return Settings.FWProtWSR && me.inCombat() && me.effectiveHealthPercent < 70;
      }),
    );
  }

  // =================================================================
  // IGNORE PAIN — Full SimC conditions (off-GCD)
  // SimC: ignore_pain,if=target.health.pct>=20&(
  //   rage.deficit<=15&cooldown.shield_slam.ready|
  //   rage.deficit<=20&cooldown.shield_charge.ready|
  //   rage.deficit<=20&cooldown.demoralizing_shout.ready&talent.booming_voice|
  //   rage.deficit<=15|
  //   rage.deficit<=40&cooldown.shield_slam.ready&buff.violent_outburst.up&talent.heavy_repercussions&talent.practiced_strikes|
  //   rage.deficit<=17&cooldown.shield_slam.ready&talent.heavy_repercussions|
  //   rage.deficit<=18&cooldown.shield_slam.ready&talent.practiced_strikes
  // )|(rage>=70|buff.seeing_red.stack=7&rage>=35)&cooldown.shield_slam.remains<=1&buff.shield_block.remains
  // =================================================================
  ignorePainLogic() {
    return spell.cast(S.ignorePain, () => me, () => {
      const deficit = this.getRageDeficit();
      const rage = this.getRage();
      const ssReady = !spell.isOnCooldown(S.shieldSlam);
      const scReady = !spell.isOnCooldown(S.shieldCharge);
      const dsReady = !spell.isOnCooldown(S.demoshout);
      const t = this.getCurrentTarget();
      const targetHP = t ? t.effectiveHealthPercent : 100;

      // First big condition block: target.health.pct >= 20
      if (targetHP >= 20) {
        if (deficit <= 15 && ssReady) return true;
        if (deficit <= 20 && scReady) return true;
        if (deficit <= 20 && dsReady && spell.isSpellKnown(T.boomingVoice)) return true;
        if (deficit <= 15) return true;
        if (deficit <= 40 && ssReady && this.hasViolentOutburst() &&
            spell.isSpellKnown(T.heavyRepercussions) && spell.isSpellKnown(T.practicedStrikes)) return true;
        if (deficit <= 17 && ssReady && spell.isSpellKnown(T.heavyRepercussions)) return true;
        if (deficit <= 18 && ssReady && spell.isSpellKnown(T.practicedStrikes)) return true;
      }

      // Second condition block: (rage>=70|seeing_red.stack=7&rage>=35)&ss.remains<=1&shield_block.remains
      const ssCD = spell.getCooldown(S.shieldSlam);
      const ssRemains = ssCD ? ssCD.timeleft : 0;
      if ((rage >= 70 || (this.getSeeingRedStacks() >= 7 && rage >= 35)) &&
          ssRemains <= 1000 && this.hasShieldBlock()) {
        return true;
      }

      return false;
    });
  }

  // =================================================================
  // AOE (3+ targets) — 10 SimC lines
  // =================================================================
  aoeRotation() {
    return new bt.Selector(
      // thunder_blast,if=dot.rend_dot.remains<=1
      spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => this.getRendRemaining() <= 1000),
      // thunder_clap,if=dot.rend_dot.remains<=1
      spell.cast(S.thunderClap, () => this.getCurrentTarget(), () => this.getRendRemaining() <= 1000),
      // thunder_blast,if=spell_targets>=2&buff.avatar.up
      spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => {
        return this.getEnemyCount() >= 2 && this.hasAvatar();
      }),
      // execute,if=spell_targets>=2&(rage>=50|buff.sudden_death.up)&talent.heavy_handed
      spell.cast(S.execute, () => this.getCurrentTarget(), () => {
        return this.getEnemyCount() >= 2 &&
               (this.getRage() >= 50 || this.hasSuddenDeath()) &&
               spell.isSpellKnown(T.heavyHanded);
      }),
      // thunder_clap,if=spell_targets>=4&buff.avatar.up&hero_tree.mountain_thane|spell_targets>6&buff.avatar.up
      spell.cast(S.thunderClap, () => this.getCurrentTarget(), () => {
        return (this.getEnemyCount() >= 4 && this.hasAvatar() && this.isMountainThane()) ||
               (this.getEnemyCount() > 6 && this.hasAvatar());
      }),
      // revenge,if=rage>=70&spell_targets>=3
      spell.cast(S.revenge, () => this.getCurrentTarget(), () => {
        return this.getRage() >= 70 && this.getEnemyCount() >= 3;
      }),
      // shield_slam,if=rage<=60|buff.violent_outburst.up
      spell.cast(S.shieldSlam, () => this.getCurrentTarget(), () => {
        return this.getRage() <= 60 || this.hasViolentOutburst();
      }),
      // thunder_blast
      spell.cast(S.thunderBlast, () => this.getCurrentTarget()),
      // thunder_clap
      spell.cast(S.thunderClap, () => this.getCurrentTarget()),
      // revenge,if=rage>=30|rage>=40&talent.barbaric_training
      spell.cast(S.revenge, () => this.getCurrentTarget(), () => {
        return this.getRage() >= 30 || (this.getRage() >= 40 && spell.isSpellKnown(T.barbaricTraining));
      }),
    );
  }

  // =================================================================
  // COLOSSUS ST — 10 SimC lines
  // =================================================================
  colossusST() {
    return new bt.Selector(
      // shield_slam
      spell.cast(S.shieldSlam, () => this.getCurrentTarget()),
      // thunder_clap
      spell.cast(S.thunderClap, () => this.getCurrentTarget()),
      // revenge,if=buff.ravager.up
      spell.cast(S.revenge, () => this.getCurrentTarget(), () => this.hasRavager()),
      // execute,if=buff.sudden_death.up&talent.deep_wounds|talent.deep_wounds&rage>=40
      spell.cast(S.execute, () => this.getCurrentTarget(), () => {
        return (this.hasSuddenDeath() && spell.isSpellKnown(T.deepWounds)) ||
               (spell.isSpellKnown(T.deepWounds) && this.getRage() >= 40);
      }),
      // revenge,if=rage>=80&!variable.execute_phase|buff.revenge.up&variable.execute_phase&rage<=18&cooldown.shield_slam.remains|buff.revenge.up&!variable.execute_phase
      spell.cast(S.revenge, () => this.getCurrentTarget(), () => {
        const execPhase = this.inExecutePhase();
        const ssCD = spell.getCooldown(S.shieldSlam);
        const ssOnCD = ssCD && ssCD.timeleft > 0;
        if (this.getRage() >= 80 && !execPhase) return true;
        if (this.hasRevengeProc() && execPhase && this.getRage() <= 18 && ssOnCD) return true;
        if (this.hasRevengeProc() && !execPhase) return true;
        return false;
      }),
      // wrecking_throw,if=talent.javelineer
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget(), () => spell.isSpellKnown(T.javelineer)),
      // shattering_throw,if=talent.javelineer
      spell.cast(S.shatteringThrow, () => this.getCurrentTarget(), () => spell.isSpellKnown(T.javelineer)),
      // revenge
      spell.cast(S.revenge, () => this.getCurrentTarget()),
      // devastate
      spell.cast(S.devastate, () => this.getCurrentTarget()),
    );
  }

  // =================================================================
  // MOUNTAIN THANE ST — 11 SimC lines
  // =================================================================
  thaneST() {
    return new bt.Selector(
      // thunder_blast
      spell.cast(S.thunderBlast, () => this.getCurrentTarget()),
      // thunder_clap,if=buff.ravager.up
      spell.cast(S.thunderClap, () => this.getCurrentTarget(), () => this.hasRavager()),
      // shield_slam
      spell.cast(S.shieldSlam, () => this.getCurrentTarget()),
      // thunder_clap
      spell.cast(S.thunderClap, () => this.getCurrentTarget()),
      // thunder_blast,if=(spell_targets>=1|cooldown.shield_slam.remains)
      // This is a second Thunder Blast check — for when it wasn't available first time
      spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => {
        const ssCD = spell.getCooldown(S.shieldSlam);
        return this.getEnemyCount() >= 1 || (ssCD && ssCD.timeleft > 0);
      }),
      // execute,if=buff.sudden_death.up|rage>=40
      spell.cast(S.execute, () => this.getCurrentTarget(), () => {
        return this.hasSuddenDeath() || this.getRage() >= 40;
      }),
      // wrecking_throw,if=talent.javelineer
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget(), () => spell.isSpellKnown(T.javelineer)),
      // shattering_throw,if=talent.javelineer
      spell.cast(S.shatteringThrow, () => this.getCurrentTarget(), () => spell.isSpellKnown(T.javelineer)),
      // revenge,if=rage>=80&!variable.execute_phase|buff.revenge.up&variable.execute_phase&rage<=18&cooldown.shield_slam.remains|buff.revenge.up&!variable.execute_phase
      spell.cast(S.revenge, () => this.getCurrentTarget(), () => {
        const execPhase = this.inExecutePhase();
        const ssCD = spell.getCooldown(S.shieldSlam);
        const ssOnCD = ssCD && ssCD.timeleft > 0;
        if (this.getRage() >= 80 && !execPhase) return true;
        if (this.hasRevengeProc() && execPhase && this.getRage() <= 18 && ssOnCD) return true;
        if (this.hasRevengeProc() && !execPhase) return true;
        return false;
      }),
      // revenge
      spell.cast(S.revenge, () => this.getCurrentTarget()),
      // devastate
      spell.cast(S.devastate, () => this.getCurrentTarget()),
    );
  }
}
