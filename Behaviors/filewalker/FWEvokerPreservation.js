import { Behavior, BehaviorContext } from '@/Core/Behavior';
import * as bt from '@/Core/BehaviorTree';
import Specialization from '@/Enums/Specialization';
import common from '@/Core/Common';
import spell from '@/Core/Spell';
import Settings from '@/Core/Settings';
import { PowerType } from "@/Enums/PowerType";
import { me } from '@/Core/ObjectManager';
import { defaultHealTargeting as heal } from '@/Targeting/HealTargeting';
import { defaultCombatTargeting as combat } from '@/Targeting/CombatTargeting';
import { DispelPriority, dispels } from '@/Data/Dispels';
import { WoWDispelType } from '@/Enums/Auras';

/**
 * Preservation Evoker Behavior — Midnight 12.0.1
 * Sources: Method + Wowhead + Maxroll + Icy Veins Preservation Evoker Guides
 *
 * Auto-detects: Chronowarden (Chrono Flame 431442) vs Flameshaper (Consume Flame 444088)
 *
 * Resource: Essence (PowerType 19, max 5 base / 6 with Power Nexus) + Mana (PowerType 0)
 * Empower: Dream Breath (R1-R3) + Fire Breath (R1-R3) — handleEmpoweredSpell()
 * Spiritbloom REMOVED in 12.0 — replaced by Merithra's Blessing apex talent
 *
 * Core loop:
 *   Temporal Anomaly → spread Echo → Dream Breath R1 (Merithra's proc) →
 *   Verdant Embrace (Lifebind/Primacy) → Reversion maintenance →
 *   Emerald Blossom with EB procs → Echo spending → Living Flame filler
 *
 * Chronowarden: Tip the Scales → Temporal Burst (30% haste/CDR 30s), Primacy haste stacking,
 *   Chrono Flame repeats 15% healing, Warp (Hover → Blink), Energy Cycles (EB from empower)
 * Flameshaper: +1 charge Dream Breath & Fire Breath (Legacy of Lifebinder),
 *   Consume Flame detonates DB HoT (200% consumed), Essence Well (DB 50% EB proc),
 *   Twin Flame (duplicates LF), Fan the Flames (DB HoT extends via LF)
 *
 * Long CDs OFF by default: Dream Flight, Rewind, Stasis
 * DPS: Fire Breath on CD (Life-Giver's Flame + Leaping Flames), Disintegrate (mana via Energy Loop),
 *   Living Flame (EB procs), Azure Strike (instant filler)
 *
 * 30yd healing range — shorter than most healers
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'Method + Wowhead + Maxroll + Icy Veins Preservation Evoker',
};

// Cast spell IDs
const S = {
  // Core heals
  dreamBreath:        355936,
  livingFlame:        361469,
  emeraldBlossom:     355913,
  reversion:          366155,   // 367364 not found in Midnight — using 366155
  echo:               364343,
  temporalAnomaly:    373861,
  verdantEmbrace:     360995,
  merithrasBlessing:  1256581,
  // Major CDs
  dreamFlight:        359816,
  rewind:             363534,
  stasis:             370537,
  tipTheScales:       370553,
  timeDilation:       357170,
  // DPS
  fireBreath:         357208,
  azureStrike:        362969,
  disintegrate:       356995,
  deepBreath:         357210,
  // Movement
  hover:              358267,
  // Dispel
  naturalize:         360823,
  cauterizingFlame:   374251,
  // Defensive
  obsidianScales:     363916,
  zephyr:             374227,
  renewingBlaze:      374348,
  // Utility
  sourceOfMagic:      369459,
  blessingOfBronze:   364342,
  furyOfTheAspects:   390386,
};

// Aura IDs (may differ from cast IDs)
const A = {
  // Core buffs
  essenceBurst:       361519,  // EB stack 1 aura (confirmed)
  essenceBurst2:      369299,  // EB stack 2 aura (confirmed)
  echo:               364343,
  reversion:          366155,   // 367364 not found in Midnight — using 366155
  dreamBreathHoT:     355941,
  fireBreathDot:      357209,
  temporalAnomaly:    373861,
  lifebind:           373270,
  gracePeriod:        376239,
  goldenHour:         378196,
  resonatingSphere:   376236,
  flowState:          390148,
  merithrasBless:     1256682,  // Merithra's Blessing proc aura 1 (confirmed)
  merithrasBless2:    1256577,  // Merithra's Blessing proc aura 2 (confirmed)
  lifespark:          443177,
  leapingFlames:      369939,
  // Chronowarden
  chronoFlame:        431442,
  temporalBurst:      431695,
  primacy:            431657,
  afterimage:         431875,
  energyCycles:       1260568,
  // Flameshaper
  consumeFlame:       444088,
  twinEchoes:         1242031,
  essenceWell:        1265993,
  twinFlame:          1265979,
  legacyLifebinder:   1264269,
  // Defensive
  obsidianScales:     363916,
  hover:              358267,
};

export class PreservationEvokerBehavior extends Behavior {
  name = 'FW Preservation Evoker';
  context = BehaviorContext.Any;
  specialization = Specialization.Evoker.Preservation;
  version = wow.GameVersion.Retail;

  // Empowerment state
  _desiredEmpowerLevel = undefined;

  // Per-tick caches
  _healFrame = 0;
  _cachedLowest = null;
  _cachedLowestHP = 100;
  _cachedTankLowest = null;
  _cachedTankLowestHP = 100;
  _cachedBelow20 = 0;
  _cachedBelow40 = 0;
  _cachedBelow65 = 0;
  _cachedBelow85 = 0;
  _groupFrame = 0;
  _cachedGroupSize = 5;
  _essFrame = 0;
  _cachedEssence = 0;
  _ebFrame = 0;
  _cachedEB = null;
  _dpsTargetFrame = 0;
  _cachedDpsTarget = null;
  _manaFrame = 0;
  _cachedMana = 100;
  _echoFrame = 0;
  _cachedEchoCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'Healing Thresholds',
      options: [
        { type: 'slider', uid: 'FWPresEmergHP', text: 'Emergency HP %', default: 20, min: 5, max: 35 },
        { type: 'slider', uid: 'FWPresCritHP', text: 'Critical HP %', default: 40, min: 20, max: 55 },
        { type: 'slider', uid: 'FWPresUrgentHP', text: 'Urgent HP %', default: 65, min: 40, max: 80 },
        { type: 'slider', uid: 'FWPresMaintHP', text: 'Maintenance HP %', default: 85, min: 70, max: 95 },
        { type: 'slider', uid: 'FWPresDpsHP', text: 'DPS when all above %', default: 85, min: 70, max: 100 },
      ],
    },
    {
      header: 'Major Cooldowns (OFF = manual/raid assignment)',
      options: [
        { type: 'checkbox', uid: 'FWPresDreamFlight', text: 'Auto Dream Flight', default: false },
        { type: 'slider', uid: 'FWPresDreamFlightHP', text: 'Dream Flight avg HP %', default: 45, min: 20, max: 70 },
        { type: 'slider', uid: 'FWPresDreamFlightCount', text: 'Dream Flight min targets', default: 3, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWPresRewind', text: 'Auto Rewind', default: false },
        { type: 'slider', uid: 'FWPresRewindHP', text: 'Rewind avg HP %', default: 40, min: 15, max: 60 },
        { type: 'slider', uid: 'FWPresRewindCount', text: 'Rewind min targets', default: 3, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWPresTimeDil', text: 'Auto Time Dilation', default: false },
        { type: 'slider', uid: 'FWPresTimeDilHP', text: 'Time Dilation HP %', default: 30, min: 10, max: 50 },
        { type: 'checkbox', uid: 'FWPresTipScales', text: 'Auto Tip the Scales (emergency)', default: true },
        { type: 'slider', uid: 'FWPresTipScalesHP', text: 'Tip the Scales HP %', default: 25, min: 10, max: 40 },
        { type: 'checkbox', uid: 'FWPresStasis', text: 'Auto Stasis', default: false },
        { type: 'slider', uid: 'FWPresStasisHP', text: 'Stasis avg HP %', default: 35, min: 15, max: 55 },
        { type: 'slider', uid: 'FWPresStasisCount', text: 'Stasis min targets', default: 3, min: 2, max: 5 },
      ],
    },
    {
      header: 'Self-Defense',
      options: [
        { type: 'checkbox', uid: 'FWPresScales', text: 'Use Obsidian Scales', default: true },
        { type: 'slider', uid: 'FWPresScalesHP', text: 'Obsidian Scales HP %', default: 50, min: 15, max: 70 },
        { type: 'checkbox', uid: 'FWPresZephyr', text: 'Use Zephyr (AoE DR)', default: false },
        { type: 'slider', uid: 'FWPresZephyrHP', text: 'Zephyr avg HP %', default: 50, min: 20, max: 70 },
        { type: 'slider', uid: 'FWPresZephyrCount', text: 'Zephyr min targets', default: 3, min: 1, max: 5 },
      ],
    },
    {
      header: 'DPS',
      options: [
        { type: 'checkbox', uid: 'FWPresFireBreathDps', text: 'Fire Breath on CD (DPS + Life-Giver)', default: true },
        { type: 'checkbox', uid: 'FWPresDisintegrate', text: 'Use Disintegrate (mana regen)', default: true },
      ],
    },
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWPresDebug', text: 'Debug Logging', default: false },
        { type: 'checkbox', uid: 'FWPresHover', text: 'Auto Hover', default: false },
        { type: 'slider', uid: 'FWPresDispelDelay', text: 'Dispel Reaction (ms)', default: 1500, min: 300, max: 3000 },
      ],
    },
  ];

  // ===== Hero Talent Detection =====
  isChronowarden() {
    return spell.isSpellKnown(431442); // Chrono Flame
  }

  isFlameshaper() {
    return !this.isChronowarden();
  }

  // ===== Empowerment System =====
  castEmpowered(spellId, level, targetFn, conditionFn) {
    return new bt.Sequence(
      spell.cast(spellId, targetFn, conditionFn),
      new bt.Action(() => {
        this._desiredEmpowerLevel = level;
        return bt.Status.Success;
      })
    );
  }

  handleEmpoweredSpell() {
    return new bt.Action(() => {
      if (this._desiredEmpowerLevel === undefined) return bt.Status.Failure;
      if (!me.isCastingOrChanneling) {
        this._desiredEmpowerLevel = undefined;
        return bt.Status.Failure;
      }

      const currentLevel = (me.spellInfo && me.spellInfo.empowerLevel) || 0;

      // Emergency early release: if someone drops critical while charging,
      // release at current level immediately instead of waiting for desired level
      if (currentLevel >= 1) {
        this._refreshHealCache();
        const emergHP = Settings.FWPresEmergHP || 20;
        if (this._cachedLowestHP <= emergHP) {
          const currentSpellId = me.spellInfo.spellChannelId;
          const currentSpell = spell.getSpell(currentSpellId);
          if (currentSpell) {
            currentSpell.cast(me.targetUnit);
            this._desiredEmpowerLevel = undefined;
          }
          return bt.Status.Success;
        }
      }

      // Normal release at desired level
      if (currentLevel >= this._desiredEmpowerLevel) {
        const currentSpellId = me.spellInfo.spellChannelId;
        const currentSpell = spell.getSpell(currentSpellId);
        if (currentSpell) {
          currentSpell.cast(me.targetUnit);
          this._desiredEmpowerLevel = undefined;
        }
        return bt.Status.Success;
      }
      return bt.Status.Success; // Still charging — block other actions
    });
  }

  // ===== Per-Tick Caching =====
  _refreshHealCache() {
    if (this._healFrame === wow.frameTime) return;
    this._healFrame = wow.frameTime;

    let lowest = null, lowestHP = 100;
    let tankLowest = null, tankLowestHP = 100;
    let below20 = 0, below40 = 0, below65 = 0, below85 = 0;
    let selfCounted = false;

    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 30) continue;
      const isSelf = unit.guid && unit.guid.equals && unit.guid.equals(me.guid);
      if (isSelf) selfCounted = true;
      const hp = unit.effectiveHealthPercent;
      if (hp < lowestHP) { lowestHP = hp; lowest = unit; }
      if (hp <= 20) below20++;
      if (hp <= 40) below40++;
      if (hp <= 65) below65++;
      if (hp <= 85) below85++;
    }

    // Ensure self is counted
    if (!selfCounted) {
      const selfHP = me.effectiveHealthPercent;
      if (selfHP < lowestHP) { lowestHP = selfHP; lowest = me; }
      if (selfHP <= 20) below20++;
      if (selfHP <= 40) below40++;
      if (selfHP <= 65) below65++;
      if (selfHP <= 85) below85++;
    }

    // Tank cache
    const tanks = heal.friends.Tanks;
    for (let i = 0; i < tanks.length; i++) {
      const unit = tanks[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 30) continue;
      const hp = unit.effectiveHealthPercent;
      if (hp < tankLowestHP) { tankLowestHP = hp; tankLowest = unit; }
    }

    this._cachedLowest = lowest;
    this._cachedLowestHP = lowestHP;
    this._cachedTankLowest = tankLowest;
    this._cachedTankLowestHP = tankLowestHP;
    this._cachedBelow20 = below20;
    this._cachedBelow40 = below40;
    this._cachedBelow65 = below65;
    this._cachedBelow85 = below85;
  }

  getHealTarget(maxHP) {
    this._refreshHealCache();
    return this._cachedLowestHP <= maxHP ? this._cachedLowest : null;
  }

  getTankTarget(maxHP) {
    this._refreshHealCache();
    return (this._cachedTankLowestHP <= maxHP) ? this._cachedTankLowest : null;
  }

  getFriendsBelow(hp) {
    this._refreshHealCache();
    if (hp <= 20) return this._cachedBelow20;
    if (hp <= 40) return this._cachedBelow40;
    if (hp <= 65) return this._cachedBelow65;
    if (hp <= 85) return this._cachedBelow85;
    return 0;
  }

  // Group size detection (cached per tick)
  getGroupSize() {
    if (this._groupFrame === wow.frameTime) return this._cachedGroupSize;
    this._groupFrame = wow.frameTime;
    this._cachedGroupSize = (heal.friends.All?.length || 0) + 1;
    return this._cachedGroupSize;
  }

  isDungeon() { return this.getGroupSize() <= 5; }

  // Scale target count by group size — dungeon needs fewer hurt to trigger CDs
  // Raid (20-man): count unchanged. Dungeon (5-man): ~40% of setting (3→2, 2→1)
  scaledCount(count) {
    if (this.isDungeon()) return Math.max(1, Math.ceil(count * 0.4));
    return count;
  }

  getEssence() {
    if (this._essFrame === wow.frameTime) return this._cachedEssence;
    this._essFrame = wow.frameTime;
    this._cachedEssence = me.powerByType(PowerType.Essence);
    return this._cachedEssence;
  }

  getEBStacks() {
    if (this._ebFrame === wow.frameTime) return this._cachedEB;
    this._ebFrame = wow.frameTime;
    // EB has two separate aura IDs: 361519 (1 stack) and 369299 (2 stacks)
    const a1 = me.getAura(A.essenceBurst);
    const a2 = me.getAura(A.essenceBurst2);
    if (a2) { this._cachedEB = a2.stacks || 2; return this._cachedEB; }
    if (a1) { this._cachedEB = a1.stacks || 1; return this._cachedEB; }
    this._cachedEB = 0;
    return 0;
  }

  getEBRemaining() {
    const a2 = me.getAura(A.essenceBurst2);
    if (a2) return a2.remaining;
    const a1 = me.getAura(A.essenceBurst);
    return a1 ? a1.remaining : 0;
  }

  getManaPercent() {
    if (this._manaFrame === wow.frameTime) return this._cachedMana;
    this._manaFrame = wow.frameTime;
    const max = me.maxPowerByType ? me.maxPowerByType(PowerType.Mana) : 1;
    this._cachedMana = max > 0 ? (me.powerByType(PowerType.Mana) / max) * 100 : 100;
    return this._cachedMana;
  }

  getDpsTarget() {
    if (this._dpsTargetFrame === wow.frameTime) return this._cachedDpsTarget;
    this._dpsTargetFrame = wow.frameTime;
    // Never target enemies when out of combat — prevents pulling
    if (!me.inCombat()) {
      this._cachedDpsTarget = null;
      return null;
    }
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 25) {
      this._cachedDpsTarget = target;
      return target;
    }
    this._cachedDpsTarget = combat.bestTarget || (combat.targets && combat.targets[0]) || null;
    return this._cachedDpsTarget;
  }

  hasMerithrasProc() {
    return me.hasAura(A.merithrasBless) || me.hasAura(A.merithrasBless2);
  }

  getMerithrasRemaining() {
    const a1 = me.getAura(A.merithrasBless);
    const a2 = me.getAura(A.merithrasBless2);
    if (a1 && a2) return Math.max(a1.remaining, a2.remaining);
    if (a1) return a1.remaining;
    if (a2) return a2.remaining;
    return 0;
  }

  hasLifespark() {
    return me.hasAura(A.lifespark);
  }

  hasLeapingFlames() {
    return me.hasAura(A.leapingFlames);
  }

  hasTemporalBurst() {
    return me.hasAura(A.temporalBurst);
  }

  hasLifebind() {
    return me.hasAura(A.lifebind);
  }

  getEchoCount() {
    if (this._echoFrame === wow.frameTime) return this._cachedEchoCount;
    this._echoFrame = wow.frameTime;
    let count = 0;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 30) continue;
      if (unit.hasAuraByMe(A.echo)) count++;
    }
    this._cachedEchoCount = count;
    return count;
  }

  // ===== Target Helpers =====

  // Echo target — ally below HP threshold without Echo buff
  getEchoTarget(maxHP) {
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 30) continue;
      if (unit.effectiveHealthPercent > maxHP) continue;
      if (!unit.hasAuraByMe(A.echo)) return unit;
    }
    return null;
  }

  // Reversion target — tanks first (without Reversion), then injured allies without Reversion
  getReversionTarget(maxHP) {
    const tanks = heal.friends.Tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 30 &&
          !tank.hasAuraByMe(A.reversion)) return tank;
    }
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 30) continue;
      if (unit.effectiveHealthPercent > maxHP) continue;
      if (!unit.hasAuraByMe(A.reversion)) return unit;
    }
    return null;
  }

  // Find an ally with Dream Breath HoT (for Flameshaper Consume Flame)
  getAllyWithDBHoT(maxHP) {
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 30) continue;
      if (unit.effectiveHealthPercent > maxHP) continue;
      if (unit.hasAuraByMe(A.dreamBreathHoT)) return unit;
    }
    return null;
  }

  // Find lowest HP ally with Primacy buff expiring (for Chronowarden VE refresh)
  getPrimacyRefreshTarget(maxHP) {
    if (!this.isChronowarden()) return null;
    const primAura = me.getAura(A.primacy);
    if (!primAura || primAura.remaining > 5000) return null; // Not expiring
    // VE any injured target to refresh Primacy stacks
    return this.getHealTarget(maxHP);
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // No combat gate — heal anytime someone is injured (DPS gated by getDpsTarget OOC check)

      // Empowerment release — MUST be before waitForCastOrChannel
      this.handleEmpoweredSpell(),

      common.waitForCastOrChannel(),

      // Version + debug + cache refresh
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isChronowarden() ? 'Chronowarden' : 'Flameshaper';
          console.info(`[PresEvoker] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | Hero: ${hero}`);
        }
        this._refreshHealCache();
        if (Settings.FWPresDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const mana = Math.round(this.getManaPercent());
          const ess = this.getEssence();
          const eb = this.getEBStacks();
          const echoN = this.getEchoCount();
          const mb = this.hasMerithrasProc() ? 'Y' : 'N';
          const ls = this.hasLifespark() ? 'Y' : 'N';
          const prim = me.getAura(A.primacy);
          const primS = prim ? prim.stacks : 0;
          console.info(`[PresEvoker] Low:${Math.round(this._cachedLowestHP)}% <40:${this._cachedBelow40} <65:${this._cachedBelow65} Mana:${mana}% Ess:${ess} EB:${eb} Echo:${echoN} MB:${mb} LS:${ls} Prim:${primS}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Dispels (HIGH priority)
          this.dispels(),

          // Hover for movement casting (optional, default OFF)
          spell.cast(S.hover, () => me, () =>
            Settings.FWPresHover && me.isMoving() && !me.hasAura(A.hover) &&
            spell.getChargesFractional(S.hover) > 0.3
          ),

          // Movement healing (without Hover active)
          this.movementHealing(),

          // Self-defense
          this.defensives(),

          // Emergency healing (< 20%)
          this.emergencyHealing(),

          // Major CDs (OFF by default)
          this.majorCooldowns(),

          // Core healing rotation
          this.healingRotation(),

          // DPS when group is healthy
          this.dpsRotation(),
        )
      ),
    );
  }

  // ===== DISPELS =====
  // Same pattern as JMR RestoDruid — standard spell.dispel() calls
  dispels() {
    return new bt.Selector(
      spell.dispel(S.naturalize, true, DispelPriority.Low, false, WoWDispelType.Magic, WoWDispelType.Poison),
      spell.dispel(S.cauterizingFlame, true, DispelPriority.Low, false, WoWDispelType.Disease, WoWDispelType.Curse),
    );
  }

  // ===== MOVEMENT (without Hover) =====
  movementHealing() {
    return new bt.Decorator(
      () => me.isMoving() && !me.hasAura(A.hover),
      new bt.Selector(
        // Merithra's Blessing proc → instant empowered Reversion (bounces 4 allies)
        spell.cast(S.merithrasBlessing, () => this.getHealTarget(Settings.FWPresMaintHP), () =>
          this.hasMerithrasProc()
        ),

        // Reversion HoT (instant) — charge fractional to prevent waste
        spell.cast(S.reversion, () => this.getReversionTarget(Settings.FWPresMaintHP), () =>
          spell.getChargesFractional(S.reversion) > 0.4
        ),

        // Verdant Embrace (instant, Lifebind + Primacy)
        // Flameshaper: prefer target with DB HoT for Consume Flame detonation
        spell.cast(S.verdantEmbrace, () => {
          if (this.isFlameshaper()) {
            const dbT = this.getAllyWithDBHoT(Settings.FWPresUrgentHP);
            if (dbT) return dbT;
          }
          return this.getHealTarget(Settings.FWPresUrgentHP);
        }),

        // Echo (instant)
        spell.cast(S.echo, () => this.getEchoTarget(Settings.FWPresMaintHP), () =>
          this.getEssence() >= 2 || this.getEBStacks() >= 1
        ),

        // Emerald Blossom with EB proc (instant, free)
        spell.cast(S.emeraldBlossom, () => this.getHealTarget(Settings.FWPresUrgentHP), () =>
          this.getEBStacks() >= 1
        ),

        // Temporal Anomaly (instant) — absorb + Echo application
        spell.cast(S.temporalAnomaly, () => me, () =>
          this._cachedBelow85 >= 1
        ),

        // Time Dilation (instant) — emergency external
        spell.cast(S.timeDilation, () => this.getHealTarget(Settings.FWPresTimeDilHP), () =>
          Settings.FWPresTimeDil && this.getHealTarget(Settings.FWPresTimeDilHP) !== null
        ),

        // Lifespark proc → instant Living Flame
        spell.cast(S.livingFlame, () => this.getHealTarget(Settings.FWPresUrgentHP), () =>
          this.hasLifespark() && this.getHealTarget(Settings.FWPresUrgentHP) !== null
        ),

        // Azure Strike (instant DPS filler — only in combat)
        spell.cast(S.azureStrike, () => this.getDpsTarget(), () => me.inCombat()),
        new bt.Action(() => bt.Status.Success), // Block cast-time spells
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      // Obsidian Scales (self DR + Renewing Blaze HoT after)
      spell.cast(S.obsidianScales, () => me, () =>
        Settings.FWPresScales && me.inCombat() &&
        me.effectiveHealthPercent < Settings.FWPresScalesHP
      ),
      // Zephyr (AoE DR)
      spell.cast(S.zephyr, () => me, () => {
        if (!Settings.FWPresZephyr || !me.inCombat()) return false;
        return this.getFriendsBelow(Settings.FWPresZephyrHP) >= this.scaledCount(Settings.FWPresZephyrCount);
      }),
    );
  }

  // ===== EMERGENCY (Tier 1: < 20%) =====
  emergencyHealing() {
    return new bt.Decorator(
      () => this._cachedBelow20 >= 1,
      new bt.Selector(
        // Tip the Scales + max rank Dream Breath (instant max empower, massive burst)
        // Chronowarden: also triggers Temporal Burst (30% haste 30s)
        spell.cast(S.tipTheScales, () => me, () =>
          Settings.FWPresTipScales && this._cachedLowestHP < Settings.FWPresTipScalesHP
        ),
        this.castEmpowered(S.dreamBreath, 3, () => this.getHealTarget(Settings.FWPresEmergHP), () => {
          // After Tip the Scales, fire max rank DB
          return spell.getTimeSinceLastCast(S.tipTheScales) < 3000 &&
            this.getHealTarget(Settings.FWPresEmergHP) !== null;
        }),

        // Verdant Embrace (fly to ally, big instant heal + Lifebind)
        // Flameshaper: prefer DB HoT target for Consume Flame detonation
        spell.cast(S.verdantEmbrace, () => {
          if (this.isFlameshaper()) {
            const dbT = this.getAllyWithDBHoT(Settings.FWPresEmergHP);
            if (dbT) return dbT;
          }
          return this.getHealTarget(Settings.FWPresEmergHP);
        }),

        // Merithra's proc → empowered Reversion (bouncing heals)
        spell.cast(S.merithrasBlessing, () => this.getHealTarget(Settings.FWPresEmergHP), () =>
          this.hasMerithrasProc()
        ),

        // Dream Breath R2 — more upfront heal for emergencies
        this.castEmpowered(S.dreamBreath, 2, () => this.getHealTarget(Settings.FWPresEmergHP), () => {
          if (me.isMoving() && !me.hasAura(A.hover)) return false;
          return this.getHealTarget(Settings.FWPresEmergHP) !== null;
        }),

        // Emerald Blossom (instant with EB, AoE heal)
        spell.cast(S.emeraldBlossom, () => this.getHealTarget(Settings.FWPresEmergHP), () =>
          this.getEBStacks() >= 1
        ),

        // Lifespark proc → instant Living Flame (50% stronger)
        spell.cast(S.livingFlame, () => this.getHealTarget(Settings.FWPresEmergHP), () =>
          this.hasLifespark()
        ),

        // Living Flame heal (cast time, last resort)
        spell.cast(S.livingFlame, () => this.getHealTarget(Settings.FWPresEmergHP), () => {
          if (me.isMoving() && !me.hasAura(A.hover)) return false;
          return this.getHealTarget(Settings.FWPresEmergHP) !== null;
        }),
      )
    );
  }

  // ===== MAJOR CDS (OFF by default) =====
  majorCooldowns() {
    return new bt.Selector(
      // Dream Flight (2min, fly + heal path) — scales by group size
      spell.cast(S.dreamFlight, () => this.getHealTarget(Settings.FWPresDreamFlightHP), () =>
        Settings.FWPresDreamFlight &&
        this.getFriendsBelow(Settings.FWPresDreamFlightHP) >= this.scaledCount(Settings.FWPresDreamFlightCount)
      ),

      // Rewind (3min, heals 33% of 5s damage — doubled in dungeons)
      spell.cast(S.rewind, () => me, () =>
        Settings.FWPresRewind &&
        this.getFriendsBelow(Settings.FWPresRewindHP) >= this.scaledCount(Settings.FWPresRewindCount)
      ),

      // Time Dilation (external, 50% damage delayed 8s)
      spell.cast(S.timeDilation, () => this.getHealTarget(Settings.FWPresTimeDilHP), () =>
        Settings.FWPresTimeDil && this.getHealTarget(Settings.FWPresTimeDilHP) !== null
      ),

      // Stasis — scales by group size
      spell.cast(S.stasis, () => me, () =>
        Settings.FWPresStasis &&
        (this.getFriendsBelow(Settings.FWPresStasisHP) >= this.scaledCount(Settings.FWPresStasisCount) ||
         this.getFriendsBelow(65) >= this.scaledCount(3))
      ),
    );
  }

  // ===== HEALING ROTATION (Tiers 2-4) =====
  healingRotation() {
    return new bt.Selector(
      // ---- CRITICAL (< 40%) ----
      // Verdant Embrace — big spot heal + Lifebind (Chronowarden: Primacy haste)
      // Flameshaper: Consume Flame detonates DB HoT for 200% burst — prefer DB targets
      spell.cast(S.verdantEmbrace, () => {
        if (this.isFlameshaper()) {
          const dbTarget = this.getAllyWithDBHoT(Settings.FWPresCritHP);
          if (dbTarget) return dbTarget;
        }
        return this.getHealTarget(Settings.FWPresCritHP);
      }, () =>
        this.getHealTarget(Settings.FWPresCritHP) !== null &&
        spell.getChargesFractional(S.verdantEmbrace) > 0.4
      ),

      // Dream Breath R2 — more upfront heal on critical targets
      this.castEmpowered(S.dreamBreath, 2, () => this.getHealTarget(Settings.FWPresCritHP), () => {
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        return this._cachedBelow40 >= 2 && this.getHealTarget(Settings.FWPresCritHP) !== null;
      }),

      // Emerald Blossom with EB (free, AoE heal) — spend EB procs immediately
      spell.cast(S.emeraldBlossom, () => this.getHealTarget(Settings.FWPresCritHP), () =>
        this.getEBStacks() >= 1 && this.getHealTarget(Settings.FWPresCritHP) !== null
      ),

      // Merithra's Blessing proc → empowered Reversion (bouncing heals to 4 allies)
      spell.cast(S.merithrasBlessing, () => this.getHealTarget(Settings.FWPresMaintHP), () =>
        this.hasMerithrasProc()
      ),

      // ---- DUNGEON TANK PRIORITY (< urgent HP) ----
      // In dungeons, tank takes constant damage — dedicated spot healing before group
      // Verdant Embrace on tank (big spot heal + Lifebind mirrors subsequent heals)
      spell.cast(S.verdantEmbrace, () => this.getTankTarget(Settings.FWPresUrgentHP), () =>
        this.isDungeon() && this.getTankTarget(Settings.FWPresUrgentHP) !== null &&
        spell.getChargesFractional(S.verdantEmbrace) > 0.4
      ),

      // Dream Breath R1 on tank — fast empower, heals + Merithra's proc
      this.castEmpowered(S.dreamBreath, 1, () => this.getTankTarget(Settings.FWPresUrgentHP), () => {
        if (!this.isDungeon()) return false;
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        return this.getTankTarget(Settings.FWPresUrgentHP) !== null &&
          spell.getChargesFractional(S.dreamBreath) > 0.4;
      }),

      // Reversion on tank — always keep HoT ticking
      spell.cast(S.reversion, () => {
        if (!this.isDungeon()) return null;
        const tanks = heal.friends.Tanks;
        for (let i = 0; i < tanks.length; i++) {
          const tank = tanks[i];
          if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 30 &&
              !tank.hasAuraByMe(A.reversion)) return tank;
        }
        return null;
      }, () => this.isDungeon()),

      // Echo on tank — ensures next heal is doubled
      spell.cast(S.echo, () => {
        if (!this.isDungeon()) return null;
        const tanks = heal.friends.Tanks;
        for (let i = 0; i < tanks.length; i++) {
          const tank = tanks[i];
          if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 30 &&
              tank.effectiveHealthPercent < Settings.FWPresUrgentHP &&
              !tank.hasAuraByMe(A.echo)) return tank;
        }
        return null;
      }, () => this.isDungeon() && (this.getEssence() >= 2 || this.getEBStacks() >= 1)),

      // EB proc on tank — free Emerald Blossom
      spell.cast(S.emeraldBlossom, () => this.getTankTarget(Settings.FWPresUrgentHP), () =>
        this.isDungeon() && this.getEBStacks() >= 1 &&
        this.getTankTarget(Settings.FWPresUrgentHP) !== null
      ),

      // Living Flame on tank with Lifespark proc (instant, 50% stronger)
      spell.cast(S.livingFlame, () => this.getTankTarget(Settings.FWPresUrgentHP), () =>
        this.isDungeon() && this.hasLifespark() &&
        this.getTankTarget(Settings.FWPresUrgentHP) !== null
      ),

      // ---- TEMPORAL ANOMALY — on CD for Echo spreading + absorb ----
      spell.cast(S.temporalAnomaly, () => me, () =>
        this._cachedBelow85 >= 1 && me.inCombat()
      ),

      // ---- DREAM BREATH R1 — primary empower heal, Merithra's proc ----
      // Use charge fractional to avoid capping (Flameshaper has 3 charges via Legacy)
      this.castEmpowered(S.dreamBreath, 1, () => this.getHealTarget(Settings.FWPresUrgentHP), () => {
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        return this.getHealTarget(Settings.FWPresUrgentHP) !== null &&
          spell.getChargesFractional(S.dreamBreath) > 0.4;
      }),

      // ---- VERDANT EMBRACE — spot heal + Lifebind + Primacy + Consume Flame ----
      // Chronowarden: refresh Primacy before it expires (15s buff, 3% haste/stack)
      spell.cast(S.verdantEmbrace, () => {
        // Primacy refresh: target any injured ally to maintain haste stacks
        const primRefresh = this.getPrimacyRefreshTarget(Settings.FWPresMaintHP);
        if (primRefresh) return primRefresh;
        if (this.isFlameshaper()) {
          const dbTarget = this.getAllyWithDBHoT(Settings.FWPresUrgentHP);
          if (dbTarget) return dbTarget;
        }
        return this.getHealTarget(Settings.FWPresUrgentHP);
      }, () =>
        this.getHealTarget(Settings.FWPresUrgentHP) !== null &&
        spell.getChargesFractional(S.verdantEmbrace) > 0.4
      ),

      // ---- ECHO spreading — place on targets without Echo for next heal ----
      spell.cast(S.echo, () => this.getEchoTarget(Settings.FWPresMaintHP), () => {
        if (!this.getEchoTarget(Settings.FWPresMaintHP)) return false;
        return this.getEssence() >= 2 || this.getEBStacks() >= 1;
      }),

      // ---- REVERSION HoT maintenance — tanks + injured ----
      // Charge fractional > 1.4 to prevent waste
      spell.cast(S.reversion, () => this.getReversionTarget(Settings.FWPresMaintHP), () =>
        spell.getChargesFractional(S.reversion) > 1.4
      ),

      // ---- EMERALD BLOSSOM with Essence Burst (free, AoE + Twin Echoes synergy) ----
      // Flameshaper: EB consumes DB HoT → 200% consumed as bonus heal
      spell.cast(S.emeraldBlossom, () => {
        if (this.isFlameshaper()) {
          const dbTarget = this.getAllyWithDBHoT(Settings.FWPresMaintHP);
          if (dbTarget) return dbTarget;
        }
        return this.getHealTarget(Settings.FWPresMaintHP);
      }, () =>
        this.getEBStacks() >= 1 && this.getHealTarget(Settings.FWPresMaintHP) !== null
      ),

      // ---- EMERALD BLOSSOM (non-EB, when Essence allows) — mana gated ----
      spell.cast(S.emeraldBlossom, () => {
        if (this.isFlameshaper()) {
          const dbTarget = this.getAllyWithDBHoT(Settings.FWPresUrgentHP);
          if (dbTarget) return dbTarget;
        }
        return this.getHealTarget(Settings.FWPresUrgentHP);
      }, () =>
        this.getEssence() >= 3 && this.getManaPercent() > 40 &&
        this.getHealTarget(Settings.FWPresUrgentHP) !== null
      ),

      // ---- REVERSION — spend second charge on lower-prio targets ----
      spell.cast(S.reversion, () => this.getReversionTarget(Settings.FWPresMaintHP), () =>
        this.getReversionTarget(Settings.FWPresMaintHP) !== null &&
        spell.getChargesFractional(S.reversion) > 0.8
      ),

      // ---- LIFESPARK proc → instant Living Flame (50% stronger) ----
      spell.cast(S.livingFlame, () => this.getHealTarget(Settings.FWPresMaintHP), () =>
        this.hasLifespark() && this.getHealTarget(Settings.FWPresMaintHP) !== null
      ),

      // ---- LIVING FLAME heal (cast time, efficient, EB proc source) ----
      spell.cast(S.livingFlame, () => this.getHealTarget(Settings.FWPresMaintHP), () => {
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        return this.getHealTarget(Settings.FWPresMaintHP) !== null && this.getManaPercent() > 30;
      }),
    );
  }

  // ===== FIRE BREATH DPS (dynamic empower level) =====
  fireBreathDps() {
    return new bt.Sequence(
      spell.cast(S.fireBreath, () => this.getDpsTarget(), () => {
        if (!Settings.FWPresFireBreathDps) return false;
        if (me.isMoving() && !me.hasAura(A.hover)) return false;
        return this.getDpsTarget() !== null;
      }),
      new bt.Action(() => {
        // R3 during Temporal Burst for max Leaping Flames targets; R1 otherwise for speed
        this._desiredEmpowerLevel = this.hasTemporalBurst() ? 3 : 1;
        return bt.Status.Success;
      })
    );
  }

  // ===== DPS ROTATION (Tier 5: everyone > 85%) =====
  dpsRotation() {
    return new bt.Decorator(
      () => this._cachedLowestHP >= Settings.FWPresDpsHP && me.inCombat(),
      new bt.Selector(
        // Reversion maintenance on tanks even during DPS (Primacy haste + passive healing)
        spell.cast(S.reversion, () => this.getReversionTarget(95), () =>
          this.getReversionTarget(95) !== null &&
          spell.getChargesFractional(S.reversion) > 1.4
        ),

        // Merithra's Blessing proc — don't waste, fire on any target
        spell.cast(S.merithrasBlessing, () => this.getHealTarget(99), () =>
          this.hasMerithrasProc() && this.getHealTarget(99) !== null
        ),

        // Chronowarden: Primacy refresh — VE any target to maintain haste stacks
        spell.cast(S.verdantEmbrace, () => this.getPrimacyRefreshTarget(99), () =>
          this.getPrimacyRefreshTarget(99) !== null &&
          spell.getChargesFractional(S.verdantEmbrace) > 1.0
        ),

        // Fire Breath on CD — damage + Life-Giver's Flame heals 5 allies + Leaping Flames proc
        this.fireBreathDps(),

        // Lifespark proc → instant Living Flame on enemy (Chronowarden, don't waste)
        spell.cast(S.livingFlame, () => this.getDpsTarget(), () =>
          this.isChronowarden() && this.hasLifespark() && this.getDpsTarget() !== null
        ),

        // Leaping Flames proc → Living Flame on enemy (hits multiple targets per FB empower level)
        spell.cast(S.livingFlame, () => this.getDpsTarget(), () => {
          if (me.isMoving() && !me.hasAura(A.hover)) return false;
          return this.hasLeapingFlames() && this.getDpsTarget() !== null;
        }),

        // EB proc spending — free Emerald Blossom for passive AoE healing during DPS
        spell.cast(S.emeraldBlossom, () => this.getHealTarget(99), () =>
          this.getEBStacks() >= 1 && this.getHealTarget(99) !== null
        ),

        // Disintegrate (channel 3s, mana recovery via Energy Loop, damage)
        spell.cast(S.disintegrate, () => this.getDpsTarget(), () => {
          if (!Settings.FWPresDisintegrate) return false;
          if (me.isMoving() && !me.hasAura(A.hover)) return false;
          return this.getDpsTarget() !== null && this.getManaPercent() < 90;
        }),

        // Living Flame on ENEMY (generates EB procs 20% + Chrono Flame repeats 15%)
        spell.cast(S.livingFlame, () => this.getDpsTarget(), () => {
          if (me.isMoving() && !me.hasAura(A.hover)) return false;
          return this.getDpsTarget() !== null;
        }),

        // Azure Strike (instant filler, 2 targets)
        spell.cast(S.azureStrike, () => this.getDpsTarget()),
      )
    );
  }
}
