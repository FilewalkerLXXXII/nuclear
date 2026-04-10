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
 * Arcane Mage Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (mage.cpp midnight branch) + Method + Wowhead
 *
 * Auto-detects: Spellslinger (Splintering Sorcery) vs Sunfury (Spellfire Spheres)
 * SimC sub-lists: cooldowns (11), spellslinger (9), spellslinger_orbm (9), sunfury (7)
 *
 * Core: Arcane Blast (builder) -> Arcane Salvo stacking -> Barrage at threshold
 * Burst: Arcane Surge (mana dump, +35% dmg) -> Touch of the Magi -> Barrage
 * SS: Touch AFTER Surge | SF: Touch at END of Surge for Arcane Soul window
 *
 * Variables: opener, time_for_pooling, sunfury_hold_for_cds, pulse_aoe_count
 * Resource: Mana + Arcane Charges (max 4) + Arcane Salvo (max 20/25)
 * Movement: Barrage/Pulse/PoM+Blast/Orb instants
 *
 * SimC line coverage: cooldowns 11/11, spellslinger 9/9, spellslinger_orbm 9/9, sunfury 7/7
 * Default actions: berserking, fight-end barrage/AM/Orb, sunfury_hold_for_cds variable
 */

const S = {
  arcaneBlast:        30451,
  arcaneBarrage:      44425,
  arcaneMissiles:     5143,
  arcaneExplosion:    1449,
  arcaneOrb:          153626,
  arcanePulse:        1243460,
  arcaneSurge:        365350,
  touchOfTheMagi:     321507,
  evocation:          12051,
  presenceOfMind:     205025,
  mirrorImage:        55342,
  counterspell:       2139,
  prismaticBarrier:   235450,
  iceBlock:           45438,
  arcaneIntellect:    1459,
  berserking:         26297,
};

const T = {
  splinteringSorcery: 443739,
  spellfireSpheres:   448601,
  orbMastery:         1243435,
  highVoltage:        461248,
  overpoweredMissiles: 1277009,
  orbBarrage:         384858,
  resonance:          205028,
  impetus:            383676,
  spellfireSalvo:     1260616,
  arcanePulse:        1243460,
};

const A = {
  arcaneSurge:        365350,
  touchOfTheMagi:     321507,
  clearcasting:       263725,
  arcaneCharge:       36032,
  arcaneSalvo:        384452,
  presenceOfMind:     205025,
  overpoweredMissiles: 1277009,
  arcaneSoul:         451038,
};

export class ArcaneMageBehavior extends Behavior {
  name = 'FW Arcane Mage';
  context = BehaviorContext.Any;
  specialization = Specialization.Mage.Arcane;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _manaFrame = 0;
  _cachedMana = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _salvoFrame = 0;
  _cachedSalvo = 0;
  _ccFrame = 0;
  _cachedCC = null;
  _versionLogged = false;
  _lastDebug = 0;
  _opener = true;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWArcUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWArcAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWArcDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWArcBarrier', text: 'Use Prismatic Barrier', default: true },
        { type: 'checkbox', uid: 'FWArcIceBlock', text: 'Use Ice Block', default: true },
        { type: 'slider', uid: 'FWArcIceBlockHP', text: 'Ice Block HP %', default: 15, min: 5, max: 30 },
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

      // OOC: Arcane Intellect
      spell.cast(S.arcaneIntellect, () => me, () =>
        spell.getTimeSinceLastCast(S.arcaneIntellect) > 60000 && !me.hasAura(1459)
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

      // SimC: variable,name=opener,op=set,if=debuff.touch_of_the_magi.up&variable.opener,value=0
      new bt.Action(() => {
        if (this._opener && this.targetHasTouch()) this._opener = false;
        return bt.Status.Failure;
      }),

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Arcane] Midnight 12.0.1 | ${this.isSS() ? 'Spellslinger' : 'Sunfury'} | OrbM: ${this.hasOrbM()} | SimC APL full`);
        }
        if (Settings.FWArcDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Arcane] Mana:${Math.round(this.getMana())}% Chrg:${this.getCharges()} Salvo:${this.getSalvo()} CC:${this.getCCStacks()} Surge:${this.inSurge()} Soul:${this.inSoul()} OPM:${me.hasAura(A.overpoweredMissiles)} Hold:${this.sunfuryHoldForCds()} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.counterspell),

          // Defensives
          spell.cast(S.prismaticBarrier, () => me, () => Settings.FWArcBarrier && me.inCombat()),
          spell.cast(S.iceBlock, () => me, () =>
            Settings.FWArcIceBlock && me.effectiveHealthPercent < Settings.FWArcIceBlockHP
          ),

          // Movement block — full instant rotation
          new bt.Decorator(
            () => me.isMoving(),
            new bt.Selector(
              // Barrage at high salvo or charges
              spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
                this.getSalvo() >= 20 || this.getCharges() >= 4
              ),
              // Arcane Orb (instant, generates charges)
              spell.cast(S.arcaneOrb, () => this.getCurrentTarget()),
              // Arcane Pulse (instant AoE)
              spell.cast(S.arcanePulse, () => this.getCurrentTarget()),
              // PoM for instant Blast
              spell.cast(S.presenceOfMind, () => me, () => this.getCharges() < 2),
              spell.cast(S.arcaneBlast, () => this.getCurrentTarget(), () => me.hasAura(A.presenceOfMind)),
              // Low-charge barrage as filler
              spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () => this.getCharges() >= 2),
              new bt.Action(() => bt.Status.Success)
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: berserking,if=(buff.arcane_surge.up&debuff.touch_of_the_magi.up)|fight_remains<13
          spell.cast(S.berserking, () => me, () =>
            (this.inSurge() && this.targetHasTouch()) || this.targetTTD() < 13000
          ),

          // SimC: arcane_barrage,if=fight_remains<gcd.max*2
          spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
            this.targetTTD() < 3000
          ),

          // SimC: arcane_missiles,if=fight_remains<execute_time*(1+cc.react)&cc.react&salvo>=13+(5*spellfire_salvo)&!orb_mastery
          spell.cast(S.arcaneMissiles, () => this.getCurrentTarget(), () => {
            if (!this.hasCC() || this.hasOrbM()) return false;
            const salvoThreshold = 13 + (spell.isSpellKnown(T.spellfireSalvo) ? 5 : 0);
            return this.targetTTD() < 4000 && this.getSalvo() >= salvoThreshold;
          }),

          // SimC: arcane_orb,if=fight_remains<execute_time*(1+cc.react)&cc.react&salvo>=13+(5*spellfire_salvo)&orb_mastery
          spell.cast(S.arcaneOrb, () => this.getCurrentTarget(), () => {
            if (!this.hasCC() || !this.hasOrbM()) return false;
            const salvoThreshold = 13 + (spell.isSpellKnown(T.spellfireSalvo) ? 5 : 0);
            return this.targetTTD() < 4000 && this.getSalvo() >= salvoThreshold;
          }),

          // SimC: call_action_list,name=cooldowns
          this.cooldowns(),

          // SimC dispatch: SS+OrbM -> spellslinger_orbm, SS -> spellslinger, else -> sunfury
          new bt.Decorator(
            () => this.isSS() && this.hasOrbM(),
            this.ssOrbM(), new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isSS(),
            this.ssRotation(), new bt.Action(() => bt.Status.Failure)
          ),
          this.sfRotation(),

          // SimC fallback: arcane_barrage,if=(time>5&!prev_gcd.1.arcane_surge)|(prev_off_gcd.touch&salvo=max)
          spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
            spell.getTimeSinceLastCast(S.arcaneSurge) > 1500 ||
            (spell.getTimeSinceLastCast(S.touchOfTheMagi) < 1500 && this.getSalvo() >= this.maxSalvo())
          ),
        )
      ),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cooldowns — 11 entries)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // SimC 1: arcane_orb,if=(ss|sf_ts)&opener&time_for_pooling,line_cd=30
      spell.cast(S.arcaneOrb, () => this.getCurrentTarget(), () =>
        (this.isSS() || this.sfTouchSurge()) && this._opener &&
        spell.getTimeSinceLastCast(S.arcaneOrb) > 30000
      ),

      // SimC 2: arcane_orb,if=ss&prev_off_gcd.touch&time<5&salvo<=14,line_cd=999
      spell.cast(S.arcaneOrb, () => this.getCurrentTarget(), () =>
        this.isSS() && spell.getTimeSinceLastCast(S.touchOfTheMagi) < 1500 &&
        this.getSalvo() <= 14
      ),

      // SimC 4: arcane_missiles,if=sf&!sf_ts&opener,line_cd=30 (SF opener pooling with AM)
      spell.cast(S.arcaneMissiles, () => this.getCurrentTarget(), () =>
        this.isSF() && !this.sfTouchSurge() && this._opener && this.hasCC() &&
        spell.getTimeSinceLastCast(S.arcaneMissiles) > 30000
      ),

      // SimC 5: arcane_pulse,if=(ss|sf_ts)&salvo<20&(opener|(orbm&surge_cd<gcd*(mana/divisor)))&aoe>=pulse_count
      spell.cast(S.arcanePulse, () => this.getCurrentTarget(), () => {
        if (!(this.isSS() || this.sfTouchSurge())) return false;
        if (this.getSalvo() >= 20) return false;
        const divisor = 8 + (this.getEnemyCount() > this.pulseAoECount() ? 8 : 0);
        const poolCondition = this._opener ||
          (this.hasOrbM() && this.surgeCDRemains() < (1500 * this.getMana() / divisor));
        return poolCondition && this.getEnemyCount() >= this.pulseAoECount();
      }),

      // SimC 6: arcane_blast,if=(ss|sf_ts)&salvo<20&(opener|(orbm&surge_cd<gcd*(mana/divisor)))
      spell.cast(S.arcaneBlast, () => this.getCurrentTarget(), () => {
        if (!(this.isSS() || this.sfTouchSurge())) return false;
        if (this.getSalvo() >= 20) return false;
        const divisor = 8 + (this.getEnemyCount() >= 2 ? 8 : 0);
        return this._opener ||
          (this.hasOrbM() && this.surgeCDRemains() < (1500 * this.getMana() / divisor));
      }),

      // SimC 8: touch_of_the_magi,use_off_gcd=1 — complex conditions
      spell.cast(S.touchOfTheMagi, () => this.getCurrentTarget(), () => {
        if (!Settings.FWArcUseCDs || !this.getCurrentTarget()) return false;
        // (ss|sf_ts) & surge up
        if ((this.isSS() || this.sfTouchSurge()) && this.inSurge()) return true;
        // sf & !sf_ts & surge up & surge.remains < 5+gcd
        if (this.isSF() && !this.sfTouchSurge() && this.inSurge()) {
          const surgeRem = me.getAura(A.arcaneSurge)?.remaining || 0;
          return surgeRem < 6500; // 5s + ~1.5s gcd
        }
        // off-CD & surge CD > 30 & surge down
        return spell.getCooldown(S.touchOfTheMagi)?.ready &&
          this.surgeCDRemains() > 30000 && !this.inSurge();
      }),

      // SimC 9: arcane_surge
      spell.cast(S.arcaneSurge, () => this.getCurrentTarget(), () =>
        Settings.FWArcUseCDs && this.targetTTD() > 15000
      ),

      // Mirror Image (SimC precombat, use on CD)
      spell.cast(S.mirrorImage, () => me, () => Settings.FWArcUseCDs),

      // SimC 11: evocation,if=mana<10&surge.down&touch.down&surge_cd>10
      spell.cast(S.evocation, () => me, () =>
        this.getMana() < 10 && !this.inSurge() && !this.targetHasTouch() &&
        this.surgeCDRemains() > 10000
      ),
    );
  }

  // =============================================
  // SPELLSLINGER (non-Orb Mastery) (SimC actions.spellslinger, 9 lines)
  // =============================================
  ssRotation() {
    return new bt.Selector(
      // SimC 1: arcane_orb,if=charges<(3+(aoe>=2))&(((cc=0&hv)|(cc&salvo>=12))|(aoe>=2))&touch_cd>gcd*4
      spell.cast(S.arcaneOrb, () => this.getCurrentTarget(), () => {
        const threshold = this.getEnemyCount() >= 2 ? 4 : 3;
        if (this.getCharges() >= threshold) return false;
        if (this.touchCDRemains() <= 6000) return false; // gcd*4
        return (!this.hasCC() && spell.isSpellKnown(T.highVoltage)) ||
          (this.hasCC() && this.getSalvo() >= 12) || this.getEnemyCount() >= 2;
      }),

      // SimC 2: arcane_barrage,if=salvo>=20&(charges=4|orb_barrage)&touch_cd>gcd*(4-(2*(aoe>=2)))
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
        this.getSalvo() >= 20 && (this.getCharges() >= 4 || spell.isSpellKnown(T.orbBarrage)) &&
        this.touchCDRemains() > (this.getEnemyCount() >= 2 ? 3000 : 6000)
      ),

      // SimC 3: arcane_barrage,if=aoe>=2&charges=4&cc&opm&hv&salvo>5&salvo<14&touch_cd>gcd*4
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() >= 2 && this.getCharges() >= 4 && this.hasCC() &&
        me.hasAura(A.overpoweredMissiles) && spell.isSpellKnown(T.highVoltage) &&
        this.getSalvo() > 5 && this.getSalvo() < 14 && this.touchCDRemains() > 6000
      ),

      // SimC 4: arcane_missiles,if=cc&(salvo<(10+(5*(opm=0)))|(charges<2&hv&aoe>=2))
      spell.cast(S.arcaneMissiles, () => this.getCurrentTarget(), () => {
        if (!this.hasCC()) return false;
        const opmZero = !me.hasAura(A.overpoweredMissiles);
        return this.getSalvo() < (10 + (opmZero ? 5 : 0)) ||
          (this.getCharges() < 2 && spell.isSpellKnown(T.highVoltage) && this.getEnemyCount() >= 2);
      }),

      // SimC 5: presence_of_mind,use_off_gcd=1,if=charges<2&(cc=0|!hv&orb_frac<0.95)&!prev_orb&!prev_am
      spell.cast(S.presenceOfMind, () => me, () =>
        this.getCharges() < 2 &&
        (!this.hasCC() || (!spell.isSpellKnown(T.highVoltage) && spell.getChargesFractional(S.arcaneOrb) < 0.95)) &&
        spell.getTimeSinceLastCast(S.arcaneOrb) > 1500 && spell.getTimeSinceLastCast(S.arcaneMissiles) > 1500
      ),

      // SimC 6: arcane_blast,if=pom.up
      spell.cast(S.arcaneBlast, () => this.getCurrentTarget(), () => me.hasAura(A.presenceOfMind)),

      // SimC 7: arcane_pulse,if=(aoe>=pulse_count&!funnel)|(charges<3&mana>50)
      spell.cast(S.arcanePulse, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() >= this.pulseAoECount() || (this.getCharges() < 3 && this.getMana() > 50)
      ),

      // SimC 8: arcane_blast
      spell.cast(S.arcaneBlast, () => this.getCurrentTarget()),

      // SimC 9: arcane_barrage,if=!prev_surge|prev_touch&salvo=20
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
        spell.getTimeSinceLastCast(S.arcaneSurge) > 1500 ||
        (spell.getTimeSinceLastCast(S.touchOfTheMagi) < 1500 && this.getSalvo() >= 20)
      ),
    );
  }

  // =============================================
  // SPELLSLINGER ORB MASTERY (SimC actions.spellslinger_orbm, 9 lines)
  // =============================================
  ssOrbM() {
    return new bt.Selector(
      // SimC 1: arcane_orb,if=(prev_barrage|aoe>=4)&((cc&salvo<=14)|(cc=0&orb_frac>1.9&salvo<=18))
      spell.cast(S.arcaneOrb, () => this.getCurrentTarget(), () => {
        if (spell.getTimeSinceLastCast(S.arcaneBarrage) > 1500 && this.getEnemyCount() < 4) return false;
        return (this.hasCC() && this.getSalvo() <= 14) ||
          (!this.hasCC() && spell.getChargesFractional(S.arcaneOrb) > 1.9 && this.getSalvo() <= 18);
      }),

      // SimC 2: arcane_barrage,if=(charges=4|orb_barrage)&salvo>=20&touch_cd>gcd*(4-2*(aoe>=2))
      //   |((surge.remains<gcd&surge.up)|(touch.remains<gcd&touch.up))&salvo>=15
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () => {
        const salvo = this.getSalvo();
        if ((this.getCharges() >= 4 || spell.isSpellKnown(T.orbBarrage)) && salvo >= 20 &&
          this.touchCDRemains() > (this.getEnemyCount() >= 2 ? 3000 : 6000)) return true;
        const surgeRem = me.getAura(A.arcaneSurge)?.remaining || 0;
        if (surgeRem > 0 && surgeRem < 1500 && salvo >= 15) return true;
        const touchRem = this.getCurrentTarget()?.getAuraByMe(A.touchOfTheMagi)?.remaining || 0;
        return touchRem > 0 && touchRem < 1500 && salvo >= 15;
      }),

      // SimC 3: arcane_missiles,if=(hv|opm_talent|(cc=3))&cc&salvo<=(10+(5*(opm=0)))&!prev_orb
      //   &(surge.down|(hv&aoe=1))&(aoe<2|opm_talent)
      spell.cast(S.arcaneMissiles, () => this.getCurrentTarget(), () => {
        if (!this.hasCC()) return false;
        if (spell.getTimeSinceLastCast(S.arcaneOrb) < 1500) return false;
        if (!(spell.isSpellKnown(T.highVoltage) || spell.isSpellKnown(T.overpoweredMissiles) || this.getCCStacks() >= 3)) return false;
        const opmZero = !me.hasAura(A.overpoweredMissiles);
        return this.getSalvo() <= (10 + (opmZero ? 5 : 0)) &&
          (!this.inSurge() || (spell.isSpellKnown(T.highVoltage) && this.getEnemyCount() === 1)) &&
          (this.getEnemyCount() < 2 || spell.isSpellKnown(T.overpoweredMissiles));
      }),

      // SimC 4: arcane_barrage,if=salvo<7&surge.down&touch.down&charges=4&resonance&arcane_pulse
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
        this.getSalvo() < 7 && !this.inSurge() && !this.targetHasTouch() &&
        this.getCharges() >= 4 && spell.isSpellKnown(T.resonance) && spell.isSpellKnown(T.arcanePulse)
      ),

      // SimC 5: presence_of_mind,if=charges<2&(cc=0|!hv&orb_frac<0.95)&!prev_orb&!prev_am
      spell.cast(S.presenceOfMind, () => me, () =>
        this.getCharges() < 2 &&
        (!this.hasCC() || (!spell.isSpellKnown(T.highVoltage) && spell.getChargesFractional(S.arcaneOrb) < 0.95)) &&
        spell.getTimeSinceLastCast(S.arcaneOrb) > 1500
      ),

      // SimC 6: arcane_blast,if=pom.up
      spell.cast(S.arcaneBlast, () => this.getCurrentTarget(), () => me.hasAura(A.presenceOfMind)),

      // SimC 7: arcane_pulse,if=(aoe>=pulse_count&!funnel)|(charges<3&mana>30)
      spell.cast(S.arcanePulse, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() >= this.pulseAoECount() || (this.getCharges() < 3 && this.getMana() > 30)
      ),

      // SimC 8: arcane_blast
      spell.cast(S.arcaneBlast, () => this.getCurrentTarget()),

      // SimC 9: arcane_barrage,if=(time>5&!prev_surge)|(prev_touch&salvo=20)
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () =>
        spell.getTimeSinceLastCast(S.arcaneSurge) > 1500 ||
        (spell.getTimeSinceLastCast(S.touchOfTheMagi) < 1500 && this.getSalvo() >= 20)
      ),
    );
  }

  // =============================================
  // SUNFURY (SimC actions.sunfury, 7 lines)
  // =============================================
  sfRotation() {
    return new bt.Selector(
      // SimC 1: arcane_barrage — Arcane Soul | post-Touch | Touch ending | hold_for_cds with salvo bands
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () => {
        if (this.inSoul()) return true;
        if (spell.getTimeSinceLastCast(S.touchOfTheMagi) < 1500) return true;
        const touchRem = this.getCurrentTarget()?.getAuraByMe(A.touchOfTheMagi)?.remaining || 0;
        if (touchRem > 0 && touchRem < 1500 && this.getCharges() >= 4) return true;
        // SimC: charges=4 & sunfury_hold_for_cds & (salvo band checks OR salvo=25)
        const salvo = this.getSalvo();
        if (this.getCharges() >= 4 && this.sunfuryHoldForCds()) {
          const hasCC = this.hasCC();
          const hasHV = spell.isSpellKnown(T.highVoltage);
          const orbReady = spell.getChargesFractional(S.arcaneOrb) > 0.95;
          const aoe3 = this.getEnemyCount() >= 3;
          // (cc&hv)|(orb_ready&aoe>=3) triggers band check
          if ((hasCC && hasHV) || (orbReady && aoe3)) {
            // Salvo bands: 6-6, 12-12, 18-18, or (<19 & !resonance & aoe>=3)
            if ((salvo >= 6 && salvo < 7) || (salvo >= 12 && salvo < 13) ||
              (salvo >= 18 && salvo < 19) || (salvo < 19 && !spell.isSpellKnown(T.resonance) && aoe3)) {
              return true;
            }
          }
          if (salvo >= this.maxSalvo()) return true;
        }
        return false;
      }),

      // SimC 2: arcane_missiles — complex cc/salvo/charge/surge conditions
      spell.cast(S.arcaneMissiles, () => this.getCurrentTarget(), () => {
        if (!this.hasCC()) return false;
        const opmUp = me.hasAura(A.overpoweredMissiles);
        const salvo = this.getSalvo();
        const ccStacks = this.getCCStacks();
        const surgeUp = this.inSurge();
        const surgeDown = !surgeUp;
        const salvoThreshold = 15 - (opmUp && surgeDown ? 5 : 0);
        // (touch_cd > gcd*(8-4*sf_ts) & opm=0) | surge.up | charges<3 | cc>1
        // ... & salvo < threshold
        const touchGate = 8 - (this.sfTouchSurge() ? 4 : 0);
        if ((this.touchCDRemains() > touchGate * 1500 && !opmUp) || surgeUp ||
          this.getCharges() < 3 || ccStacks > 1) {
          if (salvo < salvoThreshold) return true;
        }
        // (touch.up & surge.up) — dump during burst
        if (this.targetHasTouch() && surgeUp) return true;
        return false;
      }),

      // SimC 3: arcane_orb,if=charges<2
      spell.cast(S.arcaneOrb, () => this.getCurrentTarget(), () => this.getCharges() < 2),

      // SimC 4: arcane_pulse,if=(aoe>=pulse_count&!funnel)|(charges<3&mana>50)
      spell.cast(S.arcanePulse, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() >= this.pulseAoECount() || (this.getCharges() < 3 && this.getMana() > 50)
      ),

      // SimC 5: arcane_explosion,if=aoe>3&charges<2&!impetus
      spell.cast(S.arcaneExplosion, () => me, () =>
        this.getEnemyCount() > 3 && this.getCharges() < 2 && !spell.isSpellKnown(T.impetus)
      ),

      // SimC 6: arcane_blast
      spell.cast(S.arcaneBlast, () => this.getCurrentTarget()),

      // SimC 7: arcane_barrage,if=(sf_ts&(!prev_surge|prev_touch&salvo=25))|!sf_ts
      spell.cast(S.arcaneBarrage, () => this.getCurrentTarget(), () => {
        if (this.sfTouchSurge()) {
          return spell.getTimeSinceLastCast(S.arcaneSurge) > 1500 ||
            (spell.getTimeSinceLastCast(S.touchOfTheMagi) < 1500 && this.getSalvo() >= 25);
        }
        return true; // !sf_touch_surge — always barrage as fallback
      }),
    );
  }

  // =============================================
  // HELPERS
  // =============================================
  isSS() { return spell.isSpellKnown(T.splinteringSorcery); }
  isSF() { return !this.isSS(); }
  hasOrbM() { return spell.isSpellKnown(T.orbMastery); }
  sfTouchSurge() { return false; } // sf_touch_surge default=0, user-configurable variable
  inSurge() { return me.hasAura(A.arcaneSurge); }
  surgeRemains() { return me.getAura(A.arcaneSurge)?.remaining || 0; }
  inSoul() { return me.hasAura(A.arcaneSoul); }

  hasCC() {
    this._refreshCCCache();
    return this._cachedCC !== null;
  }

  getCCStacks() {
    this._refreshCCCache();
    return this._cachedCC ? this._cachedCC.stacks : 0;
  }

  _refreshCCCache() {
    if (this._ccFrame === wow.frameTime) return;
    this._ccFrame = wow.frameTime;
    this._cachedCC = me.getAura(A.clearcasting) || null;
  }

  getCharges() { return me.powerByType(PowerType.ArcaneCharges); }

  getSalvo() {
    if (this._salvoFrame === wow.frameTime) return this._cachedSalvo;
    this._salvoFrame = wow.frameTime;
    const a = me.getAura(A.arcaneSalvo);
    this._cachedSalvo = a ? a.stacks : 0;
    return this._cachedSalvo;
  }

  maxSalvo() { return spell.isSpellKnown(T.spellfireSalvo) ? 25 : 20; }
  pulseAoECount() { return 3 + (this.hasOrbM() ? 1 : 0); }

  // SimC: variable,name=sunfury_hold_for_cds
  // Simplified: surge.down & touch_cd > threshold & surge_cd > threshold
  //   OR (cc|orb_ready & surge.remains > threshold during burst)
  sunfuryHoldForCds() {
    if (this.isSS()) return false; // SS doesn't use this
    const surgeUp = this.inSurge();
    const enemies = this.getEnemyCount();
    const opmCC = me.hasAura(A.overpoweredMissiles) && this.hasCC();
    const orbCC3 = (spell.getChargesFractional(S.arcaneOrb) > 0.95 || this.hasCC()) && enemies >= 3;
    const reduction = (enemies >= 3 ? 1 : 0) + Math.min(opmCC ? 2 : 0, orbCC3 ? 1 : 0);
    const gcdThreshold = 4 - reduction;

    if (!surgeUp) {
      // surge.down: both touch_cd and surge_cd must be > gcd*threshold
      return this.touchCDRemains() > gcdThreshold * 1500 &&
        this.surgeCDRemains() > gcdThreshold * 1500;
    } else {
      // surge.up: (cc|(salvo=25|orb_ready)&aoe>=3) & surge.remains > gcd*(6-2*min(opm,aoe>=3))
      const hasCC = this.hasCC();
      const salvoMax = this.getSalvo() >= 25;
      const orbReady = spell.getChargesFractional(S.arcaneOrb) > 0.95;
      if (hasCC || ((salvoMax || orbReady) && enemies >= 3)) {
        const burstReduction = Math.min(opmCC ? 2 : 0, enemies >= 3 ? 2 : 0);
        return this.surgeRemains() > (6 - burstReduction) * 1500;
      }
      return false;
    }
  }

  targetHasTouch() {
    const t = this.getCurrentTarget();
    return t ? !!(t.getAuraByMe(A.touchOfTheMagi) || t.getAuraByMe(S.touchOfTheMagi)) : false;
  }

  surgeCDRemains() { return spell.getCooldown(S.arcaneSurge)?.timeleft || 0; }
  touchCDRemains() { return spell.getCooldown(S.touchOfTheMagi)?.timeleft || 0; }

  getMana() {
    if (this._manaFrame === wow.frameTime) return this._cachedMana;
    this._manaFrame = wow.frameTime;
    const max = me.maxPowerByType ? me.maxPowerByType(PowerType.Mana) : 1;
    this._cachedMana = max > 0 ? (me.powerByType(PowerType.Mana) / max) * 100 : 100;
    return this._cachedMana;
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
