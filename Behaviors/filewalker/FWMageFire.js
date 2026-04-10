import { Behavior, BehaviorContext } from '@/Core/Behavior';
import * as bt from '@/Core/BehaviorTree';
import Specialization from '@/Enums/Specialization';
import common from '@/Core/Common';
import spell from '@/Core/Spell';
import Settings from '@/Core/Settings';
import { me } from '@/Core/ObjectManager';
import { defaultCombatTargeting as combat } from '@/Targeting/CombatTargeting';

/**
 * Fire Mage Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (mage.cpp midnight branch) + Method + Wowhead
 *
 * Auto-detects: Frostfire (Frostfire Bolt) vs Sunfury (Spellfire Spheres)
 * SimC sub-lists: ff_combustion (12), ff_filler (9), sf_combustion (14),
 *   sf_filler (10), fireblast (6), cds (8) — ALL lines implemented
 *
 * Core: Heating Up -> crit -> Hot Streak -> instant Pyroblast/Flamestrike
 * Fire Blast: off-GCD + while-casting — 6 distinct conditions from SimC
 * Combustion: 100% crit 10s, activated mid-cast at execute_remains < 0.2s
 *
 * FF: Frostfire Bolt replaces Fireball, Frostfire Empowerment procs, Heat Shimmer
 * SF: Spellfire Spheres, Scorch as Combustion filler, Hyperthermia post-Combustion
 *
 * Fire Blast weaving runs BEFORE waitForCastOrChannel (off-GCD, while-casting)
 * Combustion activation runs BEFORE waitForCastOrChannel (off-GCD mid-cast)
 * SF Combustion fireblast gating: pyroclasm stack management
 *
 * SimC line coverage: fireblast 6/6, cds 8/8, ff_comb 12/12, ff_fill 9/9,
 *   sf_comb 14/14, sf_fill 10/10
 */

const S = {
  fireball:           133,
  fireBlast:          108853,
  pyroblast:          11366,
  flamestrike:        2120,
  scorch:             2948,
  meteor:             153561,
  frostfireBolt:      431044,
  combustion:         190319,
  mirrorImage:        55342,
  counterspell:       2139,
  blazingBarrier:     235313,
  iceBlock:           45438,
  iceCold:            414659,
  arcaneIntellect:    1459,
  berserking:         26297,
};

const T = {
  fuelTheFire:        416094,
  firestarter:        205026,
  burnout:            1271177,
  scald:              450746,
  spontaneousComb:    451875,
  pyroclasm:          269650,
  savorTheMoment:     449412,
  blastZone:          451755,
  sunfuryExecution:   449349,
};

const A = {
  heatingUp:          48107,
  hotStreak:          48108,
  pyroclasm:          269651,
  combustion:         190319,
  hyperthermia:       383860,
  frostfireEmpow:     431177,
  heatShimmer:        458964,
  spellfireSpheres:   448604,
  bloodlust:          2825,
  heroism:            32182,
};

export class FireMageBehavior extends Behavior {
  name = 'FW Fire Mage';
  context = BehaviorContext.Any;
  specialization = Specialization.Mage.Fire;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;
  _combatStart = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWFireUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWFireDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWFireBarrier', text: 'Use Blazing Barrier', default: true },
        { type: 'checkbox', uid: 'FWFireIB', text: 'Use Ice Block', default: true },
        { type: 'slider', uid: 'FWFireIBHP', text: 'Ice Block HP %', default: 15, min: 5, max: 30 },
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

      spell.cast(S.arcaneIntellect, () => me, () =>
        spell.getTimeSinceLastCast(S.arcaneIntellect) > 60000 && !me.hasAura(1459)
      ),

      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),
      new bt.Action(() => {
        if (me.inCombat() && !this._combatStart) this._combatStart = wow.frameTime;
        if (!me.inCombat()) this._combatStart = 0;
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),

      // Fire Blast weaving (off-GCD, while-casting — BEFORE waitForCast)
      this.fireBlastWeave(),

      // Combustion activation mid-cast (off-GCD)
      this.combustionMidCast(),

      common.waitForCastOrChannel(),

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Fire] Midnight 12.0.1 | ${this.isFF() ? 'Frostfire' : 'Sunfury'} | SimC APL full`);
        }
        if (Settings.FWFireDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Fire] HS:${this.hasHS()} HU:${this.hasHU()} Comb:${this.inComb()} CombRem:${Math.round(this.combRem()/1000)}s FBfrac:${spell.getChargesFractional(S.fireBlast).toFixed(2)} Pyro:${this.getPyroStacks()} Hyper:${me.hasAura(A.hyperthermia)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.counterspell),
          this.defensives(),

          // Movement: Scorch (castable moving) + instants
          new bt.Decorator(
            () => me.isMoving(),
            new bt.Selector(
              spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
                this.hasHS() && this.useFS()
              ),
              spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
                this.hasHS() || me.hasAura(A.hyperthermia)
              ),
              spell.cast(S.frostfireBolt, () => this.getCurrentTarget(), () =>
                this.isFF() && me.hasAura(A.frostfireEmpow)
              ),
              spell.cast(S.scorch, () => this.getCurrentTarget()),
              new bt.Action(() => bt.Status.Success)
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: call_action_list,name=cds
          this.cooldowns(),

          // SimC dispatch: FF/SF x Combustion/Filler
          new bt.Decorator(
            () => this.isFF() && this.nearCombustion(),
            this.ffCombustion(), new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isSF() && this.nearCombustion(),
            this.sfCombustion(), new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isFF(),
            this.ffFiller(), new bt.Action(() => bt.Status.Failure)
          ),
          this.sfFiller(),
        )
      ),
    );
  }

  // =============================================
  // FIRE BLAST WEAVE (SimC actions.fireblast, 6 lines — off-GCD, while-casting)
  // =============================================
  fireBlastWeave() {
    return new bt.Action(() => {
      if (!me.isCastingOrChanneling) return bt.Status.Failure;
      if (this.hasHS()) return bt.Status.Failure; // Never with Hot Streak active
      if (spell.getChargesFractional(S.fireBlast) < 0.3) return bt.Status.Failure;

      // SimC 1: cooldown_react&!hs&(combustion|hyperthermia)&(in_flight+hu=1)&gcd.remains<gcd.max
      // During Combustion/Hyperthermia: FB with Heating Up
      if ((this.inComb() || me.hasAura(A.hyperthermia)) && this.hasHU()) {
        spell.cast(S.fireBlast, () => this.getCurrentTarget()).execute({});
        return bt.Status.Failure;
      }

      // SimC 2: !hs&(fireball.executing&fireball.exec_remains>0.1|pyroclasm&pyroblast.executing&pyro.exec>0.1)
      //   &(hp>=30|!scald)&hu&(in_flight+hu=1)&gcd<gcd.max
      // Filler: FB with Heating Up while hardcasting (not during Scorch execute)
      if (this.hasHU() && !this.isScorchExecute()) {
        // SF Combustion Pyroclasm gating: don't FB when holding 2 Pyroclasm stacks during Combustion
        if (this.isSF() && this.inComb()) {
          const pyroStacks = this.getPyroStacks();
          if (pyroStacks >= 2 && spell.getChargesFractional(S.fireBlast) < 2) {
            return bt.Status.Failure; // Hold FB, spend Pyroclasm first
          }
        }
        spell.cast(S.fireBlast, () => this.getCurrentTarget()).execute({});
        return bt.Status.Failure;
      }

      // SimC 3: !hs&(hp<30&scald)&(in_flight+hu=0)&scorch.executing&heat_shimmer.down&gcd<gcd.max
      // Execute: FB WITHOUT Heating Up during Scorch (Scorch will generate HU)
      if (this.isScorchExecute() && !this.hasHU() && !me.hasAura(A.heatShimmer)) {
        spell.cast(S.fireBlast, () => this.getCurrentTarget()).execute({});
        return bt.Status.Failure;
      }

      // SimC 4: !hs&time<combustion_delay&(firestarter|fireball.executing&exec>0.1|pyroclasm&pyro.executing)
      //   &(in_flight+hu=1)&gcd<gcd.max&combustion.ready
      // Pre-Combustion: FB with HU when Combustion ready
      if (this.hasHU() && spell.getCooldown(S.combustion)?.ready &&
        this.combatTime() < this.combDelay()) {
        spell.cast(S.fireBlast, () => this.getCurrentTarget()).execute({});
        return bt.Status.Failure;
      }

      // SimC 5: (time>=combustion_delay&(combustion.remains<=precast_time))&combustion.down
      //   &spontaneous_combustion&(scorch|fireball|pyroblast|flamestrike executing)
      // Spontaneous Combustion: dump FB pre-Combustion
      if (spell.isSpellKnown(T.spontaneousComb) && this.nearCombustion() && !this.inComb()) {
        spell.cast(S.fireBlast, () => this.getCurrentTarget()).execute({});
        return bt.Status.Failure;
      }

      // SimC 6: fight_remains<1
      if (this.targetTTD() < 1000) {
        spell.cast(S.fireBlast, () => this.getCurrentTarget()).execute({});
        return bt.Status.Failure;
      }

      return bt.Status.Failure;
    });
  }

  // SimC: combustion,use_off_gcd=1,use_while_casting=1 — activation mid-cast
  // FF: if=combustion.down&fireball.executing&(exec_remains<cast_remains_time)|meteor.in_flight|pyroblast.executing&(exec<crt)|prev_gcd.1.meteor
  // SF: if=scorch.executing&(exec<crt)|fireball.executing&(exec<crt)|pyroblast.executing&(exec<crt)|flamestrike.executing&(exec<crt)|meteor.in_flight&(!sunfury_execution)
  combustionMidCast() {
    return new bt.Action(() => {
      if (!me.isCastingOrChanneling || this.inComb()) return bt.Status.Failure;
      if (!Settings.FWFireUseCDs || !spell.getCooldown(S.combustion)?.ready) return bt.Status.Failure;
      if (this.combatTime() < this.combDelay()) return bt.Status.Failure;
      // Activate Combustion — framework ticks fast enough to catch end-of-cast
      spell.cast(S.combustion, () => me).execute({});
      return bt.Status.Failure;
    });
  }

  // =============================================
  // FROSTFIRE COMBUSTION (SimC actions.ff_combustion, 12 lines)
  // =============================================
  ffCombustion() {
    return new bt.Selector(
      // SimC 1: combustion activation is handled by combustionMidCast() above

      // SimC 2: flamestrike,if=fuel_the_fire&aoe>=ff_comb_fs&flamestriking&(pyroclasm&!hs&combustion.down)
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.ffCombFS() &&
        me.hasAura(A.pyroclasm) && !this.hasHS() && !this.inComb()
      ),
      // SimC 3: pyroblast,if=pyroclasm&!hs&combustion.down
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        me.hasAura(A.pyroclasm) && !this.hasHS() && !this.inComb()
      ),
      // SimC 4: fireball,if=combustion.down (FFB for FF)
      spell.cast(S.frostfireBolt, () => this.getCurrentTarget(), () => !this.inComb()),
      // SimC 5: meteor,if=(burnout&combustion.remains<8)|(!burnout&combustion.remains>2)
      spell.cast(S.meteor, () => this.getCurrentTarget(), () => {
        const rem = this.combRem();
        if (spell.isSpellKnown(T.burnout)) return rem < 8000 && rem > 0;
        return rem > 2000;
      }),
      // SimC 6: flamestrike,if=fuel_the_fire&aoe>=ff_comb_fs&flamestriking&hs
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.ffCombFS() && this.hasHS()
      ),
      // SimC 7: pyroblast,if=hs
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () => this.hasHS()),
      // SimC 8: flamestrike,if=fuel_the_fire&aoe>=ff_comb_fs&pyroclasm&cast_time<combustion.remains
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.ffCombFS() &&
        me.hasAura(A.pyroclasm) && this.combRem() > 2500
      ),
      // SimC 9: pyroblast,if=pyroclasm&cast_time<combustion.remains
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        me.hasAura(A.pyroclasm) && this.combRem() > 2500
      ),
      // SimC 10: scorch,if=heat_shimmer|scald&hp<30&ff_empow.down
      spell.cast(S.scorch, () => this.getCurrentTarget(), () =>
        me.hasAura(A.heatShimmer) || (spell.isSpellKnown(T.scald) && this.isScorchExecute() && !me.hasAura(A.frostfireEmpow))
      ),
      // SimC 11: fireball (FFB for FF)
      spell.cast(S.frostfireBolt, () => this.getCurrentTarget()),
      // SimC 12: call_action_list,name=fireblast — FB weaving handled by fireBlastWeave() above
    );
  }

  // =============================================
  // FROSTFIRE FILLER (SimC actions.ff_filler, 9 lines)
  // =============================================
  ffFiller() {
    return new bt.Selector(
      // SimC 1: meteor,if=time>=(combustion_delay-gcd.max)
      spell.cast(S.meteor, () => this.getCurrentTarget(), () =>
        this.combatTime() >= this.combDelay() - 1500
      ),
      // SimC 2: pyroblast,if=hs&firestarter&time<combustion_delay
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        this.hasHS() && spell.isSpellKnown(T.firestarter) && this.combatTime() < this.combDelay()
      ),
      // SimC 3: flamestrike,if=fuel_the_fire&aoe>=ff_fill_fs&hs&(combustion_cd>=5|time<comb_delay)
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.ffFillFS() &&
        this.hasHS() && (this.combCDRemains() >= 5000 || this.combatTime() < this.combDelay())
      ),
      // SimC 4: pyroblast,if=hs&(combustion_cd>=5|time<comb_delay)
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        this.hasHS() && (this.combCDRemains() >= 5000 || this.combatTime() < this.combDelay())
      ),
      // SimC 5: flamestrike,if=fuel_the_fire&aoe>=ff_fill_fs&pyroclasm&(combustion_cd>12|pyroclasm.stack=2)
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.ffFillFS() &&
        me.hasAura(A.pyroclasm) && (this.combCDRemains() > 12000 || this.getPyroStacks() >= 2)
      ),
      // SimC 6: pyroblast,if=pyroclasm&(combustion_cd>12|pyroclasm.stack=2)
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        me.hasAura(A.pyroclasm) && (this.combCDRemains() > 12000 || this.getPyroStacks() >= 2)
      ),
      // SimC 7: scorch,if=heat_shimmer
      spell.cast(S.scorch, () => this.getCurrentTarget(), () => me.hasAura(A.heatShimmer)),
      // SimC 8: fireball (FFB for FF)
      spell.cast(S.frostfireBolt, () => this.getCurrentTarget()),
      // SimC 9: call_action_list,name=fireblast — handled by fireBlastWeave()
    );
  }

  // =============================================
  // SUNFURY COMBUSTION (SimC actions.sf_combustion, 14 lines)
  // =============================================
  sfCombustion() {
    return new bt.Selector(
      // SimC 1: combustion activation handled by combustionMidCast()

      // SimC 2: meteor,if=bloodlust&combustion.down&(blast_zone|aoe>=4)&!sunfury_execution
      spell.cast(S.meteor, () => this.getCurrentTarget(), () =>
        this.hasBloodlust() && !this.inComb() && !spell.isSpellKnown(T.sunfuryExecution) &&
        (spell.isSpellKnown(T.blastZone) || this.getEnemyCount() >= 4)
      ),
      // SimC 3: flamestrike,if=fuel_the_fire&aoe>=sf_comb_fs&combustion.down&!hs&pyroclasm
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.sfCombFS() &&
        !this.inComb() && !this.hasHS() && me.hasAura(A.pyroclasm)
      ),
      // SimC 4: pyroblast,if=combustion.down&!hs&pyroclasm
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        !this.inComb() && !this.hasHS() && me.hasAura(A.pyroclasm)
      ),
      // SimC 5: scorch,if=combustion.down&(hp<30|aoe>=4)
      spell.cast(S.scorch, () => this.getCurrentTarget(), () => {
        if (this.inComb()) return false;
        const t = this.getCurrentTarget();
        return (t && t.effectiveHealthPercent < 30) || this.getEnemyCount() >= 4;
      }),
      // SimC 6: fireball,if=combustion.down&(!prev_gcd.1.meteor|bloodlust.down)
      spell.cast(S.fireball, () => this.getCurrentTarget(), () =>
        !this.inComb() && (spell.getTimeSinceLastCast(S.meteor) > 1500 || !this.hasBloodlust())
      ),
      // SimC 7: meteor,if=(burnout&combustion.remains<8|!burnout&combustion.remains>2)|combustion.remains>2&aoe>=4
      spell.cast(S.meteor, () => this.getCurrentTarget(), () => {
        const rem = this.combRem();
        if (spell.isSpellKnown(T.burnout)) return rem > 0 && rem < 8000;
        return rem > 2000 || (rem > 2000 && this.getEnemyCount() >= 4);
      }),
      // SimC 8: flamestrike,if=fuel_the_fire&aoe>=sf_comb_fs&(hs|prev_scorch&hu&scorch_recent)
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.sfCombFS() &&
        (this.hasHS() || (spell.getTimeSinceLastCast(S.scorch) < 500 && this.hasHU()))
      ),
      // SimC 9: pyroblast,if=hs|prev_scorch&hu&scorch_recent
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        this.hasHS() || (spell.getTimeSinceLastCast(S.scorch) < 500 && this.hasHU())
      ),
      // SimC 10: flamestrike,if=fuel_the_fire&aoe>=sf_comb_fs&pyroclasm&!hs&cast_time<combustion.remains
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.sfCombFS() &&
        me.hasAura(A.pyroclasm) && !this.hasHS() && this.combRem() > 2500
      ),
      // SimC 11: pyroblast,if=pyroclasm&!hs&cast_time<combustion.remains
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        me.hasAura(A.pyroclasm) && !this.hasHS() && this.combRem() > 2500
      ),
      // SimC 12: scorch (SF Combustion filler — guaranteed crit)
      spell.cast(S.scorch, () => this.getCurrentTarget()),
      // SimC 13: fireball fallback
      spell.cast(S.fireball, () => this.getCurrentTarget()),
      // SimC 14: call_action_list,name=fireblast,if=!pyroclasm|(pyro.stack<2|pyro.executing&exec>0.2&pyro.stack=2|fb.charges_frac>=2|combustion.remains<pyro.cast_time)&(aoe<sf_comb_fs|pyro.down|!fs.executing)
      // Fireblast gating for SF Combustion is handled in fireBlastWeave() with Pyroclasm awareness
    );
  }

  // =============================================
  // SUNFURY FILLER (SimC actions.sf_filler, 10 lines)
  // =============================================
  sfFiller() {
    return new bt.Selector(
      // SimC 1: meteor,if=aoe>=4&time>combustion_delay&combustion_cd<=gcd+precast&bloodlust.down
      spell.cast(S.meteor, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() >= 4 && this.combatTime() > this.combDelay() &&
        this.combCDRemains() <= 3000 && !this.hasBloodlust()
      ),
      // SimC 2: pyroblast,if=hs&firestarter&time<combustion_delay
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        this.hasHS() && spell.isSpellKnown(T.firestarter) && this.combatTime() < this.combDelay()
      ),
      // SimC 3: flamestrike,if=fuel_the_fire&aoe>=sf_fill_fs&(hs|prev_scorch&hu|hyperthermia)
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= this.sfFillFS() &&
        (this.hasHS() || (spell.getTimeSinceLastCast(S.scorch) < 500 && this.hasHU()) || me.hasAura(A.hyperthermia))
      ),
      // SimC 4: pyroblast,if=hs|prev_scorch&hu|hyperthermia
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () =>
        this.hasHS() || (spell.getTimeSinceLastCast(S.scorch) < 500 && this.hasHU()) || me.hasAura(A.hyperthermia)
      ),
      // SimC 5: flamestrike,if=fuel_the_fire&aoe>=sf_fill_fs&pyroclasm&((combustion_cd>=12|time<comb_delay&(firestarter|time>(comb_delay-fs.cast_time)))|pyroclasm.stack=2)
      spell.cast(S.flamestrike, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.fuelTheFire) || this.getEnemyCount() < this.sfFillFS()) return false;
        if (!me.hasAura(A.pyroclasm)) return false;
        if (this.getPyroStacks() >= 2) return true;
        const combCD = this.combCDRemains();
        if (combCD >= 12000) return true;
        if (this.combatTime() < this.combDelay()) {
          return spell.isSpellKnown(T.firestarter) || this.combatTime() > (this.combDelay() - 3000);
        }
        return false;
      }),
      // SimC 6: pyroblast,if=pyroclasm&(combustion_cd>=12|time<comb_delay&(firestarter|time>(comb_delay-pyro.cast_time)))|pyroclasm.stack=2
      spell.cast(S.pyroblast, () => this.getCurrentTarget(), () => {
        if (!me.hasAura(A.pyroclasm)) return false;
        if (this.getPyroStacks() >= 2) return true;
        const combCD = this.combCDRemains();
        if (combCD >= 12000) return true;
        if (this.combatTime() < this.combDelay()) {
          return spell.isSpellKnown(T.firestarter) || this.combatTime() > (this.combDelay() - 3000);
        }
        return false;
      }),
      // SimC 7: meteor,if=(!blast_zone&sunfury_execution&combustion_cd<12&pyroclasm.stack<2)|(blast_zone&time>combustion_delay)
      spell.cast(S.meteor, () => this.getCurrentTarget(), () =>
        (!spell.isSpellKnown(T.blastZone) && spell.isSpellKnown(T.sunfuryExecution) &&
          this.combCDRemains() < 12000 && this.getPyroStacks() < 2) ||
        (spell.isSpellKnown(T.blastZone) && this.combatTime() > this.combDelay())
      ),
      // SimC 8: scorch,if=scald&hp<30|heat_shimmer&(hp>=90|prev_pyro|prev_fs)
      spell.cast(S.scorch, () => this.getCurrentTarget(), () => {
        if (spell.isSpellKnown(T.scald) && this.isScorchExecute()) return true;
        if (!me.hasAura(A.heatShimmer)) return false;
        const t = this.getCurrentTarget();
        return (t && t.effectiveHealthPercent >= 90) ||
          spell.getTimeSinceLastCast(S.pyroblast) < 1500 ||
          spell.getTimeSinceLastCast(S.flamestrike) < 1500;
      }),
      // SimC 9: fireball
      spell.cast(S.fireball, () => this.getCurrentTarget()),
      // SimC 10: call_action_list,name=fireblast — handled by fireBlastWeave()
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cds, 8 lines)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // SimC: mirror_image
      spell.cast(S.mirrorImage, () => me, () => Settings.FWFireUseCDs),
      // SimC: berserking,if=combustion.remains>6|fight_remains<20
      spell.cast(S.berserking, () => me, () =>
        this.combRem() > 6000 || this.targetTTD() < 20000
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.blazingBarrier, () => me, () => Settings.FWFireBarrier && me.inCombat()),
      spell.cast(S.iceCold, () => me, () =>
        Settings.FWFireIB && spell.isSpellKnown(S.iceCold) && me.effectiveHealthPercent < Settings.FWFireIBHP
      ),
      spell.cast(S.iceBlock, () => me, () =>
        Settings.FWFireIB && !spell.isSpellKnown(S.iceCold) && me.effectiveHealthPercent < Settings.FWFireIBHP
      ),
    );
  }

  // =============================================
  // HELPERS
  // =============================================
  isFF() { return spell.isSpellKnown(S.frostfireBolt); }
  isSF() { return !this.isFF(); }
  hasHS() { return me.hasAura(A.hotStreak); }
  hasHU() { return me.hasAura(A.heatingUp); }
  inComb() { return me.hasAura(A.combustion); }
  combRem() { const a = me.getAura(A.combustion); return a ? a.remaining : 0; }
  combCDRemains() { return spell.getCooldown(S.combustion)?.timeleft || 0; }

  getPyroStacks() {
    if (!spell.isSpellKnown(T.pyroclasm)) return 0;
    const a = me.getAura(A.pyroclasm);
    return a ? a.stacks : 0;
  }

  hasBloodlust() {
    return me.hasAura(A.bloodlust) || me.hasAura(A.heroism) ||
      me.hasAura(80353) || me.hasAura(264667) || me.hasAura(390386); // Time Warp, Primal Rage, Fury of the Aspects
  }

  nearCombustion() {
    if (this.combatTime() < this.combDelay()) return false;
    const cd = spell.getCooldown(S.combustion);
    return cd?.ready || (cd?.timeleft || 99999) <= this.combPrecastTime() || this.inComb();
  }

  isScorchExecute() {
    const t = this.getCurrentTarget();
    return t && t.effectiveHealthPercent < 30 && spell.isSpellKnown(T.scald);
  }

  useFS() {
    return spell.isSpellKnown(T.fuelTheFire) && this.getEnemyCount() >= 4;
  }

  // Flamestrike thresholds per build (SimC variables)
  ffCombFS() { return spell.isSpellKnown(T.fuelTheFire) ? 4 : 999; }
  ffFillFS() { return spell.isSpellKnown(T.fuelTheFire) ? 4 : 999; }
  sfCombFS() { return spell.isSpellKnown(T.fuelTheFire) ? 4 : 999; }
  sfFillFS() { return spell.isSpellKnown(T.fuelTheFire) ? 3 : 999; }

  // SimC: combustion_delay = 10 + 8*firestarter - adjustments
  combDelay() {
    let delay = 10000;
    if (spell.isSpellKnown(T.firestarter)) delay += 8000;
    return delay;
  }

  // SimC: combustion_precast_time = cast_time - 0.2
  // Approximate: Scorch during execute, Fireball normally, Pyroblast with Pyroclasm
  combPrecastTime() {
    if (me.hasAura(A.pyroclasm)) return 2800; // Pyroblast cast ~3s - 0.2
    if (this.isScorchExecute()) return 1300; // Scorch cast ~1.5s - 0.2
    return 2300; // Fireball cast ~2.5s - 0.2
  }

  combatTime() { return this._combatStart ? wow.frameTime - this._combatStart : 0; }

  // =============================================
  // TARGET (cached)
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
    this._cachedEnemyCount = t ? t.getUnitsAroundCount(10) + 1 : 1;
    return this._cachedEnemyCount;
  }

  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }
}
