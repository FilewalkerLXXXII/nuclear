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
 * Restoration Druid Behavior - Midnight 12.0.1
 * Sources: Method Guide (rotation + talents) + Wowhead (spell data) + Dreamgrove Compendium
 *
 * Auto-detects: Keeper of the Grove vs Wildstalker
 *   KotG: Grove Guardians (102693), Dream Surge, Cenarius' Might — raid-focused throughput
 *   Wildstalker: Symbiotic Blooms, Strategic Infusion, Bursting Growth — M+/catweave
 *
 * Tiered healing: Emergency (<20%) → Critical (<40%) → Urgent (<65%) → Maintenance (<85%) → DPS (>85%)
 * Major CDs (Tranquility, Incarnation: Tree of Life) OFF by default for raid assignment
 *
 * Key mechanics implemented:
 *  - Mastery: Harmony — more HoTs on target = more healing; maintain 3+ HoTs on tanks
 *  - Lifebloom: maintain on tank, refresh in last 4.5s for bloom + pandemic
 *  - Rejuvenation: primary ramp tool, pandemic at 3.6s (30% of 12s)
 *  - Wild Growth: 7s HoT on 5 targets (7 in ToL), 10s CD
 *  - Swiftmend: instant heal, 2 charges (15s recharge), spawns Grove Guardian (KotG)
 *    With Verdant Infusion: extends HoTs by 8s instead of consuming them
 *  - Efflorescence: ground AoE, 30s duration; with Lifetreading auto-moves to LB target
 *  - Soul of the Forest: Swiftmend → +60% next Regrowth/Rejuv; Power of the Archdruid spreads to 2 extra
 *  - Cenarion Ward: 30s CD, procs 8s HoT when target takes damage
 *  - Nature's Swiftness: instant Regrowth + 60% more healing (48s CD)
 *  - Incarnation: Tree of Life: +10% healing, instant Regrowth, +40% Rejuv, 30s duration
 *  - Tranquility: 6s channel, raid heal; Flourish extends all HoTs by 2s per tick
 *  - Convoke the Spirits: 4s channel, 16 random druid spells (favors form)
 *  - Innervate: free mana for 8s, 6min CD
 *  - Ironbark: 20% DR on ally, 90s CD, 12s duration
 *  - Nature's Cure: dispels Magic, Curse, Poison (8s CD)
 *  - DPS: Moonfire DoT, Sunfire DoT, Wrath filler
 *  - Catweave (optional): Cat Form → Rake, Shred, Rip, Ferocious Bite
 *  - Master Shapeshifter: Wrath generates mana
 *  - Cast cancellation: cancel DPS casts when healing needed
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'Method + Wowhead + Dreamgrove Compendium — Restoration Druid',
};

// Cast spell IDs
const S = {
  // Core heals
  rejuvenation:       774,
  regrowth:           8936,
  wildGrowth:         48438,
  lifebloom:          33763,
  swiftmend:          18562,
  efflorescence:      81262,
  cenarionWard:       102351,
  nourish:            50464,
  // Cooldowns
  tranquility:        740,
  incarnation:        33891,     // Incarnation: Tree of Life
  flourish:           197721,    // Now passive on Tranquility — extends HoTs 2s/tick
  convoke:            391528,    // Convoke the Spirits (all specs)
  naturesSwiftness:   132158,
  innervate:          29166,
  groveGuardians:     102693,    // Talent: summon treant (3 charges, 20s recharge)
  // Defensives
  ironbark:           102342,    // Ally external: 20% DR, 12s, 90s CD
  barkskin:           22812,     // Self: 20% DR, 12s, 60s CD
  renewal:            108238,    // Self-heal
  // Dispel
  naturesCure:        88423,     // Magic + Curse + Poison (8s CD)
  // DPS
  moonfire:           8921,
  sunfire:            93402,
  wrath:              5176,      // Resto Wrath
  starfire:           194153,
  solarBeam:          78675,     // Interrupt (talent)
  // Forms
  catForm:            768,
  bearForm:           5487,
  moonkinForm:        24858,
  // Cat abilities (catweave)
  rake:               1822,
  shred:              5221,
  rip:                1079,
  ferociousBite:      22568,
  swipeCat:           106785,
  // Utility
  markOfTheWild:      1126,
  stampedingRoar:     106898,
  // Racials
  berserking:         26297,
};

// Aura IDs (may differ from cast IDs)
const A = {
  rejuvenation:       774,
  regrowth:           8936,
  wildGrowth:         48438,
  lifebloom:          33763,
  cenarionWard:       102351,    // Ward buff on target (102352 = the HoT proc)
  cenarionWardHoT:    102352,    // Active HoT after damage taken
  efflorescence:      81262,
  // Buff auras
  naturesSwiftness:   132158,
  incarnation:        33891,     // Tree of Life buff
  soulOfTheForest:    114108,    // Proc from Swiftmend — +60% next Regrowth/Rejuv
  clearCasting:       16870,     // Omen of Clarity — free Regrowth
  abundanceBuff:      207640,    // Per-Rejuv stacking crit bonus
  // Debuff auras
  moonfireDebuff:     164812,
  sunfireDebuff:      164815,
  // Hero talent detection
  groveGuardiansKnown: 102693,  // KotG exclusive talent
  // Defensive
  ironbark:           102342,
  barkskin:           22812,
  // Forms
  catForm:            768,
  bearForm:           5487,
  moonkinForm:        24858,
  treeOfLife:         33891,
  // Marks
  markOfTheWild:      1126,
  // Rake debuff
  rakeDebuff:         155722,
  ripDebuff:          1079,
};

const MIN_DOT_TTD = 6000;

export class RestorationDruidBehavior extends Behavior {
  name = 'FW Restoration Druid';
  context = BehaviorContext.Any;
  specialization = Specialization.Druid.Restoration;
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
  _lbTargetFrame = 0;
  _cachedLBTarget = null;
  _rejuvTargetFrame = 0;
  _cachedRejuvTargets = {};
  _wgTargetFrame = 0;
  _cachedWGTarget = null;
  _versionLogged = false;
  _lastDebug = 0;
  _efflFrame = 0;
  _cachedEfflActive = false;

  static settings = [
    {
      header: 'Healing Thresholds',
      options: [
        { type: 'slider', uid: 'FWRdEmergencyHP', text: 'Emergency HP %', default: 20, min: 5, max: 40 },
        { type: 'slider', uid: 'FWRdCriticalHP', text: 'Critical HP %', default: 40, min: 15, max: 60 },
        { type: 'slider', uid: 'FWRdUrgentHP', text: 'Urgent HP %', default: 65, min: 30, max: 80 },
        { type: 'slider', uid: 'FWRdMaintenanceHP', text: 'Maintenance HP %', default: 85, min: 50, max: 95 },
        { type: 'slider', uid: 'FWRdDpsThreshold', text: 'DPS when all above %', default: 85, min: 70, max: 100 },
      ],
    },
    {
      header: 'Major Cooldowns (OFF = manual/raid assignment)',
      options: [
        { type: 'checkbox', uid: 'FWRdUseTranq', text: 'Auto Tranquility', default: false },
        { type: 'slider', uid: 'FWRdTranqHP', text: 'Tranquility avg HP %', default: 40, min: 15, max: 60 },
        { type: 'slider', uid: 'FWRdTranqCount', text: 'Tranquility min targets', default: 3, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWRdUseIncarn', text: 'Auto Tree of Life', default: false },
        { type: 'checkbox', uid: 'FWRdUseConvoke', text: 'Auto Convoke the Spirits', default: false },
        { type: 'checkbox', uid: 'FWRdUseInnervate', text: 'Auto Innervate (self)', default: true },
        { type: 'slider', uid: 'FWRdInnervateMana', text: 'Innervate below mana %', default: 50, min: 10, max: 80 },
      ],
    },
    {
      header: 'Externals & Defensives',
      options: [
        { type: 'checkbox', uid: 'FWRdUseIronbark', text: 'Auto Ironbark', default: true },
        { type: 'slider', uid: 'FWRdIronbarkHP', text: 'Ironbark HP %', default: 30, min: 10, max: 50 },
        { type: 'checkbox', uid: 'FWRdUseBarkskin', text: 'Use Barkskin', default: true },
        { type: 'slider', uid: 'FWRdBarkskinHP', text: 'Barkskin HP %', default: 50, min: 10, max: 80 },
      ],
    },
    {
      header: 'DPS',
      options: [
        { type: 'checkbox', uid: 'FWRdDPS', text: 'DPS when idle', default: true },
        { type: 'checkbox', uid: 'FWRdCatweave', text: 'Catweave DPS', default: false },
      ],
    },
    {
      header: 'Debug',
      options: [
        { type: 'checkbox', uid: 'FWRdDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // ===== Hero Talent Detection =====
  isKeeperOfTheGrove() {
    return spell.isSpellKnown(S.groveGuardians);
  }

  isWildstalker() {
    return !this.isKeeperOfTheGrove();
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

    if (!selfCounted) {
      const selfHP = me.effectiveHealthPercent;
      if (selfHP < lowestHP) { lowestHP = selfHP; lowest = me; }
      if (selfHP <= 20) below20++;
      if (selfHP <= 40) below40++;
      if (selfHP <= 65) below65++;
      if (selfHP <= 85) below85++;
    }

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
    this._rejuvTargetFrame = 0;
    this._cachedRejuvTargets = {};
    this._lbTargetFrame = 0;
    this._wgTargetFrame = 0;
  }

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

  // Lifebloom tank target — maintain on tank, pandemic refresh at < 4.5s (30% of 15s)
  getLifebloomTarget() {
    if (this._lbTargetFrame === wow.frameTime) return this._cachedLBTarget;
    this._lbTargetFrame = wow.frameTime;

    if (spell.getTimeSinceLastCast(S.lifebloom) < 2000) {
      this._cachedLBTarget = null;
      return null;
    }

    const tanks = heal.friends.Tanks;
    let result = null;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (!tank || tank.deadOrGhost || me.distanceTo(tank) > 40) continue;
      const lbAura = tank.getAuraByMe(A.lifebloom);
      if (!lbAura || lbAura.remaining < 4500) {
        result = tank;
        break;
      }
    }
    // If no tank needs LB, check if any tank has it at all
    if (!result) {
      for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        if (!tank || tank.deadOrGhost || me.distanceTo(tank) > 40) continue;
        const lbAura = tank.getAuraByMe(A.lifebloom);
        if (!lbAura) {
          result = tank;
          break;
        }
      }
    }
    // Fallback: if no tanks, maintain on lowest
    if (!result && tanks.length === 0) {
      this._refreshHealCache();
      if (this._cachedLowest) {
        const lbAura = this._cachedLowest.getAuraByMe(A.lifebloom);
        if (!lbAura || lbAura.remaining < 4500) {
          result = this._cachedLowest;
        }
      }
    }
    this._cachedLBTarget = result;
    return result;
  }

  // Rejuvenation target — prioritize tanks without Rejuv, then lowest HP without Rejuv
  // Pandemic: refresh at < 3.6s (30% of 12s)
  getRejuvTarget(maxHP) {
    this._refreshHealCache();
    const key = maxHP;
    if (this._rejuvTargetFrame === wow.frameTime && key in this._cachedRejuvTargets) {
      return this._cachedRejuvTargets[key];
    }
    this._rejuvTargetFrame = wow.frameTime;

    let result = null;
    // Tanks first (healed at higher threshold)
    const tanks = heal.friends.Tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40 &&
          tank.effectiveHealthPercent <= Math.min(maxHP + 10, 95)) {
        const rejuvAura = tank.getAuraByMe(A.rejuvenation);
        if (!rejuvAura || rejuvAura.remaining < 3600) { result = tank; break; }
      }
    }
    // Then lowest friend needing Rejuv
    if (!result) {
      const friends = heal.friends.All;
      for (let i = 0; i < friends.length; i++) {
        const unit = friends[i];
        if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
            unit.effectiveHealthPercent <= maxHP) {
          const rejuvAura = unit.getAuraByMe(A.rejuvenation);
          if (!rejuvAura || rejuvAura.remaining < 3600) { result = unit; break; }
        }
      }
    }
    this._cachedRejuvTargets[key] = result;
    return result;
  }

  // Wild Growth target — best cluster of injured allies
  getWildGrowthTarget(maxHP) {
    if (this._wgTargetFrame === wow.frameTime) return this._cachedWGTarget;
    this._wgTargetFrame = wow.frameTime;

    let best = null;
    let bestCount = 0;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
      if (unit.effectiveHealthPercent > maxHP) continue;
      let count = 0;
      for (let j = 0; j < friends.length; j++) {
        const ally = friends[j];
        if (ally && !ally.deadOrGhost && ally.effectiveHealthPercent <= maxHP &&
            unit.distanceTo(ally) <= 30) {
          count++;
        }
      }
      if (count > bestCount) { bestCount = count; best = unit; }
    }
    this._cachedWGTarget = (bestCount >= 2) ? best : null;
    return this._cachedWGTarget;
  }

  // Swiftmend target — needs a HoT on them (Rejuv, Regrowth, or WG)
  getSwiftmendTarget(maxHP) {
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
      if (unit.effectiveHealthPercent > maxHP) continue;
      // Swiftmend requires a HoT present (unless using Verdant Infusion which extends)
      if (unit.getAuraByMe(A.rejuvenation) || unit.getAuraByMe(A.regrowth) ||
          unit.getAuraByMe(A.wildGrowth)) {
        return unit;
      }
    }
    return null;
  }

  // Cenarion Ward target — put on tank or lowest (if they don't have it)
  getCenarionWardTarget() {
    if (spell.getTimeSinceLastCast(S.cenarionWard) < 3000) return null;
    const tanks = heal.friends.Tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40) {
        const cwAura = tank.getAura(A.cenarionWard);
        const cwHot = tank.getAura(A.cenarionWardHoT);
        if (!cwAura && !cwHot) return tank;
      }
    }
    return null;
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

  // ===== Mana Management =====
  hasManaFor(spellType) {
    const mana = this.getManaPercent();
    if (mana < 8) return false;
    if (mana < 20 && spellType === 'wildGrowth') return false;
    if (mana < 15 && spellType === 'rejuv') return false;
    return true;
  }

  isLowMana() {
    return this.getManaPercent() < 35;
  }

  // ===== Buff Helpers =====
  hasNaturesSwiftness() {
    return me.hasAura(A.naturesSwiftness);
  }

  hasSoulOfTheForest() {
    return me.hasAura(A.soulOfTheForest);
  }

  hasClearCasting() {
    return me.hasAura(A.clearCasting);
  }

  inTreeOfLife() {
    return me.hasAura(A.incarnation);
  }

  // ===== Form Checks =====
  inCatForm() {
    return me.hasAura(A.catForm);
  }

  inBearForm() {
    return me.hasAura(A.bearForm);
  }

  needsFormExit() {
    return this.inCatForm() || this.inBearForm();
  }

  // ===== Cast Cancellation =====
  shouldStopCasting() {
    if (!me.isCastingOrChanneling) return false;
    const currentCast = me.currentCastOrChannel;
    if (!currentCast || currentCast.timeleft < 500) return false;

    const castId = currentCast.spellId;
    const isDamageCast = castId === S.wrath || castId === S.starfire;

    if (isDamageCast && this._cachedLowestHP < Settings.FWRdCriticalHP) return true;
    return false;
  }

  // ===== Debuff Helpers =====
  getDebuffRemaining(target, spellId) {
    if (!target) return 0;
    const debuffMap = {
      [S.moonfire]: A.moonfireDebuff,
      [S.sunfire]: A.sunfireDebuff,
      [S.rake]: A.rakeDebuff,
      [S.rip]: A.ripDebuff,
    };
    const debuffId = debuffMap[spellId] || spellId;
    let d = target.getAuraByMe(debuffId);
    if (!d && debuffId !== spellId) d = target.getAuraByMe(spellId);
    return d ? d.remaining : 0;
  }

  // ===== OOC Buff Helper =====
  _hasBuff(unit, id) {
    if (!unit) return false;
    if (unit.hasVisibleAura(id) || unit.hasAura(id)) return true;
    if (unit.auras && unit.auras.find(a => a.spellId === id)) return true;
    return false;
  }

  // MotW target (same pattern as Balance)
  getMotwTarget() {
    if (spell.getTimeSinceLastCast(S.markOfTheWild) < 5000) return null;
    if (!this._hasBuff(me, A.markOfTheWild)) return me;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
          !this._hasBuff(unit, A.markOfTheWild)) {
        return unit;
      }
    }
    return null;
  }

  // Ironbark target — lowest ally below threshold
  getIronbarkTarget() {
    if (!Settings.FWRdUseIronbark) return null;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
          unit.effectiveHealthPercent <= Settings.FWRdIronbarkHP &&
          !unit.hasAura(A.ironbark)) {
        return unit;
      }
    }
    return null;
  }

  // Efflorescence active check (did we cast recently? 30s duration)
  isEfflorescenceActive() {
    if (this._efflFrame === wow.frameTime) return this._cachedEfflActive;
    this._efflFrame = wow.frameTime;
    this._cachedEfflActive = spell.getTimeSinceLastCast(S.efflorescence) < 28000;
    return this._cachedEfflActive;
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      // Pre-combat
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC buffs (Mark of the Wild spreading)
      this.oocBuffs(),

      // Combat gate — proceed if self or any party member in combat
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
          const hero = this.isKeeperOfTheGrove() ? 'Keeper of the Grove' : 'Wildstalker';
          console.info(`[RestoDruid] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | Hero: ${hero} | ${SCRIPT_VERSION.guide}`);
        }
        return bt.Status.Failure;
      }),

      // Refresh heal cache + debug
      new bt.Action(() => {
        this._refreshHealCache();
        if (Settings.FWRdDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const mana = Math.round(this.getManaPercent());
          const lowestHP = Math.round(this._cachedLowestHP);
          const tankHP = Math.round(this._cachedTankLowestHP);
          const dpsMode = this._cachedLowestHP >= Settings.FWRdDpsThreshold;
          const tol = this.inTreeOfLife();
          const ns = this.hasNaturesSwiftness();
          const sotf = this.hasSoulOfTheForest();
          const cc = this.hasClearCasting();
          console.info(`[RestoDruid] Lowest:${lowestHP}% Tank:${tankHP}% <40:${this._cachedBelow40} <65:${this._cachedBelow65} Mana:${mana}% ToL:${tol} NS:${ns} SotF:${sotf} CC:${cc} DPS:${dpsMode}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // 1. Interrupt (Solar Beam if talented)
          spell.interrupt(S.solarBeam),

          // 2. Dispels (Nature's Cure — Magic, Curse, Poison)
          this.dispels(),

          // 3. Movement handling (instants only)
          this.movementHealing(),

          // 4. Emergency healing (Tier 1: someone < 20%)
          this.emergencyHealing(),

          // 5. Defensives (self + externals)
          this.defensives(),

          // 6. Major CDs (group-wide, OFF by default)
          this.majorCooldowns(),

          // 7. Lifebloom maintenance on tank
          this.lifebloomMaintenance(),

          // 8. Efflorescence maintenance
          this.efflorescenceMaintenance(),

          // 9. Cenarion Ward on tank
          this.cenarionWardMaintenance(),

          // 10. Healing rotation (Tiers 2-4)
          this.healingRotation(),

          // 11. DPS rotation (Tier 5: nobody needs healing)
          this.dpsRotation(),
        )
      ),
    );
  }

  // ===== OOC BUFFS =====
  oocBuffs() {
    return new bt.Selector(
      // Mark of the Wild (spreading to group)
      spell.cast(S.markOfTheWild, () => this.getMotwTarget(), () => {
        return this.getMotwTarget() !== null;
      }),
    );
  }

  // ===== DISPELS =====
  dispels() {
    return new bt.Selector(
      spell.dispel(S.naturesCure, true, DispelPriority.High, false, WoWDispelType.Magic),
      spell.dispel(S.naturesCure, true, DispelPriority.High, false, WoWDispelType.Curse),
      spell.dispel(S.naturesCure, true, DispelPriority.High, false, WoWDispelType.Poison),
      spell.dispel(S.naturesCure, true, DispelPriority.Medium, false, WoWDispelType.Magic),
      spell.dispel(S.naturesCure, true, DispelPriority.Medium, false, WoWDispelType.Curse),
      spell.dispel(S.naturesCure, true, DispelPriority.Medium, false, WoWDispelType.Poison),
    );
  }

  // ===== MOVEMENT HEALING =====
  movementHealing() {
    return new bt.Decorator(
      () => me.isMoving(),
      new bt.Selector(
        // Emergency: Nature's Swiftness → instant Regrowth
        spell.cast(S.naturesSwiftness, () => me, () => {
          return this._cachedLowestHP < Settings.FWRdCriticalHP &&
            !me.hasAura(A.naturesSwiftness);
        }),
        spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdCriticalHP), () => {
          return this.hasNaturesSwiftness();
        }),

        // Swiftmend (instant, charge-based)
        spell.cast(S.swiftmend, () => this.getSwiftmendTarget(Settings.FWRdUrgentHP), () => {
          const target = this.getSwiftmendTarget(Settings.FWRdUrgentHP);
          return target !== null && spell.getChargesFractional(S.swiftmend) > 0.5;
        }),

        // Rejuvenation (instant HoT — pandemic aware)
        spell.cast(S.rejuvenation, () => this.getRejuvTarget(Settings.FWRdMaintenanceHP), () => {
          return this.getRejuvTarget(Settings.FWRdMaintenanceHP) !== null &&
            this.hasManaFor('rejuv');
        }),

        // Wild Growth (1.5s cast, but instant in Tree of Life)
        spell.cast(S.wildGrowth, () => this.getWildGrowthTarget(Settings.FWRdUrgentHP), () => {
          return this.inTreeOfLife() &&
            this.getWildGrowthTarget(Settings.FWRdUrgentHP) !== null;
        }),

        // Lifebloom (instant)
        spell.cast(S.lifebloom, () => this.getLifebloomTarget(), () => {
          return this.getLifebloomTarget() !== null;
        }),

        // Cenarion Ward (instant)
        spell.cast(S.cenarionWard, () => this.getCenarionWardTarget(), () => {
          return this.getCenarionWardTarget() !== null;
        }),

        // ClearCasting Regrowth (instant with OoC proc)
        spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdUrgentHP), () => {
          return this.hasClearCasting() && this.getHealTarget(Settings.FWRdUrgentHP) !== null;
        }),

        // Ironbark (instant, off-GCD defensive)
        spell.cast(S.ironbark, () => this.getIronbarkTarget(), () => {
          return this.getIronbarkTarget() !== null;
        }),

        // Barkskin (instant, self)
        spell.cast(S.barkskin, () => me, () => {
          return Settings.FWRdUseBarkskin && me.effectiveHealthPercent < Settings.FWRdBarkskinHP;
        }),

        // DPS instants while moving
        spell.cast(S.moonfire, () => this.getDpsTarget(), () => {
          const target = this.getDpsTarget();
          if (!target) return false;
          if (spell.getTimeSinceLastCast(S.moonfire) < 3000) return false;
          return this.getDebuffRemaining(target, S.moonfire) < 3000;
        }),
        spell.cast(S.sunfire, () => this.getDpsTarget(), () => {
          const target = this.getDpsTarget();
          if (!target) return false;
          if (spell.getTimeSinceLastCast(S.sunfire) < 3000) return false;
          return this.getDebuffRemaining(target, S.sunfire) < 3000;
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
        // Nature's Swiftness → instant Regrowth (60% more healing)
        spell.cast(S.naturesSwiftness, () => me, () => {
          return !me.hasAura(A.naturesSwiftness);
        }),
        spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdEmergencyHP), () => {
          return this.hasNaturesSwiftness();
        }),

        // Swiftmend (instant, big heal)
        spell.cast(S.swiftmend, () => this.getSwiftmendTarget(Settings.FWRdEmergencyHP), () => {
          return this.getSwiftmendTarget(Settings.FWRdEmergencyHP) !== null;
        }),

        // Ironbark on emergency target
        spell.cast(S.ironbark, () => this.getHealTarget(Settings.FWRdEmergencyHP), () => {
          if (!Settings.FWRdUseIronbark) return false;
          const target = this.getHealTarget(Settings.FWRdEmergencyHP);
          return target !== null && !target.hasAura(A.ironbark);
        }),

        // Rejuvenation (instant HoT to start ticking)
        spell.cast(S.rejuvenation, () => this.getHealTarget(Settings.FWRdEmergencyHP), () => {
          const target = this.getHealTarget(Settings.FWRdEmergencyHP);
          if (!target) return false;
          const rejuvAura = target.getAuraByMe(A.rejuvenation);
          return !rejuvAura || rejuvAura.remaining < 3600;
        }),

        // ClearCasting Regrowth (instant, free)
        spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdEmergencyHP), () => {
          return this.hasClearCasting();
        }),

        // Hard-cast Regrowth (last resort)
        spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdEmergencyHP)),
      )
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      // Barkskin (self-defense)
      spell.cast(S.barkskin, () => me, () => {
        return Settings.FWRdUseBarkskin && me.inCombat() &&
          me.effectiveHealthPercent < Settings.FWRdBarkskinHP;
      }),
      // Ironbark on low ally
      spell.cast(S.ironbark, () => this.getIronbarkTarget(), () => {
        return this.getIronbarkTarget() !== null;
      }),
    );
  }

  // ===== MAJOR COOLDOWNS (OFF by default) =====
  majorCooldowns() {
    return new bt.Selector(
      // Innervate (self — mana recovery)
      spell.cast(S.innervate, () => me, () => {
        if (!Settings.FWRdUseInnervate) return false;
        return this.getManaPercent() < Settings.FWRdInnervateMana && me.inCombat();
      }),

      // Incarnation: Tree of Life
      spell.cast(S.incarnation, () => me, () => {
        if (!Settings.FWRdUseIncarn) return false;
        if (!me.inCombat()) return false;
        return this._cachedBelow65 >= 2;
      }),

      // Convoke the Spirits (strong burst healing in Resto form)
      spell.cast(S.convoke, () => me, () => {
        if (!Settings.FWRdUseConvoke) return false;
        if (!me.inCombat()) return false;
        return this._cachedBelow40 >= 2;
      }),

      // Tranquility (raid-wide emergency)
      spell.cast(S.tranquility, () => me, () => {
        if (!Settings.FWRdUseTranq) return false;
        if (!me.inCombat()) return false;
        return this.getFriendsBelow(Settings.FWRdTranqHP) >= Settings.FWRdTranqCount;
      }),
    );
  }

  // ===== LIFEBLOOM MAINTENANCE =====
  lifebloomMaintenance() {
    return spell.cast(S.lifebloom, () => this.getLifebloomTarget(), () => {
      return this.getLifebloomTarget() !== null;
    });
  }

  // ===== EFFLORESCENCE MAINTENANCE =====
  efflorescenceMaintenance() {
    return spell.cast(S.efflorescence, () => me, () => {
      if (!me.inCombat()) return false;
      if (this.isEfflorescenceActive()) return false;
      // Only place when people are grouped and need healing
      return this._cachedBelow85 >= 2;
    });
  }

  // ===== CENARION WARD MAINTENANCE =====
  cenarionWardMaintenance() {
    return spell.cast(S.cenarionWard, () => this.getCenarionWardTarget(), () => {
      return this.getCenarionWardTarget() !== null;
    });
  }

  // ===== HEALING ROTATION (Tiers 2-4) =====
  healingRotation() {
    return new bt.Selector(
      // ===== Tier 2: CRITICAL (< 40%) =====

      // Nature's Swiftness → Regrowth for critical target
      spell.cast(S.naturesSwiftness, () => me, () => {
        return this._cachedLowestHP < Settings.FWRdCriticalHP &&
          !me.hasAura(A.naturesSwiftness);
      }),
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdCriticalHP), () => {
        return this.hasNaturesSwiftness() &&
          this.getHealTarget(Settings.FWRdCriticalHP) !== null;
      }),

      // Swiftmend on critical target (instant, spawns Grove Guardian for KotG)
      spell.cast(S.swiftmend, () => this.getSwiftmendTarget(Settings.FWRdCriticalHP), () => {
        const target = this.getSwiftmendTarget(Settings.FWRdCriticalHP);
        return target !== null && spell.getChargesFractional(S.swiftmend) > 0.5;
      }),

      // Rejuvenation on critical target (instant, gets healing ticking)
      spell.cast(S.rejuvenation, () => this.getHealTarget(Settings.FWRdCriticalHP), () => {
        const target = this.getHealTarget(Settings.FWRdCriticalHP);
        if (!target) return false;
        const rejuvAura = target.getAuraByMe(A.rejuvenation);
        return !rejuvAura || rejuvAura.remaining < 3600;
      }),

      // Wild Growth when 2+ injured at critical
      spell.cast(S.wildGrowth, () => this.getWildGrowthTarget(Settings.FWRdCriticalHP), () => {
        const target = this.getWildGrowthTarget(Settings.FWRdCriticalHP);
        return target !== null && this.hasManaFor('wildGrowth');
      }),

      // ClearCasting Regrowth (free, instant)
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdCriticalHP), () => {
        return this.hasClearCasting() &&
          this.getHealTarget(Settings.FWRdCriticalHP) !== null;
      }),

      // Soul of the Forest empowered Regrowth/Rejuv
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdCriticalHP), () => {
        return this.hasSoulOfTheForest() &&
          this.getHealTarget(Settings.FWRdCriticalHP) !== null;
      }),

      // Hard-cast Regrowth on critical target
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdCriticalHP), () => {
        return this._cachedLowestHP < Settings.FWRdCriticalHP;
      }),

      // ===== Tier 3: URGENT (< 65%) =====

      // Swiftmend (save charges at fractional > 1.4 for efficiency, but use at 0.5+ for urgent)
      spell.cast(S.swiftmend, () => this.getSwiftmendTarget(Settings.FWRdUrgentHP), () => {
        const target = this.getSwiftmendTarget(Settings.FWRdUrgentHP);
        return target !== null && spell.getChargesFractional(S.swiftmend) > 1.4;
      }),

      // Rejuvenation spreading — pandemic-aware (build Mastery: Harmony stacks)
      spell.cast(S.rejuvenation, () => this.getRejuvTarget(Settings.FWRdUrgentHP), () => {
        return this.getRejuvTarget(Settings.FWRdUrgentHP) !== null &&
          this.hasManaFor('rejuv');
      }),

      // Wild Growth when 2+ urgent
      spell.cast(S.wildGrowth, () => this.getWildGrowthTarget(Settings.FWRdUrgentHP), () => {
        const target = this.getWildGrowthTarget(Settings.FWRdUrgentHP);
        return target !== null && this.hasManaFor('wildGrowth');
      }),

      // ClearCasting Regrowth (free)
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdUrgentHP), () => {
        return this.hasClearCasting() && this.getHealTarget(Settings.FWRdUrgentHP) !== null;
      }),

      // SotF-empowered Rejuvenation (spreads to 2 extra with Power of the Archdruid)
      spell.cast(S.rejuvenation, () => this.getRejuvTarget(Settings.FWRdUrgentHP), () => {
        return this.hasSoulOfTheForest() &&
          this.getRejuvTarget(Settings.FWRdUrgentHP) !== null;
      }),

      // Regrowth with Tidal-like conditions: SotF or Tree of Life (instant)
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdUrgentHP), () => {
        if (!this.getHealTarget(Settings.FWRdUrgentHP)) return false;
        return this.inTreeOfLife() || this.hasSoulOfTheForest();
      }),

      // Hard-cast Regrowth on urgent (only if mana OK and no better option)
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdUrgentHP), () => {
        return this._cachedLowestHP < Settings.FWRdUrgentHP && this.getManaPercent() > 40;
      }),

      // ===== Tier 4: MAINTENANCE (< 85%) =====

      // Rejuvenation spreading (maintain HoTs for Mastery)
      spell.cast(S.rejuvenation, () => this.getRejuvTarget(Settings.FWRdMaintenanceHP), () => {
        return this.getRejuvTarget(Settings.FWRdMaintenanceHP) !== null &&
          this.getManaPercent() > 50 && this.hasManaFor('rejuv');
      }),

      // Wild Growth for group top-off
      spell.cast(S.wildGrowth, () => this.getWildGrowthTarget(Settings.FWRdMaintenanceHP), () => {
        const target = this.getWildGrowthTarget(Settings.FWRdMaintenanceHP);
        return target !== null && this.getManaPercent() > 60 && this.hasManaFor('wildGrowth');
      }),

      // Swiftmend for SotF proc (if charges capping and someone needs healing)
      spell.cast(S.swiftmend, () => this.getSwiftmendTarget(Settings.FWRdMaintenanceHP), () => {
        const target = this.getSwiftmendTarget(Settings.FWRdMaintenanceHP);
        return target !== null && spell.getChargesFractional(S.swiftmend) >= 2;
      }),

      // ClearCasting Regrowth (free, never waste)
      spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdMaintenanceHP), () => {
        return this.hasClearCasting() && this.getHealTarget(Settings.FWRdMaintenanceHP) !== null;
      }),

      // Tank-focused Regrowth (keeps Regrowth HoT up for Mastery)
      spell.cast(S.regrowth, () => this.getTankTarget(Settings.FWRdMaintenanceHP), () => {
        const tank = this.getTankTarget(Settings.FWRdMaintenanceHP);
        if (!tank) return false;
        const rgAura = tank.getAuraByMe(A.regrowth);
        return (!rgAura || rgAura.remaining < 3000) && this.getManaPercent() > 60;
      }),
    );
  }

  // ===== DPS ROTATION (Tier 5: everyone > 85%) =====
  dpsRotation() {
    return new bt.Decorator(
      () => this._cachedLowestHP >= Settings.FWRdDpsThreshold && me.inCombat() && Settings.FWRdDPS,
      new bt.Selector(
        // Keep up HoT maintenance even while DPSing
        // Rejuvenation on anyone needing it (low priority)
        spell.cast(S.rejuvenation, () => this.getRejuvTarget(90), () => {
          const target = this.getRejuvTarget(90);
          return target !== null && this.getManaPercent() > 70;
        }),

        // ClearCasting Regrowth (free, never waste even in DPS mode)
        spell.cast(S.regrowth, () => this.getHealTarget(Settings.FWRdMaintenanceHP), () => {
          return this.hasClearCasting() && this.getHealTarget(Settings.FWRdMaintenanceHP) !== null;
        }),

        // Catweave DPS (optional)
        new bt.Decorator(
          () => Settings.FWRdCatweave,
          this.catweaveRotation(),
          new bt.Action(() => bt.Status.Failure)
        ),

        // Caster DPS
        // Moonfire maintenance
        spell.cast(S.moonfire, () => this.getDpsTarget(), () => {
          const target = this.getDpsTarget();
          if (!target) return false;
          if (spell.getTimeSinceLastCast(S.moonfire) < 3000) return false;
          if (target.timeToDeath && target.timeToDeath() < MIN_DOT_TTD) return false;
          return this.getDebuffRemaining(target, S.moonfire) < 3000;
        }),

        // Sunfire maintenance
        spell.cast(S.sunfire, () => this.getDpsTarget(), () => {
          const target = this.getDpsTarget();
          if (!target) return false;
          if (spell.getTimeSinceLastCast(S.sunfire) < 3000) return false;
          if (target.timeToDeath && target.timeToDeath() < MIN_DOT_TTD) return false;
          return this.getDebuffRemaining(target, S.sunfire) < 3000;
        }),

        // Wrath filler (also generates mana with Master Shapeshifter)
        spell.cast(S.wrath, () => this.getDpsTarget()),
      )
    );
  }

  // ===== CATWEAVE ROTATION =====
  catweaveRotation() {
    return new bt.Selector(
      // Enter Cat Form if not already
      spell.cast(S.catForm, () => me, () => {
        return !this.inCatForm() && this._cachedLowestHP >= Settings.FWRdDpsThreshold;
      }),

      // Only catweave if in Cat Form
      new bt.Decorator(
        () => this.inCatForm(),
        new bt.Selector(
          // Rake (DoT maintenance)
          spell.cast(S.rake, () => this.getDpsTarget(), () => {
            const target = this.getDpsTarget();
            if (!target) return false;
            if (target.timeToDeath && target.timeToDeath() < MIN_DOT_TTD) return false;
            return this.getDebuffRemaining(target, S.rake) < 3000;
          }),

          // Rip (DoT maintenance, higher priority with combo points)
          spell.cast(S.rip, () => this.getDpsTarget(), () => {
            const target = this.getDpsTarget();
            if (!target) return false;
            if (target.timeToDeath && target.timeToDeath() < 8000) return false;
            const cp = me.powerByType(PowerType.ComboPoints);
            return cp >= 4 && this.getDebuffRemaining(target, S.rip) < 3000;
          }),

          // Ferocious Bite at 5 combo points (dump)
          spell.cast(S.ferociousBite, () => this.getDpsTarget(), () => {
            const cp = me.powerByType(PowerType.ComboPoints);
            return cp >= 5 && this.getDpsTarget() !== null;
          }),

          // Shred (builder)
          spell.cast(S.shred, () => this.getDpsTarget()),
        ),
        new bt.Action(() => bt.Status.Failure)
      ),
    );
  }
}
