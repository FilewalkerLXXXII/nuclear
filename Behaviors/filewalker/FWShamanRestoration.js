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
import { DispelPriority } from '@/Data/Dispels';
import { WoWDispelType } from '@/Enums/Auras';

/**
 * Restoration Shaman Behavior - Midnight 12.0.1
 * Sources: Method Guide (all pages) + Wowhead (spell data + rotation)
 *
 * Auto-detects: Totemic (Surging Totem) vs Farseer (Ancestral Swiftness)
 * Auto-detects: Ascendance vs Healing Tide Totem (choice node)
 *
 * Tiered healing: Emergency (<20%) → Critical (<40%) → Urgent (<65%) → Maintenance (<85%) → DPS (>85%)
 * Long CDs (Ascendance, HTT, Spirit Link) OFF by default for raid assignment
 *
 * Key mechanics implemented:
 *  - Tidal Waves: Riptide/CH grants 2 stacks → empowered HW (20% cast time reduction)
 *  - Flow of the Tides: CH consumes Riptide HoT for 30% boost + extra bounce
 *  - Riptide pandemic: refresh at <30% duration remaining (5.4s of 18s)
 *  - Earth Shield: maintain on tank (9 charges), refresh when < 3
 *  - Surging Totem (Totemic): replaces Healing Rain, 25s duration, +20% effectiveness
 *  - Stormstream Totem: NS/AS guaranteed proc, 6% per Riptide cast
 *  - NS/AS cooldown starts AFTER consuming buff — must cast heal immediately
 *  - Lively Totems (Totemic): free Chain Heal when summoning HTT/HST/SLT
 *  - Whirling Elements (Totemic): Water/Air/Earth motes from Surging Totem
 *  - Unleash Life: +25% next RT/HW/CH, -30% cast time
 *  - Ascendance: HW always crits, CH +3 bounces, applies Riptide on HW/CH, -25% mana
 *  - Downpour: burst AoE at Healing Rain location, granted by HR/Surging Totem casts (16s window)
 *  - Deeply Rooted Elements: 7% chance per Riptide to trigger mini Ascendance (6s)
 *  - Undercurrent: +0.5% healing per active Riptide — spread aggressively
 *  - Primal Tide Core: every 4th Riptide auto-applies to nearby target
 *  - Mana: Resurgence refunds on direct heal crits, Water Shield mp5
 *  - Wind Shear: only healer with an interrupt in Midnight
 *  - Cloudburst Totem: REMOVED in Midnight (spell #157153 deleted)
 *  - Healing Surge: REMOVED from Resto in Midnight (use Healing Wave)
 *  - Cast cancellation: cancel DPS casts when healing needed
 *
 * Totemic: Surging Totem (instant HR), Stormstream procs, Whirling Elements, Lively Totems
 *   NS 1.5min CD, CD starts after buff consumed — cast immediately
 * Farseer: Ancestral Swiftness (instant heal + Ancestor, 1min CD), Call of Ancestors
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'Method + Wowhead Restoration Shaman',
};

// Cast spell IDs
const S = {
  // Core heals
  healingWave:          77472,
  chainHeal:            1064,
  riptide:              61295,
  healingSurge:         8004,     // Shared shaman ID — REMOVED from Resto in Midnight, kept as fallback
  healingRain:          73920,
  unleashLife:          73685,
  downpour:             207778,  // Burst AoE at HR location (granted by HR/Surging Totem casts)
  // Totems
  healingStreamTotem:   5394,
  healingTideTotem:     108280,
  spiritLinkTotem:      98008,
  surgingTotem:         444995,   // Totemic hero — replaces Healing Rain, 25s duration
  stormstreamTotem:     1267068,  // Empowered HST from NS/AS procs
  poisonCleansingTotem: 383013,
  // Cooldowns
  ascendance:           114052,   // Resto-specific Ascendance
  naturesSwiftness:     378081,   // Totemic: instant next heal + Stormstream proc
  ancestralSwiftness:   443454,   // Farseer: instant next heal + Ancestor
  spiritwalkerGrace:    79206,    // Cast while moving
  // Buffs
  earthShield:          974,
  waterShield:          52127,
  earthlivingWeapon:    382024,   // Cast ID (verified from Wowhead)
  skyfury:              462854,
  // Defensives
  astralShift:          108271,
  earthElemental:       198103,
  // Dispel
  purifySpirit:         77130,    // Magic + Curse
  // DPS
  flameShock:           188389,
  lavaBurst:            51505,
  lightningBolt:        188196,
  chainLightning:       188443,
  // Interrupt
  windShear:            57994,
  // Racials
  berserking:           26297,
};

// Aura IDs (may differ from cast IDs)
const A = {
  riptide:              61295,
  tidalWaves:           51564,    // From Riptide/CH: empowered HW (2 stacks)
  earthShield:          974,
  earthShieldSelf:      383648,   // Self-buff variant (Elemental Orbit)
  waterShield:          52127,
  earthlivingWeapon:    382022,   // Aura ID differs from cast (382024)
  flameShock:           188389,   // Debuff on target
  lavaSurge:            77762,    // Instant LvB proc
  ascendance:           114052,
  naturesSwiftness:     378081,
  ancestralSwiftness:   443454,
  stormstreamProc:      1267089,  // Proc from NS/AS → summon Stormstream
  skyfury:              462854,
  spiritwalkerGrace:    79206,
  astralShift:          108271,
  unleashLife:          73685,    // +25% next RT/HW/CH, -30% cast time
  downpour:             462486,   // Downpour ready buff (from HR/Surging Totem cast)
  // Hero detection
  surgingTotemKnown:    444995,   // Totemic exclusive
  farseerAncestral:     443454,   // Farseer exclusive
  // Totemic passives
  livelyTotems:         445034,   // Free CH when summoning totems
  whirlingElements:     445024,   // Elemental motes from Surging Totem
  // Whirling Element mote buffs (consumed by specific spells)
  whirlingWater:        462187,   // HW also heals ally in HR at 50%
  whirlingAir:          462186,   // 40% cast time reduction on next heal
  whirlingEarth:        462188,   // CH applies Earthliving at 150% to all targets
  // Farseer
  callOfTheAncestors:   443450,   // Summons ancestors
  // Deeply Rooted Elements
  deeplyRootedAsc:      378270,   // Mini Ascendance proc from Riptide
};

export class RestorationShamanBehavior extends Behavior {
  name = 'FW Restoration Shaman';
  context = BehaviorContext.Any;
  specialization = Specialization.Shaman.Restoration;
  version = wow.GameVersion.Retail;

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
  _dpsTargetFrame = 0;
  _cachedDpsTarget = null;
  _manaFrame = 0;
  _cachedMana = 100;
  _tidalFrame = 0;
  _cachedTidalStacks = 0;
  _cachedTidalRemaining = 0;
  _riptideTargetFrame = 0;
  _cachedRiptideTargets = {};  // keyed by maxHP
  _chainHealTargetFrame = 0;
  _cachedChainHealTargets = {}; // keyed by maxHP
  _sltTargetFrame = 0;
  _cachedSLTTarget = null;
  _esTargetFrame = 0;
  _cachedESTarget = null;
  _skyfuryFrame = 0;
  _cachedSkyfuryTarget = null;
  _whirlingFrame = 0;
  _cachedWhirlingWater = false;
  _cachedWhirlingAir = false;
  _cachedWhirlingEarth = false;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'Healing Thresholds',
      options: [
        { type: 'slider', uid: 'FWRsEmergencyHP', text: 'Emergency HP %', default: 20, min: 5, max: 35 },
        { type: 'slider', uid: 'FWRsCriticalHP', text: 'Critical HP %', default: 40, min: 20, max: 55 },
        { type: 'slider', uid: 'FWRsUrgentHP', text: 'Urgent HP %', default: 65, min: 40, max: 80 },
        { type: 'slider', uid: 'FWRsMaintHP', text: 'Maintenance HP %', default: 85, min: 70, max: 95 },
        { type: 'slider', uid: 'FWRsDpsThreshold', text: 'DPS when all above %', default: 85, min: 70, max: 100 },
      ],
    },
    {
      header: 'Major Cooldowns (OFF = manual/raid assignment)',
      options: [
        { type: 'checkbox', uid: 'FWRsAscendance', text: 'Auto Ascendance', default: false },
        { type: 'slider', uid: 'FWRsAscendanceHP', text: 'Ascendance avg HP %', default: 40, min: 15, max: 60 },
        { type: 'slider', uid: 'FWRsAscendanceCount', text: 'Ascendance min targets', default: 2, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWRsHTT', text: 'Auto Healing Tide Totem', default: false },
        { type: 'slider', uid: 'FWRsHTTHP', text: 'HTT avg HP %', default: 45, min: 15, max: 65 },
        { type: 'slider', uid: 'FWRsHTTCount', text: 'HTT min targets', default: 3, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWRsSLT', text: 'Auto Spirit Link Totem', default: false },
        { type: 'slider', uid: 'FWRsSLTHP', text: 'Spirit Link HP %', default: 30, min: 10, max: 50 },
        { type: 'slider', uid: 'FWRsSLTCount', text: 'Spirit Link min targets', default: 2, min: 1, max: 5 },
      ],
    },
    {
      header: 'Self-Defense',
      options: [
        { type: 'checkbox', uid: 'FWRsAstralShift', text: 'Use Astral Shift', default: true },
        { type: 'slider', uid: 'FWRsAstralShiftHP', text: 'Astral Shift HP %', default: 40, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWRsEarthElemental', text: 'Use Earth Elemental', default: true },
        { type: 'slider', uid: 'FWRsEarthEleHP', text: 'Earth Elemental tank HP %', default: 20, min: 5, max: 40 },
      ],
    },
    {
      header: 'General',
      options: [
        { type: 'slider', uid: 'FWRsChainHealMin', text: 'Chain Heal min injured', default: 3, min: 2, max: 5 },
        { type: 'checkbox', uid: 'FWRsDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // ===== Hero Talent Detection =====
  isTotemic() {
    return spell.isSpellKnown(S.surgingTotem) || me.hasAura(A.livelyTotems);
  }

  isFarseer() {
    return !this.isTotemic();
  }

  // Ascendance vs HTT (choice node — never both)
  hasAscendance() {
    return spell.isSpellKnown(S.ascendance);
  }

  hasHTT() {
    return spell.isSpellKnown(S.healingTideTotem);
  }

  // ===== Per-Tick Caching =====
  _refreshHealCache() {
    if (this._healFrame === wow.frameTime) return;
    this._healFrame = wow.frameTime;

    let lowest = null;
    let lowestHP = 100;
    let tankLowest = null;
    let tankLowestHP = 100;
    let below20 = 0;
    let below40 = 0;
    let below65 = 0;
    let below85 = 0;
    let selfCounted = false;

    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
      if (unit.guid && unit.guid.equals && unit.guid.equals(me.guid)) selfCounted = true;
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
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
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

    // Invalidate dependent caches
    this._riptideTargetFrame = 0;
    this._cachedRiptideTargets = {};
    this._chainHealTargetFrame = 0;
    this._cachedChainHealTargets = {};
    this._sltTargetFrame = 0;
    this._esTargetFrame = 0;
  }

  // Tidal Waves cache (stacks + remaining)
  _refreshTidalCache() {
    if (this._tidalFrame === wow.frameTime) return;
    this._tidalFrame = wow.frameTime;
    const aura = me.getAura(A.tidalWaves);
    this._cachedTidalStacks = aura ? aura.stacks : 0;
    this._cachedTidalRemaining = aura ? aura.remaining : 0;
  }

  getTidalStacks() {
    this._refreshTidalCache();
    return this._cachedTidalStacks;
  }

  getTidalRemaining() {
    this._refreshTidalCache();
    return this._cachedTidalRemaining;
  }

  hasTidalWaves() {
    return this.getTidalStacks() > 0;
  }

  // Whirling Elements cache (Totemic)
  _refreshWhirlingCache() {
    if (this._whirlingFrame === wow.frameTime) return;
    this._whirlingFrame = wow.frameTime;
    this._cachedWhirlingWater = me.hasAura(A.whirlingWater);
    this._cachedWhirlingAir = me.hasAura(A.whirlingAir);
    this._cachedWhirlingEarth = me.hasAura(A.whirlingEarth);
  }

  hasWhirlingWater() { this._refreshWhirlingCache(); return this._cachedWhirlingWater; }
  hasWhirlingAir() { this._refreshWhirlingCache(); return this._cachedWhirlingAir; }
  hasWhirlingEarth() { this._refreshWhirlingCache(); return this._cachedWhirlingEarth; }

  // Mana cache
  getManaPercent() {
    if (this._manaFrame === wow.frameTime) return this._cachedMana;
    this._manaFrame = wow.frameTime;
    const max = me.maxPowerByType ? me.maxPowerByType(PowerType.Mana) : 1;
    this._cachedMana = max > 0 ? (me.powerByType(PowerType.Mana) / max) * 100 : 100;
    return this._cachedMana;
  }

  // ===== Target Helpers =====
  getHealTarget(maxHP) {
    this._refreshHealCache();
    if (this._cachedLowestHP <= maxHP) return this._cachedLowest;
    return null;
  }

  getTankTarget(maxHP) {
    this._refreshHealCache();
    if (this._cachedTankLowestHP <= maxHP) return this._cachedTankLowest;
    return null;
  }

  getFriendsBelow(hp) {
    this._refreshHealCache();
    if (hp <= 20) return this._cachedBelow20;
    if (hp <= 40) return this._cachedBelow40;
    if (hp <= 65) return this._cachedBelow65;
    if (hp <= 85) return this._cachedBelow85;
    // Fallback for non-cached thresholds
    let count = 0;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
          unit.effectiveHealthPercent <= hp) {
        count++;
      }
    }
    return count;
  }

  // Riptide target: prioritize tanks without RT, then lowest HP without RT
  // Pandemic: refresh if remaining < 5.4s (30% of 18s duration)
  // Cached per tick per maxHP to avoid double-call in spell.cast target+condition
  getRiptideTarget(maxHP) {
    this._refreshHealCache();
    const key = maxHP;
    if (this._riptideTargetFrame === wow.frameTime && key in this._cachedRiptideTargets) {
      return this._cachedRiptideTargets[key];
    }
    this._riptideTargetFrame = wow.frameTime;

    let result = null;
    const tanks = heal.friends.Tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40 &&
          tank.effectiveHealthPercent <= Math.min(maxHP + 10, 95)) {
        const rtAura = tank.getAuraByMe(A.riptide);
        if (!rtAura || rtAura.remaining < 5400) { result = tank; break; }
      }
    }
    if (!result) {
      const friends = heal.friends.All;
      for (let i = 0; i < friends.length; i++) {
        const unit = friends[i];
        if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
            unit.effectiveHealthPercent <= maxHP) {
          const rtAura = unit.getAuraByMe(A.riptide);
          if (!rtAura || rtAura.remaining < 5400) { result = unit; break; }
        }
      }
    }
    this._cachedRiptideTargets[key] = result;
    return result;
  }

  // Chain Heal target — cached per tick per maxHP
  // Finds best cluster, preferring Riptide targets for Flow of the Tides (+30%)
  getBestChainHealTarget(maxHP) {
    this._refreshHealCache();
    const key = maxHP;
    if (this._chainHealTargetFrame === wow.frameTime && key in this._cachedChainHealTargets) {
      return this._cachedChainHealTargets[key];
    }
    this._chainHealTargetFrame = wow.frameTime;

    let best = null;
    let bestScore = 0;
    const friends = heal.friends.All;

    // Pre-filter eligible friends to avoid repeated checks in O(n^2)
    const eligible = [];
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
          unit.effectiveHealthPercent <= maxHP) {
        eligible.push(unit);
      }
    }

    for (let i = 0; i < eligible.length; i++) {
      const unit = eligible[i];
      const hasRT = unit.getAuraByMe(A.riptide) != null;
      let count = 0;
      for (let j = 0; j < eligible.length; j++) {
        if (unit.distanceTo(eligible[j]) <= 30) count++;
      }
      // Heavily prefer Riptide targets for Flow of the Tides 30% boost
      const score = hasRT ? count + 100 : count;
      if (score > bestScore) { bestScore = score; best = unit; }
    }

    this._cachedChainHealTargets[key] = best;
    return best;
  }

  // Spirit Link Totem target — cached per tick
  getBestSpiritLinkTarget() {
    if (this._sltTargetFrame === wow.frameTime) return this._cachedSLTTarget;
    this._sltTargetFrame = wow.frameTime;

    let best = null;
    let bestCount = 0;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
      let count = 0;
      for (let j = 0; j < friends.length; j++) {
        const ally = friends[j];
        if (ally && !ally.deadOrGhost && unit.distanceTo(ally) <= 10) count++;
      }
      if (count > bestCount) { bestCount = count; best = unit; }
    }
    this._cachedSLTTarget = best;
    return best;
  }

  // Earth Shield tank target — cached per tick
  getEarthShieldTankTarget() {
    if (this._esTargetFrame === wow.frameTime) return this._cachedESTarget;
    this._esTargetFrame = wow.frameTime;

    if (spell.getTimeSinceLastCast(S.earthShield) < 3000) {
      this._cachedESTarget = null;
      return null;
    }
    const tanks = heal.friends.Tanks;
    let result = null;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40) {
        const esAura = tank.getAura(A.earthShield);
        // Reapply if missing or charges low (< 3 of 9 remaining)
        if (!esAura || (esAura.stacks !== undefined && esAura.stacks < 3)) {
          result = tank;
          break;
        }
      }
    }
    this._cachedESTarget = result;
    return result;
  }

  getDpsTarget() {
    if (this._dpsTargetFrame === wow.frameTime) return this._cachedDpsTarget;
    this._dpsTargetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 40) {
      this._cachedDpsTarget = target;
      return target;
    }
    this._cachedDpsTarget = (combat.bestTarget) || (combat.targets && combat.targets[0]) || null;
    return this._cachedDpsTarget;
  }

  getFlameShockTarget() {
    const dps = this.getDpsTarget();
    if (!dps) return null;
    if (spell.getTimeSinceLastCast(S.flameShock) < 3000) return null;
    const debuff = dps.getAuraByMe(A.flameShock);
    if (debuff && debuff.remaining > 5400) return null;
    if (dps.timeToDeath && dps.timeToDeath() < 6000) return null;
    return dps;
  }

  getLavaBurstTarget() {
    const dps = this.getDpsTarget();
    if (!dps) return null;
    return dps.hasAuraByMe(A.flameShock) ? dps : null;
  }

  // Skyfury target — spread to party members, cached per tick
  getSkyfuryTarget() {
    if (this._skyfuryFrame === wow.frameTime) return this._cachedSkyfuryTarget;
    this._skyfuryFrame = wow.frameTime;

    if (spell.getTimeSinceLastCast(S.skyfury) < 60000) {
      this._cachedSkyfuryTarget = null;
      return null;
    }
    if (!this._hasBuff(me, A.skyfury)) {
      this._cachedSkyfuryTarget = me;
      return me;
    }
    // Spread to party/raid members
    const friends = heal.friends.All;
    let target = null;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
          !this._hasBuff(unit, A.skyfury)) {
        target = unit;
        break;
      }
    }
    this._cachedSkyfuryTarget = target;
    return target;
  }

  // ===== Mana Management =====
  hasManaFor(spellType) {
    const mana = this.getManaPercent();
    if (mana < 10) return false;
    if (mana < 20 && spellType === 'chainHeal') return false;
    if (mana < 25 && spellType === 'healingRain') return false;
    return true;
  }

  // Returns true when mana is low enough to prefer HW over CH
  isLowMana() {
    return this.getManaPercent() < 40;
  }

  // ===== Burst Detection =====
  inAscendance() {
    return me.hasAura(A.ascendance) || me.hasAura(A.deeplyRootedAsc);
  }

  // Unleash Life buff active — next RT/HW/CH gets +25% and -30% cast time
  hasUnleashLife() {
    return me.hasAura(A.unleashLife);
  }

  // ===== OOC Buff Helper =====
  _hasBuff(unit, id) {
    if (!unit) return false;
    if (unit.hasVisibleAura(id) || unit.hasAura(id)) return true;
    if (unit.auras && unit.auras.find(a => a.spellId === id)) return true;
    // Name-based fallback for locale safety (Skyfury = "Himmelszorn" in German)
    if (id === A.skyfury) {
      return unit.auras && unit.auras.find(a =>
        a.name.includes("Skyfury") || a.name.includes("Himmelszorn")
      ) !== undefined;
    }
    return false;
  }

  // ===== Downpour available =====
  hasDownpour() {
    return me.hasAura(A.downpour) || spell.getCharges(S.downpour) > 0;
  }

  // ===== Nature's Swiftness / Ancestral Swiftness active =====
  hasInstantCast() {
    return me.hasAura(A.naturesSwiftness) || me.hasAura(A.ancestralSwiftness);
  }

  // ===== Cast Cancellation =====
  // Cancel DPS casts when healing is urgently needed (from jmr reference pattern)
  shouldStopCasting() {
    if (!me.isCastingOrChanneling) return false;
    const currentCast = me.currentCastOrChannel;
    if (!currentCast || currentCast.timeleft < 500) return false;

    const castId = currentCast.spellId;
    const isDamageCast = castId === S.lightningBolt || castId === S.chainLightning ||
                         castId === S.lavaBurst;

    if (isDamageCast && this._cachedLowestHP < Settings.FWRsCriticalHP) return true;
    return false;
  }

  // ===== Surging Totem uptime check =====
  // Returns true if Surging Totem needs refresh (> 21s since last cast or never cast)
  needsSurgingTotem() {
    if (!this.isTotemic()) return false;
    const timeSince = spell.getTimeSinceLastCast(S.surgingTotem);
    // getTimeSinceLastCast returns large value if never cast, or actual time
    return timeSince > 21000;
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      // Pre-combat
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC buffs (always maintain)
      this.oocBuffs(),

      // Combat gate — proceed if self or any party/raid member in combat
      new bt.Action(() => {
        if (me.inCombat()) return bt.Status.Failure;
        const tanks = heal.friends.Tanks;
        for (let i = 0; i < tanks.length; i++) {
          if (tanks[i] && tanks[i].inCombat()) return bt.Status.Failure;
        }
        const friends = heal.friends.All;
        for (let i = 0; i < friends.length; i++) {
          if (friends[i] && friends[i].inCombat()) return bt.Status.Failure;
        }
        return bt.Status.Success; // nobody in combat — block
      }),

      // Cast cancellation — cancel DPS casts when critical healing needed
      new bt.Decorator(
        () => this.shouldStopCasting(),
        new bt.Action(() => {
          me.stopCasting();
          return bt.Status.Success;
        })
      ),

      // Cast/channel check
      common.waitForCastOrChannel(),

      // Version log (once)
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isTotemic() ? 'Totemic' : 'Farseer';
          const majorCD = this.hasAscendance() ? 'Ascendance' : 'Healing Tide Totem';
          console.info(`[RestoSham] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | Hero: ${hero} | Major CD: ${majorCD} | ${SCRIPT_VERSION.guide}`);
        }
        return bt.Status.Failure;
      }),

      // Refresh heal cache + debug
      new bt.Action(() => {
        this._refreshHealCache();
        if (Settings.FWRsDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const mana = Math.round(this.getManaPercent());
          const lowestHP = Math.round(this._cachedLowestHP);
          const tankHP = Math.round(this._cachedTankLowestHP);
          const tw = this.getTidalStacks();
          const dpsMode = this._cachedLowestHP >= Settings.FWRsDpsThreshold;
          const asc = this.inAscendance();
          const ul = this.hasUnleashLife();
          const wAir = this.hasWhirlingAir();
          const wEarth = this.hasWhirlingEarth();
          console.info(`[RestoSham] Lowest:${lowestHP}% Tank:${tankHP}% <40:${this._cachedBelow40} <65:${this._cachedBelow65} Mana:${mana}% TW:${tw} Asc:${asc} UL:${ul} WAir:${wAir} WEarth:${wEarth} DPS:${dpsMode}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // 1. Interrupt (HIGHEST — only healer with a kick)
          spell.interrupt(S.windShear),

          // 2. Dispels (HIGH priority — above healing)
          this.dispels(),

          // 3. Movement handling (instant heals while moving)
          this.movementHealing(),

          // 4. Emergency healing (Tier 1: someone < 20%)
          this.emergencyHealing(),

          // 5. Defensives (self + externals)
          this.defensives(),

          // 6. Major CDs (group-wide, OFF by default)
          this.majorCooldowns(),

          // 7. Earth Shield maintenance on tank
          this.earthShieldMaintenance(),

          // 8. Ascendance window — enhanced healing when active
          this.ascendanceHealing(),

          // 9. Healing rotation (Tiers 2-4)
          this.healingRotation(),

          // 10. DPS rotation (Tier 5: nobody needs healing)
          this.dpsRotation(),
        )
      ),
    );
  }

  // ===== OOC BUFFS =====
  oocBuffs() {
    return new bt.Selector(
      // Water Shield (mana regen)
      spell.cast(S.waterShield, () => me, () => {
        if (spell.getTimeSinceLastCast(S.waterShield) < 5000) return false;
        return !this._hasBuff(me, A.waterShield);
      }),
      // Earthliving Weapon
      spell.cast(S.earthlivingWeapon, () => me, () => {
        if (spell.getTimeSinceLastCast(S.earthlivingWeapon) < 5000) return false;
        return !this._hasBuff(me, A.earthlivingWeapon);
      }),
      // Earth Shield on self (Elemental Orbit: self + ally simultaneously)
      spell.cast(S.earthShield, () => me, () => {
        if (spell.getTimeSinceLastCast(S.earthShield) < 3000) return false;
        return !this._hasBuff(me, A.earthShieldSelf) && !this._hasBuff(me, A.earthShield);
      }),
      // Skyfury (group buff — spread to party)
      spell.cast(S.skyfury, () => this.getSkyfuryTarget(), () => {
        return this.getSkyfuryTarget() !== null;
      }),
    );
  }

  // ===== DISPELS =====
  dispels() {
    return new bt.Selector(
      // High priority dispels
      spell.dispel(S.purifySpirit, true, DispelPriority.High, false, WoWDispelType.Magic),
      spell.dispel(S.purifySpirit, true, DispelPriority.High, false, WoWDispelType.Curse),
      spell.dispel(S.poisonCleansingTotem, true, DispelPriority.High, false, WoWDispelType.Poison),
      // Medium priority
      spell.dispel(S.purifySpirit, true, DispelPriority.Medium, false, WoWDispelType.Magic),
      spell.dispel(S.purifySpirit, true, DispelPriority.Medium, false, WoWDispelType.Curse),
      spell.dispel(S.poisonCleansingTotem, true, DispelPriority.Medium, false, WoWDispelType.Poison),
    );
  }

  // ===== MOVEMENT HEALING =====
  movementHealing() {
    return new bt.Decorator(
      () => me.isMoving() && !me.hasAura(A.spiritwalkerGrace),
      new bt.Selector(
        // Spiritwalker's Grace — enable full casting while moving (use for urgent+ damage)
        spell.cast(S.spiritwalkerGrace, () => me, () => {
          return this._cachedLowestHP < Settings.FWRsUrgentHP;
        }),

        // ----- Instant heals while moving (no SWG) -----

        // Emergency: NS/AS → instant Healing Wave
        spell.cast(S.naturesSwiftness, () => me, () => {
          return this.isTotemic() && this._cachedLowestHP < Settings.FWRsCriticalHP;
        }),
        spell.cast(S.ancestralSwiftness, () => me, () => {
          return this.isFarseer() && this._cachedLowestHP < Settings.FWRsCriticalHP &&
            spell.getTimeSinceLastCast(S.ancestralSwiftness) > 2000;
        }),
        // Consume NS/AS with Healing Wave on lowest
        spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsCriticalHP), () => {
          return this.hasInstantCast();
        }),

        // Riptide (instant HoT + heal) — pandemic refresh
        spell.cast(S.riptide, () => this.getRiptideTarget(Settings.FWRsMaintHP), () => {
          return this.getRiptideTarget(Settings.FWRsMaintHP) !== null;
        }),

        // Unleash Life (instant, buffs next heal +25%)
        spell.cast(S.unleashLife, () => me, () => {
          return this._cachedLowestHP < Settings.FWRsUrgentHP && !this.hasUnleashLife();
        }),

        // Surging Totem (Totemic, instant) — maintain uptime
        spell.cast(S.surgingTotem, () => me, () => {
          return this.needsSurgingTotem() && this._cachedBelow85 >= 1;
        }),

        // Downpour (burst AoE at HR location — instant)
        spell.cast(S.downpour, () => me, () => {
          return this.hasDownpour() && this._cachedBelow65 >= 2;
        }),

        // Stormstream Totem proc (instant)
        spell.cast(S.stormstreamTotem, () => me, () => {
          return me.hasAura(A.stormstreamProc);
        }),

        // Healing Stream Totem (instant, fractional charge aware)
        spell.cast(S.healingStreamTotem, () => me, () => {
          return this._cachedBelow85 >= 1 &&
            spell.getChargesFractional(S.healingStreamTotem) > 1.4;
        }),

        // Earth Shield maintenance while moving (instant)
        spell.cast(S.earthShield,
          () => this.getEarthShieldTankTarget(),
          () => this.getEarthShieldTankTarget() !== null
        ),

        // Instant DPS while moving
        spell.cast(S.flameShock, () => this.getFlameShockTarget()),
        spell.cast(S.lavaBurst, () => this.getLavaBurstTarget(), () => {
          return me.hasAura(A.lavaSurge);
        }),

        // Block cast-time spells while moving
        new bt.Action(() => bt.Status.Success),
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== EMERGENCY HEALING (Tier 1: < 20%) =====
  emergencyHealing() {
    return new bt.Decorator(
      () => this._cachedBelow20 >= 1,
      new bt.Selector(
        // Nature's Swiftness → instant Healing Wave (Totemic)
        spell.cast(S.naturesSwiftness, () => me, () => {
          return this.isTotemic() && !me.hasAura(A.naturesSwiftness);
        }),
        // Ancestral Swiftness → instant Healing Wave (Farseer)
        spell.cast(S.ancestralSwiftness, () => me, () => {
          return this.isFarseer() &&
            spell.getTimeSinceLastCast(S.ancestralSwiftness) > 2000;
        }),
        // Consume NS/AS with Healing Wave — instant
        spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsEmergencyHP), () => {
          return this.hasInstantCast();
        }),

        // Riptide — instant HoT + initial heal
        spell.cast(S.riptide, () => this.getHealTarget(Settings.FWRsEmergencyHP)),

        // Unleash Life — instant, buffs next heal by +25%
        spell.cast(S.unleashLife, () => me, () => {
          return this._cachedLowestHP < Settings.FWRsEmergencyHP && !this.hasUnleashLife();
        }),

        // Healing Wave — hard-cast with Tidal Waves for reduced cast time
        spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsEmergencyHP), () => {
          return this.hasTidalWaves();
        }),

        // Healing Wave — Whirling Air gives 40% cast time reduction
        spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsEmergencyHP), () => {
          return this.hasWhirlingAir();
        }),

        // Healing Wave — hard-cast fallback
        spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsEmergencyHP)),
      )
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      // Astral Shift (self-defense: -40% damage for 12s, or -60% with Astral Bulwark)
      spell.cast(S.astralShift, () => me, () => {
        return Settings.FWRsAstralShift && me.inCombat() &&
          me.effectiveHealthPercent < Settings.FWRsAstralShiftHP;
      }),
      // Earth Elemental (tank dying — taunts and tanks for 30s, +15% max HP with Primordial Bond)
      spell.cast(S.earthElemental, () => me, () => {
        if (!Settings.FWRsEarthElemental || !me.inCombat()) return false;
        return this._cachedTankLowestHP < Settings.FWRsEarthEleHP;
      }),
    );
  }

  // ===== MAJOR COOLDOWNS (OFF by default) =====
  majorCooldowns() {
    return new bt.Selector(
      // Ascendance (if talented): HW always crits, CH +3 bounces, -25% mana, applies Riptide
      // Pre-cast: Unleash Life → Ascendance (Method guide)
      spell.cast(S.unleashLife, () => me, () => {
        if (!Settings.FWRsAscendance || !this.hasAscendance()) return false;
        if (this.inAscendance()) return false;
        // Only pre-buff if Ascendance is about to be used
        const ascCD = spell.getCooldown(S.ascendance);
        if (!ascCD || !ascCD.ready) return false;
        return this.getFriendsBelow(Settings.FWRsAscendanceHP) >= Settings.FWRsAscendanceCount &&
          !this.hasUnleashLife();
      }),
      spell.cast(S.ascendance, () => me, () => {
        if (!Settings.FWRsAscendance || !this.hasAscendance()) return false;
        return this.getFriendsBelow(Settings.FWRsAscendanceHP) >= Settings.FWRsAscendanceCount;
      }),
      // Healing Tide Totem (if talented): pulses every 2s for 10s, 40yd
      spell.cast(S.healingTideTotem, () => me, () => {
        if (!Settings.FWRsHTT || !this.hasHTT()) return false;
        return this.getFriendsBelow(Settings.FWRsHTTHP) >= Settings.FWRsHTTCount;
      }),
      // Spirit Link Totem: 10% (or 15%) DR + health redistribution, 10yd, 6s
      spell.cast(S.spiritLinkTotem, () => {
        const t = this.getBestSpiritLinkTarget();
        return t || null;
      }, () => {
        if (!Settings.FWRsSLT) return false;
        const target = this.getBestSpiritLinkTarget();
        if (!target) return false;
        return this.getFriendsBelow(Settings.FWRsSLTHP) >= Settings.FWRsSLTCount;
      }),
    );
  }

  // ===== EARTH SHIELD MAINTENANCE =====
  earthShieldMaintenance() {
    return spell.cast(S.earthShield,
      () => this.getEarthShieldTankTarget(),
      () => this.getEarthShieldTankTarget() !== null
    );
  }

  // ===== ASCENDANCE WINDOW — Enhanced healing when active =====
  ascendanceHealing() {
    return new bt.Decorator(
      () => this.inAscendance(),
      new bt.Selector(
        // During Ascendance: HW always crits + applies Riptide + overflow healing
        // Chain Heal: +3 bounces (8 total), 10% reduction per bounce (vs 30% normal)
        // Minimize Riptide casts during Ascendance (HW/CH auto-apply it)
        // -25% mana cost on all heals

        // Unleash Life to buff next CH/HW by +25%
        spell.cast(S.unleashLife, () => me, () => {
          return !this.hasUnleashLife() && this._cachedBelow65 >= 1;
        }),

        // Chain Heal on 2+ injured (8 bounces during Ascendance, 10% reduction!)
        spell.cast(S.chainHeal, () => this.getBestChainHealTarget(Settings.FWRsUrgentHP), () => {
          const target = this.getBestChainHealTarget(Settings.FWRsUrgentHP);
          return target !== null && this._cachedBelow65 >= 2;
        }),

        // Healing Wave — always crits, -25% mana, applies Riptide, heals 1 extra at 50%
        spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsMaintHP)),

        // Chain Heal even on 2+ for maintenance (still 8 bounces)
        spell.cast(S.chainHeal, () => this.getBestChainHealTarget(Settings.FWRsMaintHP), () => {
          const target = this.getBestChainHealTarget(Settings.FWRsMaintHP);
          return target !== null && this._cachedBelow85 >= 2;
        }),
      )
    );
  }

  // ===== HEALING ROTATION (Tiers 2-4) =====
  healingRotation() {
    return new bt.Selector(
      // ===== Tier 2: CRITICAL (< 40%) =====

      // Riptide on critical target (instant — top priority)
      spell.cast(S.riptide, () => this.getHealTarget(Settings.FWRsCriticalHP), () => {
        const target = this.getHealTarget(Settings.FWRsCriticalHP);
        if (!target) return false;
        const rtAura = target.getAuraByMe(A.riptide);
        return !rtAura || rtAura.remaining < 5400;
      }),

      // Unleash Life before big heal on critical target (+25%, -30% cast time)
      spell.cast(S.unleashLife, () => me, () => {
        return this._cachedLowestHP < Settings.FWRsCriticalHP &&
          !this.hasUnleashLife();
      }),

      // Nature's Swiftness → instant HW (Totemic, critical)
      spell.cast(S.naturesSwiftness, () => me, () => {
        return this.isTotemic() && this._cachedLowestHP < Settings.FWRsCriticalHP &&
          !me.hasAura(A.naturesSwiftness);
      }),
      // Ancestral Swiftness → instant HW (Farseer, critical)
      spell.cast(S.ancestralSwiftness, () => me, () => {
        return this.isFarseer() && this._cachedLowestHP < Settings.FWRsCriticalHP &&
          spell.getTimeSinceLastCast(S.ancestralSwiftness) > 2000;
      }),
      // Consume NS/AS instant HW
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsCriticalHP), () => {
        return this.hasInstantCast();
      }),

      // Healing Wave on critical target with Whirling Air (40% cast time reduction)
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsCriticalHP), () => {
        return this._cachedLowestHP < Settings.FWRsCriticalHP && this.hasWhirlingAir();
      }),

      // Healing Wave on critical target (Tidal Waves reduces cast time by 20%)
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsCriticalHP), () => {
        return this._cachedLowestHP < Settings.FWRsCriticalHP && this.hasTidalWaves();
      }),

      // Healing Wave on critical target — fallback hard-cast
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsCriticalHP), () => {
        return this._cachedLowestHP < Settings.FWRsCriticalHP;
      }),

      // ===== Surging Totem maintenance (Totemic hero) =====
      // Priority: keep uptime near 100% — replaces Healing Rain with +20% effectiveness
      spell.cast(S.surgingTotem, () => me, () => {
        return this.needsSurgingTotem() && this._cachedBelow85 >= 1;
      }),

      // ===== Downpour (burst AoE at HR/Surging Totem location) =====
      // Use before Surging Totem expires for maximum value (16s window from cast)
      spell.cast(S.downpour, () => me, () => {
        if (!this.hasDownpour()) return false;
        return this._cachedBelow65 >= 2;
      }),

      // ===== Stormstream Totem (NS/AS proc → empowered HST) =====
      spell.cast(S.stormstreamTotem, () => me, () => {
        return me.hasAura(A.stormstreamProc);
      }),

      // ===== Healing Stream Totem (fractional charge aware, triggers Lively Totems CH) =====
      spell.cast(S.healingStreamTotem, () => me, () => {
        if (spell.getTimeSinceLastCast(S.healingStreamTotem) < 5000) return false;
        // Use at 1.4+ fractional to avoid charge waste
        return this._cachedBelow85 >= 1 &&
          spell.getChargesFractional(S.healingStreamTotem) > 1.4;
      }),

      // ===== Healing Rain (non-Totemic only — Totemic uses Surging Totem) =====
      spell.cast(S.healingRain, () => me, () => {
        if (this.isTotemic()) return false;
        if (spell.getTimeSinceLastCast(S.healingRain) < 3000) return false;
        return this._cachedBelow65 >= 3 && this.hasManaFor('healingRain');
      }),

      // ===== Tier 3: URGENT (< 65%) =====

      // Riptide spread — pandemic-aware (Tidal Waves + Undercurrent stacking)
      spell.cast(S.riptide, () => this.getRiptideTarget(Settings.FWRsUrgentHP), () => {
        return this.getRiptideTarget(Settings.FWRsUrgentHP) !== null &&
          spell.getChargesFractional(S.riptide) > 1.4;
      }),

      // Unleash Life (buff next HW/CH by +25%, -30% cast time)
      // Pair with CH when 3+ injured (AoE), HW when ST damage
      spell.cast(S.unleashLife, () => me, () => {
        return this._cachedLowestHP < Settings.FWRsUrgentHP &&
          !this.hasUnleashLife();
      }),

      // Chain Heal — prefer when 3+ injured nearby, consume Riptide via Flow of Tides (+30%)
      // Whirling Earth: CH applies Earthliving at 150% to all targets — lower threshold
      spell.cast(S.chainHeal, () => this.getBestChainHealTarget(Settings.FWRsUrgentHP), () => {
        const target = this.getBestChainHealTarget(Settings.FWRsUrgentHP);
        if (!target) return false;
        const minInjured = Settings.FWRsChainHealMin;
        // Use CH more aggressively with Whirling Earth buff or Unleash Life
        const threshold = this.hasWhirlingEarth() ? Math.max(minInjured - 1, 2) :
                         (this.hasUnleashLife() ? Math.max(minInjured - 1, 2) : minInjured);
        return this._cachedBelow65 >= threshold && this.hasManaFor('chainHeal');
      }),

      // Healing Wave with Whirling Air (40% cast time reduction — prioritize over TW)
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsUrgentHP), () => {
        return this.getHealTarget(Settings.FWRsUrgentHP) !== null && this.hasWhirlingAir();
      }),

      // Healing Wave with Tidal Waves (empowered — 20% cast time reduction)
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsUrgentHP), () => {
        return this.getHealTarget(Settings.FWRsUrgentHP) !== null && this.hasTidalWaves();
      }),

      // Healing Wave — Whirling Water: also heals ally in HR at 50%
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsUrgentHP), () => {
        return this.getHealTarget(Settings.FWRsUrgentHP) !== null && this.hasWhirlingWater();
      }),

      // Healing Wave — efficient single-target filler
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsUrgentHP)),

      // ===== Tier 4: MAINTENANCE (< 85%) =====

      // Riptide spread — keep HoTs rolling for Undercurrent stacking (+0.5% per active RT)
      spell.cast(S.riptide, () => this.getRiptideTarget(Settings.FWRsMaintHP), () => {
        return this.getRiptideTarget(Settings.FWRsMaintHP) !== null &&
          spell.getChargesFractional(S.riptide) > 1.4;
      }),

      // Healing Stream Totem — keep on CD even for light damage (2 charges max)
      spell.cast(S.healingStreamTotem, () => me, () => {
        if (spell.getTimeSinceLastCast(S.healingStreamTotem) < 5000) return false;
        return this._cachedBelow85 >= 1 &&
          spell.getChargesFractional(S.healingStreamTotem) >= 2;
      }),

      // Healing Wave on tank maintenance (tanks get healed at higher threshold)
      // Prefer when Tidal Waves or Whirling Air available for faster cast
      spell.cast(S.healingWave, () => this.getTankTarget(Settings.FWRsMaintHP), () => {
        const tank = this.getTankTarget(Settings.FWRsMaintHP);
        if (!tank) return false;
        return this.getManaPercent() > 40 &&
          (this.hasTidalWaves() || this.hasWhirlingAir());
      }),

      // Chain Heal for light group damage (3+ below maint, only if mana OK)
      spell.cast(S.chainHeal, () => this.getBestChainHealTarget(Settings.FWRsMaintHP), () => {
        if (this.isLowMana()) return false;
        const target = this.getBestChainHealTarget(Settings.FWRsMaintHP);
        return target !== null && this._cachedBelow85 >= Settings.FWRsChainHealMin &&
          this.hasManaFor('chainHeal');
      }),

      // Healing Wave on maintenance targets (mana efficient)
      spell.cast(S.healingWave, () => this.getHealTarget(Settings.FWRsMaintHP), () => {
        return this.getHealTarget(Settings.FWRsMaintHP) !== null && this.getManaPercent() > 50;
      }),
    );
  }

  // ===== DPS ROTATION (Tier 5: everyone > 85%) =====
  dpsRotation() {
    return new bt.Decorator(
      () => this._cachedLowestHP >= Settings.FWRsDpsThreshold && me.inCombat(),
      new bt.Selector(
        // Surging Totem uptime for Acid Rain damage (Totemic)
        spell.cast(S.surgingTotem, () => me, () => {
          return this.needsSurgingTotem();
        }),

        // Riptide on CD for Undercurrent stacking (even when DPSing)
        spell.cast(S.riptide, () => this.getRiptideTarget(95), () => {
          return this.getRiptideTarget(95) !== null &&
            spell.getChargesFractional(S.riptide) > 1.7;
        }),

        // Unleash Life on CD (instant, keeps up activity + buffs next heal if needed)
        spell.cast(S.unleashLife, () => me, () => {
          return !this.hasUnleashLife() && this._cachedBelow85 >= 1;
        }),

        // Flame Shock maintenance (DoT + enables Lava Surge procs)
        spell.cast(S.flameShock, () => this.getFlameShockTarget()),

        // Lava Burst with Lava Surge proc (instant, always crits with FS)
        spell.cast(S.lavaBurst, () => this.getLavaBurstTarget(), () => {
          return me.hasAura(A.lavaSurge) && this.getLavaBurstTarget() !== null;
        }),

        // Stormstream Totem proc (don't waste)
        spell.cast(S.stormstreamTotem, () => me, () => {
          return me.hasAura(A.stormstreamProc);
        }),

        // HST to avoid charge waste
        spell.cast(S.healingStreamTotem, () => me, () => {
          return spell.getChargesFractional(S.healingStreamTotem) >= 2;
        }),

        // Chain Lightning (2+ targets)
        spell.cast(S.chainLightning, () => this.getDpsTarget(), () => {
          const target = this.getDpsTarget();
          return target && target.getUnitsAroundCount(10) >= 2;
        }),

        // Lava Burst (hard-cast with FS up)
        spell.cast(S.lavaBurst, () => this.getLavaBurstTarget()),

        // Lightning Bolt filler
        spell.cast(S.lightningBolt, () => this.getDpsTarget()),
      )
    );
  }
}
