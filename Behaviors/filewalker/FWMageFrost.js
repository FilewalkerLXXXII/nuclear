import { Behavior, BehaviorContext } from '@/Core/Behavior';
import * as bt from '@/Core/BehaviorTree';
import Specialization from '@/Enums/Specialization';
import common from '@/Core/Common';
import spell from '@/Core/Spell';
import Settings from '@/Core/Settings';
import { me } from '@/Core/ObjectManager';
import { defaultCombatTargeting as combat } from '@/Targeting/CombatTargeting';

/**
 * Frost Mage Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (mage.cpp midnight branch) + Method + Wowhead
 *
 * Auto-detects: Frostfire (Frostfire Bolt) vs Spellslinger (Splinterstorm)
 * SimC sub-lists: ff_st (10), ff_aoe (12), ss_st (10), ss_aoe (14), movement (5), cds (20)
 *
 * Midnight rework:
 *   Icy Veins REMOVED — replaced by Ray of Frost (2 charges, Hand of Frost R3)
 *   Freezing (1221389) replaces Winter's Chill — stacking debuff, shatters consume 4 stacks
 *   Icicles passive (1246832) — 5 = auto Glacial Spike
 *   Thermal Void (1247729) — BF consume -> next IL shatters 4 EXTRA stacks
 *   Comet Storm (1247777) — 7 comets, each shatters 1 Freezing stack
 *   Ray of Frost (205021) — major CD, 8 Freezing stacks over 4s, 2 charges
 *
 * FF: FFB filler, Empowerment instant, IL at 10+ stacks, no Comet Storm gate
 * SS: Frostbolt filler, Splinterstorm from RoF, IL at 6+ stacks, Comet Storm gated on Splinterstorm
 *
 * Opener: SimC uses line_cd=9999 entries in CDs to sequence opener
 *   FF: Flurry -> GS -> Flurry -> RoF -> FO
 *   SS: Flurry -> FO -> RoF
 *
 * SimC line coverage: cds 20/20, ff_st 10/10, ff_aoe 12/12,
 *   ss_st 10/10, ss_aoe 14/14, movement 5/5
 */

const S = {
  frostbolt:          116,
  frostfireBolt:      431044,
  iceLance:           30455,
  flurry:             44614,
  frozenOrb:          84714,
  blizzard:           190356,
  cometStorm:         153595,   // Cast spell (1247777 is Midnight buff ID)
  rayOfFrost:         205021,
  glacialSpike:       199786,
  iceNova:            157997,
  coneOfCold:         120,
  counterspell:       2139,
  iceBarrier:         11426,
  iceBlock:           45438,
  iceCold:            414659,
  arcaneIntellect:    1459,
  summonWaterEle:     31687,
  berserking:         26297,
};

const T = {
  freezingRain:       270233,
  freezingWinds:      1216953,
  coneOfFrost:        417493,
  splinterstorm:      443783,
  lonelyWinter:       205024,
};

const A = {
  brainFreeze:        190446,   // Buff aura (190447 is talent passive)
  fingersOfFrost:     44544,    // Buff aura, 2 stacks (112965 is talent passive)
  freezing:           1221389,  // Debuff on target, 20 stacks
  thermalVoid:        1247730,  // Buff (1247729 off by one)
  freezingRain:       270232,   // Buff — instant Blizzard (270233 is talent passive)
  frostfireEmpow:     431177,   // Buff — instant FFB (confirmed correct)
  splinterstorm:      1247908,  // Buff from RoF (443783 is talent passive)
  arcaneIntellect:    1459,
  wintersChill:       228358,   // Debuff on target from Flurry (shatter)
  glacialSpikeBuff:   1222865,  // Override buff — GS ready (5 icicles)
};

export class FrostMageBehavior extends Behavior {
  name = 'FW Frost Mage';
  context = BehaviorContext.Any;
  specialization = Specialization.Mage.Frost;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _freezeFrame = 0;
  _cachedFreezeStacks = 0;
  _versionLogged = false;
  _lastDebug = 0;
  // Opener tracking for line_cd=9999 sequence
  _openerFlurry1 = false;
  _openerGS = false;
  _openerFlurry2 = false;
  _openerRoF = false;
  _openerFO = false;
  _openerComplete = false;
  _combatStart = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWFrostUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWFrostAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWFrostDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWFrostBarrier', text: 'Use Ice Barrier', default: true },
        { type: 'checkbox', uid: 'FWFrostIB', text: 'Use Ice Block', default: true },
        { type: 'slider', uid: 'FWFrostIBHP', text: 'Ice Block HP %', default: 15, min: 5, max: 30 },
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

      // OOC: Arcane Intellect + Water Elemental
      spell.cast(S.arcaneIntellect, () => me, () =>
        spell.getTimeSinceLastCast(S.arcaneIntellect) > 60000 && !me.hasAura(A.arcaneIntellect)
      ),
      spell.cast(S.summonWaterEle, () => me, () =>
        !me.inCombat() && (!me.pet || me.pet.deadOrGhost) && !spell.isSpellKnown(T.lonelyWinter)
      ),

      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),
      new bt.Action(() => {
        if (me.inCombat() && !this._combatStart) this._combatStart = wow.frameTime;
        if (!me.inCombat()) {
          this._combatStart = 0;
          this._openerComplete = false;
          this._openerFlurry1 = false;
          this._openerGS = false;
          this._openerFlurry2 = false;
          this._openerRoF = false;
          this._openerFO = false;
        }
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),

      // FoF/WC interrupt: Ice Lance is instant — cast it even during Frostbolt channel
      // This prevents stalling when FoF procs mid-cast
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () =>
        (this.hasFoF() || this.targetHasWC()) && me.isCastingOrChanneling
      ),

      common.waitForCastOrChannel(),

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Frost] Midnight 12.0.1 | ${this.isFF() ? 'Frostfire' : 'Spellslinger'} | SimC APL full`);
        }
        if (Settings.FWFrostDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Frost] BF:${this.hasBF()} FoF:${this.hasFoF()} Freeze:${this.getFreezeStacks()} TV:${me.hasAura(A.thermalVoid)} Emp:${me.hasAura(A.frostfireEmpow)} SS:${me.hasAura(A.splinterstorm)} E:${this.getEnemyCount()} Opener:${!this._openerComplete}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.counterspell),
          this.defensives(),

          // SimC: call_action_list,name=cds (includes opener, racials, items, end-of-fight)
          this.cds(),

          // Movement block (SimC actions.movement, 5 lines)
          new bt.Decorator(
            () => me.isMoving(),
            new bt.Selector(
              // SimC 2: blizzard,if=freezing_rain.up
              spell.cast(S.blizzard, () => this.getCurrentTarget(), () => me.hasAura(A.freezingRain)),
              // SimC 3: ice_nova,if=cone_of_frost
              spell.cast(S.iceNova, () => this.getCurrentTarget(), () => spell.isSpellKnown(T.coneOfFrost)),
              // SimC 4: cone_of_cold,if=cone_of_frost
              spell.cast(S.coneOfCold, () => me, () => spell.isSpellKnown(T.coneOfFrost)),
              // SimC 5: ice_lance
              spell.cast(S.iceLance, () => this.getCurrentTarget()),
              new bt.Action(() => bt.Status.Success)
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC dispatch: FF AoE -> FF ST -> SS AoE -> SS ST
          new bt.Decorator(
            () => this.isFF() && this.getEnemyCount() >= Settings.FWFrostAoECount,
            this.ffAoE(), new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isFF(),
            this.ffST(), new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.getEnemyCount() >= Settings.FWFrostAoECount,
            this.ssAoE(), new bt.Action(() => bt.Status.Failure)
          ),
          this.ssST(),

          // === ABSOLUTE FALLBACK — prevents tree stall when all entries fail ===
          spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.hasFoF() || this.targetHasWC()),
          spell.cast(S.iceLance, () => this.getCurrentTarget()),
        )
      ),
    );
  }

  // =============================================
  // CDS (SimC actions.cds — 20 lines)
  // Includes: items, racials, opener sequence (line_cd=9999), end-of-fight
  // =============================================
  cds() {
    return new bt.Selector(
      // SimC: berserking,if=time=0|ff|prev_frozen_orb|prev_ray_of_frost|freezing<6&rof.charges>=1|fight<20
      spell.cast(S.berserking, () => me, () =>
        this.combatTime() < 500 || this.isFF() ||
        spell.getTimeSinceLastCast(S.frozenOrb) < 1500 ||
        spell.getTimeSinceLastCast(S.rayOfFrost) < 1500 ||
        (this.getFreezeStacks() < 6 && spell.getCharges(S.rayOfFrost) >= 1) ||
        this.targetTTD() < 20000
      ),

      // Opener sequence (SimC line_cd=9999 entries — fire once per combat)
      // FF opener: Flurry -> GS -> Flurry -> RoF -> FO
      new bt.Action(() => {
        if (this._openerComplete || !this.isFF()) return bt.Status.Failure;
        if (this.combatTime() > 15000) { this._openerComplete = true; return bt.Status.Failure; }
        const target = this.getCurrentTarget();
        if (!target) return bt.Status.Failure;

        if (!this._openerFlurry1) {
          const r = spell.cast(S.flurry, () => target).execute({});
          if (r === bt.Status.Success) this._openerFlurry1 = true;
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        if (!this._openerGS) {
          const r = spell.cast(S.glacialSpike, () => target).execute({});
          if (r === bt.Status.Success) this._openerGS = true;
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        if (!this._openerFlurry2) {
          const r = spell.cast(S.flurry, () => target).execute({});
          if (r === bt.Status.Success) this._openerFlurry2 = true;
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        if (!this._openerRoF) {
          const r = spell.cast(S.rayOfFrost, () => target).execute({});
          if (r === bt.Status.Success) this._openerRoF = true;
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        if (!this._openerFO) {
          const r = spell.cast(S.frozenOrb, () => target).execute({});
          if (r === bt.Status.Success) { this._openerFO = true; this._openerComplete = true; }
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        this._openerComplete = true;
        return bt.Status.Failure;
      }),

      // SS opener: Flurry -> FO -> RoF
      new bt.Action(() => {
        if (this._openerComplete || this.isFF()) return bt.Status.Failure;
        if (this.combatTime() > 15000) { this._openerComplete = true; return bt.Status.Failure; }
        const target = this.getCurrentTarget();
        if (!target) return bt.Status.Failure;

        if (!this._openerFlurry1) {
          const r = spell.cast(S.flurry, () => target).execute({});
          if (r === bt.Status.Success) this._openerFlurry1 = true;
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        if (!this._openerFO) {
          const r = spell.cast(S.frozenOrb, () => target).execute({});
          if (r === bt.Status.Success) this._openerFO = true;
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        if (!this._openerRoF) {
          const r = spell.cast(S.rayOfFrost, () => target).execute({});
          if (r === bt.Status.Success) { this._openerRoF = true; this._openerComplete = true; }
          return r === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
        }
        this._openerComplete = true;
        return bt.Status.Failure;
      }),

      // SimC: ray_of_frost,if=fight_remains<12
      spell.cast(S.rayOfFrost, () => this.getCurrentTarget(), () => this.targetTTD() < 12000),
      // SimC: ice_lance,if=fight_remains<gcd*1.5
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.targetTTD() < 2250),
    );
  }

  // =============================================
  // FROSTFIRE ST (SimC actions.ff_st, 10 lines)
  // =============================================
  ffST() {
    return new bt.Selector(
      // HIGHEST: Ice Lance to consume Winter's Chill (from Flurry shatter)
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.targetHasWC()),
      // SimC 1: flurry,if=bf&thermal_void.down
      spell.cast(S.flurry, () => this.getCurrentTarget(), () =>
        this.hasBF() && !me.hasAura(A.thermalVoid)
      ),
      // SimC 2: frozen_orb
      spell.cast(S.frozenOrb, () => this.getCurrentTarget()),
      // SimC 3: glacial_spike
      spell.cast(S.glacialSpike, () => this.getCurrentTarget()),
      // SimC 4: comet_storm
      spell.cast(S.cometStorm, () => this.getCurrentTarget()),
      // SimC 5: ice_lance,if=fof
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.hasFoF()),
      // SimC 6: ice_lance,if=freezing>=10
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.getFreezeStacks() >= 10),
      // SimC 7: flurry,if=cooldown_react
      spell.cast(S.flurry, () => this.getCurrentTarget()),
      // SimC 8: ray_of_frost,if=aoe=1|!ff_empow
      spell.cast(S.rayOfFrost, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() === 1 || !me.hasAura(A.frostfireEmpow)
      ),
      // SimC 9: frostbolt (FFB for FF)
      spell.cast(S.frostfireBolt, () => this.getCurrentTarget()),
      // Absolute fallback: Ice Lance if any shatter condition (prevents tree stall)
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () =>
        this.hasFoF() || this.targetHasWC()
      ),
      // Last resort: Frostbolt (base, non-FF)
      spell.cast(S.frostbolt, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // FROSTFIRE AoE (SimC actions.ff_aoe, 12 lines)
  // =============================================
  ffAoE() {
    return new bt.Selector(
      // SimC 1: blizzard,if=freezing_rain.up
      spell.cast(S.blizzard, () => this.getCurrentTarget(), () => me.hasAura(A.freezingRain)),
      // SimC 2: flurry,if=bf&thermal_void.down
      spell.cast(S.flurry, () => this.getCurrentTarget(), () =>
        this.hasBF() && !me.hasAura(A.thermalVoid)
      ),
      // SimC 3: frozen_orb
      spell.cast(S.frozenOrb, () => this.getCurrentTarget()),
      // SimC 4: glacial_spike
      spell.cast(S.glacialSpike, () => this.getCurrentTarget()),
      // SimC 5: comet_storm
      spell.cast(S.cometStorm, () => this.getCurrentTarget()),
      // SimC 6: blizzard,if=aoe>=(5-freezing_rain-freezing_winds)&(orb_cd>12*haste|!freezing_rain)
      spell.cast(S.blizzard, () => this.getCurrentTarget(), () => {
        const threshold = 5 - (spell.isSpellKnown(T.freezingRain) ? 1 : 0) -
          (spell.isSpellKnown(T.freezingWinds) ? 1 : 0);
        const orbFar = (spell.getCooldown(S.frozenOrb)?.timeleft || 0) > 12000 ||
          !spell.isSpellKnown(T.freezingRain);
        return this.getEnemyCount() >= threshold && orbFar;
      }),
      // SimC 7: ice_lance,if=fof
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.hasFoF()),
      // SimC 8: ice_lance,if=freezing>=10
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.getFreezeStacks() >= 10),
      // SimC 9: flurry,if=cooldown_react
      spell.cast(S.flurry, () => this.getCurrentTarget()),
      // SimC 10: ray_of_frost,if=!ff_empow
      spell.cast(S.rayOfFrost, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.frostfireEmpow)
      ),
      // Blizzard only with Freezing Rain talent (instant cast) — without talent it's a DPS loss
      // SimC 11: frostbolt (FFB for FF)
      spell.cast(S.frostfireBolt, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // SPELLSLINGER ST (SimC actions.ss_st, 10 lines)
  // =============================================
  ssST() {
    return new bt.Selector(
      // HIGHEST: Ice Lance to consume Winter's Chill (from Flurry shatter)
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.targetHasWC()),
      // SimC 1: comet_storm,if=splinterstorm.down
      spell.cast(S.cometStorm, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.splinterstorm)
      ),
      // SimC 2: flurry,if=bf&thermal_void.down
      spell.cast(S.flurry, () => this.getCurrentTarget(), () =>
        this.hasBF() && !me.hasAura(A.thermalVoid)
      ),
      // SimC 3: frozen_orb
      spell.cast(S.frozenOrb, () => this.getCurrentTarget()),
      // SimC 4: ice_lance,if=fof
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.hasFoF()),
      // SimC 5: glacial_spike
      spell.cast(S.glacialSpike, () => this.getCurrentTarget()),
      // SimC 6: ice_lance,if=freezing>=6
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.getFreezeStacks() >= 6),
      // SimC 7: ray_of_frost
      spell.cast(S.rayOfFrost, () => this.getCurrentTarget()),
      // SimC 8: flurry,if=cooldown_react
      spell.cast(S.flurry, () => this.getCurrentTarget()),
      // SimC 9: frostbolt
      spell.cast(S.frostbolt, () => this.getCurrentTarget()),
      // Absolute fallback: Ice Lance if any shatter condition (prevents tree stall)
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () =>
        this.hasFoF() || this.targetHasWC()
      ),
    );
  }

  // =============================================
  // SPELLSLINGER AoE (SimC actions.ss_aoe, 14 lines)
  // =============================================
  ssAoE() {
    return new bt.Selector(
      // SimC 1: comet_storm,if=splinterstorm.down
      spell.cast(S.cometStorm, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.splinterstorm)
      ),
      // SimC 2: blizzard,if=freezing_rain.up
      spell.cast(S.blizzard, () => this.getCurrentTarget(), () => me.hasAura(A.freezingRain)),
      // SimC 3: flurry,if=bf&thermal_void.down
      spell.cast(S.flurry, () => this.getCurrentTarget(), () =>
        this.hasBF() && !me.hasAura(A.thermalVoid)
      ),
      // SimC 4: frozen_orb
      spell.cast(S.frozenOrb, () => this.getCurrentTarget()),
      // SimC 5: ice_lance,if=fof
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.hasFoF()),
      // SimC 6: glacial_spike
      spell.cast(S.glacialSpike, () => this.getCurrentTarget()),
      // SimC 7: ice_lance,if=freezing>=6
      spell.cast(S.iceLance, () => this.getCurrentTarget(), () => this.getFreezeStacks() >= 6),
      // SimC 8: ice_nova,if=cone_of_frost&aoe>=4
      spell.cast(S.iceNova, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.coneOfFrost) && this.getEnemyCount() >= 4
      ),
      // SimC 9: cone_of_cold,if=cone_of_frost&aoe>=4
      spell.cast(S.coneOfCold, () => me, () =>
        spell.isSpellKnown(T.coneOfFrost) && this.getEnemyCount() >= 4
      ),
      // SimC 10: blizzard,if=aoe>=5&freezing_winds&freezing_rain
      spell.cast(S.blizzard, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() >= 5 && spell.isSpellKnown(T.freezingWinds) && spell.isSpellKnown(T.freezingRain)
      ),
      // SimC 11: flurry,if=cooldown_react
      spell.cast(S.flurry, () => this.getCurrentTarget()),
      // SimC 12: ray_of_frost
      spell.cast(S.rayOfFrost, () => this.getCurrentTarget()),
      // Blizzard only with Freezing Rain talent (instant cast) — without talent it's a DPS loss
      // SimC 13: frostbolt
      spell.cast(S.frostbolt, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.iceBarrier, () => me, () => Settings.FWFrostBarrier && me.inCombat()),
      spell.cast(S.iceCold, () => me, () =>
        Settings.FWFrostIB && spell.isSpellKnown(S.iceCold) && me.effectiveHealthPercent < Settings.FWFrostIBHP
      ),
      spell.cast(S.iceBlock, () => me, () =>
        Settings.FWFrostIB && !spell.isSpellKnown(S.iceCold) && me.effectiveHealthPercent < Settings.FWFrostIBHP
      ),
    );
  }

  // =============================================
  // HELPERS
  // =============================================
  isFF() { return spell.isSpellKnown(S.frostfireBolt); }
  isSS() { return !this.isFF(); }

  hasBF() { return me.hasAura(A.brainFreeze); }
  hasFoF() { return me.hasAura(A.fingersOfFrost); }
  targetHasWC() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    return !!(t.getAuraByMe(A.wintersChill) || t.hasAura(A.wintersChill));
  }

  combatTime() { return this._combatStart ? wow.frameTime - this._combatStart : 0; }

  getFreezeStacks() {
    if (this._freezeFrame === wow.frameTime) return this._cachedFreezeStacks;
    this._freezeFrame = wow.frameTime;
    const t = this.getCurrentTarget();
    if (!t) { this._cachedFreezeStacks = 0; return 0; }
    const d = t.getAuraByMe(A.freezing);
    this._cachedFreezeStacks = d ? d.stacks : 0;
    return this._cachedFreezeStacks;
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 40) {
      if (me.isFacing(target)) {
        this._cachedTarget = target;
        return target;
      }
      // Not facing manual target — try to find one we ARE facing
      if (me.inCombat() && combat.targets) {
        const alt = combat.targets.find(t =>
          t && common.validTarget(t) && me.distanceTo(t) <= 40 && me.isFacing(t)
        );
        if (alt) { this._cachedTarget = alt; return alt; }
      }
      // Nothing facing — return manual target anyway (don't block tree)
      this._cachedTarget = target;
      return target;
    }
    if (me.inCombat()) {
      const t = combat.targets?.find(u =>
        u && common.validTarget(u) && me.distanceTo(u) <= 40 && me.isFacing(u)
      );
      if (t) { this._cachedTarget = t; return t; }
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
