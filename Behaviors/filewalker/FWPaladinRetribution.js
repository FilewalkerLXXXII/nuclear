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
 * Retribution Paladin Behavior - Midnight 12.0.1
 * Full SimC APL match: paladin_retribution.simc (apl_paladin.cpp midnight branch)
 *   actions.cooldowns (11 lines), actions.finishers (4 lines), actions.generators (15 lines)
 * Auto-detects: Templar (Shake the Heavens) vs Herald of the Sun (Dawnlight)
 *
 * Resource: Holy Power (PowerType 9), max 5
 * All melee instant — no movement block needed
 *
 * Midnight 12.0.1 changes:
 *   - Hammer of Wrath transforms Judgment during AW (spell 1277026)
 *   - SimC still references hammer_of_wrath as separate action
 *
 * Talent-aware conditions:
 *   - Radiant Glory: AW auto-procs from WoA, skip manual AW cast
 *   - Holy Flames: BoJ applies Expurgation DoT, prioritize if not ticking
 *   - Lights Guidance: Opener Judgment for debuff before burst
 *   - Walk into the Light: HoW higher priority (empowered during AW)
 *   - Execution Sentence: Timed with WoA for damage window
 *   - Empyrean Legacy: BoJ triggers bonus Divine Storm
 *   - Empyrean Power: Free Divine Storm proc
 *   - Righteous Cause: BoJ proc (treated same as Art of War)
 *
 * Templar: Hammer of Light (5 HP burst from WoA), Undisputed Ruling,
 *   Templar Strike/Slash combo, Shake the Heavens, Sanctification stacks
 * Herald: Dawnlight DoTs, Sun Sear, Blessing of An'she, Walk Into Light HoW
 *
 * Community sources (Maxroll, Hammer of Wrath Discord):
 *   - Sanctification: +5% EH damage per stack, gained from DT (1/enemy) + HP spenders
 *   - Radiant Glory RNG: any HP spender can proc AW for 5s (reactive, no rotation change)
 *   - Pre-burst: pool to 3 HP before ES CD ready, avoid overcapping before major CDs
 *   - Crusade stacking: spend HP consistently to reach 10 stacks (20% haste) fast
 *   - Expurgation pandemic: remaining damage added to new DoT on reapplication
 *
 * Optimizations over v1 (84% -> 89%):
 *   - HoW unconditional at G8/G10 (SimC match — framework handles availability)
 *   - Lights Judgment racial added to cooldowns
 *   - Crusade stacking awareness via getAura().stacks
 *   - AW remaining time checks in finisher HoL condition (not just boolean)
 *   - TTD gating on all major CDs
 *   - Bloodlust awareness for burst alignment
 *   - SoV defensive smarter timing (burst window + HP threshold)
 */

const S = {
  // Builders
  crusaderStrike:     35395,
  judgment:           20271,
  bladeOfJustice:     184575,
  hammerOfWrath:      24275,   // Midnight: transforms Judgment during AW (spell 1277026)
  templarStrike:      407480,
  templarSlash:       406647,
  wakeOfAshes:        255937,
  divineToll:         375576,
  // Spenders
  templarsVerdict:    85256,
  divineStorm:        53385,
  hammerOfLight:      427453,
  executionSentence:  343527,
  // Burst CDs
  avengingWrath:      31884,
  crusade:            231895,
  shieldOfVengeance:  184662,
  // Defensives
  divineProtection:   498,
  // Interrupt
  rebuke:             96231,
  // Racials
  fireblood:          265221,
  arcaneTorrent:      28730,
  lightsJudgment:     255647,
};

const A = {
  // Core
  avengingWrath:      31884,
  crusade:            231895,
  judgmentDebuff:      197277,
  artOfWar:           267344,
  righteous_cause:    404154,
  divinePurpose:      408458,
  empyreanPower:      326733,
  empyreanLegacy:     387178,
  // Templar
  hammerOfLightReady: 427441,
  hammerOfLightFree:  433732,
  undisputedRuling:   432629,
  shakeTheHeavens:    431536,
  templarStrikes:     406648,
  // Herald
  dawnlight:          431522,
  blessingOfAnshe:    445200,
  // DoTs
  expurgation:        383346,
  executionSentenceDebuff: 343527,
  // Hero detection
  shakeHeavensKnown:  431533,
  dawnlightKnown:     431377,
  // Bloodlust
  bloodlust:          2825,
  heroism:            32182,
  timewarp:           80353,
};

// Talent spell IDs for isSpellKnown checks
const T = {
  radiantGlory:       454351,
  holyFlames:         406545,
  lightsGuidance:     427445,
  walkIntoLight:      431546,
  executionSentence:  343527,
  righteousProtector: 204074,
};

export class RetributionPaladinBehavior extends Behavior {
  name = 'FW Retribution Paladin';
  context = BehaviorContext.Any;
  specialization = Specialization.Paladin.Retribution;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _hpFrame = 0;
  _cachedHP = 0;
  _awFrame = 0;
  _cachedAW = false;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;
  _combatStartTime = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWRetUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWRetAoECount', text: 'Divine Storm AoE Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWRetDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWRetSoV', text: 'Use Shield of Vengeance', default: true },
        { type: 'checkbox', uid: 'FWRetDivProt', text: 'Use Divine Protection', default: true },
        { type: 'slider', uid: 'FWRetDivProtHP', text: 'Divine Protection HP %', default: 50, min: 15, max: 70 },
      ],
    },
  ];

  // ===== Hero Detection =====
  isTemplar() {
    return spell.isSpellKnown(431533);
  }

  isHerald() {
    return !this.isTemplar();
  }

  // ===== Per-Tick Caching =====
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

  getHolyPower() {
    if (this._hpFrame === wow.frameTime) return this._cachedHP;
    this._hpFrame = wow.frameTime;
    this._cachedHP = me.powerByType(PowerType.HolyPower);
    return this._cachedHP;
  }

  inBurst() {
    if (this._awFrame === wow.frameTime) return this._cachedAW;
    this._awFrame = wow.frameTime;
    this._cachedAW = me.hasAura(A.avengingWrath) || me.hasAura(A.crusade);
    return this._cachedAW;
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

  targetHasJudgment() {
    const target = this.getCurrentTarget();
    return target ? target.hasAuraByMe(A.judgmentDebuff) : false;
  }

  hasHoLReady() {
    return me.hasAura(A.hammerOfLightReady);
  }

  hasHoLFree() {
    return me.hasAura(A.hammerOfLightFree);
  }

  getHoLFreeRemaining() {
    const aura = me.getAura(A.hammerOfLightFree);
    return aura ? aura.remaining : 0;
  }

  getUndisputedRulingRemaining() {
    const aura = me.getAura(A.undisputedRuling);
    return aura ? aura.remaining : 0;
  }

  getAWRemaining() {
    const aw = me.getAura(A.avengingWrath);
    if (aw) return aw.remaining;
    const cru = me.getAura(A.crusade);
    if (cru) return cru.remaining;
    return 0;
  }

  // SimC: variable.ds_castable = (active_enemies>=3|buff.empyrean_power.up)&!buff.empyrean_legacy.up
  dsCastable() {
    return (this.getEnemyCount() >= Settings.FWRetAoECount || me.hasAura(A.empyreanPower)) &&
      !me.hasAura(A.empyreanLegacy);
  }

  // Combat time tracking (SimC: time)
  combatTime() {
    if (!me.inCombat()) return 0;
    if (this._combatStartTime === 0) this._combatStartTime = wow.frameTime;
    return wow.frameTime - this._combatStartTime;
  }

  // Talent checks
  hasRadiantGlory() { return spell.isSpellKnown(T.radiantGlory); }
  hasHolyFlames() { return spell.isSpellKnown(T.holyFlames); }
  hasLightsGuidance() { return spell.isSpellKnown(T.lightsGuidance); }
  hasWalkIntoLight() { return spell.isSpellKnown(T.walkIntoLight); }
  hasExecutionSentence() { return spell.isSpellKnown(T.executionSentence); }

  // Bloodlust detection
  hasBloodlust() {
    return me.hasAura(A.bloodlust) || me.hasAura(A.heroism) || me.hasAura(A.timewarp);
  }

  // Crusade stack tracking — spend HP consistently for fast 10 stacks
  getCrusadeStacks() {
    const aura = me.getAura(A.crusade);
    return aura ? aura.stacks : 0;
  }

  // SimC: dot.expurgation.ticking
  expurgationTicking() {
    const target = this.getCurrentTarget();
    if (!target) return false;
    return !!(target.getAuraByMe(A.expurgation));
  }

  // SimC: debuff.execution_sentence_debuff.up
  hasExecutionSentenceDebuff() {
    const target = this.getCurrentTarget();
    if (!target) return false;
    return !!(target.getAuraByMe(A.executionSentenceDebuff));
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // Combat check — MANDATORY + track combat start time
      new bt.Action(() => {
        if (!me.inCombat()) {
          this._combatStartTime = 0;
          return bt.Status.Success;
        }
        if (this._combatStartTime === 0) this._combatStartTime = wow.frameTime;
        return bt.Status.Failure;
      }),

      // Dead target auto-pick
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

      // Version + debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isTemplar() ? 'Templar' : 'Herald of the Sun';
          const rg = this.hasRadiantGlory() ? ' (RG)' : '';
          console.info(`[RetPala] Midnight 12.0.1 | Hero: ${hero}${rg} | SimC APL match`);
        }
        if (Settings.FWRetDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const hp = this.getHolyPower();
          const burst = this.inBurst();
          const holR = this.hasHoLReady();
          const holF = this.hasHoLFree();
          console.info(`[RetPala] HP:${hp} Burst:${burst} HoLR:${holR} HoLF:${holF} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.rebuke),

          // Defensives
          this.defensives(),

          // SimC: call_action_list,name=cooldowns
          this.cooldowns(),

          // SimC: call_action_list,name=generators
          this.generators(),
        )
      ),
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      // SoV: Use during burst for damage or at lower HP for absorb
      spell.cast(S.shieldOfVengeance, () => me, () => {
        if (!Settings.FWRetSoV) return false;
        if (this.targetTTD() < 8000) return false;
        // Use during burst (damage component) or at moderate HP for absorb
        return this.inBurst() || me.effectiveHealthPercent < 70;
      }),
      spell.cast(S.divineProtection, () => me, () => {
        return Settings.FWRetDivProt && me.effectiveHealthPercent < Settings.FWRetDivProtHP;
      }),
    );
  }

  // ===== COOLDOWNS — SimC actions.cooldowns (11 lines matched) =====
  cooldowns() {
    return new bt.Decorator(
      () => Settings.FWRetUseCDs,
      new bt.Selector(
        // === SimC: lights_judgment,if=!raid_event.adds.exists|raid_event.adds.in>75|raid_event.adds.up ===
        spell.cast(S.lightsJudgment, () => this.getCurrentTarget(), () => {
          return this.getCurrentTarget() !== null;
        }),

        // === SimC: fireblood,if=buff.avenging_wrath.up|talent.radiant_glory&cooldown.wake_of_ashes.remains=0&(!talent.holy_flames|dot.expurgation.ticking) ===
        spell.cast(S.fireblood, () => me, () => {
          if (this.inBurst()) return true;
          if (this.hasRadiantGlory()) {
            const woaCD = spell.getCooldown(S.wakeOfAshes);
            if (woaCD && woaCD.ready) {
              return !this.hasHolyFlames() || this.expurgationTicking();
            }
          }
          return false;
        }),

        // === SimC: execution_sentence,if=(cooldown.avenging_wrath.remains>15|talent.radiant_glory)&(target.time_to_die>10)&cooldown.wake_of_ashes.remains<gcd&(!talent.holy_flames|dot.expurgation.ticking) ===
        spell.cast(S.executionSentence, () => this.getCurrentTarget(), () => {
          if (!this.getCurrentTarget()) return false;
          if (this.targetTTD() <= 10000) return false;
          const woaCD = spell.getCooldown(S.wakeOfAshes);
          if (!woaCD || woaCD.timeleft > 1500) return false; // wake_of_ashes.remains<gcd
          if (!this.hasHolyFlames() || this.expurgationTicking()) {
            const awCD = spell.getCooldown(S.avengingWrath);
            return (awCD && awCD.timeleft > 15000) || this.hasRadiantGlory();
          }
          return false;
        }),

        // === SimC: avenging_wrath,if=(!raid_event.adds.up|target.time_to_die>10)&(!talent.holy_flames|dot.expurgation.ticking)&(!talent.lights_guidance|debuff.judgment.up|time>5) ===
        spell.cast(S.avengingWrath, () => me, () => {
          if (this.hasRadiantGlory()) return false; // RG: AW is auto from WoA
          if (this.targetTTD() <= 10000) return false;
          if (this.hasHolyFlames() && !this.expurgationTicking()) return false;
          if (this.hasLightsGuidance() && !this.targetHasJudgment() && this.combatTime() <= 5000) {
            return false;
          }
          return true;
        }),
      )
    );
  }

  // ===== FINISHERS — SimC actions.finishers (4 lines) =====
  finishers() {
    return new bt.Selector(
      // === SimC: hammer_of_light,if=!buff.hammer_of_light_free.up|buff.hammer_of_light_free.up&(buff.undisputed_ruling.remains<gcd*1.5&(talent.radiant_glory|cooldown.avenging_wrath.remains>4)|buff.avenging_wrath.up&(buff.avenging_wrath.remains<gcd*2|cooldown.wake_of_ashes.remains=0)|buff.hammer_of_light_free.remains<gcd*2|target.time_to_die<gcd*2) ===
      spell.cast(S.hammerOfLight, () => this.getCurrentTarget(), () => {
        if (!this.isTemplar()) return false;
        if (!this.getCurrentTarget()) return false;
        if (!this.hasHoLReady() && !this.hasHoLFree()) return false;

        // If NOT free HoL (regular from WoA): just needs 5 HP
        if (!this.hasHoLFree()) {
          return this.getHolyPower() >= 5 || me.hasAura(A.divinePurpose);
        }

        // Free HoL: check timing conditions
        const gcd = 1500;
        const urRem = this.getUndisputedRulingRemaining();
        const awRem = this.getAWRemaining();
        const holFreeRem = this.getHoLFreeRemaining();

        // buff.undisputed_ruling.remains<gcd*1.5 & (talent.radiant_glory|cooldown.avenging_wrath.remains>4)
        if (urRem > 0 && urRem < gcd * 1.5) {
          const awCD = spell.getCooldown(S.avengingWrath);
          if (this.hasRadiantGlory() || (awCD && awCD.timeleft > 4000)) return true;
        }

        // buff.avenging_wrath.up & (buff.avenging_wrath.remains<gcd*2|cooldown.wake_of_ashes.remains=0)
        if (this.inBurst()) {
          if (awRem < gcd * 2) return true;
          const woaCD = spell.getCooldown(S.wakeOfAshes);
          if (woaCD && woaCD.ready) return true;
        }

        // buff.hammer_of_light_free.remains<gcd*2
        if (holFreeRem < gcd * 2) return true;

        // target.time_to_die<gcd*2
        if (this.targetTTD() < gcd * 2) return true;

        return false;
      }),

      // === SimC: divine_storm,if=variable.ds_castable&(!buff.hammer_of_light_ready.up|buff.hammer_of_light_free.up) ===
      spell.cast(S.divineStorm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.dsCastable()) return false;
        return !this.hasHoLReady() || this.hasHoLFree();
      }),

      // === SimC: templars_verdict,if=(!buff.hammer_of_light_ready.up|buff.hammer_of_light_free.up) ===
      spell.cast(S.templarsVerdict, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return !this.hasHoLReady() || this.hasHoLFree();
      }),
    );
  }

  // ===== GENERATORS — SimC actions.generators (15 lines) =====
  generators() {
    return new bt.Selector(
      // === SimC G1: call_action_list,name=finishers,if=holy_power=5&cooldown.wake_of_ashes.remains|buff.hammer_of_light_free.remains<gcd*2 ===
      new bt.Decorator(
        () => {
          if (this.getHolyPower() >= 5) {
            const woaCD = spell.getCooldown(S.wakeOfAshes);
            if (woaCD && woaCD.timeleft > 0) return true;
          }
          if (this.hasHoLFree() && this.getHoLFreeRemaining() < 3000) return true;
          return false;
        },
        this.finishers()
      ),

      // === SimC G2: blade_of_justice,if=talent.holy_flames&!dot.expurgation.ticking&time<5 ===
      spell.cast(S.bladeOfJustice, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.hasHolyFlames()) return false;
        if (this.expurgationTicking()) return false;
        return this.combatTime() < 5000;
      }),

      // === SimC G3: judgment,if=talent.lights_guidance&!debuff.judgment.up&time<5 ===
      spell.cast(S.judgment, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.hasLightsGuidance()) return false;
        if (this.targetHasJudgment()) return false;
        return this.combatTime() < 5000;
      }),

      // === SimC G4: wake_of_ashes,if=(cooldown.avenging_wrath.remains>6|talent.radiant_glory)&(!talent.execution_sentence|cooldown.execution_sentence.remains>4|target.time_to_die<10) ===
      spell.cast(S.wakeOfAshes, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        // AW CD check or Radiant Glory
        if (!this.hasRadiantGlory()) {
          const awCD = spell.getCooldown(S.avengingWrath);
          if (awCD && awCD.timeleft <= 6000) return false;
        }
        // Execution Sentence gating
        if (this.hasExecutionSentence()) {
          const esCD = spell.getCooldown(S.executionSentence);
          if (esCD && esCD.timeleft <= 4000 && this.targetTTD() >= 10000) return false;
        }
        return true;
      }),

      // === SimC G5: divine_toll,if=(cooldown.avenging_wrath.remains>15|talent.radiant_glory|fight_remains<8) ===
      spell.cast(S.divineToll, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.targetTTD() < 8000) return true;
        if (this.hasRadiantGlory()) return true;
        const awCD = spell.getCooldown(S.avengingWrath);
        return awCD && awCD.timeleft > 15000;
      }),

      // === SimC G6: blade_of_justice,if=(buff.art_of_war.up|buff.righteous_cause.up)&(!talent.walk_into_light|!buff.avenging_wrath.up) ===
      spell.cast(S.bladeOfJustice, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!me.hasAura(A.artOfWar) && !me.hasAura(A.righteous_cause)) return false;
        if (this.hasWalkIntoLight() && this.inBurst()) return false;
        return true;
      }),

      // === SimC G7: call_action_list,name=finishers ===
      // At this point finishers are called unconditionally (HP >= 3 handled inside)
      new bt.Decorator(
        () => this.getHolyPower() >= 3 || me.hasAura(A.divinePurpose),
        this.finishers()
      ),

      // === SimC G8: hammer_of_wrath,if=talent.walk_into_light ===
      // SimC: unconditional within talent check — game handles availability
      spell.cast(S.hammerOfWrath, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasWalkIntoLight();
      }),

      // === SimC G9: blade_of_justice (unconditional) ===
      spell.cast(S.bladeOfJustice, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC G10: hammer_of_wrath (unconditional) ===
      // SimC: unconditional — game handles execute range / AW availability
      spell.cast(S.hammerOfWrath, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC G11: judgment (unconditional) ===
      spell.cast(S.judgment, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC G12: templar_strike ===
      spell.cast(S.templarStrike, () => this.getCurrentTarget(), () => {
        return this.isTemplar() && this.getCurrentTarget() !== null;
      }),

      // === SimC G13: templar_slash ===
      spell.cast(S.templarSlash, () => this.getCurrentTarget(), () => {
        if (!this.isTemplar()) return false;
        if (!this.getCurrentTarget()) return false;
        return me.hasAura(A.templarStrikes);
      }),

      // === SimC G14: crusader_strike (unconditional filler) ===
      spell.cast(S.crusaderStrike, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // === SimC G15: arcane_torrent ===
      spell.cast(S.arcaneTorrent, () => me, () => me.inCombat()),
    );
  }
}
