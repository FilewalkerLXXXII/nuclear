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
 * Outlaw Rogue Behavior - Midnight 12.0.1
 * Line-by-line match to SimC APL (midnight branch):
 *   actions (default), actions.cds, actions.build, actions.finish
 *
 * Auto-detects: Fatebound (452536) vs Trickster (441146)
 * Resource: Energy (PowerType 3) + Combo Points (PowerType 4)
 * All melee instant + Pistol Shot (ranged) -- no movement block needed
 *
 * Key mechanics:
 *   - Roll the Bones stage management (reroll at stage 1, KIR at stage 2+)
 *   - Adrenaline Rush burst + Improved AR sync
 *   - Hidden Opportunity talent: Ambush > Pistol Shot > SS
 *   - Fan the Hammer: Opportunity stack/expiry management
 *   - Fatebound: finish at cp_max-2 when BtE not ready, Preparation CD reset
 *   - Trickster: Coup de Grace with Disorienting Strikes
 *   - Blade Flurry AoE toggle + Deft Maneuvers CP gen
 *   - Supercharger + Zero In: hold BtE for upcoming AR
 *   - Blade Rush: 4pc set bonus tracking + energy management
 *   - Bloodlust-aware potion timing
 */

const S = {
  // Builders
  sinisterStrike:     193315,
  ambush:             8676,
  pistolShot:         185763,
  // Finishers
  dispatch:           2098,
  betweenTheEyes:     315341,
  killingSpree:       51690,
  coupDeGrace:        441776,
  // Buffs / CDs
  bladeFlurry:        13877,
  rollTheBones:       315508,
  sliceAndDice:       315496,
  adrenalineRush:     13750,
  keepItRolling:      381989,
  bladeRush:          271877,
  preparation:        1277933,
  coldBlood:          382245,
  thistleTea:         381623,
  vanish:             1856,
  stealth:            1784,
  // Utility
  kick:               1766,
  shadowstep:         36554,
  berserking:         26297,
};

const A = {
  // Self buffs
  adrenalineRush:     13750,
  bladeFlurry:        13877,
  sliceAndDice:       315496,
  rollTheBones:       315508,
  coldBlood:          382245,
  vanishBuff:         11327,
  subterfuge:         115192,
  stealth:            1784,
  // RtB individual buffs
  broadside:          193356,
  ruthlessPrecision:  193357,
  grandMelee:         193358,
  trueBearing:        193359,
  buriedTreasure:     199600,
  skullCrossbones:    199603,
  // Procs
  opportunity:        195627,
  audacity:           386270,
  loadedDice:         256171,
  greenskinsWickers:  394131,
  // BtE debuff on target
  betweenTheEyes:     315341,
  // Trickster
  escalatingBlade:    441786,
  flawlessForm:       441326,
  fazed:              441224,
  disorienting:       441274,   // Disorienting Strikes buff
  // Fatebound
  fateCoinsHeads:     452923,
  fateCoinsTails:     452917,
  // Set bonus
  whirlOfBlades:      1275176,  // 4pc set buff: +5% dmg 8s from Blade Rush
  // Bloodlust
  bloodlust:          2825,
  heroism:            32182,
  timewarp:           80353,
  // Hero detection
  fateboundKnown:     452536,
  tricksterKnown:     441146,
};

// Talent IDs
const T = {
  hiddenOpportunity:  383281,
  improvedAmbush:     381620,
  fanTheHammer:       381846,
  quickDraw:          196938,
  audacity:           381845,
  deftManeuvers:      381878,
  improvedAR:         395422,
  supercharger:       470347,
  zeroIn:             1265736,
  dealFate:           452536,   // Fatebound talent
  preparation:        1277933,
};

export class OutlawRogueBehavior extends Behavior {
  name = 'FW Outlaw Rogue';
  context = BehaviorContext.Any;
  specialization = Specialization.Rogue.Combat; // "Combat" = Outlaw in enum
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _energyFrame = 0;
  _cachedEnergy = 0;
  _cpFrame = 0;
  _cachedCP = 0;
  _rtbFrame = 0;
  _cachedRtbCount = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWOutUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWOutAoECount', text: 'Blade Flurry targets', default: 2, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWOutDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isFatebound() { return spell.isSpellKnown(A.fateboundKnown); }
  isTrickster() { return !this.isFatebound(); }

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
  getEnergyDeficit() { return this.getEnergyMax() - this.getEnergy(); }

  getCP() {
    if (this._cpFrame === wow.frameTime) return this._cachedCP;
    this._cpFrame = wow.frameTime;
    this._cachedCP = me.powerByType(PowerType.ComboPoints);
    return this._cachedCP;
  }

  getCPMax() { return me.maxPowerByType ? me.maxPowerByType(PowerType.ComboPoints) : 7; }
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

  // Count active RtB buffs (cached per tick)
  getRtbBuffCount() {
    if (this._rtbFrame === wow.frameTime) return this._cachedRtbCount;
    this._rtbFrame = wow.frameTime;
    let count = 0;
    if (me.hasAura(A.broadside)) count++;
    if (me.hasAura(A.ruthlessPrecision)) count++;
    if (me.hasAura(A.grandMelee)) count++;
    if (me.hasAura(A.trueBearing)) count++;
    if (me.hasAura(A.buriedTreasure)) count++;
    if (me.hasAura(A.skullCrossbones)) count++;
    this._cachedRtbCount = count;
    return count;
  }

  // =============================================
  // SIMC VARIABLES
  // =============================================
  // variable.ambush_condition = (talent.hidden_opportunity|combo_points.deficit>=2+talent.improved_ambush)&energy>=50
  ambushCondition() {
    const ho = spell.isSpellKnown(T.hiddenOpportunity);
    const impAmb = spell.isSpellKnown(T.improvedAmbush) ? 1 : 0;
    return (ho || this.getCPDeficit() >= 2 + impAmb) && this.getEnergy() >= 50;
  }

  // variable.finish_condition = combo_points>=cp_max_spend-1-(hero_tree.fatebound&!cooldown.between_the_eyes.ready)
  finishCondition() {
    const bteReady = spell.getCooldown(S.betweenTheEyes)?.ready || false;
    const fbAdj = (this.isFatebound() && !bteReady) ? 1 : 0;
    return this.getCP() >= this.getCPMax() - 1 - fbAdj;
  }

  // variable.blade_flurry_sync = spell_targets<2&raid_event.adds.in>20|buff.blade_flurry.up
  bladeFlurrySync() {
    return this.getEnemyCount() < 2 || me.hasAura(A.bladeFlurry);
  }

  inAR() { return me.hasAura(A.adrenalineRush); }
  hasOpportunity() { return me.hasAura(A.opportunity); }
  hasAudacity() { return me.hasAura(A.audacity); }

  inStealth() {
    return me.hasAura(A.stealth) || me.hasAura(A.vanishBuff) || me.hasAura(A.subterfuge);
  }

  getOpportunityStacks() {
    const a = me.getAura(A.opportunity);
    return a ? a.stacks : 0;
  }

  getOpportunityRemaining() {
    const a = me.getAura(A.opportunity);
    return a ? a.remaining : 0;
  }

  getOpportunityMaxStacks() {
    const a = me.getAura(A.opportunity);
    return a ? (a.maxStacks || 6) : 6;
  }

  getEscalatingBladeStacks() {
    const a = me.getAura(A.escalatingBlade);
    return a ? a.stacks : 0;
  }

  // Bloodlust check
  hasBloodlust() {
    return me.hasAura(A.bloodlust) || me.hasAura(A.heroism) || me.hasAura(A.timewarp);
  }

  // BtE buff check (debuff on target)
  hasBtEDebuff() {
    const t = this.getCurrentTarget();
    return t && t.getAuraByMe(A.betweenTheEyes) !== undefined;
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
          console.info(`[Outlaw] Midnight 12.0.1 | Hero: ${this.isFatebound() ? 'Fatebound' : 'Trickster'}`);
        }
        if (Settings.FWOutDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Outlaw] E:${Math.round(this.getEnergy())} CP:${this.getCP()}/${this.getCPMax()} RtB:${this.getRtbBuffCount()} AR:${this.inAR()} Opp:${this.getOpportunityStacks()} Aud:${this.hasAudacity()} FC:${this.finishCondition()} WoB:${me.hasAura(A.whirlOfBlades)}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // SimC: actions+=/kick
          spell.interrupt(S.kick),

          // SimC: actions+=/call_action_list,name=cds
          this.cooldowns(),

          // SimC: actions+=/run_action_list,name=finish,if=variable.finish_condition
          new bt.Decorator(
            () => this.finishCondition(),
            this.finishers(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: actions+=/call_action_list,name=build
          this.builders(),
        )
      ),
    );
  }

  // =============================================
  // CDS -- SimC: actions.cds (~14 lines)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // SimC: adrenaline_rush,if=!buff.adrenaline_rush.up&(!variable.finish_condition|!talent.improved_adrenaline_rush)
      spell.cast(S.adrenalineRush, () => me, () => {
        if (!Settings.FWOutUseCDs) return false;
        if (this.inAR()) return false;
        if (this.finishCondition() && spell.isSpellKnown(T.improvedAR)) return false;
        return this.targetTTD() > 10000;
      }),

      // SimC: blade_flurry,if=spell_targets>=2&buff.blade_flurry.remains<gcd
      spell.cast(S.bladeFlurry, () => me, () => {
        if (this.getEnemyCount() < 2) return false;
        const bf = me.getAura(A.bladeFlurry);
        return !bf || bf.remaining < 1500;
      }),

      // SimC: preparation,if=cooldown.adrenaline_rush.remains>30&!cooldown.between_the_eyes.ready&
      //   (!cooldown.killing_spree.ready|!hero_tree.trickster)|fight_remains<30
      spell.cast(S.preparation, () => me, () => {
        if (!spell.isSpellKnown(T.preparation)) return false;
        const arCD = spell.getCooldown(S.adrenalineRush)?.timeleft || 0;
        const bteReady = spell.getCooldown(S.betweenTheEyes)?.ready || false;
        const ksReady = spell.getCooldown(S.killingSpree)?.ready || false;
        if (this.targetTTD() < 30000) return true;
        return arCD > 30000 && !bteReady && (!ksReady || !this.isTrickster());
      }),

      // SimC: keep_it_rolling,if=rtb_buffs=2&buff.roll_the_bones.remains<cooldown.adrenaline_rush.remains&
      //   !buff.loaded_dice.up&(cooldown.preparation.remains|!talent.preparation)|rtb_buffs>=3
      spell.cast(S.keepItRolling, () => me, () => {
        if (!spell.isSpellKnown(S.keepItRolling)) return false;
        const rtb = this.getRtbBuffCount();
        if (rtb >= 3) return true;
        if (rtb === 2) {
          const rtbBuff = me.getAura(A.rollTheBones);
          const rtbRemains = rtbBuff ? rtbBuff.remaining : 0;
          const arCD = spell.getCooldown(S.adrenalineRush)?.timeleft || 0;
          const hasLoadedDice = me.hasAura(A.loadedDice);
          const prepCD = spell.getCooldown(S.preparation)?.timeleft || 0;
          const hasPrepTalent = spell.isSpellKnown(T.preparation);
          return rtbRemains < arCD && !hasLoadedDice && (prepCD > 0 || !hasPrepTalent);
        }
        return false;
      }),

      // SimC: roll_the_bones,if=!buff.roll_the_bones.up|rtb_buffs=1
      spell.cast(S.rollTheBones, () => me, () => {
        if (this.getCP() < 1) return false;
        const rtb = this.getRtbBuffCount();
        return rtb === 0 || rtb <= 1;
      }),

      // SimC: blade_rush,if=set_bonus.mid1_4pc&!buff.whirl_of_blades.up|spell_targets=1&energy.base_time_to_max>2|spell_targets>=2
      spell.cast(S.bladeRush, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        // 4pc check: if whirl_of_blades buff is not up, use Blade Rush
        if (!me.hasAura(A.whirlOfBlades)) return true;
        // ST: use when energy won't cap in 2s (energy deficit > ~regen*2)
        if (this.getEnemyCount() === 1) return this.getEnergyDeficit() > 30;
        // AoE: always use
        return this.getEnemyCount() >= 2;
      }),

      // SimC: vanish,if=!variable.finish_condition&talent.hidden_opportunity&!buff.audacity.up&!buff.opportunity.up
      spell.cast(S.vanish, () => me, () => {
        if (!Settings.FWOutUseCDs) return false;
        if (this.finishCondition()) return false;
        if (!spell.isSpellKnown(T.hiddenOpportunity)) return false;
        return !this.hasAudacity() && !this.hasOpportunity();
      }),

      // SimC: potion,if=buff.bloodlust.react|fight_remains<30|buff.adrenaline_rush.up
      // (potion handled externally)

      // SimC: berserking (unconditional in SimC APL)
      spell.cast(S.berserking, () => me),
    );
  }

  // =============================================
  // FINISHERS -- SimC: actions.finish (6 lines)
  // =============================================
  finishers() {
    return new bt.Selector(
      // SimC: dispatch,if=!buff.slice_and_dice.up
      spell.cast(S.dispatch, () => this.getCurrentTarget(), () => {
        return !me.hasAura(A.sliceAndDice);
      }),

      // SimC: between_the_eyes,if=cooldown.adrenaline_rush.remains>30|buff.adrenaline_rush.up|!talent.supercharger|!talent.zero_in
      spell.cast(S.betweenTheEyes, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        const arCD = spell.getCooldown(S.adrenalineRush)?.timeleft || 0;
        if (arCD > 30000) return true;
        if (this.inAR()) return true;
        if (!spell.isSpellKnown(T.supercharger)) return true;
        if (!spell.isSpellKnown(T.zeroIn)) return true;
        return false;
      }),

      // SimC: pool_resource,for_next=1 + killing_spree (unconditional after pool)
      spell.cast(S.killingSpree, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // SimC: coup_de_grace (unconditional)
      spell.cast(S.coupDeGrace, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // SimC: dispatch (fallback finisher, unconditional)
      spell.cast(S.dispatch, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // BUILDERS -- SimC: actions.build (10 lines)
  // =============================================
  builders() {
    return new bt.Selector(
      // SimC: ambush,if=talent.hidden_opportunity&buff.audacity.up
      spell.cast(S.ambush, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.hiddenOpportunity) && this.hasAudacity();
      }),

      // SimC: blade_flurry,if=talent.deft_maneuvers&spell_targets>=4
      spell.cast(S.bladeFlurry, () => me, () => {
        return spell.isSpellKnown(T.deftManeuvers) && this.getEnemyCount() >= 4;
      }),

      // SimC: coup_de_grace,if=buff.disorienting_strikes.up
      spell.cast(S.coupDeGrace, () => this.getCurrentTarget(), () => {
        return me.hasAura(A.disorienting);
      }),

      // SimC: pistol_shot,if=talent.audacity&talent.hidden_opportunity&buff.opportunity.up&!buff.audacity.up
      spell.cast(S.pistolShot, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.audacity)) return false;
        if (!spell.isSpellKnown(T.hiddenOpportunity)) return false;
        return this.hasOpportunity() && !this.hasAudacity();
      }),

      // SimC: pistol_shot,if=talent.fan_the_hammer&buff.opportunity.up&(buff.opportunity.stack>=buff.opportunity.max_stack|buff.opportunity.remains<2)
      spell.cast(S.pistolShot, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.fanTheHammer)) return false;
        if (!this.hasOpportunity()) return false;
        return this.getOpportunityStacks() >= this.getOpportunityMaxStacks() ||
          this.getOpportunityRemaining() < 2000;
      }),

      // SimC: pistol_shot,if=talent.fan_the_hammer&buff.opportunity.up&(combo_points.deficit>=(1+talent.quick_draw+(talent.quick_draw*talent.fan_the_hammer.rank))&(combo_points>1|rtb_buffs<2|!talent.deal_fate))
      spell.cast(S.pistolShot, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.fanTheHammer)) return false;
        if (!this.hasOpportunity()) return false;
        const qd = spell.isSpellKnown(T.quickDraw) ? 1 : 0;
        const fthRank = spell.isSpellKnown(T.fanTheHammer) ? 1 : 0;
        const cpThreshold = 1 + qd + (qd * fthRank);
        if (this.getCPDeficit() < cpThreshold) return false;
        const hasDealFate = spell.isSpellKnown(T.dealFate);
        return this.getCP() > 1 || this.getRtbBuffCount() < 2 || !hasDealFate;
      }),

      // SimC: pistol_shot,if=!talent.fan_the_hammer&buff.opportunity.up&(energy.base_deficit>energy.regen*1.5|combo_points.deficit<=1|talent.quick_draw|talent.audacity&!buff.audacity.up)
      spell.cast(S.pistolShot, () => this.getCurrentTarget(), () => {
        if (spell.isSpellKnown(T.fanTheHammer)) return false;
        if (!this.hasOpportunity()) return false;
        if (this.getEnergyDeficit() > 25) return true; // energy.base_deficit>energy.regen*1.5 approx
        if (this.getCPDeficit() <= 1) return true;
        if (spell.isSpellKnown(T.quickDraw)) return true;
        if (spell.isSpellKnown(T.audacity) && !this.hasAudacity()) return true;
        return false;
      }),

      // SimC: pool_resource,for_next=1 + ambush,if=talent.hidden_opportunity
      spell.cast(S.ambush, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(T.hiddenOpportunity) && this.getEnergy() >= 50;
      }),

      // SimC: sinister_strike (fallback builder, unconditional)
      spell.cast(S.sinisterStrike, () => this.getCurrentTarget()),
    );
  }
}
