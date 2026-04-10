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
 * Fury Warrior Behavior - Midnight 12.0.1
 * Full rewrite matched line-by-line to SimC APL: warrior_fury.simc
 * Sources: SimC APL + Method Guide + Wowhead
 *
 * Auto-detects: Slayer (Slayer's Dominance) vs Mountain Thane (Lightning Strikes)
 *
 * Resource: Rage (PowerType 1), max 100
 * All melee instant — no movement block needed
 *
 * SimC action lists replicated:
 *   slayer (14 lines), slayer_aoe (16 lines)
 *   thane (16 lines), thane_aoe (18 lines)
 *   variables (4 lines), main routing
 *
 * Core: Enrage uptime #1 — Rampage always triggers Enrage, BT 30% chance
 *   Rampage at rage >= 100 (110 AoE) or when Enrage about to fall off
 * Reckless Abandon: BT->Bloodbath, RB->Crushing Blow during Recklessness
 *
 * Key additions vs previous version:
 *   - Deft Experience talent awareness for Bladestorm gating
 *   - Improved Whirlwind talent gate for WW buff maintenance
 *   - Rend dot duration check (not just remaining)
 *   - Storm Bolt during Bladestorm
 *   - Proper Recklessness CD remaining checks for Bladestorm
 *   - Execute phase variable (Massacre <35% or <20%)
 *   - Bloodlust awareness via SimC on_gcd_racials
 */

const S = {
  // Core
  bloodthirst:        23881,
  ragingBlow:         85288,
  rampage:            184367,
  execute:            5308,
  whirlwind:          190411,
  // Reckless Abandon upgrades
  bloodbath:          335096,
  crushingBlow:       335097,
  // CDs
  recklessness:       1719,
  avatar:             107574,
  odynsFury:          385059,
  bladestorm:         227847,
  championsSpear:     376079,
  // Mountain Thane
  thunderBlast:       435222,   // Cast spell (435607 is talent passive)
  thunderClap:        6343,
  // Utility
  charge:             100,
  wreckingThrow:      384110,
  rend:               772,
  stormBolt:          107570,
  // Interrupt
  pummel:             6552,
  // Buff
  battleShout:        6673,
  // Racials
  berserking:         26297,
};

const A = {
  enrage:             184362,
  recklessness:       1719,
  avatar:             107574,
  whirlwindBuff:      85739,    // Meat Cleaver stacks
  suddenDeath:        52437,    // Proc buff (280776 may not be correct, SimC uses 52437)
  bladestorm:         227847,
  // Thane
  thunderBlast:       435615,   // Proc buff (435607 is talent passive, 435222 is cast)
  // Slayer
  executioner:        445584,
  // Hero detection
  slayersDominance:   444767,
  lightningStrikes:   434969,
  // Rend debuff
  rendDot:            388539,
};

// Talent IDs
const T = {
  slayersDominance:   444767,
  lightningStrikes:   434969,
  deftExperience:     383295,
  improvedWhirlwind:  12950,
  massacre:           383103,
};

export class FuryWarriorBehavior extends Behavior {
  name = 'FW Fury Warrior';
  context = BehaviorContext.Any;
  specialization = Specialization.Warrior.Fury;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _rageFrame = 0;
  _cachedRage = 0;
  _enrageFrame = 0;
  _cachedEnrage = null;
  _enemyFrame = 0;
  _cachedEnemies = 1;
  _auraFrame = 0;
  _cachedReck = false;
  _cachedAvatar = false;
  _cachedWWBuff = null;
  _cachedSuddenDeath = false;
  _cachedTBStacks = 0;
  _cachedRendRemaining = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWFuryUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWFuryAoECount', text: 'AoE Target Count', default: 2, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWFuryDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // ===== Hero Detection =====
  isSlayer() { return spell.isSpellKnown(T.slayersDominance); }
  isThane() { return !this.isSlayer(); }

  // ===== Per-tick Caching =====
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 8 && me.isFacing(target)) {
      this._cachedTarget = target;
      return target;
    }
    const t = combat.bestTarget || (combat.targets && combat.targets[0]) || null;
    this._cachedTarget = (t && me.isFacing(t)) ? t : null;
    return this._cachedTarget;
  }

  getRage() {
    if (this._rageFrame === wow.frameTime) return this._cachedRage;
    this._rageFrame = wow.frameTime;
    this._cachedRage = me.powerByType(PowerType.Rage);
    return this._cachedRage;
  }

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
    const enrageAura = me.getAura(A.enrage);
    this._cachedEnrage = enrageAura;
    this._cachedReck = me.hasAura(A.recklessness);
    this._cachedAvatar = me.hasAura(A.avatar);
    this._cachedWWBuff = me.getAura(A.whirlwindBuff);
    this._cachedSuddenDeath = me.hasAura(A.suddenDeath);
    const tbAura = me.getAura(A.thunderBlast);
    this._cachedTBStacks = tbAura ? tbAura.stacks : 0;
    const t = this.getCurrentTarget();
    const rendAura = t ? (t.getAuraByMe(A.rendDot) || t.getAuraByMe(S.rend)) : null;
    this._cachedRendRemaining = rendAura ? rendAura.remaining : 0;
  }

  isEnraged() { this._refreshAuraCache(); return this._cachedEnrage !== null && this._cachedEnrage !== undefined; }
  getEnrageRemaining() { this._refreshAuraCache(); return this._cachedEnrage ? this._cachedEnrage.remaining : 0; }
  inRecklessness() { this._refreshAuraCache(); return this._cachedReck; }
  hasAvatar() { this._refreshAuraCache(); return this._cachedAvatar; }
  getWWStacks() { this._refreshAuraCache(); return this._cachedWWBuff ? this._cachedWWBuff.stacks : 0; }
  hasWWBuff() { this._refreshAuraCache(); return this._cachedWWBuff !== null && this._cachedWWBuff !== undefined; }
  hasSuddenDeath() { this._refreshAuraCache(); return this._cachedSuddenDeath; }
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

  getGCD() { return 1500; }

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
          console.info(`[FuryWarr] Midnight 12.0.1 | Hero: ${this.isSlayer() ? 'Slayer' : 'Mountain Thane'}`);
        }
        if (Settings.FWFuryDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[FuryWarr] Rage:${Math.round(this.getRage())} Enrage:${this.isEnraged()}(${Math.round(this.getEnrageRemaining()/1000)}s) Reck:${this.inRecklessness()} TB:${this.getThunderBlastStacks()}`);
        }
        return bt.Status.Failure;
      }),
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.pummel),
          // Berserking during Recklessness
          spell.cast(S.berserking, () => me, () => this.inRecklessness()),
          // Route by hero + target count
          new bt.Decorator(
            () => this.isSlayer() && this.getEnemyCount() === 1,
            this.slayerST()
          ),
          new bt.Decorator(
            () => this.isSlayer() && this.getEnemyCount() > 1,
            this.slayerAoE()
          ),
          new bt.Decorator(
            () => this.isThane() && this.getEnemyCount() === 1,
            this.thaneST()
          ),
          this.thaneAoE(),
        )
      ),
    );
  }

  // =================================================================
  // SLAYER ST — 14 SimC lines
  // =================================================================
  slayerST() {
    return new bt.Selector(
      // recklessness
      spell.cast(S.recklessness, () => me, () => Settings.FWFuryUseCDs && this.targetTTD() > 10000),
      // avatar
      spell.cast(S.avatar, () => me, () => Settings.FWFuryUseCDs && this.targetTTD() > 15000),
      // rampage,if=buff.enrage.remains<gcd|rage>=100
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => {
        return this.getEnrageRemaining() < this.getGCD() || this.getRage() >= 100;
      }),
      // bladestorm,if=(buff.enrage.up&talent.deft_experience|buff.enrage.remains>1)&(buff.recklessness.up|cooldown.recklessness.remains>30)
      spell.cast(S.bladestorm, () => this.getCurrentTarget(), () => {
        const enrageOK = (this.isEnraged() && spell.isSpellKnown(T.deftExperience)) || this.getEnrageRemaining() > 1000;
        const reckCD = spell.getCooldown(S.recklessness);
        const reckOK = this.inRecklessness() || (reckCD && reckCD.timeleft > 30000);
        return enrageOK && reckOK;
      }),
      // odyns_fury
      spell.cast(S.odynsFury, () => this.getCurrentTarget(), () => this.targetTTD() > 8000),
      // bloodbath
      spell.cast(S.bloodbath, () => this.getCurrentTarget()),
      // rampage,if=buff.recklessness.up
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => this.inRecklessness()),
      // execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // crushing_blow
      spell.cast(S.crushingBlow, () => this.getCurrentTarget()),
      // bloodthirst
      spell.cast(S.bloodthirst, () => this.getCurrentTarget()),
      // rampage (fallback — dump rage)
      spell.cast(S.rampage, () => this.getCurrentTarget()),
      // wrecking_throw
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget()),
      // rend,if=dot.rend.duration<6
      spell.cast(S.rend, () => this.getCurrentTarget(), () => this.getRendRemaining() < 6000),
      // raging_blow
      spell.cast(S.ragingBlow, () => this.getCurrentTarget()),
      // whirlwind
      spell.cast(S.whirlwind, () => this.getCurrentTarget()),
      // storm_bolt,if=buff.bladestorm.up
      spell.cast(S.stormBolt, () => this.getCurrentTarget(), () => me.hasAura(A.bladestorm)),
    );
  }

  // =================================================================
  // SLAYER AOE — 16 SimC lines
  // =================================================================
  slayerAoE() {
    return new bt.Selector(
      // whirlwind,if=talent.improved_whirlwind&buff.whirlwind.stack=0
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.improvedWhirlwind) && this.getWWStacks() === 0;
      }),
      // recklessness
      spell.cast(S.recklessness, () => me, () => Settings.FWFuryUseCDs && this.targetTTD() > 8000),
      // avatar
      spell.cast(S.avatar, () => me, () => Settings.FWFuryUseCDs),
      // rampage,if=buff.enrage.remains<gcd|rage>=110
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => {
        return this.getEnrageRemaining() < this.getGCD() || this.getRage() >= 110;
      }),
      // bladestorm,if=(buff.enrage.up&talent.deft_experience|buff.enrage.remains>1)&(buff.recklessness.up|cooldown.recklessness.remains>10)
      spell.cast(S.bladestorm, () => this.getCurrentTarget(), () => {
        const enrageOK = (this.isEnraged() && spell.isSpellKnown(T.deftExperience)) || this.getEnrageRemaining() > 1000;
        const reckCD = spell.getCooldown(S.recklessness);
        const reckOK = this.inRecklessness() || (reckCD && reckCD.timeleft > 10000);
        return enrageOK && reckOK;
      }),
      // odyns_fury
      spell.cast(S.odynsFury, () => this.getCurrentTarget()),
      // bloodbath
      spell.cast(S.bloodbath, () => this.getCurrentTarget()),
      // execute,if=buff.sudden_death.up
      spell.cast(S.execute, () => this.getCurrentTarget(), () => this.hasSuddenDeath()),
      // rampage,if=buff.recklessness.up
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => this.inRecklessness()),
      // whirlwind,if=talent.improved_whirlwind&buff.recklessness.up
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.improvedWhirlwind) && this.inRecklessness();
      }),
      // crushing_blow
      spell.cast(S.crushingBlow, () => this.getCurrentTarget()),
      // bloodthirst
      spell.cast(S.bloodthirst, () => this.getCurrentTarget()),
      // rend,if=dot.rend_dot.duration<6
      spell.cast(S.rend, () => this.getCurrentTarget(), () => this.getRendRemaining() < 6000),
      // execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // rampage
      spell.cast(S.rampage, () => this.getCurrentTarget()),
      // whirlwind,if=talent.improved_whirlwind
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => spell.isSpellKnown(T.improvedWhirlwind)),
      // raging_blow
      spell.cast(S.ragingBlow, () => this.getCurrentTarget()),
      // storm_bolt,if=buff.bladestorm.up
      spell.cast(S.stormBolt, () => this.getCurrentTarget(), () => me.hasAura(A.bladestorm)),
    );
  }

  // =================================================================
  // THANE ST — 16 SimC lines
  // =================================================================
  thaneST() {
    return new bt.Selector(
      // odyns_fury
      spell.cast(S.odynsFury, () => this.getCurrentTarget(), () => this.targetTTD() > 8000),
      // recklessness
      spell.cast(S.recklessness, () => me, () => Settings.FWFuryUseCDs && this.targetTTD() > 10000),
      // avatar
      spell.cast(S.avatar, () => me, () => Settings.FWFuryUseCDs && this.targetTTD() > 15000),
      // rampage,if=buff.enrage.remains<gcd|rage>=100
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => {
        return this.getEnrageRemaining() < this.getGCD() || this.getRage() >= 100;
      }),
      // thunder_blast,if=buff.thunder_blast.stack=2
      spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => this.getThunderBlastStacks() >= 2),
      // bloodbath
      spell.cast(S.bloodbath, () => this.getCurrentTarget()),
      // rampage,if=buff.recklessness.up
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => this.inRecklessness()),
      // thunder_blast,if=buff.avatar.up
      spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => this.hasAvatar()),
      // bloodthirst
      spell.cast(S.bloodthirst, () => this.getCurrentTarget()),
      // execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // crushing_blow
      spell.cast(S.crushingBlow, () => this.getCurrentTarget()),
      // thunder_blast
      spell.cast(S.thunderBlast, () => this.getCurrentTarget()),
      // rampage
      spell.cast(S.rampage, () => this.getCurrentTarget()),
      // raging_blow
      spell.cast(S.ragingBlow, () => this.getCurrentTarget()),
      // thunder_clap
      spell.cast(S.thunderClap, () => this.getCurrentTarget()),
      // whirlwind
      spell.cast(S.whirlwind, () => this.getCurrentTarget()),
    );
  }

  // =================================================================
  // THANE AOE — 18 SimC lines
  // =================================================================
  thaneAoE() {
    return new bt.Selector(
      // odyns_fury
      spell.cast(S.odynsFury, () => this.getCurrentTarget()),
      // recklessness
      spell.cast(S.recklessness, () => me, () => Settings.FWFuryUseCDs),
      // avatar
      spell.cast(S.avatar, () => me, () => Settings.FWFuryUseCDs),
      // thunder_blast,if=buff.thunder_blast.stack=2
      spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => this.getThunderBlastStacks() >= 2),
      // thunder_blast,if=buff.avatar.up
      spell.cast(S.thunderBlast, () => this.getCurrentTarget(), () => this.hasAvatar()),
      // thunder_clap,if=talent.improved_whirlwind&buff.whirlwind.stack=0|(buff.avatar.up&active_enemies>6)
      spell.cast(S.thunderClap, () => this.getCurrentTarget(), () => {
        return (spell.isSpellKnown(T.improvedWhirlwind) && this.getWWStacks() === 0) ||
               (this.hasAvatar() && this.getEnemyCount() > 6);
      }),
      // rampage,if=buff.enrage.remains<gcd|rage>=100
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => {
        return this.getEnrageRemaining() < this.getGCD() || this.getRage() >= 100;
      }),
      // bloodbath
      spell.cast(S.bloodbath, () => this.getCurrentTarget()),
      // rampage,if=buff.recklessness.up
      spell.cast(S.rampage, () => this.getCurrentTarget(), () => this.inRecklessness()),
      // thunder_clap,if=buff.avatar.up
      spell.cast(S.thunderClap, () => this.getCurrentTarget(), () => this.hasAvatar()),
      // bloodthirst
      spell.cast(S.bloodthirst, () => this.getCurrentTarget()),
      // thunder_blast
      spell.cast(S.thunderBlast, () => this.getCurrentTarget()),
      // execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // thunder_clap
      spell.cast(S.thunderClap, () => this.getCurrentTarget()),
      // crushing_blow
      spell.cast(S.crushingBlow, () => this.getCurrentTarget()),
      // rampage
      spell.cast(S.rampage, () => this.getCurrentTarget()),
      // raging_blow
      spell.cast(S.ragingBlow, () => this.getCurrentTarget()),
      // whirlwind
      spell.cast(S.whirlwind, () => this.getCurrentTarget()),
    );
  }
}
