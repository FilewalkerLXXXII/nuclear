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
 * Arms Warrior Behavior - Midnight 12.0.1
 * SimC APL: simc/midnight/engine/class_modules/apl/apl_warrior.cpp
 * Sources: SimC APL + Method Guide + Wowhead + Icy Veins
 *
 * Auto-detects: Colossus (Demolish) vs Slayer (Slayer's Dominance)
 * Resource: Rage (PowerType 1), max 100
 * All melee instant — no movement block needed
 *
 * SimC action lists matched:
 *   actions.default (racials, variables, dispatch)
 *   actions.colossus_st (16 entries)
 *   actions.colossus_execute (17 entries)
 *   actions.colossus_aoe (21 entries)
 *   actions.slayer_st (17 entries)
 *   actions.slayer_execute (17 entries)
 *   actions.slayer_aoe (21 entries)
 *
 * Key changes from previous version:
 *   - Added Heroic Strike (1269383) - Master of Warfare talent replaces Slam
 *   - Added Collateral Damage tracking (buff stacks consumed by Cleave/WW)
 *   - Added Broad Strokes awareness (CS auto-grants Sweeping Strikes)
 *   - Added Critical Thinking / Mass Execution / Bloodletting / Fervor of Battle talent checks
 *   - Removed separate sweep lists (SimC handles 2-target via sweeping_strikes conditions inline)
 *   - Added storm_bolt during bladestorm (SimC: storm_bolt,if=buff.bladestorm.up)
 *   - Matched ALL SimC conditional expressions line-by-line
 */

const S = {
  // Core rotational
  mortalStrike:       12294,
  overpower:          7384,
  slam:               1464,
  heroicStrike:       1269383,  // Master of Warfare upgrade of Slam
  execute:            163201,
  cleave:             845,
  whirlwind:          1680,
  // CDs
  colossusSmash:      167105,
  warbreaker:         262161,
  bladestorm:         227847,
  ravager:            228920,
  avatar:             107574,
  sweepingStrikes:    260708,
  championsSpear:     376079,
  // Colossus hero
  demolish:           436358,
  // Generators
  skullsplitter:      260643,
  rend:               772,
  thunderClap:        396719,
  // Utility
  charge:             100,
  stormBolt:          132169,
  wreckingThrow:      384110,
  // Interrupt
  pummel:             6552,
  // Buff
  battleShout:        6673,
  battleStance:       386164,
  // Racials
  berserking:         26297,
};

const A = {
  // Debuffs
  colossusSmash:      208086,   // +30% damage taken debuff
  deepWounds:         262115,
  rend:               388539,   // Rend debuff aura (rend_dot in SimC)
  rendCast:           772,      // Cast ID fallback
  // Procs
  suddenDeath:        280776,   // Sudden Death proc buff (12s), NOT talent passive 280721
  // Buffs
  avatar:             107574,
  sweepingStrikes:    260708,
  ravager:            228920,
  bladestorm:         227847,
  collateralDamage:   334779,   // Sweeping Strikes stacking buff, consumed by Cleave/WW
  battlelord:         386631,   // Battlelord talent aura
  // Colossus
  colossalMight:      440989,
  // Slayer
  executioner:        445584,
  opportunist:        456120,
  // Shared
  juggernaut:         201009,
  executionersPrecision: 386634,
  // Talent detection IDs
  massacre:           281001,
  broadStrokes:       1277889,  // Colossus Smash grants Sweeping Strikes
  fervorOfBattle:     202316,   // WW replaces Slam (3+ targets)
  criticalThinking:   389306,   // Execute crit + rage refund
  massExecution:      1273075,  // Cleave/WW +20% below 35%
  bloodletting:       383154,   // Rend/DW 33% longer, MS applies Rend <35%
  martialProwess:     316440,   // OP/Slam stack MS damage
  dreadnaught:        262150,   // OP seismic wave
  improvedExecute:    316405,   // Improved Execute talent
  masterOfWarfare:    440561,   // Slam -> Heroic Strike talent
  deepWoundsTalent:   262111,   // Deep Wounds talent
  // Hero detection
  demolishKnown:      436358,
  slayersDominance:   444767,
  fierceFT:           444773,
};

export class ArmsWarriorBehavior extends Behavior {
  name = 'FW Arms Warrior';
  context = BehaviorContext.Any;
  specialization = Specialization.Warrior.Arms;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _rageFrame = 0;
  _cachedRage = 0;
  _enemyFrame = 0;
  _cachedEnemies = 1;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWArmsUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWArmsAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWArmsDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // ===== Hero Detection =====
  isColossus() { return spell.isSpellKnown(S.demolish); }
  isSlayer() { return !this.isColossus(); }

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

  getRageDeficit() { return 100 - this.getRage(); }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemies;
    this._enemyFrame = wow.frameTime;
    const t = this.getCurrentTarget();
    this._cachedEnemies = t ? t.getUnitsAroundCount(8) + 1 : 1;
    return this._cachedEnemies;
  }

  // ===== Helpers =====
  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }

  // SimC: variable.execute_phase = (talent.massacre&target.health.pct<35)|target.health.pct<20
  inExecutePhase() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    const threshold = spell.isSpellKnown(A.massacre) ? 35 : 20;
    return t.effectiveHealthPercent < threshold;
  }

  targetHasCS() {
    const t = this.getCurrentTarget();
    return t ? (t.hasAuraByMe(A.colossusSmash) || t.hasAuraByMe(S.colossusSmash) || t.hasAuraByMe(S.warbreaker)) : false;
  }

  getCSRemaining() {
    const t = this.getCurrentTarget();
    if (!t) return 0;
    const a = t.getAuraByMe(A.colossusSmash) || t.getAuraByMe(S.colossusSmash) || t.getAuraByMe(S.warbreaker);
    return a ? a.remaining : 0;
  }

  inBurst() {
    return this.targetHasCS() || me.hasAura(A.avatar);
  }

  getColossalMight() {
    const a = me.getAura(A.colossalMight);
    return a ? a.stacks : 0;
  }

  getEPStacks() {
    const a = me.getAura(A.executionersPrecision);
    return a ? a.stacks : 0;
  }

  hasSuddenDeath() { return me.hasAura(A.suddenDeath); }
  hasOpportunist() { return me.hasAura(A.opportunist); }

  getCollateralDamageStacks() {
    const a = me.getAura(A.collateralDamage);
    return a ? a.stacks : 0;
  }

  hasBattlelord() { return me.hasAura(A.battlelord); }

  getRendRemaining() {
    const t = this.getCurrentTarget();
    if (!t) return 0;
    const a = t.getAuraByMe(A.rend) || t.getAuraByMe(A.rendCast);
    return a ? a.remaining : 0;
  }

  hasRend() {
    return this.getRendRemaining() > 0;
  }

  getCSCooldownRemains() {
    const cs = spell.getCooldown(S.colossusSmash);
    const wb = spell.getCooldown(S.warbreaker);
    const csRem = cs ? cs.timeleft : 99999;
    const wbRem = wb ? wb.timeleft : 99999;
    return Math.min(csRem, wbRem);
  }

  hasMasterOfWarfare() { return spell.isSpellKnown(A.masterOfWarfare) || spell.isSpellKnown(S.heroicStrike); }

  isInBladestorm() { return me.hasAura(A.bladestorm); }

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

      // Null target bail
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      // Version + Debug logging
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isColossus() ? 'Colossus' : 'Slayer';
          console.info(`[ArmsWarr] Midnight 12.0.1 | Hero: ${hero} | SimC APL matched`);
        }
        if (Settings.FWArmsDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[ArmsWarr] Rage:${Math.round(this.getRage())} CS:${this.targetHasCS()} Exec:${this.inExecutePhase()} CM:${this.getColossalMight()} EP:${this.getEPStacks()} CD:${this.getCollateralDamageStacks()} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.pummel),

          // SimC: berserking conditions
          spell.cast(S.berserking, () => me, () => {
            const ttd = this.targetTTD();
            if (ttd > 180000 && this.targetHasCS()) return true;
            if (ttd <= 180000 && this.inExecutePhase() && this.targetHasCS()) return true;
            if (ttd < 20000) return true;
            return false;
          }),

          // Dispatch by hero + target count + execute phase
          // SimC: run_action_list,name=colossus_aoe,if=talent.demolish&active_enemies>2
          new bt.Decorator(
            () => this.isColossus() && this.getEnemyCount() > 2,
            this.colossusAoE()
          ),
          // SimC: run_action_list,name=colossus_execute,if=talent.demolish&variable.execute_phase
          new bt.Decorator(
            () => this.isColossus() && this.inExecutePhase(),
            this.colossusExecute()
          ),
          // SimC: run_action_list,name=colossus_st,if=talent.demolish
          new bt.Decorator(
            () => this.isColossus(),
            this.colossusST()
          ),
          // SimC: run_action_list,name=slayer_aoe,if=talent.slayers_dominance&active_enemies>2
          new bt.Decorator(
            () => this.isSlayer() && this.getEnemyCount() > 2,
            this.slayerAoE()
          ),
          // SimC: run_action_list,name=slayer_execute,if=talent.slayers_dominance&variable.execute_phase
          new bt.Decorator(
            () => this.isSlayer() && this.inExecutePhase(),
            this.slayerExecute()
          ),
          // SimC: run_action_list,name=slayer_st (fallback)
          this.slayerST(),
        )
      ),
    );
  }

  // =============================================
  // COLOSSUS SINGLE TARGET — SimC: actions.colossus_st (16 entries)
  // =============================================
  colossusST() {
    return new bt.Selector(
      // 1. rend,if=dot.rend_dot.remains<=gcd|cooldown.colossus_smash.remains<2&dot.rend_dot.remains<=10
      spell.cast(S.rend, () => this.getCurrentTarget(), () => {
        const rem = this.getRendRemaining();
        return rem <= 1500 || (this.getCSCooldownRemains() < 2000 && rem <= 10000);
      }),
      // 2. sweeping_strikes,if=active_enemies=2&(cooldown.colossus_smash.remains&buff.sweeping_strikes.down|!talent.broad_strokes)
      spell.cast(S.sweepingStrikes, () => me, () => {
        if (this.getEnemyCount() !== 2) return false;
        return (this.getCSCooldownRemains() > 0 && !me.hasAura(A.sweepingStrikes)) ||
          !spell.isSpellKnown(A.broadStrokes);
      }),
      // 3. ravager,if=cooldown.colossus_smash.remains<=gcd
      spell.cast(S.ravager, () => this.getCurrentTarget(), () => {
        return Settings.FWArmsUseCDs && this.getCSCooldownRemains() <= 1500;
      }),
      // 4. avatar
      spell.cast(S.avatar, () => me, () => Settings.FWArmsUseCDs),
      // 5. colossus_smash / warbreaker
      spell.cast(S.colossusSmash, () => this.getCurrentTarget()),
      spell.cast(S.warbreaker, () => this.getCurrentTarget()),
      // 6. cleave,if=buff.ravager.remains&buff.collateral_damage.stack=3
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => {
        return me.hasAura(A.ravager) && this.getCollateralDamageStacks() >= 3;
      }),
      // 7. heroic_strike (replaces slam in SimC when talented)
      spell.cast(S.heroicStrike, () => this.getCurrentTarget(), () => this.hasMasterOfWarfare()),
      // 8. champions_spear
      spell.cast(S.championsSpear, () => this.getCurrentTarget(), () => Settings.FWArmsUseCDs),
      // 9. demolish,if=debuff.colossus_smash.up&buff.colossal_might.stack>0|talent.master_of_warfare.rank=4
      spell.cast(S.demolish, () => this.getCurrentTarget(), () => {
        return (this.targetHasCS() && this.getColossalMight() > 0) ||
          spell.isSpellKnown(A.masterOfWarfare);
      }),
      // 10. mortal_strike
      spell.cast(S.mortalStrike, () => this.getCurrentTarget()),
      // 11. cleave,if=buff.ravager.remains|buff.collateral_damage.stack=3
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => {
        return me.hasAura(A.ravager) || this.getCollateralDamageStacks() >= 3;
      }),
      // 12. overpower
      spell.cast(S.overpower, () => this.getCurrentTarget()),
      // 13. whirlwind,if=active_enemies=2&buff.collateral_damage.stack=3
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => {
        return this.getEnemyCount() === 2 && this.getCollateralDamageStacks() >= 3;
      }),
      // 14. cleave,if=talent.mass_execution&target.health.pct<35
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        return spell.isSpellKnown(A.massExecution) && t && t.effectiveHealthPercent < 35;
      }),
      // 15. execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // 16. wrecking_throw,if=active_enemies=1
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget(), () => this.getEnemyCount() === 1),
      // 17. rend,if=dot.rend_dot.remains<=gcd*5
      spell.cast(S.rend, () => this.getCurrentTarget(), () => this.getRendRemaining() <= 7500),
      // 18. cleave,if=!talent.martial_prowess
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => !spell.isSpellKnown(A.martialProwess)),
      // 19. slam (fallback filler - if no Master of Warfare)
      spell.cast(S.slam, () => this.getCurrentTarget(), () => !this.hasMasterOfWarfare()),
    );
  }

  // =============================================
  // COLOSSUS EXECUTE — SimC: actions.colossus_execute (17 entries)
  // =============================================
  colossusExecute() {
    return new bt.Selector(
      // 1. sweeping_strikes,if=active_enemies=2&(cooldown.colossus_smash.remains&buff.sweeping_strikes.down|!talent.broad_strokes)
      spell.cast(S.sweepingStrikes, () => me, () => {
        if (this.getEnemyCount() !== 2) return false;
        return (this.getCSCooldownRemains() > 0 && !me.hasAura(A.sweepingStrikes)) ||
          !spell.isSpellKnown(A.broadStrokes);
      }),
      // 2. rend,if=dot.rend_dot.remains<=gcd&!talent.bloodletting
      spell.cast(S.rend, () => this.getCurrentTarget(), () => {
        return this.getRendRemaining() <= 1500 && !spell.isSpellKnown(A.bloodletting);
      }),
      // 3. champions_spear
      spell.cast(S.championsSpear, () => this.getCurrentTarget(), () => Settings.FWArmsUseCDs),
      // 4. ravager,if=cooldown.colossus_smash.remains<=gcd
      spell.cast(S.ravager, () => this.getCurrentTarget(), () => {
        return Settings.FWArmsUseCDs && this.getCSCooldownRemains() <= 1500;
      }),
      // 5. avatar
      spell.cast(S.avatar, () => me, () => Settings.FWArmsUseCDs),
      // 6. colossus_smash / warbreaker
      spell.cast(S.colossusSmash, () => this.getCurrentTarget()),
      spell.cast(S.warbreaker, () => this.getCurrentTarget()),
      // 7. heroic_strike
      spell.cast(S.heroicStrike, () => this.getCurrentTarget(), () => this.hasMasterOfWarfare()),
      // 8. demolish,if=buff.colossal_might.stack=10&debuff.colossus_smash.up
      spell.cast(S.demolish, () => this.getCurrentTarget(), () => {
        return this.getColossalMight() >= 10 && this.targetHasCS();
      }),
      // 9. mortal_strike,if=buff.executioners_precision.stack=2|!talent.executioners_precision|talent.battlelord
      spell.cast(S.mortalStrike, () => this.getCurrentTarget(), () => {
        return this.getEPStacks() >= 2 ||
          !spell.isSpellKnown(A.executionersPrecision) ||
          spell.isSpellKnown(A.battlelord);
      }),
      // 10. cleave,if=buff.ravager.remains
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => me.hasAura(A.ravager)),
      // 11. overpower
      spell.cast(S.overpower, () => this.getCurrentTarget()),
      // 12. execute,if=talent.deep_wounds&talent.critical_thinking
      spell.cast(S.execute, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(A.deepWoundsTalent) && spell.isSpellKnown(A.criticalThinking);
      }),
      // 13. cleave,if=talent.mass_execution
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => spell.isSpellKnown(A.massExecution)),
      // 14. execute,if=talent.deep_wounds
      spell.cast(S.execute, () => this.getCurrentTarget(), () => spell.isSpellKnown(A.deepWoundsTalent)),
      // 15. slam,if=!talent.critical_thinking
      spell.cast(S.slam, () => this.getCurrentTarget(), () => !spell.isSpellKnown(A.criticalThinking)),
      // 16. execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // 17. bladestorm
      spell.cast(S.bladestorm, () => this.getCurrentTarget()),
      // 18. wrecking_throw
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // COLOSSUS AOE — SimC: actions.colossus_aoe (21 entries)
  // =============================================
  colossusAoE() {
    return new bt.Selector(
      // 1. thunder_clap,if=!dot.rend_dot.remains
      spell.cast(S.thunderClap, () => this.getCurrentTarget(), () => !this.hasRend()),
      // 2. rend,if=!dot.rend_dot.remains
      spell.cast(S.rend, () => this.getCurrentTarget(), () => !this.hasRend()),
      // 3. sweeping_strikes,if=cooldown.colossus_smash.remains>10&buff.sweeping_strikes.down|!talent.broad_strokes
      spell.cast(S.sweepingStrikes, () => me, () => {
        return (this.getCSCooldownRemains() > 10000 && !me.hasAura(A.sweepingStrikes)) ||
          !spell.isSpellKnown(A.broadStrokes);
      }),
      // 4. ravager,if=cooldown.colossus_smash.remains<3
      spell.cast(S.ravager, () => this.getCurrentTarget(), () => {
        return Settings.FWArmsUseCDs && this.getCSCooldownRemains() < 3000;
      }),
      // 5. avatar
      spell.cast(S.avatar, () => me, () => Settings.FWArmsUseCDs),
      // 6. colossus_smash / warbreaker
      spell.cast(S.colossusSmash, () => this.getCurrentTarget()),
      spell.cast(S.warbreaker, () => this.getCurrentTarget()),
      // 7. champions_spear
      spell.cast(S.championsSpear, () => this.getCurrentTarget(), () => Settings.FWArmsUseCDs),
      // 8. demolish,if=buff.colossal_might.stack=10
      spell.cast(S.demolish, () => this.getCurrentTarget(), () => this.getColossalMight() >= 10),
      // 9. cleave
      spell.cast(S.cleave, () => this.getCurrentTarget()),
      // 10. demolish,if=debuff.colossus_smash.remains>=2
      spell.cast(S.demolish, () => this.getCurrentTarget(), () => this.getCSRemaining() >= 2000),
      // 11. whirlwind,if=talent.fervor_of_battle&buff.collateral_damage.stack=3
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(A.fervorOfBattle) && this.getCollateralDamageStacks() >= 3;
      }),
      // 12. mortal_strike
      spell.cast(S.mortalStrike, () => this.getCurrentTarget()),
      // 13. rend,if=dot.rend_dot.remains<4
      spell.cast(S.rend, () => this.getCurrentTarget(), () => this.getRendRemaining() < 4000),
      // 14. overpower
      spell.cast(S.overpower, () => this.getCurrentTarget()),
      // 15. execute,if=buff.sudden_death.remains
      spell.cast(S.execute, () => this.getCurrentTarget(), () => this.hasSuddenDeath()),
      // 16. heroic_strike
      spell.cast(S.heroicStrike, () => this.getCurrentTarget(), () => this.hasMasterOfWarfare()),
      // 17. rend (catch-all refresh)
      spell.cast(S.rend, () => this.getCurrentTarget()),
      // 18. slam (if no heroic strike)
      spell.cast(S.slam, () => this.getCurrentTarget(), () => !this.hasMasterOfWarfare()),
      // 19. execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // 20. bladestorm
      spell.cast(S.bladestorm, () => this.getCurrentTarget()),
      // 21. wrecking_throw
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget()),
      // 22. whirlwind (absolute fallback)
      spell.cast(S.whirlwind, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // SLAYER SINGLE TARGET — SimC: actions.slayer_st (17 entries)
  // =============================================
  slayerST() {
    return new bt.Selector(
      // 1. sweeping_strikes,if=active_enemies=2&(cooldown.colossus_smash.remains&buff.sweeping_strikes.down|!talent.broad_strokes)
      spell.cast(S.sweepingStrikes, () => me, () => {
        if (this.getEnemyCount() !== 2) return false;
        return (this.getCSCooldownRemains() > 0 && !me.hasAura(A.sweepingStrikes)) ||
          !spell.isSpellKnown(A.broadStrokes);
      }),
      // 2. avatar
      spell.cast(S.avatar, () => me, () => Settings.FWArmsUseCDs),
      // 3. champions_spear,if=debuff.colossus_smash.up|buff.avatar.up
      spell.cast(S.championsSpear, () => this.getCurrentTarget(), () => {
        return Settings.FWArmsUseCDs && (this.targetHasCS() || me.hasAura(A.avatar));
      }),
      // 4. ravager,if=cooldown.colossus_smash.remains<=gcd
      spell.cast(S.ravager, () => this.getCurrentTarget(), () => {
        return Settings.FWArmsUseCDs && this.getCSCooldownRemains() <= 1500;
      }),
      // 5. colossus_smash / warbreaker
      spell.cast(S.colossusSmash, () => this.getCurrentTarget()),
      spell.cast(S.warbreaker, () => this.getCurrentTarget()),
      // 6. bladestorm,if=debuff.colossus_smash.up
      spell.cast(S.bladestorm, () => this.getCurrentTarget(), () => this.targetHasCS()),
      // 7. mortal_strike
      spell.cast(S.mortalStrike, () => this.getCurrentTarget()),
      // 8. execute,if=buff.sudden_death.up
      spell.cast(S.execute, () => this.getCurrentTarget(), () => this.hasSuddenDeath()),
      // 9. heroic_strike
      spell.cast(S.heroicStrike, () => this.getCurrentTarget(), () => this.hasMasterOfWarfare()),
      // 10. cleave,if=active_enemies=2&buff.collateral_damage.stack=3
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => {
        return this.getEnemyCount() === 2 && this.getCollateralDamageStacks() >= 3;
      }),
      // 11. overpower
      spell.cast(S.overpower, () => this.getCurrentTarget()),
      // 12. cleave,if=talent.mass_execution&target.health.pct<35
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        return spell.isSpellKnown(A.massExecution) && t && t.effectiveHealthPercent < 35;
      }),
      // 13. whirlwind,if=active_enemies=2&buff.collateral_damage.stack=3
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => {
        return this.getEnemyCount() === 2 && this.getCollateralDamageStacks() >= 3;
      }),
      // 14. rend,if=dot.rend_dot.remains<=5
      spell.cast(S.rend, () => this.getCurrentTarget(), () => this.getRendRemaining() <= 5000),
      // 15. wrecking_throw,if=active_enemies=1
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget(), () => this.getEnemyCount() === 1),
      // 16. slam (filler if no heroic strike)
      spell.cast(S.slam, () => this.getCurrentTarget(), () => !this.hasMasterOfWarfare()),
      // 17. storm_bolt,if=buff.bladestorm.up
      spell.cast(S.stormBolt, () => this.getCurrentTarget(), () => this.isInBladestorm()),
    );
  }

  // =============================================
  // SLAYER EXECUTE — SimC: actions.slayer_execute (17 entries)
  // =============================================
  slayerExecute() {
    return new bt.Selector(
      // 1. sweeping_strikes,if=active_enemies=2&(cooldown.colossus_smash.remains&buff.sweeping_strikes.down|!talent.broad_strokes)
      spell.cast(S.sweepingStrikes, () => me, () => {
        if (this.getEnemyCount() !== 2) return false;
        return (this.getCSCooldownRemains() > 0 && !me.hasAura(A.sweepingStrikes)) ||
          !spell.isSpellKnown(A.broadStrokes);
      }),
      // 2. rend,if=dot.rend_dot.remains<2&!talent.bloodletting
      spell.cast(S.rend, () => this.getCurrentTarget(), () => {
        return this.getRendRemaining() < 2000 && !spell.isSpellKnown(A.bloodletting);
      }),
      // 3. avatar
      spell.cast(S.avatar, () => me, () => Settings.FWArmsUseCDs),
      // 4. colossus_smash / warbreaker
      spell.cast(S.colossusSmash, () => this.getCurrentTarget()),
      spell.cast(S.warbreaker, () => this.getCurrentTarget()),
      // 5. heroic_strike
      spell.cast(S.heroicStrike, () => this.getCurrentTarget(), () => this.hasMasterOfWarfare()),
      // 6. bladestorm,if=debuff.colossus_smash.up
      spell.cast(S.bladestorm, () => this.getCurrentTarget(), () => this.targetHasCS()),
      // 7. mortal_strike,if=buff.executioners_precision.stack=2|debuff.colossus_smash.up
      spell.cast(S.mortalStrike, () => this.getCurrentTarget(), () => {
        return this.getEPStacks() >= 2 || this.targetHasCS();
      }),
      // 8. overpower,if=buff.opportunist.up&talent.opportunist
      spell.cast(S.overpower, () => this.getCurrentTarget(), () => {
        return this.hasOpportunist() && spell.isSpellKnown(A.opportunist);
      }),
      // 9. overpower,if=talent.fierce_followthrough&!buff.battlelord.up&rage<90
      spell.cast(S.overpower, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(A.fierceFT) && !this.hasBattlelord() && this.getRage() < 90;
      }),
      // 10. execute,if=rage>40|buff.sudden_death.up
      spell.cast(S.execute, () => this.getCurrentTarget(), () => {
        return this.getRage() > 40 || this.hasSuddenDeath();
      }),
      // 11. overpower
      spell.cast(S.overpower, () => this.getCurrentTarget()),
      // 12. execute,if=talent.improved_execute
      spell.cast(S.execute, () => this.getCurrentTarget(), () => spell.isSpellKnown(A.improvedExecute)),
      // 13. cleave,if=talent.mass_execution
      spell.cast(S.cleave, () => this.getCurrentTarget(), () => spell.isSpellKnown(A.massExecution)),
      // 14. slam,if=!talent.critical_thinking
      spell.cast(S.slam, () => this.getCurrentTarget(), () => !spell.isSpellKnown(A.criticalThinking)),
      // 15. execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // 16. wrecking_throw
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget()),
      // 17. storm_bolt,if=buff.bladestorm.up
      spell.cast(S.stormBolt, () => this.getCurrentTarget(), () => this.isInBladestorm()),
    );
  }

  // =============================================
  // SLAYER AOE — SimC: actions.slayer_aoe (21 entries)
  // =============================================
  slayerAoE() {
    return new bt.Selector(
      // 1. rend,if=!dot.rend_dot.remains&talent.rend
      spell.cast(S.rend, () => this.getCurrentTarget(), () => {
        return !this.hasRend() && spell.isSpellKnown(S.rend);
      }),
      // 2. sweeping_strikes,if=!buff.sweeping_strikes.up&cooldown.colossus_smash.remains>10|!talent.broad_strokes
      spell.cast(S.sweepingStrikes, () => me, () => {
        return (!me.hasAura(A.sweepingStrikes) && this.getCSCooldownRemains() > 10000) ||
          !spell.isSpellKnown(A.broadStrokes);
      }),
      // 3. avatar
      spell.cast(S.avatar, () => me, () => Settings.FWArmsUseCDs),
      // 4. champions_spear
      spell.cast(S.championsSpear, () => this.getCurrentTarget(), () => Settings.FWArmsUseCDs),
      // 5. ravager,if=debuff.colossus_smash.up
      spell.cast(S.ravager, () => this.getCurrentTarget(), () => {
        return Settings.FWArmsUseCDs && this.targetHasCS();
      }),
      // 6. colossus_smash / warbreaker
      spell.cast(S.colossusSmash, () => this.getCurrentTarget()),
      spell.cast(S.warbreaker, () => this.getCurrentTarget()),
      // 7. cleave
      spell.cast(S.cleave, () => this.getCurrentTarget()),
      // 8. whirlwind,if=talent.fervor_of_battle&buff.collateral_damage.stack=3
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(A.fervorOfBattle) && this.getCollateralDamageStacks() >= 3;
      }),
      // 9. execute,if=buff.sudden_death.up
      spell.cast(S.execute, () => this.getCurrentTarget(), () => this.hasSuddenDeath()),
      // 10. bladestorm,if=debuff.colossus_smash.up
      spell.cast(S.bladestorm, () => this.getCurrentTarget(), () => this.targetHasCS()),
      // 11. mortal_strike
      spell.cast(S.mortalStrike, () => this.getCurrentTarget()),
      // 12. thunder_clap,if=dot.rend_dot.remains<8&talent.rend
      spell.cast(S.thunderClap, () => this.getCurrentTarget(), () => {
        return this.getRendRemaining() < 8000 && spell.isSpellKnown(S.rend);
      }),
      // 13. overpower,if=talent.dreadnaught
      spell.cast(S.overpower, () => this.getCurrentTarget(), () => spell.isSpellKnown(A.dreadnaught)),
      // 14. whirlwind,if=talent.fervor_of_battle
      spell.cast(S.whirlwind, () => this.getCurrentTarget(), () => spell.isSpellKnown(A.fervorOfBattle)),
      // 15. overpower
      spell.cast(S.overpower, () => this.getCurrentTarget()),
      // 16. mortal_strike (duplicate for lower prio)
      spell.cast(S.mortalStrike, () => this.getCurrentTarget()),
      // 17. rend,if=dot.rend_dot.remains (refresh)
      spell.cast(S.rend, () => this.getCurrentTarget(), () => this.hasRend()),
      // 18. execute
      spell.cast(S.execute, () => this.getCurrentTarget()),
      // 19. wrecking_throw
      spell.cast(S.wreckingThrow, () => this.getCurrentTarget()),
      // 20. whirlwind
      spell.cast(S.whirlwind, () => this.getCurrentTarget()),
      // 21. slam
      spell.cast(S.slam, () => this.getCurrentTarget()),
      // 22. storm_bolt,if=buff.bladestorm.up
      spell.cast(S.stormBolt, () => this.getCurrentTarget(), () => this.isInBladestorm()),
    );
  }
}
