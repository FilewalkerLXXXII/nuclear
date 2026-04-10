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
 * Mistweaver Monk Behavior - Midnight 12.0.1
 * Sources: Method Guide (all pages) + Wowhead (spell data + rotation) + Icy Veins spell list
 *
 * Auto-detects: Conduit of the Celestials (Celestial Conduit) vs Master of Harmony (Aspect of Harmony)
 * Auto-detects: Invoke Yu'lon vs Invoke Chi-Ji (choice node)
 * Auto-detects: Revival vs Restoral (choice node)
 *
 * Tiered healing: Emergency (<20%) -> Critical (<35%) -> Urgent (<60%) -> Maintenance (<85%) -> DPS (>85%)
 * Long CDs (Revival/Restoral, Invoke Yu'lon/Chi-Ji, Celestial Conduit) OFF by default for raid assignment
 *
 * Key mechanics implemented:
 *  - Renewing Mist: 3 charges (Pool of Mists), pandemic refresh at <6s remaining, charge fractional
 *  - Vivify: cleave heal via Invigorating Mists to all ReM targets
 *  - Enveloping Mist: 6s HoT + 10% healing amp, instant via Soothing Mist or TFT
 *  - Thunder Focus Tea: empowers next heal differently per spell (2-3 charges)
 *  - Rising Sun Kick: extends ReM + EnvM via Rising Mist, triggers Vivacious Vivification
 *  - Soothing Mist: channel that makes Vivify/EnvM instant on target
 *  - Life Cocoon: external absorb + 50% HoT amp, emergency CD
 *  - Sheilun's Gift: cloud-based heal, instant with Emperor's Favor
 *  - Mana Tea: consume stacks for mana regen + 30% mana cost reduction
 *  - Ancient Teachings: DPS abilities heal 5 injured allies for 25% damage
 *  - Secret Infusion: TFT spell choice grants 4% stat bonus
 *  - Heart of the Jade Serpent (Conduit): TFT triggers 75% CDR window for 8s
 *  - Aspect of Harmony (MoH): TFT triggers vitality withdraw for bonus healing
 *  - Rapid Diffusion: RSK/EnvM spreads 6s ReM to nearby ally
 *  - Vivacious Vivification: RSK makes next Vivify instant + 20% stronger
 *  - Rising Mist: RSK extends ReM/EnvM by 4s (up to 100% original duration)
 *
 * Conduit of the Celestials: Celestial Conduit (moveable channel), Heart of Jade Serpent CDR
 * Master of Harmony: Aspect of Harmony (accumulator/spender), Harmonic Surge, Coalescence
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-20',
  guide: 'Method + Wowhead Mistweaver Monk',
};

// Cast spell IDs
const S = {
  // Core heals
  vivify:             116670,
  envelopingMist:     124682,
  renewingMist:       115151,
  soothingMist:       115175,
  lifeCocoon:         116849,
  revival:            115310,
  restoral:           388615,
  sheilunsGift:       399491,
  // Thunder Focus Tea
  thunderFocusTea:    116680,
  // Cooldowns
  invokeYulon:        322118,
  invokeChiJi:        325197,
  celestialConduit:   443028,
  // DPS
  tigerPalm:          100780,
  blackoutKick:       100784,
  risingSunKick:      107428,
  spinningCraneKick:  101546,
  cracklingJadeLightning: 117952,
  rushingWindKick:    1269159,
  touchOfDeath:       322109,
  // Utility
  expelHarm:          322101,
  detox:              115450,
  mysticTouch:        8647,
  legSweep:           119381,
  manaTea:            115867,
  // Defensives
  fortifyingBrew:     115203,
  diffuseMagic:       122783,
  // Interrupt
  spearHandStrike:    116705,
  // Racials
  berserking:         26297,
};

// Aura IDs (may differ from cast IDs — verified on Wowhead)
const A = {
  // Heals
  renewingMist:           119607,   // HoT aura on target (cast is 115151)
  envelopingMist:         124682,   // HoT aura on target (same as cast ID)
  soothingMist:           115175,   // Channel aura
  lifeCocoon:             116849,   // Absorb shield (same as cast ID)
  // Thunder Focus Tea
  thunderFocusTea:        116680,   // Buff on player (same as cast ID, 30s duration)
  // Procs
  vivaciousVivification:  392883,   // Instant Vivify proc (from RSK — different from talent 388812!)
  teachingsOfMonastery:   202090,   // Stacking buff (passive talent is 116645)
  // Secret Infusion stat buff
  secretInfusion:         388496,   // Stat buff from TFT spell choice
  // Celestials
  invokeYulon:            322118,
  invokeChiJi:            325197,
  // Conduit of the Celestials hero
  celestialConduit:       443028,
  heartOfJadeSerpent:     443421,   // CDR window buff (passive talent is 443294)
  unityWithin:            443592,   // Unity Within buff (443421 is HotJS buff)
  // Master of Harmony hero
  aspectOfHarmony:        450508,   // Accumulator passive
  aspectOfHarmonySpender: 450711,   // Spender window buff from TFT
  // Mana
  manaTea:                197908,   // Mana cost reduction buff (30% for 10s)
  manaTeaStacks:          115867,   // Stacks accumulated (channel spell)
  // DPS
  mysticTouch:            8647,     // Debuff on target (5% phys damage taken)
  // Procs (Method guide priorities)
  spiritfont:             1260565,  // Stacking proc — EnvM at 2 stacks
  zenPulse:               124081,   // Stacking proc — Vivify at 2 stacks
  strengthBlackOx:        443110,   // Faster EnvM proc
  // Defensives
  fortifyingBrew:         120954,   // Buff aura (cast is 115203)
  diffuseMagic:           122783,
  // Bloodlust variants
  bloodlust:              2825,
};

// Talent IDs for spell.isSpellKnown() checks (NOT buff aura IDs)
const T = {
  // Hero talents
  celestialConduit:       443028,   // Conduit of the Celestials exclusive
  aspectOfHarmony:        450508,   // Master of Harmony exclusive
  heartOfJadeSerpent:     443294,   // Conduit passive
  // Choice nodes
  invokeYulon:            322118,
  invokeChiJi:            325197,
  revival:                115310,
  restoral:               388615,
  // Key talents
  risingMist:             274909,   // RSK extends ReM/EnvM by 4s
  ancientTeachings:       388023,   // DPS heals allies for 25% damage
  secretInfusion:         388491,   // TFT grants stat buff
  rapidDiffusion:         388847,   // RSK/EnvM spreads 6s ReM
  vivaciousVivification:  388812,   // RSK makes next Vivify instant
  poolOfMists:            173841,   // ReM 3 charges
  manaTea:                115867,   // Mana regen talent
  chrysalis:              202424,   // Life Cocoon CD -45s
  upliftedSpirits:        388551,   // Revival/Restoral CD -30s + 15% healing
  focusedThunder:         197895,   // TFT empowers next 2 spells
  endlessDraught:         450892,   // TFT +1 charge (3 total)
  jadeInfusion:           1242910,  // TFT summons Jade Serpent Statue
  morningBreeze:          1277302,  // RSK damage += mastery, TFT resets RSK
  zenPulse:               124081,   // ReM HoT proc on Vivify/Sheilun's Gift
  deepClarity:            446345,   // TFT full consume triggers Zen Pulse
  emperorsFavor:          471761,   // Sheilun's Gift instant + 20% healing
  wayOfTheCrane:          388779,   // Tiger Palm/BOK/SCK melee enhancements
  rushingWindKick:        1269159,  // Apex replacement for RSK
  sheilunsGift:           399491,   // Sheilun's Gift talent
};

// Bloodlust aura IDs (all variants)
const BLOODLUST_IDS = [2825, 32182, 80353, 264667, 390386, 386540];

export class MistweaverMonkBehavior extends Behavior {
  name = 'FW Mistweaver Monk';
  context = BehaviorContext.Any;
  specialization = Specialization.Monk.Mistweaver;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _healFrame = 0;
  _cachedLowest = null;
  _cachedLowestHP = 100;
  _cachedTankLowest = null;
  _cachedTankLowestHP = 100;
  _cachedBelow20 = 0;
  _cachedBelow35 = 0;
  _cachedBelow60 = 0;
  _cachedBelow85 = 0;
  _dpsTargetFrame = 0;
  _cachedDpsTarget = null;
  _manaFrame = 0;
  _cachedMana = 100;
  _tftFrame = 0;
  _cachedTFTStacks = 0;
  _tftRemaining = 0;
  _remTargetFrame = 0;
  _cachedRemTargets = {};
  _envmTargetFrame = 0;
  _cachedEnvmTargets = {};
  _cocoonTargetFrame = 0;
  _cachedCocoonTarget = null;
  _vivaciousFrame = 0;
  _cachedVivacious = false;
  _teachingsFrame = 0;
  _cachedTeachingsStacks = 0;
  _bloodlustFrame = 0;
  _cachedBloodlust = false;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'Healing Thresholds',
      options: [
        { type: 'slider', uid: 'FWMWEmergencyHP', text: 'Emergency HP %', default: 20, min: 5, max: 35 },
        { type: 'slider', uid: 'FWMWCriticalHP', text: 'Critical HP %', default: 35, min: 20, max: 50 },
        { type: 'slider', uid: 'FWMWUrgentHP', text: 'Urgent HP %', default: 70, min: 40, max: 80 },
        { type: 'slider', uid: 'FWMWMaintHP', text: 'Maintenance HP %', default: 90, min: 70, max: 95 },
        { type: 'slider', uid: 'FWMWDpsThreshold', text: 'DPS when all above %', default: 95, min: 70, max: 100 },
      ],
    },
    {
      header: 'Major Cooldowns (OFF = manual/raid assignment)',
      options: [
        { type: 'checkbox', uid: 'FWMWRevival', text: 'Auto Revival/Restoral', default: false },
        { type: 'slider', uid: 'FWMWRevivalHP', text: 'Revival avg HP %', default: 35, min: 15, max: 55 },
        { type: 'slider', uid: 'FWMWRevivalCount', text: 'Revival min targets below', default: 3, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWMWCelestial', text: 'Auto Invoke Yu\'lon/Chi-Ji', default: false },
        { type: 'slider', uid: 'FWMWCelestialHP', text: 'Celestial avg HP %', default: 50, min: 20, max: 70 },
        { type: 'slider', uid: 'FWMWCelestialCount', text: 'Celestial min targets below', default: 2, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWMWConduit', text: 'Auto Celestial Conduit', default: false },
        { type: 'slider', uid: 'FWMWConduitHP', text: 'Conduit avg HP %', default: 50, min: 20, max: 70 },
      ],
    },
    {
      header: 'Life Cocoon',
      options: [
        { type: 'checkbox', uid: 'FWMWCocoon', text: 'Auto Life Cocoon', default: true },
        { type: 'slider', uid: 'FWMWCocoonHP', text: 'Life Cocoon HP %', default: 25, min: 10, max: 50 },
      ],
    },
    {
      header: 'Self-Defense',
      options: [
        { type: 'checkbox', uid: 'FWMWFortBrew', text: 'Use Fortifying Brew', default: true },
        { type: 'slider', uid: 'FWMWFortBrewHP', text: 'Fortifying Brew HP %', default: 35, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWMWDiffuse', text: 'Use Diffuse Magic', default: true },
        { type: 'slider', uid: 'FWMWDiffuseHP', text: 'Diffuse Magic HP %', default: 45, min: 15, max: 70 },
      ],
    },
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWMWSoothingMist', text: 'Use Soothing Mist channel', default: true },
        { type: 'checkbox', uid: 'FWMWDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // ===== Hero Talent Detection =====
  isConduitOfTheCelestials() {
    return spell.isSpellKnown(T.celestialConduit) || spell.isSpellKnown(T.heartOfJadeSerpent);
  }

  isMasterOfHarmony() {
    return !this.isConduitOfTheCelestials();
  }

  // Choice node detection
  hasYulon() {
    return spell.isSpellKnown(T.invokeYulon);
  }

  hasChiJi() {
    return spell.isSpellKnown(T.invokeChiJi);
  }

  hasRevival() {
    return spell.isSpellKnown(T.revival);
  }

  hasRestoral() {
    return spell.isSpellKnown(T.restoral);
  }

  hasRisingMist() {
    return spell.isSpellKnown(T.risingMist);
  }

  hasAncientTeachings() {
    return spell.isSpellKnown(T.ancientTeachings);
  }

  hasRushingWindKick() {
    return spell.isSpellKnown(T.rushingWindKick);
  }

  hasSheilunsGift() {
    return spell.isSpellKnown(T.sheilunsGift);
  }

  hasEmperorsFavor() {
    return spell.isSpellKnown(T.emperorsFavor);
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
    let below35 = 0;
    let below60 = 0;
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
      if (hp <= 35) below35++;
      if (hp <= 60) below60++;
      if (hp <= 85) below85++;
    }

    // Ensure self is counted
    if (!selfCounted) {
      const selfHP = me.effectiveHealthPercent;
      if (selfHP < lowestHP) { lowestHP = selfHP; lowest = me; }
      if (selfHP <= 20) below20++;
      if (selfHP <= 35) below35++;
      if (selfHP <= 60) below60++;
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
    this._cachedBelow35 = below35;
    this._cachedBelow60 = below60;
    this._cachedBelow85 = below85;

    // Invalidate dependent caches
    this._remTargetFrame = 0;
    this._cachedRemTargets = {};
    this._envmTargetFrame = 0;
    this._cachedEnvmTargets = {};
    this._cocoonTargetFrame = 0;
  }

  // Thunder Focus Tea cache
  _refreshTFTCache() {
    if (this._tftFrame === wow.frameTime) return;
    this._tftFrame = wow.frameTime;
    const aura = me.getAura(A.thunderFocusTea);
    this._cachedTFTStacks = aura ? (aura.stacks || 1) : 0;
    this._tftRemaining = aura ? aura.remaining : 0;
  }

  hasTFT() {
    this._refreshTFTCache();
    return this._cachedTFTStacks > 0;
  }

  getTFTRemaining() {
    this._refreshTFTCache();
    return this._tftRemaining;
  }

  // Vivacious Vivification proc cache
  hasVivaciousVivification() {
    if (this._vivaciousFrame === wow.frameTime) return this._cachedVivacious;
    this._vivaciousFrame = wow.frameTime;
    this._cachedVivacious = me.hasAura(A.vivaciousVivification);
    return this._cachedVivacious;
  }

  // Teachings of the Monastery stacks cache
  getTeachingsStacks() {
    if (this._teachingsFrame === wow.frameTime) return this._cachedTeachingsStacks;
    this._teachingsFrame = wow.frameTime;
    const aura = me.getAura(A.teachingsOfMonastery);
    this._cachedTeachingsStacks = aura ? (aura.stacks || 0) : 0;
    return this._cachedTeachingsStacks;
  }

  // Bloodlust cache
  hasBloodlust() {
    if (this._bloodlustFrame === wow.frameTime) return this._cachedBloodlust;
    this._bloodlustFrame = wow.frameTime;
    this._cachedBloodlust = BLOODLUST_IDS.some(id => me.hasAura(id));
    return this._cachedBloodlust;
  }

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
    if (hp <= 35) return this._cachedBelow35;
    if (hp <= 60) return this._cachedBelow60;
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

  // Renewing Mist target: prioritize tanks without ReM, then lowest HP without ReM
  // Pandemic: refresh if remaining < 6s (30% of 20s duration)
  getRenewingMistTarget(maxHP) {
    this._refreshHealCache();
    const key = maxHP;
    if (this._remTargetFrame === wow.frameTime && key in this._cachedRemTargets) {
      return this._cachedRemTargets[key];
    }
    this._remTargetFrame = wow.frameTime;

    let result = null;

    // Check tanks first — they benefit most from constant ReM
    const tanks = heal.friends.Tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40 &&
          tank.effectiveHealthPercent <= Math.min(maxHP + 15, 95)) {
        const remAura = tank.getAuraByMe(A.renewingMist);
        if (!remAura || remAura.remaining < 6000) { result = tank; break; }
      }
    }

    // Then check all friends
    if (!result) {
      const friends = heal.friends.All;
      for (let i = 0; i < friends.length; i++) {
        const unit = friends[i];
        if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
            unit.effectiveHealthPercent <= maxHP) {
          const remAura = unit.getAuraByMe(A.renewingMist);
          if (!remAura || remAura.remaining < 6000) { result = unit; break; }
        }
      }
    }

    this._cachedRemTargets[key] = result;
    return result;
  }

  // Enveloping Mist target: prioritize tanks, then lowest HP without EnvM
  getEnvelopingMistTarget(maxHP) {
    this._refreshHealCache();
    const key = maxHP;
    if (this._envmTargetFrame === wow.frameTime && key in this._cachedEnvmTargets) {
      return this._cachedEnvmTargets[key];
    }
    this._envmTargetFrame = wow.frameTime;

    let result = null;
    const tanks = heal.friends.Tanks;
    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40 &&
          tank.effectiveHealthPercent <= maxHP) {
        const envAura = tank.getAuraByMe(A.envelopingMist);
        if (!envAura || envAura.remaining < 2000) { result = tank; break; }
      }
    }
    if (!result) {
      const friends = heal.friends.All;
      for (let i = 0; i < friends.length; i++) {
        const unit = friends[i];
        if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
            unit.effectiveHealthPercent <= maxHP) {
          const envAura = unit.getAuraByMe(A.envelopingMist);
          if (!envAura || envAura.remaining < 2000) { result = unit; break; }
        }
      }
    }

    this._cachedEnvmTargets[key] = result;
    return result;
  }

  // Life Cocoon target: lowest HP ally below threshold
  getCocoonTarget() {
    if (this._cocoonTargetFrame === wow.frameTime) return this._cachedCocoonTarget;
    this._cocoonTargetFrame = wow.frameTime;

    if (spell.getTimeSinceLastCast(S.lifeCocoon) < 3000) {
      this._cachedCocoonTarget = null;
      return null;
    }

    const threshold = Settings.FWMWCocoonHP;
    let result = null;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
          unit.effectiveHealthPercent <= threshold) {
        // Don't cocoon if already has cocoon
        if (unit.hasAura(A.lifeCocoon)) continue;
        result = unit;
        break;
      }
    }
    this._cachedCocoonTarget = result;
    return result;
  }

  // DPS target helper
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

  // Get melee DPS target (within 5 yards for melee abilities)
  getMeleeTarget() {
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 5) {
      return target;
    }
    return (combat.bestTarget && me.distanceTo(combat.bestTarget) <= 5) ? combat.bestTarget : null;
  }

  // Enemy count around melee target
  getEnemyCount() {
    const target = this.getMeleeTarget();
    if (!target) return 0;
    return target.getUnitsAroundCount(8) + 1;
  }

  // ===== Mana Management =====
  isLowMana() {
    return this.getManaPercent() < 30;
  }

  hasManaFor(spellType) {
    const mana = this.getManaPercent();
    if (mana < 5) return false;
    if (mana < 15 && spellType === 'envelopingMist') return false;
    if (mana < 10 && spellType === 'vivify') return false;
    return true;
  }

  // ===== Burst Detection =====
  inCelestialWindow() {
    return me.hasAura(A.invokeYulon) || me.hasAura(A.invokeChiJi);
  }

  inHeartOfJadeSerpent() {
    return me.hasAura(A.heartOfJadeSerpent);
  }

  hasUnityWithin() {
    return me.hasAura(A.unityWithin);
  }

  hasAspectSpender() {
    return me.hasAura(A.aspectOfHarmonySpender);
  }

  // ===== Cast Cancellation =====
  shouldStopCasting() {
    if (!me.isCastingOrChanneling) return false;
    const currentCast = me.currentCastOrChannel;
    if (!currentCast || currentCast.timeleft < 500) return false;

    const castId = currentCast.spellId;
    // Cancel DPS casts when emergency healing needed
    const isDamageCast = castId === S.cracklingJadeLightning || castId === S.spinningCraneKick;
    if (isDamageCast && this._cachedLowestHP < Settings.FWMWCriticalHP) return true;
    return false;
  }

  // ===== Soothing Mist Channel Check =====
  // Returns true if currently channeling Soothing Mist on a target
  isChannelingSoothingMist() {
    if (!me.isCastingOrChanneling) return false;
    const currentCast = me.currentCastOrChannel;
    return currentCast && currentCast.spellId === S.soothingMist;
  }

  // ===== TTD Helper =====
  targetTTD() {
    const target = this.getDpsTarget();
    if (!target || !target.timeToDeath) return 99999;
    return target.timeToDeath();
  }

  // ===== Mystic Touch Target =====
  getMysticTouchTarget() {
    const target = this.getMeleeTarget();
    if (!target) return null;
    if (spell.getTimeSinceLastCast(S.tigerPalm) < 3000) return null;
    // Mystic Touch is applied passively by damage, just need to hit something
    if (!target.hasAura(A.mysticTouch)) return target;
    return null;
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      // Pre-combat
      common.waitForNotMounted(),
      common.waitForNotSitting(),

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

      // Cast/channel check — wait if already casting/channeling (EXCEPT Soothing Mist — handled inline)
      new bt.Decorator(
        () => me.isCastingOrChanneling && !this.isChannelingSoothingMist(),
        new bt.Action(() => bt.Status.Success)
      ),

      // Version log (once)
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isConduitOfTheCelestials() ? 'Conduit of the Celestials' : 'Master of Harmony';
          const celestial = this.hasYulon() ? 'Yu\'lon' : 'Chi-Ji';
          const bigHeal = this.hasRevival() ? 'Revival' : 'Restoral';
          console.info(`[Mistweaver] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | Hero: ${hero} | Celestial: ${celestial} | Big Heal: ${bigHeal} | ${SCRIPT_VERSION.guide}`);
        }
        return bt.Status.Failure;
      }),

      // Refresh heal cache + debug
      new bt.Action(() => {
        this._refreshHealCache();
        if (Settings.FWMWDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const mana = Math.round(this.getManaPercent());
          const lowestHP = Math.round(this._cachedLowestHP);
          const tankHP = Math.round(this._cachedTankLowestHP);
          const tft = this.hasTFT();
          const vivProc = this.hasVivaciousVivification();
          const celestial = this.inCelestialWindow();
          const dpsMode = this._cachedLowestHP >= Settings.FWMWDpsThreshold;
          const hotjs = this.inHeartOfJadeSerpent();
          console.info(`[MW] Lowest:${lowestHP}% Tank:${tankHP}% <35:${this._cachedBelow35} <60:${this._cachedBelow60} Mana:${mana}% TFT:${tft} Viv:${vivProc} Cel:${celestial} HotJS:${hotjs} DPS:${dpsMode}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // 1. Interrupt (Spear Hand Strike — melee range only)
          spell.interrupt(S.spearHandStrike),

          // 2. Dispels (Detox: Magic + Poison + Disease)
          this.dispels(),

          // 3. Movement handling (instants while moving)
          this.movementHealing(),

          // 4. Emergency healing (Tier 1: < 20%)
          this.emergencyHealing(),

          // 5. Defensives (self + externals)
          this.defensives(),

          // 6. Major CDs (OFF by default)
          this.majorCooldowns(),

          // 7. Thunder Focus Tea usage
          this.thunderFocusTea(),

          // 8. Heart of the Jade Serpent CDR window (CotC — special priority)
          this.heartOfJadeSerpentWindow(),

          // 8b. Celestial window healing (Yu'lon or Chi-Ji active)
          this.celestialWindowHealing(),

          // 9. Renewing Mist maintenance (high priority — charge fractional)
          this.renewingMistMaintenance(),

          // 10. Healing rotation (Tiers 2-4)
          this.healingRotation(),

          // 11. Mana Tea consumption
          this.manaTeaConsumption(),

          // 12. DPS rotation (nobody needs healing)
          this.dpsRotation(),
        )
      ),
    );
  }

  // ===== DISPELS =====
  dispels() {
    return new bt.Selector(
      // Detox: Magic + Poison + Disease (Mistweaver version)
      spell.dispel(S.detox, true, DispelPriority.High, false, WoWDispelType.Magic),
      spell.dispel(S.detox, true, DispelPriority.High, false, WoWDispelType.Poison),
      spell.dispel(S.detox, true, DispelPriority.High, false, WoWDispelType.Disease),
      spell.dispel(S.detox, true, DispelPriority.Medium, false, WoWDispelType.Magic),
      spell.dispel(S.detox, true, DispelPriority.Medium, false, WoWDispelType.Poison),
      spell.dispel(S.detox, true, DispelPriority.Medium, false, WoWDispelType.Disease),
    );
  }

  // ===== MOVEMENT HEALING =====
  movementHealing() {
    return new bt.Decorator(
      () => me.isMoving(),
      new bt.Selector(
        // ----- Instant heals while moving -----

        // Life Cocoon on critically low ally (instant, off-GCD style)
        spell.cast(S.lifeCocoon, () => this.getCocoonTarget(), () => {
          return Settings.FWMWCocoon && this.getCocoonTarget() !== null;
        }),

        // Renewing Mist (instant, charge-based)
        spell.cast(S.renewingMist, () => this.getRenewingMistTarget(Settings.FWMWMaintHP), () => {
          return this.getRenewingMistTarget(Settings.FWMWMaintHP) !== null &&
            spell.getChargesFractional(S.renewingMist) > 0.8;
        }),

        // Vivify with Vivacious Vivification proc (instant after RSK)
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWUrgentHP), () => {
          return this.hasVivaciousVivification() && this.getHealTarget(Settings.FWMWUrgentHP) !== null;
        }),

        // Sheilun's Gift with Emperor's Favor (instant)
        spell.cast(S.sheilunsGift, () => this.getHealTarget(Settings.FWMWUrgentHP), () => {
          return this.hasSheilunsGift() && this.hasEmperorsFavor() &&
            this.getHealTarget(Settings.FWMWUrgentHP) !== null;
        }),

        // Thunder Focus Tea (instant, self-cast)
        spell.cast(S.thunderFocusTea, () => me, () => {
          return !this.hasTFT() && this._cachedLowestHP < Settings.FWMWUrgentHP;
        }),

        // Expel Harm (instant self-heal)
        spell.cast(S.expelHarm, () => me, () => {
          return me.effectiveHealthPercent < 60;
        }),

        // Celestial Conduit (channeled while moving! — Conduit hero)
        spell.cast(S.celestialConduit, () => me, () => {
          if (!this.isConduitOfTheCelestials()) return false;
          if (!Settings.FWMWConduit) return false;
          return this._cachedBelow60 >= 2;
        }),

        // Rising Sun Kick (instant melee — triggers Rising Mist extension + Vivacious Vivification)
        spell.cast(S.risingSunKick, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
        }),

        // Rushing Wind Kick (instant melee — apex talent, heals allies)
        spell.cast(S.rushingWindKick, () => this.getMeleeTarget(), () => {
          return this.hasRushingWindKick() && this.getMeleeTarget() !== null;
        }),

        // Tiger Palm (instant melee — generates Teachings stacks + Mystic Touch)
        spell.cast(S.tigerPalm, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
        }),

        // Blackout Kick (instant melee — 12% RSK reset, consumes Teachings)
        spell.cast(S.blackoutKick, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
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
        // Life Cocoon — emergency absorb shield + 50% HoT amplification
        spell.cast(S.lifeCocoon, () => this.getCocoonTarget(), () => {
          return Settings.FWMWCocoon && this.getCocoonTarget() !== null;
        }),

        // Thunder Focus Tea (if available, to empower next heal)
        spell.cast(S.thunderFocusTea, () => me, () => {
          return !this.hasTFT();
        }),

        // Vivify with Vivacious Vivification proc (instant)
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWEmergencyHP), () => {
          return this.hasVivaciousVivification();
        }),

        // TFT Vivify (no mana cost when TFT empowered)
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWEmergencyHP), () => {
          return this.hasTFT();
        }),

        // Renewing Mist on emergency target (instant)
        spell.cast(S.renewingMist, () => this.getHealTarget(Settings.FWMWEmergencyHP), () => {
          const target = this.getHealTarget(Settings.FWMWEmergencyHP);
          if (!target) return false;
          const remAura = target.getAuraByMe(A.renewingMist);
          return !remAura || remAura.remaining < 6000;
        }),

        // Expel Harm (instant self-heal if self is dying)
        spell.cast(S.expelHarm, () => me, () => {
          return me.effectiveHealthPercent < Settings.FWMWEmergencyHP;
        }),

        // Sheilun's Gift (instant with Emperor's Favor, or cast-time)
        spell.cast(S.sheilunsGift, () => this.getHealTarget(Settings.FWMWEmergencyHP), () => {
          return this.hasSheilunsGift() && this.getHealTarget(Settings.FWMWEmergencyHP) !== null;
        }),

        // Vivify hard-cast (emergency fallback — cleaves to all ReM targets)
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWEmergencyHP)),
      )
    );
  }

  // ===== DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      // Fortifying Brew (self, 15s duration, 6min CD — major DR)
      spell.cast(S.fortifyingBrew, () => me, () => {
        return Settings.FWMWFortBrew && me.inCombat() &&
          me.effectiveHealthPercent < Settings.FWMWFortBrewHP;
      }),

      // Diffuse Magic (self, 6s 60% magic DR)
      spell.cast(S.diffuseMagic, () => me, () => {
        return Settings.FWMWDiffuse && me.inCombat() &&
          me.effectiveHealthPercent < Settings.FWMWDiffuseHP;
      }),

      // Life Cocoon on ally (if not already handled by emergency)
      spell.cast(S.lifeCocoon, () => this.getCocoonTarget(), () => {
        return Settings.FWMWCocoon && this.getCocoonTarget() !== null &&
          this._cachedLowestHP < Settings.FWMWCocoonHP;
      }),
    );
  }

  // ===== MAJOR COOLDOWNS (OFF by default) =====
  majorCooldowns() {
    return new bt.Selector(
      // Revival / Restoral — raid-wide heal + dispel
      spell.cast(S.revival, () => me, () => {
        if (!Settings.FWMWRevival || !this.hasRevival()) return false;
        return this.getFriendsBelow(Settings.FWMWRevivalHP) >= Settings.FWMWRevivalCount;
      }),
      spell.cast(S.restoral, () => me, () => {
        if (!Settings.FWMWRevival || !this.hasRestoral()) return false;
        return this.getFriendsBelow(Settings.FWMWRevivalHP) >= Settings.FWMWRevivalCount;
      }),

      // Invoke Yu'lon — 25s, Soothing Breath heals, -50% EnvM mana cost
      spell.cast(S.invokeYulon, () => me, () => {
        if (!Settings.FWMWCelestial || !this.hasYulon()) return false;
        return this.getFriendsBelow(Settings.FWMWCelestialHP) >= Settings.FWMWCelestialCount;
      }),

      // Invoke Chi-Ji — 25s, instant EnvM, 3 Gusts per melee
      spell.cast(S.invokeChiJi, () => me, () => {
        if (!Settings.FWMWCelestial || !this.hasChiJi()) return false;
        return this.getFriendsBelow(Settings.FWMWCelestialHP) >= Settings.FWMWCelestialCount;
      }),

      // Celestial Conduit (Conduit hero, OFF by default)
      spell.cast(S.celestialConduit, () => me, () => {
        if (!Settings.FWMWConduit || !this.isConduitOfTheCelestials()) return false;
        return this._cachedBelow60 >= 2 &&
          this.getFriendsBelow(Settings.FWMWConduitHP) >= 2;
      }),
    );
  }

  // ===== THUNDER FOCUS TEA =====
  thunderFocusTea() {
    return new bt.Selector(
      // Pop TFT when healing needed and no buff active
      spell.cast(S.thunderFocusTea, () => me, () => {
        if (this.hasTFT()) return false;
        // Use on CD for Heart of Jade Serpent CDR window (Conduit)
        if (this.isConduitOfTheCelestials()) return true;
        // Use on CD for Aspect of Harmony vitality withdraw (MoH)
        if (this.isMasterOfHarmony()) return true;
        // Fallback: use when healing needed
        return this._cachedBelow85 >= 1;
      }),

      // Consume TFT: prioritize based on situation
      // TFT + Renewing Mist = +10s duration (best for ReM spread + Secret Infusion haste)
      // TFT + Enveloping Mist = instant cast + heal (best for emergency)
      // TFT + Rising Sun Kick = -9s CD (best for Rising Mist extension + DPS)

      // TFT + EnvM when critical healing needed (instant EnvM)
      spell.cast(S.envelopingMist, () => this.getHealTarget(Settings.FWMWCriticalHP), () => {
        if (!this.hasTFT()) return false;
        return this.getHealTarget(Settings.FWMWCriticalHP) !== null;
      }),

      // TFT + ReM when no critical healing (extended duration, Secret Infusion haste)
      spell.cast(S.renewingMist, () => this.getRenewingMistTarget(Settings.FWMWMaintHP), () => {
        if (!this.hasTFT()) return false;
        if (this._cachedLowestHP < Settings.FWMWCriticalHP) return false;
        return this.getRenewingMistTarget(Settings.FWMWMaintHP) !== null;
      }),

      // TFT + RSK when DPSing (Morning Breeze: TFT resets RSK CD)
      spell.cast(S.risingSunKick, () => this.getMeleeTarget(), () => {
        if (!this.hasTFT()) return false;
        if (this._cachedLowestHP < Settings.FWMWUrgentHP) return false;
        return this.getMeleeTarget() !== null;
      }),
    );
  }

  // ===== HEART OF THE JADE SERPENT WINDOW (CotC — 8s CDR priority) =====
  // Method: separate priority list when HotJS buff is active (75% CDR for 8s)
  heartOfJadeSerpentWindow() {
    return new bt.Decorator(
      () => this.isConduitOfTheCelestials() && this.inHeartOfJadeSerpent(),
      new bt.Selector(
        // 1. Renewing Mist at 3 charges (max charges — don't cap during CDR window)
        spell.cast(S.renewingMist, () => this.getRenewingMistTarget(95), () =>
          this.getRenewingMistTarget(95) !== null && spell.getCharges(S.renewingMist) >= 3
        ),

        // 2. Rushing Wind Kick (instant, heals allies)
        spell.cast(S.rushingWindKick, () => this.getMeleeTarget(), () =>
          this.hasRushingWindKick() && this.getMeleeTarget() !== null
        ),

        // 2b. Rising Sun Kick (if no RWK)
        spell.cast(S.risingSunKick, () => this.getMeleeTarget(), () =>
          !this.hasRushingWindKick() && this.getMeleeTarget() !== null
        ),

        // 3. Vivify at 2 Zen Pulse stacks
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWMaintHP), () => {
          const zp = me.getAura(A.zenPulse);
          return zp && zp.stacks >= 2 && this.getHealTarget(Settings.FWMWMaintHP) !== null;
        }),

        // 4. Enveloping Mist at 2 Spiritfont stacks
        spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWMaintHP), () => {
          const sf = me.getAura(A.spiritfont);
          return sf && sf.stacks >= 2 && this.getEnvelopingMistTarget(Settings.FWMWMaintHP) !== null;
        }),

        // 5. Thunder Focus Tea (triggers another HotJS window via CDR loop)
        spell.cast(S.thunderFocusTea, () => me, () => !this.hasTFT()),

        // 6. Renewing Mist (any charges — keep spreading during CDR window)
        spell.cast(S.renewingMist, () => this.getRenewingMistTarget(95), () =>
          this.getRenewingMistTarget(95) !== null && spell.getChargesFractional(S.renewingMist) >= 1
        ),

        // 7. Life Cocoon if someone injured
        spell.cast(S.lifeCocoon, () => this.getCocoonTarget(), () =>
          Settings.FWMWCocoon && this.getCocoonTarget() !== null
        ),

        // 8. Vivacious Vivification proc (instant Vivify)
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWMaintHP), () =>
          this.hasVivaciousVivification() && this.getHealTarget(Settings.FWMWMaintHP) !== null
        ),

        // 9. Enveloping Mist with Strength of the Black Ox (faster cast)
        spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWMaintHP), () =>
          me.hasAura(A.strengthBlackOx) && this.getEnvelopingMistTarget(Settings.FWMWMaintHP) !== null
        ),
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== CELESTIAL WINDOW HEALING =====
  celestialWindowHealing() {
    return new bt.Decorator(
      () => this.inCelestialWindow(),
      new bt.Selector(
        // During Yu'lon: spam Enveloping Mist (-50% mana cost) + Vivify
        // During Chi-Ji: Enveloping Mist is instant, use between melee GCDs

        // Renewing Mist (keep spreading for Invigorating Mists cleave)
        spell.cast(S.renewingMist, () => this.getRenewingMistTarget(95), () => {
          return this.getRenewingMistTarget(95) !== null &&
            spell.getChargesFractional(S.renewingMist) > 1.4;
        }),

        // Rising Sun Kick (extends ReM/EnvM via Rising Mist + triggers Vivacious Vivification)
        spell.cast(S.risingSunKick, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
        }),

        // Rushing Wind Kick (heals allies with HoTs)
        spell.cast(S.rushingWindKick, () => this.getMeleeTarget(), () => {
          return this.hasRushingWindKick() && this.getMeleeTarget() !== null;
        }),

        // Vivify with Vivacious Vivification proc (instant — high priority to consume)
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWMaintHP), () => {
          return this.hasVivaciousVivification() && this.getHealTarget(Settings.FWMWMaintHP) !== null;
        }),

        // Enveloping Mist (instant with Chi-Ji, -50% mana with Yu'lon)
        spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWMaintHP), () => {
          return this.getEnvelopingMistTarget(Settings.FWMWMaintHP) !== null;
        }),

        // Blackout Kick (Chi-Ji: 3 Gusts of Mists, 12% RSK reset chance)
        spell.cast(S.blackoutKick, () => this.getMeleeTarget(), () => {
          return me.hasAura(A.invokeChiJi) && this.getMeleeTarget() !== null;
        }),

        // Tiger Palm (generate Teachings stacks for Blackout Kick)
        spell.cast(S.tigerPalm, () => this.getMeleeTarget(), () => {
          return me.hasAura(A.invokeChiJi) && this.getMeleeTarget() !== null &&
            this.getTeachingsStacks() < 4;
        }),

        // Spinning Crane Kick (Chi-Ji: 3 Gusts + Way of Crane healing)
        spell.cast(S.spinningCraneKick, () => this.getMeleeTarget(), () => {
          return me.hasAura(A.invokeChiJi) && this.getMeleeTarget() !== null &&
            this.getEnemyCount() >= 3;
        }),

        // Vivify filler during celestial window
        spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWMaintHP), () => {
          return this.getHealTarget(Settings.FWMWMaintHP) !== null;
        }),
      )
    );
  }

  // ===== RENEWING MIST MAINTENANCE =====
  renewingMistMaintenance() {
    return new bt.Selector(
      // High priority: don't cap charges — use charge fractional tracking
      spell.cast(S.renewingMist, () => this.getRenewingMistTarget(95), () => {
        // At 2.4+ charges, we're about to cap — cast immediately
        return this.getRenewingMistTarget(95) !== null &&
          spell.getChargesFractional(S.renewingMist) > 2.4;
      }),

      // Regular maintenance: spread ReM when 1.4+ fractional charges
      spell.cast(S.renewingMist, () => this.getRenewingMistTarget(Settings.FWMWMaintHP), () => {
        return this.getRenewingMistTarget(Settings.FWMWMaintHP) !== null &&
          spell.getChargesFractional(S.renewingMist) > 1.4;
      }),
    );
  }

  // ===== HEALING ROTATION (Tiers 2-4) =====
  healingRotation() {
    return new bt.Selector(
      // ===== Tier 2: CRITICAL (< 35%) =====

      // Vivify with Vivacious Vivification proc (instant — top priority)
      spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWCriticalHP), () => {
        return this.hasVivaciousVivification() && this.getHealTarget(Settings.FWMWCriticalHP) !== null;
      }),

      // Renewing Mist on critical target (instant, spreads via Dancing Mists)
      spell.cast(S.renewingMist, () => this.getHealTarget(Settings.FWMWCriticalHP), () => {
        const target = this.getHealTarget(Settings.FWMWCriticalHP);
        if (!target) return false;
        const remAura = target.getAuraByMe(A.renewingMist);
        return (!remAura || remAura.remaining < 6000) &&
          spell.getChargesFractional(S.renewingMist) >= 1;
      }),

      // Enveloping Mist on critical target (strong HoT + 10% healing amp)
      spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWCriticalHP), () => {
        return this.getEnvelopingMistTarget(Settings.FWMWCriticalHP) !== null &&
          this.hasManaFor('envelopingMist');
      }),

      // Sheilun's Gift on critical target
      spell.cast(S.sheilunsGift, () => this.getHealTarget(Settings.FWMWCriticalHP), () => {
        return this.hasSheilunsGift() && this.getHealTarget(Settings.FWMWCriticalHP) !== null;
      }),

      // Vivify hard-cast on critical target (cleaves to all ReM targets)
      spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWCriticalHP), () => {
        return this.getHealTarget(Settings.FWMWCriticalHP) !== null &&
          this.hasManaFor('vivify');
      }),

      // ===== Tier 3: URGENT (< 60%) =====

      // Vivify with Vivacious Vivification proc (instant — consume before it expires)
      spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWUrgentHP), () => {
        return this.hasVivaciousVivification() && this.getHealTarget(Settings.FWMWUrgentHP) !== null;
      }),

      // Enveloping Mist with Spiritfont 2 stacks (Method priority)
      spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWUrgentHP), () => {
        const sf = me.getAura(A.spiritfont);
        return sf && sf.stacks >= 2 && this.getEnvelopingMistTarget(Settings.FWMWUrgentHP) !== null;
      }),

      // Enveloping Mist with Strength of the Black Ox proc (faster cast)
      spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWUrgentHP), () =>
        me.hasAura(A.strengthBlackOx) && this.getEnvelopingMistTarget(Settings.FWMWUrgentHP) !== null
      ),

      // Renewing Mist spread (charge fractional aware)
      spell.cast(S.renewingMist, () => this.getRenewingMistTarget(Settings.FWMWUrgentHP), () => {
        return this.getRenewingMistTarget(Settings.FWMWUrgentHP) !== null &&
          spell.getChargesFractional(S.renewingMist) > 1.4;
      }),

      // Enveloping Mist on urgent targets
      spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWUrgentHP), () => {
        return this.getEnvelopingMistTarget(Settings.FWMWUrgentHP) !== null &&
          this.hasManaFor('envelopingMist') && !this.isLowMana();
      }),

      // Sheilun's Gift on urgent target
      spell.cast(S.sheilunsGift, () => this.getHealTarget(Settings.FWMWUrgentHP), () => {
        return this.hasSheilunsGift() && this.getHealTarget(Settings.FWMWUrgentHP) !== null;
      }),

      // Expel Harm (instant self-heal when hurt)
      spell.cast(S.expelHarm, () => me, () => {
        return me.effectiveHealthPercent < 60;
      }),

      // Vivify (hard-cast, cleaves via Invigorating Mists to all ReM targets)
      spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWUrgentHP), () => {
        return this.getHealTarget(Settings.FWMWUrgentHP) !== null &&
          this.hasManaFor('vivify');
      }),

      // ===== Soothing Mist channel for urgent ST healing =====
      // Only channel when: target needs sustained healing, not moving, option enabled
      new bt.Decorator(
        () => Settings.FWMWSoothingMist && !me.isMoving() && this._cachedLowestHP < Settings.FWMWUrgentHP,
        new bt.Selector(
          // Start Soothing Mist channel on lowest HP target (makes Vivify/EnvM instant on them)
          spell.cast(S.soothingMist, () => this.getHealTarget(Settings.FWMWUrgentHP), () => {
            if (this.isChannelingSoothingMist()) return false;
            return this.getHealTarget(Settings.FWMWUrgentHP) !== null;
          }),
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // ===== RSK / RWK — weave between Urgent and Maintenance for Rising Mist + Vivacious proc =====
      // Moved BELOW urgent healing so direct heals take priority when people are hurt
      spell.cast(S.risingSunKick, () => this.getMeleeTarget(), () =>
        this.getMeleeTarget() !== null
      ),
      spell.cast(S.rushingWindKick, () => this.getMeleeTarget(), () =>
        this.hasRushingWindKick() && this.getMeleeTarget() !== null
      ),

      // ===== Tier 4: MAINTENANCE (< 85%) =====

      // Vivify with Vivacious Vivification proc (instant — don't waste)
      spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWMaintHP), () => {
        return this.hasVivaciousVivification() && this.getHealTarget(Settings.FWMWMaintHP) !== null;
      }),

      // Renewing Mist spread (keep rolling for Invigorating Mists cleave value)
      spell.cast(S.renewingMist, () => this.getRenewingMistTarget(Settings.FWMWMaintHP), () => {
        return this.getRenewingMistTarget(Settings.FWMWMaintHP) !== null &&
          spell.getChargesFractional(S.renewingMist) > 1.7;
      }),

      // Enveloping Mist on tank maintenance (10% healing amp)
      spell.cast(S.envelopingMist, () => this.getEnvelopingMistTarget(Settings.FWMWMaintHP), () => {
        const target = this.getEnvelopingMistTarget(Settings.FWMWMaintHP);
        if (!target) return false;
        return this.getManaPercent() > 50 && this.hasManaFor('envelopingMist');
      }),

      // Vivify maintenance (only if mana comfortable)
      spell.cast(S.vivify, () => this.getHealTarget(Settings.FWMWMaintHP), () => {
        return this.getHealTarget(Settings.FWMWMaintHP) !== null &&
          this.getManaPercent() > 50 && this.hasManaFor('vivify');
      }),
    );
  }

  // ===== MANA TEA CONSUMPTION =====
  manaTeaConsumption() {
    return spell.cast(S.manaTea, () => me, () => {
      if (!spell.isSpellKnown(T.manaTea)) return false;
      // Method: consume at 20 stacks
      const stacks = me.getAura(A.manaTeaStacks);
      if (!stacks || stacks.stacks < 20) return false;
      // Don't channel during active damage if emergency needed
      if (this._cachedLowestHP < Settings.FWMWCriticalHP) return false;
      return true;
    });
  }

  // ===== DPS ROTATION (Tier 5: everyone > 85%) =====
  dpsRotation() {
    return new bt.Decorator(
      () => this._cachedLowestHP >= Settings.FWMWDpsThreshold && me.inCombat(),
      new bt.Selector(
        // Renewing Mist on CD for Undercurrent stacking even when DPSing
        spell.cast(S.renewingMist, () => this.getRenewingMistTarget(95), () => {
          return this.getRenewingMistTarget(95) !== null &&
            spell.getChargesFractional(S.renewingMist) > 1.7;
        }),

        // Thunder Focus Tea on CD (Conduit: CDR window, MoH: Aspect withdraw)
        spell.cast(S.thunderFocusTea, () => me, () => {
          return !this.hasTFT();
        }),

        // Celestial Conduit for DPS (Conduit hero, only if enabled)
        spell.cast(S.celestialConduit, () => me, () => {
          if (!this.isConduitOfTheCelestials()) return false;
          if (!Settings.FWMWConduit) return false;
          return this.getDpsTarget() !== null;
        }),

        // Rising Sun Kick (highest DPS priority — triggers Rising Mist + Vivacious Vivification)
        spell.cast(S.risingSunKick, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
        }),

        // Rushing Wind Kick (apex talent)
        spell.cast(S.rushingWindKick, () => this.getMeleeTarget(), () => {
          return this.hasRushingWindKick() && this.getMeleeTarget() !== null;
        }),

        // Vivify with Vivacious Vivification proc (instant — don't waste even when DPSing)
        spell.cast(S.vivify, () => this.getHealTarget(95), () => {
          return this.hasVivaciousVivification() && this.getHealTarget(95) !== null;
        }),

        // Spinning Crane Kick (3+ targets — AoE DPS + Way of the Crane healing)
        spell.cast(S.spinningCraneKick, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null && this.getEnemyCount() >= 3;
        }),

        // Tiger Palm (generates Teachings stacks, applies Mystic Touch passively)
        spell.cast(S.tigerPalm, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null && this.getTeachingsStacks() < 4;
        }),

        // Blackout Kick (consume Teachings stacks for bonus hits, 12% RSK reset)
        spell.cast(S.blackoutKick, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
        }),

        // Touch of Death (execute — high damage on low HP target)
        spell.cast(S.touchOfDeath, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
        }),

        // Tiger Palm filler (when no Teachings stacks to spend)
        spell.cast(S.tigerPalm, () => this.getMeleeTarget(), () => {
          return this.getMeleeTarget() !== null;
        }),

        // Crackling Jade Lightning (ranged DPS when not in melee)
        spell.cast(S.cracklingJadeLightning, () => this.getDpsTarget(), () => {
          return this.getMeleeTarget() === null && this.getDpsTarget() !== null;
        }),
      )
    );
  }
}
