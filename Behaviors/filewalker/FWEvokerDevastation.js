import { Behavior, BehaviorContext } from '@/Core/Behavior';
import * as bt from '@/Core/BehaviorTree';
import Specialization from '@/Enums/Specialization';
import common from '@/Core/Common';
import spell from '@/Core/Spell';
import Settings from '@/Core/Settings';
import { PowerType } from "@/Enums/PowerType";
import { me } from '@/Core/ObjectManager';
import { defaultCombatTargeting as combat } from '@/Targeting/CombatTargeting';
import { DispelPriority } from '@/Data/Dispels';
import { WoWDispelType } from '@/Enums/Auras';

/**
 * Devastation Evoker Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (evoker_devastation.simc line-by-line) + Method + Wowhead
 *
 * Auto-detects: Scalecommander (Mass Disintegrate 436335) vs Flameshaper (Consume Flame 444088)
 * SimC sub-lists: st_sc (14), st_fs (14), aoe_sc (13), aoe_fs (15), es (4), green (2) — ALL matched
 *
 * Empower: Fire Breath R1 + Eternity Surge R1-R4 — handleEmpoweredSpell()
 * ES empower sub-list: R1 (ST/Mass Disint/DR), R2 (2-4 targets), R3 (3-6), R4 (4-8 w/ Font)
 * Burst: Dragonrage (18s, 100% EB, Rising Fury haste)
 * Movement: Hover (cast-while-moving 6s) + Azure Strike/Pyre/Azure Sweep instants
 *
 * Resource: Essence (PowerType 19), max 5-6
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL (line-by-line) + Method + Wowhead',
};

const S = {
  livingFlame:        361469,
  azureStrike:        362969,
  azureSweep:         1265872,   // Castable spell (talent passive is 1265867)
  disintegrate:       356995,
  pyre:               357211,
  fireBreath:         357208,
  eternitySurge:      359073,
  dragonrage:         375087,
  deepBreath:         357210,   // Corrected — 433874 was wrong
  tipTheScales:       370553,
  hover:              358267,
  quell:              351338,
  cauterizingFlame:   374251,   // Dispel: Bleed, Poison, Curse, Disease from ally
  expunge:            365585,   // Dispel: Poison from ally
  obsidianScales:     363916,
  verdantEmbrace:     360995,
  emeraldBlossom:     355913,
  berserking:         26297,
};

const T = {
  massDisintegrate:   436335,
  consumeFlame:       444088,
  eternitysSpan:      375757,
  fontOfMagic:        375783,
  feedTheFlames:      369846,   // Correct talent (214893 doesn't exist)
  volatility:         369089,   // Talent passive (393568 is Pyre damage sub-spell)
  animosity:          375797,
  immDestruction:     370781,   // Correct talent (411164 is Event Horizon)
  strafingRun:        1266151,
  burnout:            375801,
  engulfingBlaze:     370837,
  ancientFlame:       369990,
  scarletAdapt:       372469,
  slipstream:         441257,   // Scalecommander talent (388268 doesn't exist)
  leapingFlames:      369939,
  azureSweep:         1265867,
  legacyLifebinder:   1264269,
};

const A = {
  dragonrage:         375087,
  essenceBurst:       359618,
  burnout:            375802,
  chargedBlast:       370454,   // Stacking buff (370455 is hidden passive)
  ancientFlame:       375583,
  leapingFlames:      370901,   // Stacking buff (4 stacks from FB empower). 369939 is talent passive.
  scarletAdaptation:  372470,   // Buff aura (372469 is talent passive)
  tipTheScales:       370553,
  hover:              358267,
  massDisintStacks:   436336,   // Stacking buff (436335 is talent passive)
  bombardments:       434473,
  strafingRun:        1266165,   // Buff aura (1266151 is talent passive)
  fireBreathDot:      357209,
  azureSweepBuff:     1265871,   // Buff aura (1265867 is talent passive)
  risingFury:         1271783,   // Stacking haste buff (1271687 is hidden passive)
  powerSwell:         376850,
};

export class DevastationEvokerBehavior extends Behavior {
  name = 'FW Devastation Evoker';
  context = BehaviorContext.Any;
  specialization = Specialization.Evoker.Devastation;
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
  _cbFrame = 0;
  _cachedCB = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWDevEAutoCDs', text: 'Auto Cooldowns (ignore burst keybind)', default: false },
        { type: 'slider', uid: 'FWDevEAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWDevEDebug', text: 'Debug Logging', default: false },
        { type: 'checkbox', uid: 'FWDevEHover', text: 'Auto Hover', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWDevEScales', text: 'Use Obsidian Scales', default: true },
        { type: 'slider', uid: 'FWDevEScalesHP', text: 'Obsidian Scales HP %', default: 50, min: 15, max: 70 },
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
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      this.handleEmpoweredSpell(),
      common.waitForCastOrChannel(),

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Dev] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isSC() ? 'Scalecommander' : 'Flameshaper'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWDevEDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Dev] Ess:${this.getEss()} EB:${this.getEB()} DR:${this.inDR()} CB:${this.getCBStacks()} MD:${me.hasAura(A.massDisintStacks)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.quell),

          // Dispels: Cauterizing Flame (Bleed, Poison, Curse, Disease) + Expunge (Poison)
          spell.dispel(S.cauterizingFlame, true, DispelPriority.High, false, WoWDispelType.Curse),
          spell.dispel(S.cauterizingFlame, true, DispelPriority.High, false, WoWDispelType.Poison),
          spell.dispel(S.cauterizingFlame, true, DispelPriority.High, false, WoWDispelType.Disease),
          spell.dispel(S.cauterizingFlame, true, DispelPriority.Medium, false, WoWDispelType.Curse),
          spell.dispel(S.cauterizingFlame, true, DispelPriority.Medium, false, WoWDispelType.Poison),
          spell.dispel(S.cauterizingFlame, true, DispelPriority.Medium, false, WoWDispelType.Disease),

          spell.cast(S.obsidianScales, () => me, () =>
            Settings.FWDevEScales && me.effectiveHealthPercent < Settings.FWDevEScalesHP
          ),

          // SimC: hover off-GCD — movement or Slipstream (optional, default OFF)
          spell.cast(S.hover, () => me, () => {
            if (!Settings.FWDevEHover) return false;
            if (me.hasAura(A.hover)) return false;
            if (me.isMoving() && spell.getChargesFractional(S.hover) > 0.3) return true;
            return spell.isSpellKnown(T.slipstream) && !me.hasAura(A.hover);
          }),

          // Movement block — FULL instant rotation (all off-GCD CDs + instants)
          new bt.Decorator(
            () => me.isMoving() && !me.hasAura(A.hover),
            new bt.Selector(
              // Off-GCD CDs: Dragonrage, Tip the Scales, Berserking
              spell.cast(S.dragonrage, () => this.getCurrentTarget(), () =>
                (this.useCDs() || this.getEnemyCount() >= 3) && (this.getEnemyCount() >= 3 || this.targetTTD() >= 15000)
              ),
              spell.cast(S.tipTheScales, () => me, () => this.inDR()),
              spell.cast(S.berserking, () => me, () => this.inDR()),
              // Deep Breath (works while moving for all hero trees)
              spell.cast(S.deepBreath, () => this.getCurrentTarget()),
              // Pyre: 3+ targets with resources
              spell.cast(S.pyre, () => this.getCurrentTarget(), () =>
                (this.getEB() >= 1 || this.getEss() >= 3) && this.getEnemyCount() >= 3
              ),
              // Burnout Living Flame (instant via Burnout proc)
              spell.cast(S.livingFlame, () => this.getCurrentTarget(), () =>
                me.hasAura(A.burnout)
              ),
              // Azure Sweep
              spell.cast(S.azureSweep, () => this.getCurrentTarget()),
              // Azure Strike
              spell.cast(S.azureStrike, () => this.getCurrentTarget()),
              new bt.Action(() => bt.Status.Success)
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: Dispatch by hero talent + enemy count
          // SC uses one unified list (Pyre gated by use_pyre variable inline)
          new bt.Decorator(() => this.isFS() && this.getEnemyCount() >= Settings.FWDevEAoECount,
            this.aoeFS(), new bt.Action(() => bt.Status.Failure)),
          new bt.Decorator(() => this.isSC(), this.scRotation(), new bt.Action(() => bt.Status.Failure)),
          this.stFS(),
        )
      ),
    );
  }

  // =============================================
  // ETERNITY SURGE SUB-LIST (SimC actions.es, 4 empower tiers)
  // SimC: R1 if enemies<=1+span OR enemies>4+4*span OR mass_disintegrate OR dragonrage.up
  // R2 if enemies<=2+2*span, R3 if enemies<=3+3*span, R4 if enemies<=4+4*span
  // =============================================
  es() {
    const e = this.getEnemyCount();
    const span = spell.isSpellKnown(T.eternitysSpan) ? 1 : 0;
    return new bt.Selector(
      // R1: ST / Mass Disint / DR / too many targets (overflow)
      this.castEmpowered(S.eternitySurge, 1, () => this.getCurrentTarget(), () =>
        e <= 1 + span || e > 4 + 4 * span || this.isSC() || this.inDR()
      ),
      // R2
      this.castEmpowered(S.eternitySurge, 2, () => this.getCurrentTarget(), () =>
        e <= 2 + 2 * span
      ),
      // R3
      this.castEmpowered(S.eternitySurge, 3, () => this.getCurrentTarget(), () =>
        e <= 3 + 3 * span
      ),
      // R4
      this.castEmpowered(S.eternitySurge, 4, () => this.getCurrentTarget(), () =>
        e <= 4 + 4 * span
      ),
    );
  }

  // =============================================
  // SCALECOMMANDER — Unified list (SimC actions.sc — handles all target counts)
  // =============================================
  scRotation() {
    return new bt.Selector(
      // 1. Deep Breath: Strafing Run talent + buff expiring or not up
      spell.cast(S.deepBreath, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.strafingRun)) return false;
        const sr = me.getAura(A.strafingRun);
        return !sr || sr.remaining <= 3000;
      }),

      // 2. Dragonrage: TTD>=30 — fires with burst toggle OR auto CDs OR 3+ enemies (always use in AoE)
      spell.cast(S.dragonrage, () => this.getCurrentTarget(), () =>
        (this.useCDs() || this.getEnemyCount() >= 3) && (this.getEnemyCount() >= 3 || this.targetTTD() >= 15000)
      ),

      // 3. Hover: auto-use when empowers are ready and moving (critical for DPS)
      spell.cast(S.hover, () => me, () => {
        if (me.hasAura(A.hover)) return false;
        // Always Hover when moving + empower is off CD (empowers are huge DPS)
        if (me.isMoving() && spell.getChargesFractional(S.hover) > 0.3 &&
            (!spell.isOnCooldown(S.eternitySurge) || !spell.isOnCooldown(S.fireBreath))) return true;
        // Optional Slipstream usage
        if (Settings.FWDevEHover && spell.isSpellKnown(T.slipstream)) return true;
        return false;
      }),

      // 4. Azure Sweep: high priority when ES coming off CD soon (if talented)
      spell.cast(S.azureSweep, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.azureSweep) &&
        (this.getEB() === 0 || this.getEB() < 2) &&
        (spell.getCooldown(S.eternitySurge)?.timeleft || 99999) <= 6000
      ),

      // 5. ES R1 (SC always R1) — only when off CD and not moving (or Hover up)
      this.castEmpowered(S.eternitySurge, 1, () => this.getCurrentTarget(), () =>
        !spell.isOnCooldown(S.eternitySurge) && (!me.isMoving() || me.hasAura(A.hover))
      ),

      // 6. TtS: off-GCD, only when Fire Breath is READY
      spell.cast(S.tipTheScales, () => me, () =>
        !spell.isOnCooldown(S.fireBreath)
      ),

      // 7. FB R1 (SC always R1) — only when off CD and not moving (or Hover up)
      this.castEmpowered(S.fireBreath, 1, () => this.getCurrentTarget(), () =>
        !spell.isOnCooldown(S.fireBreath) && (!me.isMoving() || me.hasAura(A.hover))
      ),

      // 8. Deep Breath: Imminent Destruction AoE OR general fallback when off CD
      spell.cast(S.deepBreath, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.immDestruction) ? this.usePyre() : !spell.isOnCooldown(S.deepBreath)
      ),

      // 9. Disintegrate: Mass Disint stacks — target_if=min:bombardments.remains
      spell.cast(S.disintegrate, () => this.getBombTarget(), () => {
        if (me.isMoving()) return false;
        if (!me.hasAura(A.massDisintStacks)) return false;
        return this.getEB() >= 1 || this.getEss() >= 2;
      }),

      // 10. Pyre: !mass_disint + use_pyre (4+ or 3+ with talents)
      spell.cast(S.pyre, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.massDisintStacks) && this.usePyre() &&
        (this.getEB() >= 1 || this.getEss() >= 2)
      ),

      // 11. Disintegrate: normal — target_if=max:fire_breath_dot.remains
      spell.cast(S.disintegrate, () => this.getFBDotTarget(), () =>
        !me.isMoving() && (this.getEB() >= 1 || this.getEss() >= 2)
      ),

      // 12. Azure Sweep (unconditional)
      spell.cast(S.azureSweep, () => this.getCurrentTarget()),

      // 13. Living Flame with procs: burnout | (leaping|ancient|engulfing) & !moving
      spell.cast(S.livingFlame, () => this.getCurrentTarget(), () =>
        !me.isMoving() && (me.hasAura(A.burnout) || me.hasAura(A.leapingFlames) ||
          me.hasAura(A.ancientFlame) || spell.isSpellKnown(T.engulfingBlaze))
      ),

      // 14. Green: Ancient Flame + Scarlet Adaptation, not in DR
      spell.cast(S.emeraldBlossom, () => me, () =>
        spell.isSpellKnown(T.ancientFlame) && !me.hasAura(A.ancientFlame) &&
        spell.isSpellKnown(T.scarletAdapt) && !this.inDR()
      ),
      spell.cast(S.verdantEmbrace, () => me, () =>
        spell.isSpellKnown(T.ancientFlame) && !me.hasAura(A.ancientFlame) &&
        spell.isSpellKnown(T.scarletAdapt) && !this.inDR()
      ),

      // 15. Living Flame filler (no procs needed)
      spell.cast(S.livingFlame, () => this.getCurrentTarget(), () => !me.isMoving()),

      // 16. Azure Strike
      spell.cast(S.azureStrike, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // FLAMESHAPER ST (SimC actions.st_fs, 14 lines — ALL matched)
  // =============================================
  stFS() {
    return new bt.Selector(
      // 1. Dragonrage: fires with burst toggle OR auto CDs OR 3+ enemies
      spell.cast(S.dragonrage, () => this.getCurrentTarget(), () =>
        (this.useCDs() || this.getEnemyCount() >= 3) && (this.getEnemyCount() >= 3 || this.targetTTD() >= 15000)
      ),

      // 2. Hover: auto when moving + empowers ready
      spell.cast(S.hover, () => me, () => {
        if (me.hasAura(A.hover)) return false;
        if (me.isMoving() && spell.getChargesFractional(S.hover) > 0.3 &&
            (!spell.isOnCooldown(S.eternitySurge) || !spell.isOnCooldown(S.fireBreath))) return true;
        if (Settings.FWDevEHover && spell.isSpellKnown(T.slipstream)) return true;
        return false;
      }),

      // 3. TtS during DR: ES before FB priority
      spell.cast(S.tipTheScales, () => me, () =>
        this.inDR() && (spell.getCooldown(S.eternitySurge)?.timeleft || 99999) <=
          (spell.getCooldown(S.fireBreath)?.timeleft || 99999)
      ),

      // 4. Berserking during DR
      spell.cast(S.berserking, () => me, () => this.inDR()),

      // 5. ES R2 at 2 enemies without Eternity's Span
      this.castEmpowered(S.eternitySurge, 2, () => this.getCurrentTarget(), () =>
        (!me.isMoving() || me.hasAura(A.hover)) &&
        this.getEnemyCount() === 2 && !spell.isSpellKnown(T.eternitysSpan) &&
        (this.canUseEmpower() || (me.hasAura(A.azureSweepBuff) && spell.isSpellKnown(T.azureSweep)))
      ),

      // 6. ES R1 (default): SimC: can_use_empower | 2pc+azure_sweep
      this.castEmpowered(S.eternitySurge, 1, () => this.getCurrentTarget(), () =>
        (!me.isMoving() || me.hasAura(A.hover)) &&
        (this.canUseEmpower() || (me.hasAura(A.azureSweepBuff) && spell.isSpellKnown(T.azureSweep)))
      ),

      // 7. FB R1: refreshable DoT + can_use_empower + !TtS
      // SimC: can_use_empower & !tip_the_scales & dot.refreshable &
      //       (DR.CD>full_recharge | DR.up | full_recharge<gcd*5)
      this.castEmpowered(S.fireBreath, 1, () => this.getCurrentTarget(), () => {
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        if (me.hasAura(A.tipTheScales)) return false;
        if (!this.canUseEmpower()) return false;
        const fbDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
        if (fbDot && fbDot.remaining > 6000) return false; // not refreshable
        const drCD = spell.getCooldown(S.dragonrage)?.timeleft || 99999;
        const fbRecharge = spell.getFullRechargeTime(S.fireBreath) || 0;
        return this.inDR() ||
          (fbRecharge < 7500) ||
          (drCD > fbRecharge) ||
          !spell.isSpellKnown(T.animosity);
      }),

      // 7b. Deep Breath: baseline AoE damage (Imm Dest: when no FB DoT, otherwise on CD)
      spell.cast(S.deepBreath, () => this.getCurrentTarget(), () => {
        if (spell.isSpellKnown(T.immDestruction)) {
          const fbDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
          return !fbDot || fbDot.remaining < 1000;
        }
        return this.getEnemyCount() >= 2; // Without Imm Dest, only use in AoE
      }),

      // 8. Pyre: 2+ targets with FB DoT <= 8s + Feed the Flames + Volatility
      spell.cast(S.pyre, () => this.getCurrentTarget(), () => {
        if (this.getEnemyCount() < 2) return false;
        const fbDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
        return fbDot && fbDot.remaining <= 8000 && spell.isSpellKnown(T.feedTheFlames) &&
          spell.isSpellKnown(T.volatility) && (this.getEB() >= 1 || this.getEss() >= 2);
      }),

      // 9. Disintegrate: chain, target with max FB DoT (Consume Flame value)
      spell.cast(S.disintegrate, () => this.getFBDotTarget(), () =>
        !me.isMoving() && (this.getEB() >= 1 || this.getEss() >= 2)
      ),

      // 10. Azure Sweep
      spell.cast(S.azureSweep, () => this.getCurrentTarget()),

      // 11. Living Flame with procs
      spell.cast(S.livingFlame, () => this.getCurrentTarget(), () =>
        !me.isMoving() && (me.hasAura(A.burnout) || me.hasAura(A.leapingFlames) || me.hasAura(A.ancientFlame))
      ),

      // 12. Azure Strike 2+
      spell.cast(S.azureStrike, () => this.getCurrentTarget(), () => this.getEnemyCount() > 1),

      // 13. Living Flame filler
      spell.cast(S.livingFlame, () => this.getCurrentTarget(), () => !me.isMoving()),

      // 14. Green + Azure Strike
      spell.cast(S.emeraldBlossom, () => me, () =>
        spell.isSpellKnown(T.ancientFlame) && !me.hasAura(A.ancientFlame) &&
        spell.isSpellKnown(T.scarletAdapt) && !this.inDR()
      ),
      spell.cast(S.verdantEmbrace, () => me, () =>
        spell.isSpellKnown(T.ancientFlame) && !me.hasAura(A.ancientFlame) &&
        spell.isSpellKnown(T.scarletAdapt) && !this.inDR()
      ),
      spell.cast(S.azureStrike, () => this.getCurrentTarget()),
    );
  }

  // (aoeSC removed — SC uses unified scRotation() per SimC)

  // =============================================
  // FLAMESHAPER AoE (SimC actions.aoe_fs, 15 lines — ALL matched)
  // =============================================
  aoeFS() {
    return new bt.Selector(
      // 1. Hover: auto when moving + empowers ready
      spell.cast(S.hover, () => me, () => {
        if (me.hasAura(A.hover)) return false;
        if (me.isMoving() && spell.getChargesFractional(S.hover) > 0.3 &&
            (!spell.isOnCooldown(S.eternitySurge) || !spell.isOnCooldown(S.fireBreath))) return true;
        if (Settings.FWDevEHover && spell.isSpellKnown(T.slipstream)) return true;
        return false;
      }),

      // 1b. Dragonrage: fires in AoE without burst toggle
      spell.cast(S.dragonrage, () => this.getCurrentTarget(), () =>
        (this.useCDs() || this.getEnemyCount() >= 3) && (this.getEnemyCount() >= 3 || this.targetTTD() >= 15000)
      ),

      // 2. FB R1 pre-DR: no active FB DoT & DR coming up
      this.castEmpowered(S.fireBreath, 1, () => this.getCurrentTarget(), () => {
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        const drCD = spell.getCooldown(S.dragonrage)?.timeleft || 99999;
        if (drCD > 3000) return false;
        const fbDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
        return (!fbDot || fbDot.remaining < 1000) && (this.getEnemyCount() >= 3 || this.targetTTD() > 15000);
      }),

      // 3. Tip the Scales during DR: ES before FB
      spell.cast(S.tipTheScales, () => me, () =>
        this.inDR() && (spell.getCooldown(S.eternitySurge)?.timeleft || 99999) <=
          (spell.getCooldown(S.fireBreath)?.timeleft || 99999)
      ),

      // 4. ES sub-list: TtS up
      new bt.Decorator(() => me.hasAura(A.tipTheScales), this.es(), new bt.Action(() => bt.Status.Failure)),

      // 5. FB R1: Consume Flame + can_use_empower + refreshable
      this.castEmpowered(S.fireBreath, 1, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.consumeFlame) || !this.canUseEmpowerAoE()) return false;
        const fbDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
        return !fbDot || fbDot.remaining < 6000;
      }),

      // 6. Dragonrage (moved to top — 1b)
      spell.cast(S.dragonrage, () => this.getCurrentTarget(), () =>
        (this.useCDs() || this.getEnemyCount() >= 3) && (this.getEnemyCount() >= 3 || this.targetTTD() >= 15000)
      ),

      // 7. ES: (DR or prep) & (DR or consume_flame & !azure_sweep) & (!FB DoT or enemies<=3)
      new bt.Decorator(
        () => {
          if (!this.inDR() && !this.canUseEmpowerAoE()) return false;
          if (!this.inDR() && !(spell.isSpellKnown(T.consumeFlame) && !me.hasAura(A.azureSweepBuff))) return false;
          const fbDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
          return !fbDot || fbDot.remaining < 1000 || this.getEnemyCount() <= 3;
        },
        this.es(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 8. Pyre: CB >= 12 or 4+ targets or 3+ with talents
      // SimC: DR.CD>gcd*4 & (CB>=12 | enemies>=4 | enemies>=3 & (ftf|vol))
      spell.cast(S.pyre, () => this.getCurrentTarget(), () => {
        const e = this.getEnemyCount();
        if (e < 3) return false;
        const drCD = spell.getCooldown(S.dragonrage)?.timeleft || 99999;
        if (drCD <= 6000) return false;
        return (this.getCBStacks() >= 12 || e >= 4 ||
          (e >= 3 && (spell.isSpellKnown(T.feedTheFlames) || spell.isSpellKnown(T.volatility)))) &&
          (this.getEB() >= 1 || this.getEss() >= 2);
      }),

      // 9. Pyre: 3 targets without Feed/Volatility
      spell.cast(S.pyre, () => this.getCurrentTarget(), () =>
        this.getEnemyCount() === 3 && !spell.isSpellKnown(T.feedTheFlames) &&
        !spell.isSpellKnown(T.volatility) && (this.getEB() >= 1 || this.getEss() >= 2)
      ),

      // 10. Deep Breath: Imminent Destruction (no FB DoT) OR general use on CD
      spell.cast(S.deepBreath, () => this.getCurrentTarget(), () => {
        if (spell.isSpellKnown(T.immDestruction)) {
          const fbDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
          return !fbDot || fbDot.remaining < 1000;
        }
        return true; // No Imm Dest — use on CD as AoE damage
      }),

      // 11. Azure Sweep
      spell.cast(S.azureSweep, () => this.getCurrentTarget()),

      // 12. Living Flame: Leaping Flames + procs + EB/essence check
      // SimC: leaping_flames & (!burnout | burnout.up | active_dot.fb=0 | scarlet | ancient_flame) &
      //       (!EB.up & essence.deficit>1 | FB.CD<=gcd*3 & EB<max)
      spell.cast(S.livingFlame, () => this.getCurrentTarget(), () => {
        if (!me.hasAura(A.leapingFlames) || me.isMoving()) return false;
        const hasFBDot = this.getCurrentTarget()?.getAuraByMe(A.fireBreathDot);
        if (!me.hasAura(A.burnout) && !me.hasAura(A.scarletAdaptation) && !me.hasAura(A.ancientFlame) && hasFBDot) {
          return spell.isSpellKnown(T.burnout);
        }
        const fbCD = spell.getCooldown(S.fireBreath)?.timeleft || 99999;
        return (this.getEB() === 0 && this.getEssDef() > 1) ||
          (fbCD <= 4500 && this.getEB() < 2);
      }),

      // 13. ES: (DR or prep) + Azure Sweep buff
      new bt.Decorator(
        () => (this.inDR() || this.canUseEmpowerAoE()) && me.hasAura(A.azureSweepBuff),
        this.es(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 14. Living Flame: Engulfing Blaze + procs
      spell.cast(S.livingFlame, () => this.getCurrentTarget(), () =>
        !me.isMoving() && (me.hasAura(A.leapingFlames) || me.hasAura(A.burnout) ||
          me.hasAura(A.scarletAdaptation) || me.hasAura(A.ancientFlame))
      ),

      // 15. Azure Strike
      spell.cast(S.azureStrike, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // HELPERS
  // =============================================
  isSC() { return spell.isSpellKnown(T.massDisintegrate); }
  isFS() { return !this.isSC(); }
  inDR() { return me.hasAura(A.dragonrage); }
  useCDs() { return combat.burstToggle || Settings.FWDevEAutoCDs; }

  // SimC: variable.use_pyre = enemies>=4 | enemies>=3 & (volatility.rank=2 | feed_the_flames)
  usePyre() {
    const e = this.getEnemyCount();
    return e >= 4 || (e >= 3 && (spell.isSpellKnown(T.feedTheFlames) || spell.isSpellKnown(T.volatility)));
  }

  // SimC: can_use_empower = DR.CD >= gcd*dr_prep_time (6 for ST, 4 for AoE)
  // Fix: if DR is ready but won't fire (TTD too low), don't block empowers
  canUseEmpower() {
    if (!spell.isSpellKnown(S.dragonrage) || !spell.isSpellKnown(T.animosity)) return true;
    const drCD = spell.getCooldown(S.dragonrage)?.timeleft || 0;
    // DR is ready but TTD is too low to use it — don't lock out empowers
    if (drCD === 0 && this.targetTTD() < 15000) return true;
    return drCD >= 9000;
  }

  canUseEmpowerAoE() {
    if (!spell.isSpellKnown(S.dragonrage) || !spell.isSpellKnown(T.animosity)) return true;
    const drCD = spell.getCooldown(S.dragonrage)?.timeleft || 0;
    if (drCD === 0 && this.targetTTD() < 15000) return true;
    return drCD >= 6000;
  }

  // Bombardments target: min:bombardments.remains
  getBombTarget() {
    if (!combat.targets || combat.targets.length <= 1) return this.getCurrentTarget();
    let best = null;
    let bestRem = 99999;
    for (const t of combat.targets) {
      if (!t || !common.validTarget(t) || me.distanceTo(t) > 25) continue;
      const bomb = t.getAuraByMe(A.bombardments);
      if (bomb && bomb.remaining < bestRem) {
        bestRem = bomb.remaining;
        best = t;
      }
    }
    return best || this.getCurrentTarget();
  }

  // FB DoT target: max:fire_breath_damage.remains (maximize Consume Flame)
  getFBDotTarget() {
    if (!combat.targets || combat.targets.length <= 1) return this.getCurrentTarget();
    let best = null;
    let bestRem = 0;
    for (const t of combat.targets) {
      if (!t || !common.validTarget(t) || me.distanceTo(t) > 25) continue;
      const fb = t.getAuraByMe(A.fireBreathDot);
      if (fb && fb.remaining > bestRem) {
        bestRem = fb.remaining;
        best = t;
      }
    }
    return best || this.getCurrentTarget();
  }

  getEB() {
    if (this._ebFrame === wow.frameTime) return this._cachedEB;
    this._ebFrame = wow.frameTime;
    const a = me.getAura(A.essenceBurst);
    this._cachedEB = a ? a.stacks : 0;
    return this._cachedEB;
  }

  getCBStacks() {
    if (this._cbFrame === wow.frameTime) return this._cachedCB;
    this._cbFrame = wow.frameTime;
    const a = me.getAura(A.chargedBlast);
    this._cachedCB = a ? a.stacks : 0;
    return this._cachedCB;
  }

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
