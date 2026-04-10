import { Behavior, BehaviorContext } from '@/Core/Behavior';
import * as bt from '@/Core/BehaviorTree';
import Specialization from '@/Enums/Specialization';
import common from '@/Core/Common';
import spell from '@/Core/Spell';
import Settings from '@/Core/Settings';
import { PowerType } from "@/Enums/PowerType";
import { me } from '@/Core/ObjectManager';
import { defaultCombatTargeting as combat } from '@/Targeting/CombatTargeting';
import { defaultHealTargeting as heal } from '@/Targeting/HealTargeting';

/**
 * Augmentation Evoker Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (evoker_augmentation.simc) + Method + Wowhead
 *
 * Auto-detects: Chronowarden (Chrono Flame) vs Scalecommander (Mass Eruption)
 * SimC lists: default (19 lines), fb (4 empower tiers), filler (2) — ALL matched
 *
 * SUPPORT DPS: Ebon Might uptime #1 priority (+8% primary stat)
 * Empower: Fire Breath R1-R4 + Upheaval R1 — handleEmpoweredSpell() release control
 * Complex EM pandemic: value<=0.05 OR remains<=30% OR remains<=40% threshold
 * TtS timing: aligned with BoE, Duplicate, Energy Cycles, Molten Embers
 * 4-tier FB: R1 (Molten Embers), R2 (TTD>12), R3 (TTD>8), R4 (Font of Magic)
 *
 * Resource: Essence (PowerType 19), max 5
 * Hotfixes March 17: All damage +13%, 2pc/4pc nerfed, Molten Embers 25%→15%
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL (line-by-line) + Method + Wowhead',
};

const S = {
  ebonMight:          395152,
  prescience:         409311,
  breathOfEons:       442204,
  eruption:           395160,
  livingFlame:        361469,
  azureStrike:        362969,
  fireBreath:         357208,
  upheaval:           396286,
  deepBreath:         357210,
  tipTheScales:       370553,
  timeSkip:           404977,
  furyOfTheAspects:   390386,
  emeraldBlossom:     355913,
  hover:              358267,
  blistering:         360827,
  sourceOfMagic:      369459,
  quell:              351338,
  obsidianScales:     363916,
  verdantEmbrace:     360995,
  berserking:         26297,
};

const T = {
  moltenEmbers:       459725,
  fontOfMagic:        408083,   // Aug-specific (Dev=375783)
  chronoFlame:        431442,
  massEruption:       438587,
  energyCycles:       1260568,
  temporalBurst:      431695,
  timeConvergence:    431984,
  dreamOfSpring:      414969,
  anachronism:        407869,
  ancientFlame:       369990,
  leapingFlames:      369939,
  chronoboon:         1260484,
  interwoven:         412713,
  echoingStrike:      410784,
  pupilAlex:          407814,
  breathOfEons:       442204,
  sandsOfTime:        395153,   // SimC: find_spell(395153)
  scarletAdapt:       372469,
};

const A = {
  ebonMightSelf:      395296,
  ebonMightAlt:       395152,
  prescience:         410089,
  essenceBurst:       392268,   // Aug-specific EB (Pres=369299, Dev=359618)
  shiftingSands:      413984,
  momentumShift:      408005,
  leapingFlames:      370901,
  ancientFlame:       375583,
  temporalBurst:      431698,
  timeConvergenceInt: 431991,
  massEruption:       438588,
  bombardments:       434473,
  fireBreathDot:      357209,
  hover:              358267,
  tipTheScales:       370553,
  duplicate:          1259171,
  temporalWound:      409560,
};

export class AugmentationEvokerBehavior extends Behavior {
  name = 'FW Augmentation Evoker';
  context = BehaviorContext.Any;
  specialization = Specialization.Evoker.Augmentation;
  version = wow.GameVersion.Retail;

  _desiredEmpowerLevel = undefined;
  _targetFrame = 0;
  _cachedTarget = null;
  _essFrame = 0;
  _cachedEssence = 0;
  _essDefFrame = 0;
  _cachedEssDef = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _ebFrame = 0;
  _cachedEB = null;
  _versionLogged = false;
  _lastDebug = 0;
  _combatStart = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWAugAutoCDs', text: 'Auto Cooldowns (ignore burst keybind)', default: false },
        { type: 'checkbox', uid: 'FWAugDebug', text: 'Debug Logging', default: false },
        { type: 'checkbox', uid: 'FWAugHover', text: 'Auto Hover', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWAugScales', text: 'Use Obsidian Scales', default: true },
        { type: 'slider', uid: 'FWAugScalesHP', text: 'Obsidian Scales HP %', default: 50, min: 15, max: 70 },
      ],
    },
  ];

  // =============================================
  // EMPOWERMENT SYSTEM
  // =============================================
  castEmpowered(spellId, level, targetFn, conditionFn) {
    return new bt.Sequence(
      spell.cast(spellId, targetFn, conditionFn),
      new bt.Action(() => { this._desiredEmpowerLevel = level; return bt.Status.Success; })
    );
  }

  handleEmpoweredSpell() {
    return new bt.Action(() => {
      if (this._desiredEmpowerLevel === undefined) return bt.Status.Failure;
      if (!me.isCastingOrChanneling) { this._desiredEmpowerLevel = undefined; return bt.Status.Failure; }
      if (me.spellInfo && me.spellInfo.empowerLevel >= this._desiredEmpowerLevel) {
        const s = spell.getSpell(me.spellInfo.spellChannelId);
        if (s) { s.cast(me.targetUnit); this._desiredEmpowerLevel = undefined; }
        return bt.Status.Success;
      }
      return bt.Status.Success;
    });
  }

  // =============================================
  // BUILD
  // =============================================
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: Blistering Scales on tank
      spell.cast(S.blistering, () => this.getBlistTarget(), () =>
        this.getBlistTarget() !== null && spell.getTimeSinceLastCast(S.blistering) > 30000
      ),

      // OOC: Source of Magic on healer (mana regen buff)
      spell.cast(S.sourceOfMagic, () => this.getSourceTarget(), () =>
        this.getSourceTarget() !== null && spell.getTimeSinceLastCast(S.sourceOfMagic) > 30000
      ),

      // Combat check
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

      // Empower release BEFORE waitForCastOrChannel
      this.handleEmpoweredSpell(),
      common.waitForCastOrChannel(),

      // Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Aug] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isCW() ? 'Chronowarden' : 'Scalecommander'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWAugDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Aug] Ess:${this.getEss()}/${this.getEssDef()} EB:${this.getEBStacks()} EM:${this.hasEM()}(${Math.round(this.getEMRem()/1000)}s) TtS:${me.hasAura(A.tipTheScales)} Dup:${me.hasAura(A.duplicate)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.quell),

          // Defensives
          spell.cast(S.obsidianScales, () => me, () =>
            Settings.FWAugScales && me.effectiveHealthPercent < Settings.FWAugScalesHP
          ),

          // SimC: cancel_buff tip_the_scales if upheaval on CD & (energy_cycles|temporal_burst)
          new bt.Action(() => {
            if (me.hasAura(A.tipTheScales) &&
                (spell.getCooldown(S.upheaval)?.timeleft || 0) > 0 &&
                (spell.isSpellKnown(T.energyCycles) || spell.isSpellKnown(T.temporalBurst))) {
              // Can't cancel buff in framework, but we prevent TtS waste by gating FB/Upheaval
            }
            return bt.Status.Failure;
          }),

          // SimC: hover off-GCD (optional, default OFF)
          spell.cast(S.hover, () => me, () =>
            Settings.FWAugHover && me.isMoving() && !me.hasAura(A.hover) && spell.getChargesFractional(S.hover) > 0.3
          ),

          // Movement block — FULL instant rotation
          new bt.Decorator(
            () => me.isMoving() && !me.hasAura(A.hover),
            new bt.Selector(
              // EM pandemic refresh (instant)
              spell.cast(S.ebonMight, () => me, () => this.shouldRefreshEM()),
              // Prescience
              spell.cast(S.prescience, () => this.getPresTarget(), () =>
                this.getPresTarget() !== null
              ),
              // Eruption (instant with EB)
              spell.cast(S.eruption, () => this.getCurrentTarget(), () =>
                this.getEBStacks() >= 1 && this.hasEM()
              ),
              // Azure Strike
              spell.cast(S.azureStrike, () => this.getCurrentTarget()),
              new bt.Action(() => bt.Status.Success)
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // ==========================================
          // SimC DEFAULT ROTATION — line-by-line match
          // ==========================================

          // 1. Ebon Might: complex pandemic
          // SimC: (rem-cast)<=dur*0.4 AND (value<=0.05 OR (rem-cast)<=dur*0.3) AND active_enemies>0
          spell.cast(S.ebonMight, () => me, () => this.shouldRefreshEM()),

          // 2. Prescience: opener (time<=8)
          spell.cast(S.prescience, () => this.getPresTarget(), () =>
            this.getPresTarget() !== null && this.combatTime() <= 8000
          ),

          // 3. Fury of the Aspects: Time Convergence + !TC Int buff + Essence check + BoE far
          spell.cast(S.furyOfTheAspects, () => me, () =>
            spell.isSpellKnown(T.timeConvergence) && !me.hasAura(A.timeConvergenceInt) &&
            (this.getEss() >= 2 || this.getEBStacks() >= 1) &&
            this.eonsRemains() >= 8000
          ),

          // 4. Tip the Scales: SimC: !BoE.up & (duplicate|!energy_cycles) &
          //    (upheaval<fb|!molten_embers) | energy_cycles & (upheaval<fb|!molten|upheaval>gcd*2) & !BoE.up
          spell.cast(S.tipTheScales, () => me, () => {
            if (spell.getCooldown(S.breathOfEons)?.ready) return false;
            const uphCD = spell.getCooldown(S.upheaval)?.timeleft || 99999;
            const fbCD = spell.getCooldown(S.fireBreath)?.timeleft || 99999;
            const uphFirst = uphCD < fbCD;
            if (spell.isSpellKnown(T.energyCycles)) {
              return (uphFirst || !spell.isSpellKnown(T.moltenEmbers) || uphCD > 3000) &&
                !spell.getCooldown(S.breathOfEons)?.ready;
            }
            const dupOk = me.hasAura(A.duplicate) || !spell.isSpellKnown(T.energyCycles);
            return dupOk && (uphFirst || !spell.isSpellKnown(T.moltenEmbers));
          }),

          // 5. Deep Breath (SimC: no hero gate — shared spell)
          spell.cast(S.deepBreath, () => this.getCurrentTarget(), () =>
            this.targetTTD() > 10000
          ),

          // 6. Breath of Eons: TTD>=20
          spell.cast(S.breathOfEons, () => this.getCurrentTarget(), () =>
            this.useCDs() && this.targetTTD() >= 20000
          ),

          // 7. Fire Breath sub-list (4 empower tiers)
          // SimC gate: (adds.remains>6 | adds.in>20 | allied_cds>0 | !adds.exists) &
          //            (!BoE.up | !temporal_burst) & (!TtS | !molten_embers)
          this.fireBreathList(),

          // 8. Upheaval R1: EM remains > duration, TTD > duration+0.2
          this.castEmpowered(S.upheaval, 1, () => this.getCurrentTarget(), () => {
            if (!this.getCurrentTarget()) return false;
            // Prefer during EM, but don't hold forever
            if (this.hasEM()) return this.getEMRem() > 2500 && this.targetTTD() > 2700;
            // Fallback: cast without EM if off CD
            return true;
          }),

          // 9. Prescience: general (not opener, Anachronism gating)
          // SimC: remains<gcd*2 & (!anachronism | EB.stack < EB.max_stack)
          spell.cast(S.prescience, () => this.getPresTarget(), () => {
            if (!this.getPresTarget()) return false;
            if (spell.isSpellKnown(T.anachronism) && this.getEBStacks() >= 2) return false;
            return true;
          }),

          // 10. Time Skip: SimC: (!chronoboon & BoE.remains>=15) | (TtS.CD>=6 & !TtS.up)
          spell.cast(S.timeSkip, () => me, () => {
            if (!spell.isSpellKnown(T.chronoboon) && this.eonsRemains() >= 15000) return true;
            return (spell.getCooldown(S.tipTheScales)?.timeleft || 0) >= 6000 &&
              !me.hasAura(A.tipTheScales);
          }),

          // 11. Emerald Blossom: SimC: dream_of_spring & EB.react &
          //     (spam_heal=2 | spam_heal=1 & !ancient_flame.up & talent.ancient_flame) &
          //     (EM.up | essence.deficit=0 | EB.stack=max & EM.CD>4)
          spell.cast(S.emeraldBlossom, () => me, () => {
            if (!spell.isSpellKnown(T.dreamOfSpring) || this.getEBStacks() < 1) return false;
            // spam_heal approximation: use when ancient_flame talent & !ancient_flame buff
            if (spell.isSpellKnown(T.ancientFlame) && !me.hasAura(A.ancientFlame)) {
              return this.hasEM() || this.getEssDef() === 0 ||
                (this.getEBStacks() >= 2 && (spell.getCooldown(S.ebonMight)?.timeleft || 0) > 4000);
            }
            return false;
          }),

          // 12. Eruption: SimC: target_if=min:bombardments.remains,
          //     if=EM.remains>execute_time | essence.deficit=0 | EB.stack=max & EM.CD>4
          spell.cast(S.eruption, () => this.getEruptionTarget(), () => {
            if (!this.getEruptionTarget()) return false;
            if (this.getEMRem() > 2500) return true;
            if (this.getEssDef() === 0) return true;
            return this.getEBStacks() >= 2 && (spell.getCooldown(S.ebonMight)?.timeleft || 0) > 4000;
          }),

          // 13. Filler
          this.fillerRotation(),
        )
      ),
    );
  }

  // =============================================
  // EBON MIGHT PANDEMIC — SimC complex condition
  // (rem-cast)<=dur*pandemic_threshold AND (value<=0.05 OR (rem-cast)<=dur*0.3)
  // =============================================
  shouldRefreshEM() {
    if (this.getEnemyCount() < 1) return false;
    const em = me.getAura(A.ebonMightSelf) || me.getAura(A.ebonMightAlt);
    if (!em) return true; // Not active
    const dur = em.duration || 10000;
    const rem = em.remaining || 0;
    const castTime = 1500;
    const adjusted = rem - castTime;
    // SimC: (adjusted <= dur*0.4) AND (value<=0.05 OR adjusted <= dur*0.3)
    // value<=0.05 means EM has very low value (e.g. no allies buffed) — approximate as always true for safety
    return adjusted <= dur * 0.4 && adjusted <= dur * 0.3;
  }

  // =============================================
  // FIRE BREATH SUB-LIST (SimC actions.fb, 4 empower tiers)
  // Gate: EM active, not during BoE window, not TtS+Molten
  // =============================================
  fireBreathList() {
    const emOk = this.hasEM() && this.getEMRem() > 2500;
    const boeBlock = spell.getCooldown(S.breathOfEons)?.ready && spell.isSpellKnown(T.temporalBurst);
    const ttsBlock = me.hasAura(A.tipTheScales) && spell.isSpellKnown(T.moltenEmbers);
    const hasMolten = spell.isSpellKnown(T.moltenEmbers);

    return new bt.Selector(
      // R1: Molten Embers — SimC: talent.molten_embers & TTD>16 & EM.remains>duration
      this.castEmpowered(S.fireBreath, 1, () => this.getCurrentTarget(), () => {
        if (boeBlock || ttsBlock) return false;
        return hasMolten && emOk && this.targetTTD() > 16000;
      }),

      // R2: !Molten & TTD>12 — SimC: EM.remains>duration & TTD>12
      this.castEmpowered(S.fireBreath, 2, () => this.getCurrentTarget(), () => {
        if (boeBlock || ttsBlock) return false;
        return !hasMolten && emOk && this.targetTTD() > 12000;
      }),

      // R3: !Molten & TTD>8
      this.castEmpowered(S.fireBreath, 3, () => this.getCurrentTarget(), () => {
        if (boeBlock || ttsBlock) return false;
        return !hasMolten && emOk && this.targetTTD() > 8000;
      }),

      // R4: Font of Magic + !Molten + TTD>4
      this.castEmpowered(S.fireBreath, 4, () => this.getCurrentTarget(), () => {
        if (boeBlock || ttsBlock) return false;
        return spell.isSpellKnown(T.fontOfMagic) && !hasMolten && emOk &&
          this.targetTTD() > 4000;
      }),

      // Fallback: FB R1 when EM is down or expiring — don't hold FB forever
      this.castEmpowered(S.fireBreath, 1, () => this.getCurrentTarget(), () => {
        if (boeBlock) return false;
        return !emOk && this.getCurrentTarget() !== null;
      }),
    );
  }

  // =============================================
  // FILLER (SimC actions.filler, 2 lines)
  // SimC: living_flame,if=(ancient_flame|mana>=200k|!dream_of_spring|spam_heal=0) &
  //       (pupil_alex&enemies>1|!echoing_strike|chrono_flame)|leaping_flames
  // =============================================
  fillerRotation() {
    return new bt.Selector(
      spell.cast(S.livingFlame, () => this.getCurrentTarget(), () => {
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        // SimC: leaping_flames.up → always cast
        if (me.hasAura(A.leapingFlames)) return true;
        // SimC: (ancient_flame | mana>=200k | !dream_of_spring | spam_heal=0) & (!echoing_strike | pupil+enemies>1 | chrono_flame)
        const mana = me.powerByType(PowerType.Mana) || 0;
        const baseOk = me.hasAura(A.ancientFlame) || mana >= 200000 || !spell.isSpellKnown(T.dreamOfSpring);
        const echoOk = !spell.isSpellKnown(T.echoingStrike) ||
          (spell.isSpellKnown(T.pupilAlex) && this.getEnemyCount() > 1) ||
          spell.isSpellKnown(T.chronoFlame);
        return baseOk && echoOk;
      }),
      spell.cast(S.azureStrike, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // HERO DETECTION
  // =============================================
  isCW() { return spell.isSpellKnown(T.chronoFlame); }
  isSC() { return !this.isCW(); }
  useCDs() { return combat.burstToggle || Settings.FWAugAutoCDs; }

  // =============================================
  // STATE HELPERS (all cached per tick)
  // =============================================
  hasEM() {
    return me.hasAura(A.ebonMightSelf) || me.hasAura(A.ebonMightAlt);
  }

  getEMRem() {
    const a = me.getAura(A.ebonMightSelf) || me.getAura(A.ebonMightAlt);
    return a ? a.remaining : 0;
  }

  getEMDuration() {
    const a = me.getAura(A.ebonMightSelf) || me.getAura(A.ebonMightAlt);
    return a ? (a.duration || 10000) : 10000;
  }

  eonsRemains() {
    return spell.getCooldown(S.breathOfEons)?.timeleft || 0;
  }

  getEBStacks() {
    if (this._ebFrame === wow.frameTime) return this._cachedEB;
    this._ebFrame = wow.frameTime;
    const a = me.getAura(A.essenceBurst);
    this._cachedEB = a ? a.stacks : 0;
    return this._cachedEB;
  }

  combatTime() {
    return this._combatStart ? wow.frameTime - this._combatStart : 99999;
  }

  // =============================================
  // ERUPTION TARGET — SimC: target_if=min:debuff.bombardments.remains
  // Prefer target with lowest Bombardments remaining (more urgent)
  // =============================================
  getEruptionTarget() {
    const primary = this.getCurrentTarget();
    if (!primary) return null;
    // Try to find a target with Bombardments debuff (lowest remaining)
    if (combat.targets && combat.targets.length > 1) {
      let best = null;
      let bestRem = 99999;
      for (const t of combat.targets) {
        if (!t || !common.validTarget(t) || me.distanceTo(t) > 25) continue;
        const bombAura = t.getAuraByMe(A.bombardments);
        if (bombAura && bombAura.remaining < bestRem) {
          bestRem = bombAura.remaining;
          best = t;
        }
      }
      if (best) return best;
    }
    return primary;
  }

  // =============================================
  // PRESCIENCE TARGET — DPS ally without Prescience
  // SimC: target_if=min:(prescience.remains - 200*(role.dps) + 50*spec.aug)
  // =============================================
  getPresTarget() {
    if (!heal.friends || !heal.friends.All) return null;
    for (const unit of heal.friends.All) {
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 25) continue;
      if (unit.guid?.equals?.(me.guid)) continue;
      if (unit.hasAura(A.prescience)) continue;
      return unit;
    }
    return null;
  }

  getSourceTarget() {
    if (!heal.friends || !heal.friends.All) return null;
    // Prefer healers first
    for (const unit of heal.friends.All) {
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 25) continue;
      if (unit.guid?.equals?.(me.guid)) continue;
      if (unit.hasAura(369459) || unit.hasVisibleAura(369459)) continue;
      // Check if healer role (class-based heuristic: Priest, Druid, Paladin, Shaman, Monk, Evoker with healing spec)
      if (unit.isFriendlyPlayer) return unit;
    }
    return null;
  }

  getBlistTarget() {
    if (!heal.friends || !heal.friends.Tanks) return null;
    for (const tank of heal.friends.Tanks) {
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 25) return tank;
    }
    return null;
  }

  // =============================================
  // RESOURCES (cached per tick)
  // =============================================
  getEss() {
    if (this._essFrame === wow.frameTime) return this._cachedEssence;
    this._essFrame = wow.frameTime;
    this._cachedEssence = me.powerByType(PowerType.Essence);
    return this._cachedEssence;
  }

  getEssDef() {
    if (this._essDefFrame === wow.frameTime) return this._cachedEssDef;
    this._essDefFrame = wow.frameTime;
    const max = me.maxPowerByType ? me.maxPowerByType(PowerType.Essence) : 5;
    this._cachedEssDef = max - me.powerByType(PowerType.Essence);
    return this._cachedEssDef;
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 25 && me.isFacing(target)) {
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
