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
 * Windwalker Monk Behavior - Midnight 12.0.1
 * Full SimC APL match: apl_monk.cpp windwalker namespace (midnight branch)
 * Auto-detects: Shado-Pan (Flurry Strikes) vs Conduit of the Celestials (Celestial Conduit)
 *
 * Resource: Energy (PowerType 3) + Chi (PowerType 12), max Chi = 5 (6 with Ascension)
 * CRITICAL: Combo Strikes — never repeat same ability (Mastery bonus)
 *
 * Midnight: Zenith (1249625) replaces SEF — 2 charges, 15s buff, Chi costs -1, BOK CDR +1s, resets RSK
 * Shado-Pan: Flurry Charges from auto-attacks, unleashed by abilities
 * Conduit: Celestial Conduit channel, Heart of the Jade Serpent CDR windows
 *
 * SimC APL action lists: opener, big_coc, zenith, racials, default_st, multitarget, fallback
 * Total SimC lines: opener(2) + coc(11) + zen(15) + racials(4) + st(32) + multi(31) + fallback(4) = ~99
 * Non-patchwerk simplifications applied (fight_style.patchwerk conditions always false)
 *
 * COMBO STRIKES FIX: spell.getLastSuccessfulSpell() returns raw spellNameOrId (number),
 * NOT an object with .id. Use spell.getLastSuccessfulSpells(1)[0]?.id for the last cast ID.
 */

const S = {
  // Core
  tigerPalm:          100780,
  blackoutKick:       100784,
  risingSunKick:      107428,
  fistsOfFury:        113656,
  spinningCraneKick:  101546,
  whirlingDragonPunch: 152175,
  strikeOfWindlord:   392983,
  slicingWinds:       1217413,
  rushingWindKick:    1250566,
  touchOfDeath:       322109,
  chiBurst:           123986,
  jadefireStomp:      388193,
  // Burst CDs
  zenith:             1249625,
  invokeXuen:         123904,
  celestialConduit:   443028,
  // Utility
  expelHarm:          322101,
  touchOfKarma:       122470,
  // Interrupt
  spearHandStrike:    116705,
  // Racials
  berserking:         26297,
  bloodFury:          20572,
  fireblood:          265221,
  ancestralCall:      274738,
  arcaneTorrent:      50613,
};

const A = {
  // Core
  zenith:             1249625,
  comboBreaker:       116768,
  danceOfChiJi:       325202,
  teachingsMonastery: 202090,   // Stacking buff (passive talent is 116645)
  pressurePoint:      247255,
  invokeXuen:         123904,
  rushingWindKick:    1250554,  // Buff aura (cast is 1250566)
  bloodlust:          2825,     // Also 32182 (Heroism), 80353 (Time Warp), etc.
  powerInfusion:      10060,
  // Shado-Pan
  flurryCharge:       451021,
  wisdomCritDmg:      452684,
  wisdomMastery:      452685,
  // Conduit of the Celestials
  heartOfJadeSerpent:         443616,
  heartOfJadeSerpentUnity:    443421,  // heart_of_the_jade_serpent_unity_within
  heartOfJadeSerpentYulon:    1238904, // Yu'lon's Avatar buff
  celestialConduit:   443028,
  // Tigereye Brew (Apex)
  tigereyeBrew:       1261724,  // 1-stack buff (3-stack variant: 1262042)
  // WDP buff (internal CD tracking)
  whirlingDragonPunch: 152175,
};

// Talent IDs for spell.isSpellKnown() checks
const T = {
  flurryStrikes:      450615,
  celestialConduit:   443028,
  whirlingDragonPunch: 152175,
  strikeOfWindlord:   392983,
  obsidianSpiral:     1249832,
  innerPeace:         397768,
  energyBurst:        451498,
  sequencedStrikes:   260717,
  craneVortex:        388848,
  shadowboxingTreads: 392982,
  jadefireStomp:      388193,
  invokeXuen:         123904,
  restoreBalance:     442719,
  slicingWinds:       1217413,
};

// Bloodlust aura IDs (all variants)
const BLOODLUST_IDS = [2825, 32182, 80353, 264667, 390386, 386540];

export class WindwalkerMonkBehavior extends Behavior {
  name = 'FW Windwalker Monk';
  context = BehaviorContext.Any;
  specialization = Specialization.Monk.Windwalker;
  version = wow.GameVersion.Retail;

  // Combo Strikes tracking
  _lastCastId = 0;
  // Opener tracking
  _combatStartTime = 0;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _energyFrame = 0;
  _cachedEnergy = 0;
  _chiFrame = 0;
  _cachedChi = 0;
  _chiMaxFrame = 0;
  _cachedChiMax = 0;
  _zenithFrame = 0;
  _cachedZenith = null;  // aura object or null
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _bloodlustFrame = 0;
  _cachedBloodlust = false;
  _comboBreakerFrame = 0;
  _cachedComboBreaker = null;
  _danceFrame = 0;
  _cachedDance = null;
  _hotjsFrame = 0;
  _cachedHotjs = null;
  _hotjsUnityFrame = 0;
  _cachedHotjsUnity = null;
  _hotjsYulonFrame = 0;
  _cachedHotjsYulon = null;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWWWUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWWWDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWWWKarma', text: 'Use Touch of Karma', default: true },
        { type: 'slider', uid: 'FWWWKarmaHP', text: 'Touch of Karma HP %', default: 50, min: 15, max: 70 },
      ],
    },
  ];

  // ===== Hero Detection =====
  isShadoPan() {
    return spell.isSpellKnown(T.flurryStrikes);
  }

  isConduit() {
    return !this.isShadoPan();
  }

  // ===== Combo Strikes =====
  // FIX: spell.getLastSuccessfulSpell() returns raw number, NOT object with .id
  // Must use spell.getLastSuccessfulSpells(1) which returns array of {name, id, spellName, targetName}
  _updateLastCast() {
    const history = spell.getLastSuccessfulSpells(1);
    if (history && history.length > 0 && history[0]) {
      this._lastCastId = history[0].id;
    }
  }

  isComboStrike(spellId) {
    return spellId !== this._lastCastId;
  }

  // Wrapper: cast only if Combo Strike condition met
  castCombo(spellId, targetFn, conditionFn) {
    return spell.cast(spellId, targetFn, () => {
      if (!this.isComboStrike(spellId)) return false;
      if (conditionFn && !conditionFn()) return false;
      return true;
    });
  }

  // ===== Caching =====
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

  getEnergy() {
    if (this._energyFrame === wow.frameTime) return this._cachedEnergy;
    this._energyFrame = wow.frameTime;
    this._cachedEnergy = me.powerByType(PowerType.Energy);
    return this._cachedEnergy;
  }

  getChi() {
    if (this._chiFrame === wow.frameTime) return this._cachedChi;
    this._chiFrame = wow.frameTime;
    this._cachedChi = me.powerByType(PowerType.Chi);
    return this._cachedChi;
  }

  getChiMax() {
    if (this._chiMaxFrame === wow.frameTime) return this._cachedChiMax;
    this._chiMaxFrame = wow.frameTime;
    // Default 5, 6 with Ascension — check max power
    this._cachedChiMax = me.maxPowerByType ? me.maxPowerByType(PowerType.Chi) : 5;
    if (!this._cachedChiMax || this._cachedChiMax < 5) this._cachedChiMax = 5;
    return this._cachedChiMax;
  }

  getZenithAura() {
    if (this._zenithFrame === wow.frameTime) return this._cachedZenith;
    this._zenithFrame = wow.frameTime;
    this._cachedZenith = me.getAura(A.zenith);
    return this._cachedZenith;
  }

  inZenith() {
    return this.getZenithAura() !== null && this.getZenithAura() !== undefined;
  }

  zenithRemains() {
    const aura = this.getZenithAura();
    return aura ? aura.remaining : 0;
  }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemyCount;
    this._enemyFrame = wow.frameTime;
    const target = this.getCurrentTarget();
    this._cachedEnemyCount = target ? target.getUnitsAroundCount(8) + 1 : 1;
    return this._cachedEnemyCount;
  }

  hasBloodlust() {
    if (this._bloodlustFrame === wow.frameTime) return this._cachedBloodlust;
    this._bloodlustFrame = wow.frameTime;
    this._cachedBloodlust = BLOODLUST_IDS.some(id => me.hasAura(id));
    return this._cachedBloodlust;
  }

  getComboBreaker() {
    if (this._comboBreakerFrame === wow.frameTime) return this._cachedComboBreaker;
    this._comboBreakerFrame = wow.frameTime;
    this._cachedComboBreaker = me.getAura(A.comboBreaker);
    return this._cachedComboBreaker;
  }

  comboBreakerStacks() {
    const aura = this.getComboBreaker();
    return aura ? aura.stacks : 0;
  }

  hasComboBreaker() {
    return this.getComboBreaker() !== null && this.getComboBreaker() !== undefined;
  }

  getDanceOfChiJi() {
    if (this._danceFrame === wow.frameTime) return this._cachedDance;
    this._danceFrame = wow.frameTime;
    this._cachedDance = me.getAura(A.danceOfChiJi);
    return this._cachedDance;
  }

  hasDanceOfChiJi() {
    return this.getDanceOfChiJi() !== null && this.getDanceOfChiJi() !== undefined;
  }

  danceRemains() {
    const aura = this.getDanceOfChiJi();
    return aura ? aura.remaining : 0;
  }

  danceStacks() {
    const aura = this.getDanceOfChiJi();
    return aura ? aura.stacks : 0;
  }

  // Heart of the Jade Serpent aura caching (Conduit)
  getHotJS() {
    if (this._hotjsFrame === wow.frameTime) return this._cachedHotjs;
    this._hotjsFrame = wow.frameTime;
    this._cachedHotjs = me.getAura(A.heartOfJadeSerpent);
    return this._cachedHotjs;
  }

  hasHotJS() {
    return this.getHotJS() !== null && this.getHotJS() !== undefined;
  }

  hotjsRemains() {
    const aura = this.getHotJS();
    return aura ? aura.remaining : 0;
  }

  getHotJSUnity() {
    if (this._hotjsUnityFrame === wow.frameTime) return this._cachedHotjsUnity;
    this._hotjsUnityFrame = wow.frameTime;
    this._cachedHotjsUnity = me.getAura(A.heartOfJadeSerpentUnity);
    return this._cachedHotjsUnity;
  }

  hasHotJSUnity() {
    return this.getHotJSUnity() !== null && this.getHotJSUnity() !== undefined;
  }

  hotjsUnityRemains() {
    const aura = this.getHotJSUnity();
    return aura ? aura.remaining : 0;
  }

  getHotJSYulon() {
    if (this._hotjsYulonFrame === wow.frameTime) return this._cachedHotjsYulon;
    this._hotjsYulonFrame = wow.frameTime;
    this._cachedHotjsYulon = me.getAura(A.heartOfJadeSerpentYulon);
    return this._cachedHotjsYulon;
  }

  hasHotJSYulon() {
    return this.getHotJSYulon() !== null && this.getHotJSYulon() !== undefined;
  }

  // Any HotJS variant active
  hasAnyHotJS() {
    return this.hasHotJS() || this.hasHotJSUnity() || this.hasHotJSYulon();
  }

  getFlurryCharges() {
    const aura = me.getAura(A.flurryCharge);
    return aura ? aura.stacks : 0;
  }

  hasRushingWindKick() {
    return me.hasAura(A.rushingWindKick);
  }

  hasPowerInfusion() {
    return me.hasAura(A.powerInfusion);
  }

  hasXuen() {
    return me.hasAura(A.invokeXuen);
  }

  // ===== Helpers =====
  targetTTD() {
    const target = this.getCurrentTarget();
    if (!target || !target.timeToDeath) return 99999;
    return target.timeToDeath();
  }

  // SimC: energy.time_to_max — energy deficit / regen rate
  energyTimeToMax() {
    const deficit = 100 - this.getEnergy();
    if (deficit <= 0) return 0;
    const regen = me.energyRegen || 10;
    return (deficit / regen) * 1000;
  }

  // SimC: gcd.max — GCD is 1.5s base, reduced by haste
  gcdMax() {
    return 1500; // Could be haste-adjusted but 1.5s is safe approximation
  }

  // SimC prev_gcd.1.X — was X the last ability cast?
  prevGcd(spellId) {
    return spell.getTimeSinceLastCast(spellId) < 1500;
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // Combat check — MANDATORY
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Dead target auto-pick
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),

      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),

      common.waitForCastOrChannel(),

      // Track combat start + last cast + version + debug
      new bt.Action(() => {
        this._updateLastCast();
        // Track combat start time for opener
        if (me.inCombat() && this._combatStartTime === 0) {
          this._combatStartTime = wow.frameTime;
        } else if (!me.inCombat()) {
          this._combatStartTime = 0;
        }
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isShadoPan() ? 'Shado-Pan' : 'Conduit of the Celestials';
          console.info(`[Windwalker] Midnight 12.0.1 | Hero: ${hero} | SimC APL match`);
        }
        if (Settings.FWWWDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[WW] Chi:${this.getChi()}/${this.getChiMax()} Energy:${Math.round(this.getEnergy())} Zenith:${this.inZenith()}(${Math.round(this.zenithRemains())}ms) Last:${this._lastCastId} BL:${this.hasBloodlust()} CB:${this.comboBreakerStacks()} Enemies:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.spearHandStrike),

          // Defensives
          spell.cast(S.touchOfKarma, () => me, () => {
            return Settings.FWWWKarma && me.inCombat() &&
              me.effectiveHealthPercent < Settings.FWWWKarmaHP;
          }),

          // SimC: call_action_list,name=opener,if=time<2
          this.opener(),

          // SimC: call_action_list,name=big_coc,if=talent.celestial_conduit
          new bt.Decorator(
            () => this.isConduit(),
            this.bigCoC(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: call_action_list,name=zenith
          this.zenithUsage(),

          // SimC: call_action_list,name=racials
          this.racials(),

          // SimC: call_action_list,name=default_st,if=active_enemies=1
          new bt.Decorator(
            () => this.getEnemyCount() <= 1,
            this.singleTarget(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: call_action_list,name=multitarget,if=active_enemies>1
          new bt.Decorator(
            () => this.getEnemyCount() > 1,
            this.multiTarget(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: call_action_list,name=fallback
          this.fallback(),

          // SimC: arcane_torrent,if=chi<chi.max&energy<55
          spell.cast(S.arcaneTorrent, () => me, () => {
            return this.getChi() < this.getChiMax() && this.getEnergy() < 55;
          }),
        )
      ),
    );
  }

  // ===== OPENER — SimC actions.opener (time<2) =====
  isInOpener() {
    if (this._combatStartTime === 0) return false;
    return (wow.frameTime - this._combatStartTime) < 2000;
  }

  opener() {
    return new bt.Selector(
      // tiger_palm,if=combo_strike&chi<4 (only during opener)
      new bt.Decorator(
        () => this.isInOpener(),
        this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
          if (!this.getCurrentTarget()) return false;
          return this.getChi() < 4;
        }),
        new bt.Action(() => bt.Status.Failure)
      ),
    );
  }

  // ===== CELESTIAL CONDUIT BURST — SimC actions.big_coc (11 lines) =====
  bigCoC() {
    return new bt.Selector(
      // #1: invoke_xuen,if=(ttd>25)&((zenith.up|zenith.remains>13)&!hotjs.up)
      spell.cast(S.invokeXuen, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (this.targetTTD() < 25000) return false;
        if (!((spell.getCooldown(S.zenith)?.ready || this.zenithRemains() > 13000) && !this.hasHotJS())) return false;
        return true;
      }),

      // #2: invoke_xuen with trinket alignment (simplified — no trinket API)
      // Covered by #1

      // #3: invoke_xuen,if=dungeonslice&ttd>15&enemies>4|fight_remains<=25
      spell.cast(S.invokeXuen, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (this.targetTTD() <= 25000 && this.targetTTD() > 0) return true;
        return this.getEnemyCount() > 4 && this.targetTTD() > 15000;
      }),

      // #4: celestial_conduit,if=buff.zenith.remains<12&buff.zenith.up&(!bloodlust|pi)|fight<4
      spell.cast(S.celestialConduit, () => me, () => {
        if (this.targetTTD() < 4000) return true;
        if (!this.inZenith()) return false;
        if (this.zenithRemains() >= 12000) return false;
        return !this.hasBloodlust() || this.hasPowerInfusion();
      }),

      // #5: whirling_dragon_punch,if=buff.power_infusion.up&(!hotjs_unity.up|hotjs_unity.remains<2)
      this.castCombo(S.whirlingDragonPunch, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.hasPowerInfusion()) return false;
        return !this.hasHotJSUnity() || this.hotjsUnityRemains() < 2000;
      }),

      // #6: blackout_kick,if=combo_strike&celestial_conduit&zenith.remains>11&chi<=2&rsk.remains&!rwk.up&obsidian_spiral&combo_breaker.up
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.zenithRemains() <= 11000) return false;
        if (this.getChi() > 2) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (!rskCD || rskCD.ready) return false;
        if (this.hasRushingWindKick()) return false;
        if (!spell.isSpellKnown(T.obsidianSpiral)) return false;
        return this.hasComboBreaker();
      }),

      // #7: tiger_palm,if=combo_strike&celestial_conduit&zenith.remains>11&chi<=2&rsk.remains&!rwk.up&(!obsidian_spiral|!combo_breaker|prev.bok)
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.zenithRemains() <= 11000) return false;
        if (this.getChi() > 2) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (!rskCD || rskCD.ready) return false;
        if (this.hasRushingWindKick()) return false;
        return !spell.isSpellKnown(T.obsidianSpiral) || !this.hasComboBreaker() || this.prevGcd(S.blackoutKick);
      }),

      // #8: celestial_conduit,if=zenith.up&(rsk.remains|enemies>2)&fof.remains&(sotw.remains|WDP)&(WDP.remains|SotW)&!rwk.up&!combo_breaker.up&chi>1&(!hotjs.up|hotjs.remains<4)
      spell.cast(S.celestialConduit, () => me, () => {
        if (!this.inZenith()) return false;
        if (this.getChi() <= 1) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (this.getEnemyCount() <= 2 && rskCD && rskCD.ready) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (fofCD && fofCD.ready) return false;
        const sotwCD = spell.getCooldown(S.strikeOfWindlord);
        const wdpCD = spell.getCooldown(S.whirlingDragonPunch);
        if (sotwCD && sotwCD.ready && !(spell.isSpellKnown(T.whirlingDragonPunch))) return false;
        if (wdpCD && wdpCD.ready && !(spell.isSpellKnown(T.strikeOfWindlord))) return false;
        if (this.hasRushingWindKick()) return false;
        if (this.hasComboBreaker()) return false;
        return !this.hasHotJS() || this.hotjsRemains() < 4000;
      }),

      // #9: celestial_conduit,if=zenith.up&!hotjs.up&!hotjs_yulon.up&chi>1&(rsk.remains|enemies>2)&(sotw.remains|(wdp.remains|fof.remains))
      spell.cast(S.celestialConduit, () => me, () => {
        if (!this.inZenith()) return false;
        if (this.hasHotJS() || this.hasHotJSYulon()) return false;
        if (this.getChi() <= 1) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (this.getEnemyCount() <= 2 && rskCD && rskCD.ready) return false;
        const sotwCD = spell.getCooldown(S.strikeOfWindlord);
        if (sotwCD && sotwCD.ready) {
          const wdpCD = spell.getCooldown(S.whirlingDragonPunch);
          const fofCD = spell.getCooldown(S.fistsOfFury);
          if ((wdpCD && wdpCD.ready) || (fofCD && fofCD.ready)) return false;
        }
        return true;
      }),

      // #10: celestial_conduit,if=zenith.up&hotjs.remains<2&prev.rsk&rsk.remains&fof.remains&hotjs.up&chi>1
      spell.cast(S.celestialConduit, () => me, () => {
        if (!this.inZenith()) return false;
        if (!this.hasHotJS() || this.hotjsRemains() >= 2000) return false;
        if (!this.prevGcd(S.risingSunKick)) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (rskCD && rskCD.ready) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (fofCD && fofCD.ready) return false;
        return this.getChi() > 1;
      }),
    );
  }

  // ===== ZENITH USAGE — SimC actions.zenith (14 lines) =====
  zenithUsage() {
    return new bt.Selector(
      // #1: zenith,if=xuen.up&(!zenith.up|flurry_strikes)
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (!this.hasXuen()) return false;
        return !this.inZenith() || this.isShadoPan();
      }),

      // #2: zenith,if=bloodlust.remains>10&(enemies>2|rsk.remains)&!zenith.up
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (!this.hasBloodlust()) return false;
        // Check BL remaining > 10s — approximate with hasBloodlust
        if (this.inZenith()) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        return this.getEnemyCount() > 2 || (rskCD && !rskCD.ready);
      }),

      // #3: zenith,if=ttd>25&(bloodlust&cc.remains&(rsk.remains|enemies>2)&!zenith.up&celestial_conduit)
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (this.targetTTD() < 25000) return false;
        if (!this.isConduit()) return false;
        if (!this.hasBloodlust()) return false;
        if (this.inZenith()) return false;
        const ccCD = spell.getCooldown(S.celestialConduit);
        if (!ccCD || ccCD.ready) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        return this.getEnemyCount() > 2 || (rskCD && !rskCD.ready);
      }),

      // #4: zenith,if=ttd>25&flurry_strikes&(bloodlust|full_recharge<5)&(rsk.remains|enemies>2)
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (this.targetTTD() < 25000) return false;
        if (!this.isShadoPan()) return false;
        const fullRecharge = spell.getFullRechargeTime(S.zenith);
        if (!this.hasBloodlust() && fullRecharge > 5000) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        return this.getEnemyCount() > 2 || (rskCD && !rskCD.ready);
      }),

      // #5: zenith,if=ttd>25&flurry_strikes&!trinket_buff&rsk.remains&fof.remains<5&(wdp.remains<10|sotw.remains<10)&full_recharge<40
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (this.targetTTD() < 25000) return false;
        if (!this.isShadoPan()) return false;
        const fullRecharge = spell.getFullRechargeTime(S.zenith);
        if (fullRecharge > 40000) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (rskCD && rskCD.ready) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (!fofCD || fofCD.timeleft > 5000) return false;
        const wdpCD = spell.getCooldown(S.whirlingDragonPunch);
        const sotwCD = spell.getCooldown(S.strikeOfWindlord);
        return (wdpCD && wdpCD.timeleft < 10000) || (sotwCD && sotwCD.timeleft < 10000);
      }),

      // #6-#7: Various ttd>25 conditions with trinket alignment (simplified without trinket API)
      // Covered by charge capping prevention below

      // #8-#9: Dungeon slice / large pack conditions
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (this.getEnemyCount() > 4 && this.targetTTD() > 15000) return true;
        return false;
      }),

      // #10: celestial_conduit&fight_remains<xuen.remains&(rsk.remains|enemies>2)&ttd>25
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (!this.isConduit()) return false;
        if (this.targetTTD() < 25000) return false;
        const xuenCD = spell.getCooldown(S.invokeXuen);
        if (!xuenCD || this.targetTTD() >= xuenCD.timeleft) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        return this.getEnemyCount() > 2 || (rskCD && !rskCD.ready);
      }),

      // #11: flurry_strikes&full_recharge<20&(rsk.remains|enemies>2)
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (!this.isShadoPan()) return false;
        if (this.targetTTD() < 25000) return false;
        const fullRecharge = spell.getFullRechargeTime(S.zenith);
        if (fullRecharge > 20000) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        return this.getEnemyCount() > 2 || (rskCD && !rskCD.ready);
      }),

      // #12: fight_remains<=25&(rsk.remains|enemies>2)
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        if (this.targetTTD() > 25000) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        return this.getEnemyCount() > 2 || (rskCD && !rskCD.ready);
      }),

      // #13-#14: Patchwerk trinket conditions (simplified — charge cap prevention)
      spell.cast(S.zenith, () => me, () => {
        if (!Settings.FWWWUseCDs) return false;
        // Prevent charge capping
        return spell.getChargesFractional(S.zenith) > 1.7;
      }),
    );
  }

  // ===== RACIALS — SimC actions.racials (4 lines, all same condition) =====
  _racialCondition() {
    // xuen.remains>15 | !xuen_talented & zenith.remains>14 | fight<20
    const xuenAura = me.getAura(A.invokeXuen);
    if (xuenAura && xuenAura.remaining > 15000) return true;
    if (!spell.isSpellKnown(T.invokeXuen) && this.zenithRemains() > 14000) return true;
    return this.targetTTD() < 20000;
  }

  racials() {
    return new bt.Selector(
      spell.cast(S.berserking, () => me, () => this._racialCondition()),
      spell.cast(S.ancestralCall, () => me, () => this._racialCondition()),
      spell.cast(S.bloodFury, () => me, () => this._racialCondition()),
      spell.cast(S.fireblood, () => me, () => this._racialCondition()),
    );
  }

  // ===== SINGLE TARGET — SimC actions.default_st (~30 lines) =====
  singleTarget() {
    return new bt.Selector(
      // #1: whirling_dragon_punch,if=!hotjs_unity.up&wdp.remains<1&(zenith|xuen_cd>5|flurry|!patchwerk)
      // !patchwerk always true in gameplay → simplifies to !hotjs_unity & wdp.remains<1
      this.castCombo(S.whirlingDragonPunch, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.hasHotJSUnity()) return false;
        const wdpAura = me.getAura(A.whirlingDragonPunch);
        return !wdpAura || wdpAura.remaining < 1000;
      }),

      // #2: whirling_dragon_punch,if=pi.up&(!hotjs_unity.up|hotjs_unity.remains<2)
      this.castCombo(S.whirlingDragonPunch, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.hasPowerInfusion()) return false;
        return !this.hasHotJSUnity() || this.hotjsUnityRemains() < 2000;
      }),

      // #3: spinning_crane_kick,if=combo_strike&dance.remains<1&combo_breaker.stack<2&sequenced_strikes&dance.up&celestial_conduit
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.hasDanceOfChiJi()) return false;
        if (this.danceRemains() >= 1000) return false;
        if (this.comboBreakerStacks() >= 2) return false;
        return spell.isSpellKnown(T.sequencedStrikes) && this.isConduit();
      }),

      // #4: fists_of_fury,if=hotjs.remains<1&hotjs.up|flurry_charge.stack=30&!zenith.up
      this.castCombo(S.fistsOfFury, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.hasHotJS() && this.hotjsRemains() < 1000) return true;
        return this.getFlurryCharges() >= 30 && !this.inZenith();
      }),

      // #5: whirling_dragon_punch,if=cc&hotjs_unity.remains<2&(zenith|xuen_cd>5|!patchwerk)|flurry
      // !patchwerk always true → cc&hotjs_unity.remains<2 | flurry
      this.castCombo(S.whirlingDragonPunch, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isShadoPan()) return true;
        return this.isConduit() && this.hotjsUnityRemains() < 2000;
      }),

      // #6: tiger_palm,if=chi<4&combo_strike&energy.time_to_max<=gcd*3&!zenith.up&(!bloodlust|chi<2)&combo_breaker.stack<2
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getChi() >= 4) return false;
        if (this.energyTimeToMax() > this.gcdMax() * 3) return false;
        if (this.inZenith()) return false;
        if (this.hasBloodlust() && this.getChi() >= 2) return false;
        return this.comboBreakerStacks() < 2;
      }),

      // #7: strike_of_the_windlord,if=cc&hotjs_unity.remains<2&(zenith|xuen_cd>5|!patchwerk)|flurry
      // !patchwerk always true → cc&hotjs_unity.remains<2 | flurry
      this.castCombo(S.strikeOfWindlord, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isShadoPan()) return true;
        return this.isConduit() && this.hotjsUnityRemains() < 2000;
      }),

      // #8: fists_of_fury,if=combo_strike&(hotjs)&bl|bl&flurry|!zenith&(flurry|xuen_cd>3|!patchwerk)|zenith&(flurry|!bl)&(patchwerk|ttd>5)
      this.castCombo(S.fistsOfFury, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        // Clause 1: hotjs & bloodlust
        if (this.hasBloodlust() && this.hasAnyHotJS()) return true;
        // Clause 2: bloodlust & flurry_strikes
        if (this.hasBloodlust() && this.isShadoPan()) return true;
        // Clause 3: !zenith & (flurry|xuen_cd>3|!patchwerk) — !patchwerk always true in gameplay
        if (!this.inZenith()) return true;
        // Clause 4: zenith & (flurry|!bl) & (patchwerk|ttd>5) — non-patchwerk = ttd>5 always
        if (this.inZenith() && (this.isShadoPan() || !this.hasBloodlust()) && this.targetTTD() > 5000) return true;
        return false;
      }),

      // #9: rushing_wind_kick
      this.castCombo(S.rushingWindKick, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // #10: rising_sun_kick,if=combo_strike&bloodlust|combo_strike&(hotjs|hotjs_yulon|hotjs_unity)
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasBloodlust() || this.hasAnyHotJS();
      }),

      // #11: fists_of_fury,if=bloodlust|combo_strike&(hotjs|hotjs_yulon|hotjs_unity)
      this.castCombo(S.fistsOfFury, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasBloodlust() || this.hasAnyHotJS();
      }),

      // #12: tiger_palm,if=zenith.up&chi<2&celestial_conduit&(hotjs|hotjs_unity)&!fof.remains&combo_strike
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.inZenith() || this.getChi() >= 2) return false;
        if (!this.isConduit()) return false;
        if (!this.hasHotJS() && !this.hasHotJSUnity()) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        return fofCD && fofCD.ready;
      }),

      // #13: spinning_crane_kick,if=combo_strike&dance.remains<4&combo_breaker.stack<2&sequenced_strikes&dance.up
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.hasDanceOfChiJi()) return false;
        if (this.danceRemains() >= 4000) return false;
        if (this.comboBreakerStacks() >= 2) return false;
        return spell.isSpellKnown(T.sequencedStrikes);
      }),

      // #14: rising_sun_kick,if=zenith.up&flurry_strikes&!fof.remains
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.inZenith() || !this.isShadoPan()) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        return fofCD && fofCD.ready;
      }),

      // #15: rising_sun_kick,if=combo_strike
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // #16: fists_of_fury,if=flurry_strikes|!zenith.up&(flurry|xuen_cd>3|!patchwerk)|bl&jadefire&cc.remains
      this.castCombo(S.fistsOfFury, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        // flurry_strikes — always use
        if (this.isShadoPan()) return true;
        // !zenith & (!patchwerk always true) — always use outside zenith
        if (!this.inZenith()) return true;
        // bl & jadefire & cc on CD
        if (this.hasBloodlust() && spell.isSpellKnown(T.jadefireStomp)) {
          const ccCD = spell.getCooldown(S.celestialConduit);
          if (ccCD && !ccCD.ready) return true;
        }
        return false;
      }),

      // #17: rising_sun_kick,if=hotjs|hotjs_unity|hotjs_yulon
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasAnyHotJS();
      }),

      // #18: touch_of_death,if=!zenith|fight<5|(trinket conditions → true without trinket API)
      // Simplifies to unconditional (trinket clause always true without trinket tracking)
      this.castCombo(S.touchOfDeath, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // #19: strike_of_the_windlord,if=hotjs_unity.remains<2&(zenith|xuen_cd>5|!patchwerk)|flurry
      // !patchwerk always true → hotjs_unity.remains<2 | flurry
      this.castCombo(S.strikeOfWindlord, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isShadoPan()) return true;
        return this.hotjsUnityRemains() < 2000;
      }),

      // #20: rising_sun_kick,if=combo_strike&(flurry_charge.stack<30|chi>3|zenith.up|bloodlust|energy>50&chi>2)|combo_strike&hotjs.up
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.hasHotJS()) return true;
        if (this.getFlurryCharges() < 30) return true;
        if (this.getChi() > 3) return true;
        if (this.inZenith()) return true;
        if (this.hasBloodlust()) return true;
        return this.getEnergy() > 50 && this.getChi() > 2;
      }),

      // #21: tiger_palm,if=combo_strike&zenith.up&(chi<1|chi<2&!combo_breaker.up)&celestial_conduit
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.inZenith() || !this.isConduit()) return false;
        return this.getChi() < 1 || (this.getChi() < 2 && !this.hasComboBreaker());
      }),

      // #22: blackout_kick,if=combo_strike&zenith.up&chi>1&(obsidian_spiral|fof.remains|combo_breaker.up)&(chi<6|combo_breaker.up)|combo_strike&bloodlust&combo_breaker.up
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.hasBloodlust() && this.hasComboBreaker()) return true;
        if (!this.inZenith()) return false;
        if (this.getChi() <= 1) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (!spell.isSpellKnown(T.obsidianSpiral) && (fofCD && fofCD.ready) && !this.hasComboBreaker()) return false;
        return this.getChi() < 6 || this.hasComboBreaker();
      }),

      // #23: spinning_crane_kick,if=combo_strike&!bloodlust&zenith.up&flurry_strikes&chi>3
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.hasBloodlust()) return false;
        if (!this.inZenith() || !this.isShadoPan()) return false;
        return this.getChi() > 3;
      }),

      // #24: slicing_winds
      this.castCombo(S.slicingWinds, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // #25: spinning_crane_kick,if=flurry_strikes&zenith.up&chi>5&combo_strike|combo_strike&bloodlust&dance.up&combo_breaker.stack<2
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isShadoPan() && this.inZenith() && this.getChi() > 5) return true;
        return this.hasBloodlust() && this.hasDanceOfChiJi() && this.comboBreakerStacks() < 2;
      }),

      // #26: blackout_kick,if=combo_strike&combo_breaker.up&(hotjs|hotjs_unity)
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.hasComboBreaker()) return false;
        return this.hasHotJS() || this.hasHotJSUnity();
      }),

      // #27: blackout_kick,if=combo_strike&combo_breaker.stack=2
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.comboBreakerStacks() >= 2;
      }),

      // #28: spinning_crane_kick,if=combo_strike&dance.stack=2
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.danceStacks() >= 2;
      }),

      // #29: blackout_kick,if=combo_strike&combo_breaker.up
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasComboBreaker();
      }),

      // #30: tiger_palm,if=chi<5&combo_strike&energy.time_to_max<=gcd*3&!zenith.up
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getChi() >= 5) return false;
        if (this.energyTimeToMax() > this.gcdMax() * 3) return false;
        return !this.inZenith();
      }),

      // #31: tiger_palm,if=combo_strike&((energy>55&inner_peace|energy>60&!inner_peace)&chi_deficit>=2&(energy_burst&!combo_breaker|!energy_burst)&!zenith|(energy_burst&!combo_breaker|!energy_burst)&!zenith&!fof.remains&chi<3)
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.inZenith()) return false;
        const energyThreshold = spell.isSpellKnown(T.innerPeace) ? 55 : 60;
        const chiDeficit = this.getChiMax() - this.getChi();
        const energyBurstActive = spell.isSpellKnown(T.energyBurst) && !this.hasComboBreaker();
        const nonEnergyBurst = !spell.isSpellKnown(T.energyBurst);
        const ebCheck = energyBurstActive || nonEnergyBurst;

        // First condition: energy threshold & chi deficit & eb check
        if (this.getEnergy() > energyThreshold && chiDeficit >= 2 && ebCheck) return true;

        // Second condition: eb check & !fof.remains & chi<3
        if (ebCheck) {
          const fofCD = spell.getCooldown(S.fistsOfFury);
          if (fofCD && fofCD.ready && this.getChi() < 3) return true;
        }

        return false;
      }),
    );
  }

  // ===== MULTI-TARGET — SimC actions.multitarget (~30 lines) =====
  multiTarget() {
    return new bt.Selector(
      // #1: fists_of_fury,if=hotjs.remains<1&hotjs.up
      this.castCombo(S.fistsOfFury, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasHotJS() && this.hotjsRemains() < 1000;
      }),

      // #2: whirling_dragon_punch,if=celestial_conduit&hotjs_unity.remains<2
      this.castCombo(S.whirlingDragonPunch, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.isConduit()) return false;
        return this.hotjsUnityRemains() < 2000;
      }),

      // #3: whirling_dragon_punch,if=!hotjs_unity.up&wdp.remains<1
      this.castCombo(S.whirlingDragonPunch, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.hasHotJSUnity()) return false;
        const wdpAura = me.getAura(A.whirlingDragonPunch);
        return !wdpAura || wdpAura.remaining < 1000;
      }),

      // #4: tiger_palm,if=zenith.up&chi<2&celestial_conduit&(hotjs|hotjs_unity)&!fof.remains&combo_strike
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.inZenith() || this.getChi() >= 2) return false;
        if (!this.isConduit()) return false;
        if (!this.hasHotJS() && !this.hasHotJSUnity()) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        return fofCD && fofCD.ready;
      }),

      // #5: tiger_palm,if=chi<5&combo_strike&energy.time_to_max<=gcd*3&!zenith.up&!bloodlust&combo_breaker.stack<2
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getChi() >= 5) return false;
        if (this.energyTimeToMax() > this.gcdMax() * 3) return false;
        if (this.inZenith()) return false;
        if (this.hasBloodlust()) return false;
        return this.comboBreakerStacks() < 2;
      }),

      // #6: strike_of_the_windlord,if=celestial_conduit&hotjs_unity.remains<2
      this.castCombo(S.strikeOfWindlord, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.isConduit()) return false;
        return this.hotjsUnityRemains() < 2000;
      }),

      // #7: fists_of_fury,if=flurry_charge.stack=30&!zenith.up|hotjs|hotjs_unity|hotjs_yulon|flurry_strikes
      this.castCombo(S.fistsOfFury, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getFlurryCharges() >= 30 && !this.inZenith()) return true;
        if (this.hasAnyHotJS()) return true;
        return this.isShadoPan();
      }),

      // #8: spinning_crane_kick,if=combo_strike&dance.up&combo_breaker.stack<2&sequenced_strikes&dance.remains<3
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.hasDanceOfChiJi()) return false;
        if (this.comboBreakerStacks() >= 2) return false;
        if (!spell.isSpellKnown(T.sequencedStrikes)) return false;
        return this.danceRemains() < 3000;
      }),

      // #9: rushing_wind_kick
      this.castCombo(S.rushingWindKick, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // #10: rising_sun_kick,if=(enemies<5|fof.remains|zenith.up)&(rwk.up|hotjs|hotjs_unity|hotjs_yulon)
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (this.getEnemyCount() >= 5 && (fofCD && fofCD.ready) && !this.inZenith()) return false;
        return this.hasRushingWindKick() || this.hasAnyHotJS();
      }),

      // #11: touch_of_death,if=!zenith|fight<5|(trinket → true)
      this.castCombo(S.touchOfDeath, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // #12: strike_of_the_windlord,if=zenith.up|zenith.remains>5&hotjs_unity.remains<2
      this.castCombo(S.strikeOfWindlord, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.inZenith()) return true;
        const zenithCD = spell.getCooldown(S.zenith);
        return zenithCD && zenithCD.timeleft > 5000 && this.hotjsUnityRemains() < 2000;
      }),

      // #13: whirling_dragon_punch,if=zenith.up|zenith.remains>5&hotjs_unity.remains<2
      this.castCombo(S.whirlingDragonPunch, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.inZenith()) return true;
        const zenithCD = spell.getCooldown(S.zenith);
        return zenithCD && zenithCD.timeleft > 5000 && this.hotjsUnityRemains() < 2000;
      }),

      // #14: fists_of_fury,if=flurry_strikes|!zenith.up|bloodlust&jadefire_stomp&cc.remains
      this.castCombo(S.fistsOfFury, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.isShadoPan()) return true;
        if (!this.inZenith()) return true;
        if (this.hasBloodlust() && spell.isSpellKnown(T.jadefireStomp)) {
          const ccCD = spell.getCooldown(S.celestialConduit);
          if (ccCD && !ccCD.ready) return true;
        }
        return false;
      }),

      // #15: rising_sun_kick,if=(enemies<5|fof.remains>4|zenith.up)&(combo_strike&(flurry_charge.stack<30|chi>3|zenith.up|bloodlust|energy>50&chi>2)|combo_strike&hotjs.up)
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (this.getEnemyCount() >= 5 && (!fofCD || fofCD.timeleft <= 4000) && !this.inZenith()) return false;
        if (this.hasHotJS()) return true;
        if (this.getFlurryCharges() < 30) return true;
        if (this.getChi() > 3) return true;
        if (this.inZenith()) return true;
        if (this.hasBloodlust()) return true;
        return this.getEnergy() > 50 && this.getChi() > 2;
      }),

      // #16: blackout_kick,if=combo_strike&zenith.up&chi>1&(obsidian_spiral|fof.remains|combo_breaker.up)&chi<6
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.inZenith() || this.getChi() <= 1) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (!spell.isSpellKnown(T.obsidianSpiral) && (fofCD && fofCD.ready) && !this.hasComboBreaker()) return false;
        return this.getChi() < 6;
      }),

      // #17: spinning_crane_kick,if=combo_strike&dance.up&combo_breaker.stack<2&sequenced_strikes&dance.remains<4
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.hasDanceOfChiJi()) return false;
        if (this.comboBreakerStacks() >= 2) return false;
        if (!spell.isSpellKnown(T.sequencedStrikes)) return false;
        return this.danceRemains() < 4000;
      }),

      // #18: slicing_winds
      this.castCombo(S.slicingWinds, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // #19: spinning_crane_kick,if=flurry_strikes&zenith.up&chi>3&combo_strike
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.isShadoPan() || !this.inZenith()) return false;
        return this.getChi() > 3;
      }),

      // #20: blackout_kick,if=combo_strike&combo_breaker.up&(hotjs|hotjs_unity)
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!this.hasComboBreaker()) return false;
        return this.hasHotJS() || this.hasHotJSUnity();
      }),

      // #21: tiger_palm,if=chi<5&combo_strike&energy.time_to_max<=gcd*3&!zenith.up&!bloodlust
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getChi() >= 5) return false;
        if (this.energyTimeToMax() > this.gcdMax() * 3) return false;
        if (this.inZenith()) return false;
        return !this.hasBloodlust();
      }),

      // #22: blackout_kick,if=combo_strike&combo_breaker.stack=2
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.comboBreakerStacks() >= 2;
      }),

      // #23: spinning_crane_kick,if=combo_strike&dance.stack=2
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.danceStacks() >= 2;
      }),

      // #24: blackout_kick,if=combo_strike&combo_breaker.up
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasComboBreaker();
      }),

      // #25: tiger_palm,if=chi<5&combo_strike&energy.time_to_max<=gcd*3&!zenith.up
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getChi() >= 5) return false;
        if (this.energyTimeToMax() > this.gcdMax() * 3) return false;
        return !this.inZenith();
      }),

      // #26: tiger_palm,if=combo_strike&((energy>55&inner_peace|energy>60&!inner_peace)&chi_deficit>=2&(energy_burst&!combo_breaker|!energy_burst)&!zenith|(energy_burst&!combo_breaker|!energy_burst)&!zenith&!fof.remains&chi<3)
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.inZenith()) return false;
        const energyThreshold = spell.isSpellKnown(T.innerPeace) ? 55 : 60;
        const chiDeficit = this.getChiMax() - this.getChi();
        const ebCheck = (spell.isSpellKnown(T.energyBurst) && !this.hasComboBreaker()) || !spell.isSpellKnown(T.energyBurst);

        if (this.getEnergy() > energyThreshold && chiDeficit >= 2 && ebCheck) return true;

        if (ebCheck) {
          const fofCD = spell.getCooldown(S.fistsOfFury);
          if (fofCD && fofCD.ready && this.getChi() < 3) return true;
        }
        return false;
      }),

      // #27: spinning_crane_kick,if=combo_strike&(dance.up|enemies>4&(chi>2|energy>55))&crane_vortex&rsk.remains&fof.remains
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (!spell.isSpellKnown(T.craneVortex)) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (rskCD && rskCD.ready) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (fofCD && fofCD.ready) return false;
        return this.hasDanceOfChiJi() || (this.getEnemyCount() > 4 && (this.getChi() > 2 || this.getEnergy() > 55));
      }),

      // #28: blackout_kick,if=combo_strike&shadowboxing_treads
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return spell.isSpellKnown(T.shadowboxingTreads);
      }),

      // #29: spinning_crane_kick,if=combo_strike&(chi>3|energy>55)&(!shadowboxing_treads&enemies>2|enemies>5)&rsk.remains&fof.remains
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        if (this.getChi() <= 3 && this.getEnergy() <= 55) return false;
        const rskCD = spell.getCooldown(S.risingSunKick);
        if (rskCD && rskCD.ready) return false;
        const fofCD = spell.getCooldown(S.fistsOfFury);
        if (fofCD && fofCD.ready) return false;
        if (!spell.isSpellKnown(T.shadowboxingTreads) && this.getEnemyCount() > 2) return true;
        return this.getEnemyCount() > 5;
      }),

      // #30: rising_sun_kick,if=combo_strike
      this.castCombo(S.risingSunKick, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),
    );
  }

  // ===== FALLBACK — SimC actions.fallback (4 lines) =====
  fallback() {
    return new bt.Selector(
      // blackout_kick,if=combo_strike
      this.castCombo(S.blackoutKick, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // spinning_crane_kick,if=combo_strike&dance.up&enemies=1
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.hasDanceOfChiJi() && this.getEnemyCount() <= 1;
      }),

      // tiger_palm,if=combo_strike (SimC: unconditional combo_strike only)
      this.castCombo(S.tigerPalm, () => this.getCurrentTarget(), () => {
        return this.getCurrentTarget() !== null;
      }),

      // spinning_crane_kick,if=chi>5&combo_strike
      this.castCombo(S.spinningCraneKick, () => this.getCurrentTarget(), () => {
        if (!this.getCurrentTarget()) return false;
        return this.getChi() > 5;
      }),
    );
  }
}
