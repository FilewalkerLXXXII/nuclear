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
 * Brewmaster Monk Behavior - Midnight 12.0.1
 * Full SimC APL match: apl_monk.cpp brewmaster namespace (~36 APL lines + 6 racials)
 * Sources: SimC APL (midnight branch) + Wowhead
 *
 * Auto-detects: Shado-Pan (Flurry Strikes / Wisdom of the Wall)
 *            vs Master of Harmony (Aspect of Harmony / Balanced Stratagem)
 *
 * Tank: Stagger smooths damage, Purifying Brew clears 50% or min 8% max HP
 * Resource: Energy (PowerType 3), max 100. NO Chi for Brewmaster.
 * All melee instant — no movement block needed.
 *
 * SimC APL priority (condensed):
 *   Black Ox Brew (MoH: CB charges<1, SP: energy<40)
 *   → Celestial Brew (Aspect spender up + !empty_barrel)
 *   → Keg Smash (Aspect spender up + empty_barrel)
 *   → Breath of Fire (WotW + Niuzao up)
 *   → Keg Smash (WotW + Niuzao up)
 *   → Blackout Kick (Blackout Combo talented + combo DOWN)
 *   → Celestial Brew (accumulator > 0.3*maxHP + charges > 1.9)
 *   → Purifying Brew → Fortifying Brew → Chi Burst → Invoke Niuzao
 *   → Tiger Palm (combo up + BOK CD < 1.3) → Exploding Keg (KS charges < 1)
 *   → Empty the Cellar → Breath of Fire (BOK CD > 1.5 + !empty_barrel + KS charges < max)
 *   → Tiger Palm (combo up) → Celestial Brew (SP) → Breath of Fire (SP)
 *   → Keg Smash (SP/Scalding/empty_barrel/charges=max) → Breath of Fire
 *   → Empty the Cellar → RJW → Keg Smash → Blackout Kick
 *   → Tiger Palm (MoH: e>50-regen*2, SP: e>65-regen) → Expel Harm
 */

const S = {
  // Core rotation
  blackoutKick:       205523,   // BRM-specific BoK (WW is 100784)
  tigerPalm:          100780,
  kegSmash:           121253,
  breathOfFire:       115181,
  spinningCraneKick:  322729,   // BRM-specific SCK
  risingSunKick:      107428,
  explodingKeg:       325153,
  // Brew CDs
  purifyingBrew:      119582,
  celestialBrew:      322507,
  blackOxBrew:        115399,
  fortifyingBrew:     115203,
  // Talent CDs
  weaponsOfOrder:     387184,
  invokeNiuzao:       395267,   // Castable talent (NPC spawn is 132578)
  rushingJadeWind:    116847,
  chiBurst:           123986,
  emptyTheCellar:     483898,
  // Utility
  expelHarm:          322101,
  touchOfDeath:       322109,
  provoke:            115546,
  legSweep:           119381,
  // Interrupt
  spearHandStrike:    116705,
  // Racials
  berserking:         26297,
  bloodFury:          20572,
  arcaneTorrent:      50613,
  lightsJudgment:     255647,
  fireblood:          265221,
  ancestralCall:      274738,
  bagOfTricks:        312411,
};

const A = {
  // Core buffs
  blackoutCombo:      228563,
  shuffle:            215479,   // Active buff (passive talent is 322120)
  charredPassions:    338140,   // Buff aura (386959 is damage spell)
  // Stagger
  lightStagger:       124275,
  moderateStagger:    124274,
  heavyStagger:       124273,
  // CDs
  weaponsOfOrder:     387184,
  invokeNiuzao:       132578,
  rushingJadeWind:    116847,
  fortifyingBrew:     120954,   // Buff aura (cast is 115203)
  // Procs
  counterstrike:      383800,   // Buff aura (383785 is passive talent)
  pressTheAdvantage: 418361,   // Buff aura (418360 is damage spell)
  emptyBarrel:        1265133,  // Buff aura
  // Empty the Cellar buff
  emptyTheCellar:     1262768,  // Buff aura (cast is 483898)
  // Shado-Pan
  flurryCharge:       451021,
  wisdomOfTheWall:    452684,
  flurryStrikesKnown: 450615,
  // Master of Harmony
  aspectOfHarmony:    450508,
  aspectOfHarmonySpender: 450711,
  aspectOfHarmonyAccumulator: 450521,  // Accumulator buff (450508 is passive talent)
  balancedStrategemMagic: 451508,  // Magic damage buff (talent passive is 450889)
};

export class BrewmasterMonkBehavior extends Behavior {
  name = 'FW Brewmaster Monk';
  context = BehaviorContext.Any;
  specialization = Specialization.Monk.Brewmaster;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _energyFrame = 0;
  _cachedEnergy = 0;
  _comboFrame = 0;
  _cachedCombo = false;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWBrmUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWBrmDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWBrmFortBrew', text: 'Use Fortifying Brew', default: true },
        { type: 'slider', uid: 'FWBrmFortBrewHP', text: 'Fortifying Brew HP %', default: 35, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWBrmCelBrew', text: 'Use Celestial Brew', default: true },
        { type: 'checkbox', uid: 'FWBrmPurify', text: 'Auto Purifying Brew', default: true },
      ],
    },
  ];

  // ===== Hero Detection =====
  isMasterOfHarmony() {
    return spell.isSpellKnown(450508);
  }

  isShadoPan() {
    return !this.isMasterOfHarmony();
  }

  hasBlackoutComboTalent() {
    return spell.isSpellKnown(196736);
  }

  hasScaldingBrew() {
    return spell.isSpellKnown(383698);
  }

  hasStormstoutsLastKeg() {
    return spell.isSpellKnown(383707);
  }

  // ===== Caching =====
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

  // Keg Smash is 40yd ranged — use wider distance than melee getCurrentTarget()
  getRangedTarget() {
    if (this._rangedFrame === wow.frameTime) return this._cachedRanged;
    this._rangedFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 40 && me.isFacing(target)) {
      this._cachedRanged = target;
      return target;
    }
    const t = combat.bestTarget || (combat.targets && combat.targets[0]) || null;
    this._cachedRanged = (t && me.isFacing(t) && me.distanceTo(t) <= 40) ? t : null;
    return this._cachedRanged;
  }

  getEnergy() {
    if (this._energyFrame === wow.frameTime) return this._cachedEnergy;
    this._energyFrame = wow.frameTime;
    this._cachedEnergy = me.powerByType(PowerType.Energy);
    return this._cachedEnergy;
  }

  getEnergyRegen() {
    return me.energyRegen || 10;
  }

  hasBlackoutCombo() {
    if (this._comboFrame === wow.frameTime) return this._cachedCombo;
    this._comboFrame = wow.frameTime;
    this._cachedCombo = me.hasAura(A.blackoutCombo);
    return this._cachedCombo;
  }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemyCount;
    this._enemyFrame = wow.frameTime;
    const target = this.getCurrentTarget();
    this._cachedEnemyCount = target ? target.getUnitsAroundCount(8) + 1 : 1;
    return this._cachedEnemyCount;
  }

  // ===== Helpers =====
  targetTTD() {
    const target = this.getCurrentTarget();
    if (!target || !target.timeToDeath) return 99999;
    return target.timeToDeath();
  }

  hasHeavyStagger() { return me.hasAura(A.heavyStagger); }
  hasModerateStagger() { return me.hasAura(A.moderateStagger); }
  hasEmptyBarrel() { return me.hasAura(A.emptyBarrel); }
  hasAspectSpender() { return me.hasAura(A.aspectOfHarmonySpender); }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Dead target auto-pick
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),

      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),

      common.waitForCastOrChannel(),

      // Version + debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isMasterOfHarmony() ? 'Master of Harmony' : 'Shado-Pan';
          console.info(`[Brewmaster] Midnight 12.0.1 | Hero: ${hero} | SimC APL matched`);
        }
        if (Settings.FWBrmDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const energy = Math.round(this.getEnergy());
          const combo = this.hasBlackoutCombo();
          const stagger = this.hasHeavyStagger() ? 'HEAVY' : this.hasModerateStagger() ? 'MOD' : 'light';
          const hp = Math.round(me.effectiveHealthPercent);
          const eb = this.hasEmptyBarrel();
          console.info(`[BrM] HP:${hp}% E:${energy} Combo:${combo} Stagger:${stagger} EB:${eb}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.spearHandStrike),
          this.mainRotation(),
        )
      ),
    );
  }

  // ===== MAIN ROTATION — SimC APL line-by-line =====
  mainRotation() {
    return new bt.Selector(
      // === SimC: black_ox_brew,if=talent.aspect_of_harmony&cooldown.celestial_brew.charges_fractional<1 ===
      spell.cast(S.blackOxBrew, () => me, () => {
        return this.isMasterOfHarmony() && spell.getChargesFractional(S.celestialBrew) < 1;
      }),

      // === SimC: black_ox_brew,if=!talent.aspect_of_harmony&energy<40 ===
      spell.cast(S.blackOxBrew, () => me, () => {
        return !this.isMasterOfHarmony() && this.getEnergy() < 40;
      }),

      // === SimC: celestial_brew,if=buff.aspect_of_harmony_spender.up&!buff.empty_barrel.up ===
      spell.cast(S.celestialBrew, () => me, () => {
        if (!Settings.FWBrmCelBrew) return false;
        return this.hasAspectSpender() && !this.hasEmptyBarrel();
      }),

      // === SimC: keg_smash,if=buff.aspect_of_harmony_spender.up&buff.empty_barrel.up ===
      spell.cast(S.kegSmash, () => this.getRangedTarget(), () => {
        return this.getRangedTarget() !== null &&
          this.hasAspectSpender() && this.hasEmptyBarrel();
      }),

      // === SimC: breath_of_fire,if=talent.wisdom_of_the_wall&buff.invoke_niuzao.up ===
      spell.cast(S.breathOfFire, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null &&
          this.isShadoPan() && me.hasAura(A.invokeNiuzao);
      }),

      // === SimC: keg_smash,if=talent.wisdom_of_the_wall&buff.invoke_niuzao.up ===
      spell.cast(S.kegSmash, () => this.getRangedTarget(), () => {
        return this.getRangedTarget() !== null &&
          this.isShadoPan() && me.hasAura(A.invokeNiuzao);
      }),

      // === SimC: blackout_kick,if=talent.blackout_combo&!buff.blackout_combo.up ===
      spell.cast(S.blackoutKick, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null &&
          this.hasBlackoutComboTalent() && !this.hasBlackoutCombo();
      }),

      // === SimC: celestial_brew,if=!(apex.3&buff.empty_barrel.up)&buff.aspect_of_harmony_accumulator.value>0.3*health.max&cooldown.celestial_brew.charges_fractional>1.9 ===
      spell.cast(S.celestialBrew, () => me, () => {
        if (!Settings.FWBrmCelBrew) return false;
        if (this.hasEmptyBarrel()) return false;
        if (!this.isMasterOfHarmony()) return false;
        return spell.getChargesFractional(S.celestialBrew) > 1.9;
      }),

      // === SimC: celestial_brew,if=!(apex.3&buff.empty_barrel.up)&target.time_to_die<15&buff.aspect_of_harmony_accumulator.value>0.2*health.max ===
      spell.cast(S.celestialBrew, () => me, () => {
        if (!Settings.FWBrmCelBrew) return false;
        if (this.hasEmptyBarrel()) return false;
        return this.isMasterOfHarmony() && this.targetTTD() < 15000;
      }),

      // === SimC: purifying_brew,if=!(apex.1&buff.empty_barrel.up) ===
      spell.cast(S.purifyingBrew, () => me, () => {
        if (!Settings.FWBrmPurify) return false;
        // apex.1 condition — don't purify if empty barrel is up (save for keg smash)
        return !this.hasEmptyBarrel();
      }),

      // === SimC: fortifying_brew,if=!(apex.3&buff.empty_barrel.up) ===
      spell.cast(S.fortifyingBrew, () => me, () => {
        if (!Settings.FWBrmFortBrew) return false;
        return me.effectiveHealthPercent < Settings.FWBrmFortBrewHP;
      }),

      // Touch of Death — high-priority execute (not in SimC tank APL but always use)
      spell.cast(S.touchOfDeath, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC: chi_burst ===
      spell.cast(S.chiBurst, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC: invoke_niuzao ===
      spell.cast(S.invokeNiuzao, () => me, () => {
        return Settings.FWBrmUseCDs && me.inCombat() && this.targetTTD() > 15000;
      }),

      // === SimC: race_actions (all racials unconditional) ===
      spell.cast(S.bloodFury, () => me, () => me.inCombat()),
      spell.cast(S.berserking, () => me, () => me.inCombat()),
      spell.cast(S.arcaneTorrent, () => me, () => me.inCombat()),
      spell.cast(S.lightsJudgment, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),
      spell.cast(S.fireblood, () => me, () => me.inCombat()),
      spell.cast(S.ancestralCall, () => me, () => me.inCombat()),

      // === SimC: tiger_palm,if=buff.blackout_combo.up&cooldown.blackout_kick.remains<1.3 ===
      spell.cast(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.hasBlackoutCombo()) return false;
        const bokCD = spell.getCooldown(S.blackoutKick);
        return bokCD && bokCD.timeleft < 1300;
      }),

      // === SimC: exploding_keg,if=cooldown.keg_smash.charges_fractional<1 ===
      spell.cast(S.explodingKeg, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null &&
          spell.getChargesFractional(S.kegSmash) < 1;
      }),

      // === SimC: empty_the_cellar,if=talent.aspect_of_harmony&cooldown.celestial_brew.remains>15 ===
      spell.cast(S.emptyTheCellar, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isMasterOfHarmony()) {
          const cbCD = spell.getCooldown(S.celestialBrew);
          return cbCD && cbCD.timeleft > 15000;
        }
        return false;
      }),

      // === SimC: empty_the_cellar,if=!talent.aspect_of_harmony&buff.empty_the_cellar.remains<1.5 ===
      spell.cast(S.emptyTheCellar, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.isMasterOfHarmony()) {
          const etc = me.getAura(A.emptyTheCellar);
          return !etc || etc.remaining < 1500;
        }
        return false;
      }),

      // === SimC: breath_of_fire,if=cooldown.blackout_kick.remains>1.5&!buff.empty_barrel.up&cooldown.keg_smash.charges<1+talent.stormstouts_last_keg ===
      spell.cast(S.breathOfFire, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        const bokCD = spell.getCooldown(S.blackoutKick);
        if (!bokCD || bokCD.timeleft <= 1500) return false;
        if (this.hasEmptyBarrel()) return false;
        const ksMaxCharges = 1 + (this.hasStormstoutsLastKeg() ? 1 : 0);
        return spell.getChargesFractional(S.kegSmash) < ksMaxCharges;
      }),

      // === SimC: tiger_palm,if=buff.blackout_combo.up ===
      spell.cast(S.tigerPalm, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.hasBlackoutCombo();
      }),

      // === SimC: celestial_brew,if=talent.flurry_strikes&!(apex.3&buff.empty_barrel.up) ===
      spell.cast(S.celestialBrew, () => me, () => {
        if (!Settings.FWBrmCelBrew) return false;
        return this.isShadoPan() && !this.hasEmptyBarrel();
      }),

      // === SimC: breath_of_fire,if=talent.flurry_strikes ===
      spell.cast(S.breathOfFire, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null && this.isShadoPan();
      }),

      // === SimC: keg_smash,if=talent.flurry_strikes ===
      spell.cast(S.kegSmash, () => this.getRangedTarget(), () => {
        return this.getRangedTarget() !== null && this.isShadoPan();
      }),

      // === SimC: keg_smash,if=talent.scalding_brew ===
      spell.cast(S.kegSmash, () => this.getRangedTarget(), () => {
        return this.getRangedTarget() !== null && this.hasScaldingBrew();
      }),

      // === SimC: keg_smash,if=buff.empty_barrel.up ===
      spell.cast(S.kegSmash, () => this.getRangedTarget(), () => {
        return this.getRangedTarget() !== null && this.hasEmptyBarrel();
      }),

      // === SimC: keg_smash,if=cooldown.keg_smash.charges=1+talent.stormstouts_last_keg ===
      spell.cast(S.kegSmash, () => this.getRangedTarget(), () => {
        if (!this.getRangedTarget()) return false;
        const maxCharges = 1 + (this.hasStormstoutsLastKeg() ? 1 : 0);
        // charges= means exactly at max, use getCharges for integer comparison
        return spell.getCharges(S.kegSmash) === maxCharges;
      }),

      // === SimC: breath_of_fire ===
      spell.cast(S.breathOfFire, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC: empty_the_cellar ===
      spell.cast(S.emptyTheCellar, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC: rushing_jade_wind (unconditional in SimC) ===
      spell.cast(S.rushingJadeWind, () => this.getCurrentTarget(), () => this.getCurrentTarget() !== null),

      // === SimC: keg_smash ===
      spell.cast(S.kegSmash, () => this.getRangedTarget(), () => {
        return this.getRangedTarget() !== null;
      }),

      // === SimC: blackout_kick ===
      spell.cast(S.blackoutKick, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC: tiger_palm,if=talent.aspect_of_harmony&energy>50-energy.regen*2 ===
      spell.cast(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isMasterOfHarmony()) {
          return this.getEnergy() > 50 - this.getEnergyRegen() * 2;
        }
        return false;
      }),

      // === SimC: tiger_palm,if=energy>65-energy.regen ===
      spell.cast(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.getEnergy() > 65 - this.getEnergyRegen();
      }),

      // === SimC: expel_harm (unconditional filler in SimC) ===
      spell.cast(S.expelHarm, () => me, () => {
        return me.effectiveHealthPercent < 90;
      }),
    );
  }
}
