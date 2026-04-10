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
import KeyBinding from '@/Core/KeyBinding';
// imgui is a framework global — no import needed

/**
 * Discipline Priest Behavior - Midnight 12.0.1
 * Sources: Method Disc Priest Guide (all pages) + Wowhead
 * Auto-detects: Voidweaver vs Oracle
 *
 * Midnight changes:
 *   - Evangelism: casts free Radiance + makes next 2 instant (40% cheaper) — NOT extension
 *   - Penance now applies Atonement
 *   - Removed: Shadow Covenant, Schism, Shadowfiend (replaced by SW:D proc), Renew, Halo, Divine Star, PW:Life
 *   - Void Shield: PW:S upgrade proc, splashes to 2 nearby allies + applies Atonement to all 3
 *   - Shadow Mend: proc from SW:P damage, empowered Flash Heal
 *   - Expiation: Mind Blast + SW:D consume 1s SW:P for 300% damage
 *   - Dark Indulgence: Mind Blast 100% grants Power of the Dark Side
 *   - Weal and Woe: Penance empowers next PW:S (Oracle) or Smite (Voidweaver)
 *
 * RAMP SYSTEM — Disc heals via Atonement (damage → healing):
 *   F1 = Evangelism ramp: apply Atonements → press Evangelism → instant Radiances → burst damage
 *   F2 = Rapture ramp: press Rapture → spam empowered PW:S → burst damage
 *   Both ramps are keybind-triggered (toggle). Auto-ramp optional for M+.
 *
 * Voidweaver: Mind Blast → Entropic Rift → Void Blast spam, Void Shield procs
 * Oracle: Extra Penance charge, Weal and Woe shield empowerment, Twinsight cross-healing
 *
 * Long CDs (Evangelism, Rapture, Pain Suppression, UP, Barrier) OFF by default
 * Penance castable while moving — primary movement ability
 */

const S = {
  // Core heals / Atonement applicators
  pwShield:           17,       // PW:Shield — absorb + Atonement
  flashHeal:          2061,     // Flash Heal — direct heal + Atonement (Binding Heals → self too)
  plea:               200829,   // Plea — instant cheap Atonement
  penance:            47540,    // Penance — damage or heal, applies Atonement, castable while moving
  pwRadiance:         194509,   // PW:Radiance — AoE Atonement (2 charges)
  voidShield:         1253828,  // Void Shield — proc-enhanced PW:S, splashes to 2 allies
  // Damage (Atonement healing via damage)
  smite:              585,      // Smite — filler, extends Atonement via Divine Procession
  swPain:             589,      // Shadow Word: Pain — DoT, feeds Shadow Mend procs + Expiation
  mindBlast:          8092,     // Mind Blast — strong damage, Dark Indulgence → PotDS, Voidweaver → Rift
  swDeath:            32379,    // Shadow Word: Death — execute + Expiation value
  voidBlast:          450215,   // Void Blast Disc cast (450405 is talent passive)
  holyNova:           132157,   // Holy Nova — AoE (Lightburst talent)
  // Major CDs (OFF by default)
  evangelism:         472433,   // Free Radiance + 2 instant Radiances (40% cheaper) + Archangel +15% healing
  rapture:            47536,    // Empowered PW:S spam (no CD, +80% absorb)
  painSuppression:    33206,    // External DR (2 charges)
  ultimatePenitence:  421453,   // Choice node: massive damage barrage
  pwBarrier:          62618,    // Choice node: AoE DR zone
  mindbender:         123040,   // Pet: mana + damage
  // Defensives
  desperatePrayer:    19236,
  fade:               586,
  // Dispel
  purify:             527,      // Friendly: Magic + Disease
  dispelMagic:        528,      // Offensive: remove enemy Magic buff
  massDispel:         32375,    // AoE: 5 friendly + 5 enemy magic effects
  // Utility
  pwFortitude:        21562,
  // Racials
  berserking:         26297,
};

const A = {
  atonement:          194384,   // Atonement buff on allies
  potds:              198069,   // Power of the Dark Side BUFF (198068 is talent passive)
  voidShieldProc:     1253591,  // Proc buff: next PW:S → Void Shield (1253593 is Void Shield itself)
  shadowMend:         1252217,  // Shadow Mend proc (empowered Flash Heal)
  surgeOfLight:       114255,   // Free Flash Heal proc (stacks 2)
  pwShield:           17,       // Shield buff on target
  swPain:             589,      // DoT debuff on target
  painSuppression:    33206,    // External buff
  rapture:            47536,    // Rapture active buff
  entropicRift:       459314,   // Voidweaver: rift tracking buff (447444 is talent passive)
  harshDiscipline:    373183,   // Radiance → extra Penance bolts
  pwFortitude:        21562,    // Raid buff
  // Hero detection
  voidBlastKnown:     447444,   // Entropic Rift talent (Disc-free, Voidweaver marker)
};

export class DisciplinePriestBehavior extends Behavior {
  name = 'FW Discipline Priest';
  context = BehaviorContext.Any;
  specialization = Specialization.Priest.Discipline;
  version = wow.GameVersion.Retail;

  // Ramp state
  _evangRampActive = false;
  _evangRampStart = 0;
  _raptureRampActive = false;
  _raptureRampStart = 0;
  _rampRadianceCount = 0;

  constructor() {
    super();
    KeyBinding.setDefault('FWDiscEvangKey', imgui.Key.F1);
    KeyBinding.setDefault('FWDiscRaptureKey', imgui.Key.F2);
  }

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
  _atonementFrame = 0;
  _cachedAtonementCount = 0;
  _dpsTargetFrame = 0;
  _cachedDpsTarget = null;
  _manaFrame = 0;
  _cachedMana = 100;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'Healing Thresholds',
      options: [
        { type: 'slider', uid: 'FWDiscEmergencyHP', text: 'Emergency HP %', default: 20, min: 5, max: 35 },
        { type: 'slider', uid: 'FWDiscCriticalHP', text: 'Critical HP %', default: 40, min: 20, max: 55 },
        { type: 'slider', uid: 'FWDiscUrgentHP', text: 'Urgent HP %', default: 65, min: 40, max: 80 },
        { type: 'slider', uid: 'FWDiscMaintHP', text: 'Maintenance HP %', default: 85, min: 70, max: 95 },
      ],
    },
    {
      header: 'Ramp System (Keybind-Triggered)',
      options: [
        { type: 'hotkey', uid: 'FWDiscEvangKey', text: 'Evangelism Ramp Key', default: imgui.Key.F1 },
        { type: 'hotkey', uid: 'FWDiscRaptureKey', text: 'Rapture Ramp Key', default: imgui.Key.F2 },
        { type: 'slider', uid: 'FWDiscRampDuration', text: 'Ramp duration (seconds)', default: 12, min: 5, max: 20 },
        { type: 'slider', uid: 'FWDiscRampAtonements', text: 'Min Atonements before CD', default: 4, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWDiscAutoRamp', text: 'Also auto-ramp when group hurt (M+ mode)', default: false },
        { type: 'slider', uid: 'FWDiscAutoRampHP', text: 'Auto-ramp group HP %', default: 70, min: 40, max: 90 },
        { type: 'slider', uid: 'FWDiscAutoRampCount', text: 'Auto-ramp min injured count', default: 3, min: 1, max: 5 },
      ],
    },
    {
      header: 'Major Cooldowns (OFF = manual/raid assignment)',
      options: [
        { type: 'checkbox', uid: 'FWDiscEvangelism', text: 'Auto Evangelism (keybind always works)', default: false },
        { type: 'checkbox', uid: 'FWDiscRapture', text: 'Auto Rapture (keybind always works)', default: false },
        { type: 'checkbox', uid: 'FWDiscPainSupp', text: 'Auto Pain Suppression', default: false },
        { type: 'slider', uid: 'FWDiscPainSuppHP', text: 'Pain Suppression HP %', default: 25, min: 5, max: 50 },
        { type: 'checkbox', uid: 'FWDiscUP', text: 'Auto Ultimate Penitence', default: false },
        { type: 'slider', uid: 'FWDiscUPAtonements', text: 'UP min Atonements', default: 5, min: 2, max: 10 },
        { type: 'checkbox', uid: 'FWDiscBarrier', text: 'Auto PW:Barrier', default: false },
        { type: 'slider', uid: 'FWDiscBarrierHP', text: 'Barrier avg HP %', default: 45, min: 20, max: 70 },
        { type: 'slider', uid: 'FWDiscBarrierCount', text: 'Barrier min targets', default: 3, min: 1, max: 5 },
      ],
    },
    {
      header: 'Self-Defense',
      options: [
        { type: 'checkbox', uid: 'FWDiscDesPrayer', text: 'Use Desperate Prayer', default: true },
        { type: 'slider', uid: 'FWDiscDesPrayerHP', text: 'Desperate Prayer HP %', default: 40, min: 10, max: 60 },
        { type: 'checkbox', uid: 'FWDiscFade', text: 'Use Fade', default: true },
      ],
    },
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWDiscDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // ===== Hero Talent Detection =====
  isVoidweaver() {
    return spell.isSpellKnown(A.voidBlastKnown) || spell.isSpellKnown(450405);
  }

  isOracle() {
    return !this.isVoidweaver();
  }

  // ===== Ramp System =====
  handleRampSystem() {
    // Evangelism ramp keybind (toggle)
    if (KeyBinding.isPressed('FWDiscEvangKey')) {
      if (!this._evangRampActive) {
        this._evangRampActive = true;
        this._evangRampStart = wow.frameTime;
        this._rampRadianceCount = 0;
        this._raptureRampActive = false; // Cancel rapture ramp if active
        this._raptureRampStart = 0;
      } else {
        this._evangRampActive = false;
        this._evangRampStart = 0;
      }
    }

    // Rapture ramp keybind (toggle)
    if (KeyBinding.isPressed('FWDiscRaptureKey')) {
      if (!this._raptureRampActive) {
        this._raptureRampActive = true;
        this._raptureRampStart = wow.frameTime;
        this._evangRampActive = false; // Cancel evang ramp if active
        this._evangRampStart = 0;
      } else {
        this._raptureRampActive = false;
        this._raptureRampStart = 0;
      }
    }

    // Auto-timeout ramps after configured duration
    const rampDurationMs = Settings.FWDiscRampDuration * 1000;
    if (this._evangRampActive && this._evangRampStart > 0 &&
        (wow.frameTime - this._evangRampStart) >= rampDurationMs) {
      this._evangRampActive = false;
      this._evangRampStart = 0;
    }
    if (this._raptureRampActive && this._raptureRampStart > 0 &&
        (wow.frameTime - this._raptureRampStart) >= rampDurationMs) {
      this._raptureRampActive = false;
      this._raptureRampStart = 0;
    }

    // Auto-ramp (M+ mode): start ramp when group is hurt + CD ready
    if (Settings.FWDiscAutoRamp && !this._evangRampActive && !this._raptureRampActive) {
      const injured = this.getFriendsBelow(Settings.FWDiscAutoRampHP);
      if (injured >= Settings.FWDiscAutoRampCount) {
        if (Settings.FWDiscEvangelism && !spell.isOnCooldown(S.evangelism)) {
          this._evangRampActive = true;
          this._evangRampStart = wow.frameTime;
          this._rampRadianceCount = 0;
        } else if (Settings.FWDiscRapture && spell.isSpellKnown(S.rapture) && !spell.isOnCooldown(S.rapture) &&
                   spell.isOnCooldown(S.evangelism)) {
          this._raptureRampActive = true;
          this._raptureRampStart = wow.frameTime;
        }
      }
    }
  }

  isPostEvangelism() {
    return spell.getTimeSinceLastCast(S.evangelism) < 8000;
  }

  isPostRapture() {
    if (!spell.isSpellKnown(S.rapture)) return false;
    return me.hasAura(A.rapture) || spell.getTimeSinceLastCast(S.rapture) < 10000;
  }

  isRamping() {
    return this._evangRampActive || this._raptureRampActive ||
           this.isPostEvangelism() || this.isPostRapture();
  }

  isPreRamping() {
    return (this._evangRampActive && !this.isPostEvangelism() && !spell.isOnCooldown(S.evangelism)) ||
           (this._raptureRampActive && spell.isSpellKnown(S.rapture) && !this.isPostRapture() && !spell.isOnCooldown(S.rapture));
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
    if (tanks) {
      for (let i = 0; i < tanks.length; i++) {
        const unit = tanks[i];
        if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
        const hp = unit.effectiveHealthPercent;
        if (hp < tankLowestHP) { tankLowestHP = hp; tankLowest = unit; }
      }
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

  // ===== Target Helpers =====
  getHealTarget(maxHP) {
    this._refreshHealCache();
    if (this._cachedLowestHP > maxHP) return null;
    return this._cachedLowest;
  }

  getTankTarget(maxHP) {
    this._refreshHealCache();
    if (this._cachedTankLowestHP > maxHP) return null;
    return this._cachedTankLowest;
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
      if (friends[i] && !friends[i].deadOrGhost && me.distanceTo(friends[i]) <= 40 &&
          friends[i].effectiveHealthPercent <= hp) count++;
    }
    return count;
  }

  getAtonementCount() {
    if (this._atonementFrame === wow.frameTime) return this._cachedAtonementCount;
    this._atonementFrame = wow.frameTime;
    let count = 0;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      if (friends[i] && !friends[i].deadOrGhost && friends[i].hasAuraByMe(A.atonement)) count++;
    }
    // Check self separately if not in friends list
    if (me.hasAura(A.atonement)) {
      const selfInList = friends.some(f => f && f.guid && f.guid.equals && f.guid.equals(me.guid) && f.hasAuraByMe(A.atonement));
      if (!selfInList) count++;
    }
    this._cachedAtonementCount = count;
    return count;
  }

  getAllyWithoutAtonement() {
    // Tanks first (always keep Atonement on tanks)
    const tanks = heal.friends.Tanks;
    if (tanks) {
      for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40 && !tank.hasAuraByMe(A.atonement)) {
          return tank;
        }
      }
    }
    // Then injured allies
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 &&
          unit.effectiveHealthPercent < 90 && !unit.hasAuraByMe(A.atonement)) {
        return unit;
      }
    }
    // Then anyone without Atonement
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 && !unit.hasAuraByMe(A.atonement)) {
        return unit;
      }
    }
    return null;
  }

  getAllyWithExpiringAtonement(ms) {
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
      const aura = unit.getAuraByMe(A.atonement);
      if (aura && aura.remaining > 0 && aura.remaining < ms) return unit;
    }
    return null;
  }

  getAllyWithoutShield() {
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (unit && !unit.deadOrGhost && me.distanceTo(unit) <= 40 && !unit.hasAura(A.pwShield)) {
        return unit;
      }
    }
    return null;
  }

  getVoidShieldTarget() {
    // Priority: lowest health → tank → anyone without shield
    const lowest = this.getHealTarget(Settings.FWDiscMaintHP);
    if (lowest && !lowest.hasAura(A.pwShield)) return lowest;
    const tanks = heal.friends.Tanks;
    if (tanks) {
      for (let i = 0; i < tanks.length; i++) {
        if (tanks[i] && !tanks[i].deadOrGhost && me.distanceTo(tanks[i]) <= 40 && !tanks[i].hasAura(A.pwShield)) {
          return tanks[i];
        }
      }
    }
    return this.getAllyWithoutShield();
  }

  getDpsTarget() {
    if (this._dpsTargetFrame === wow.frameTime) return this._cachedDpsTarget;
    this._dpsTargetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 40) {
      this._cachedDpsTarget = target;
      return target;
    }
    this._cachedDpsTarget = combat.bestTarget || (combat.targets && combat.targets[0]) || null;
    return this._cachedDpsTarget;
  }

  getSwPainTarget() {
    const dps = this.getDpsTarget();
    if (!dps) return null;
    if (spell.getTimeSinceLastCast(S.swPain) < 3000) return null;
    const debuff = dps.getAuraByMe(A.swPain);
    if (debuff && debuff.remaining > 4800) return null;
    if (dps.timeToDeath && dps.timeToDeath() < 6000) return null;
    return dps;
  }

  getSwPainSpreadTarget() {
    const targets = combat.targets;
    if (!targets) return null;
    for (let i = 0; i < targets.length; i++) {
      const unit = targets[i];
      if (unit && common.validTarget(unit) && me.distanceTo(unit) <= 40 &&
          !unit.hasAuraByMe(A.swPain) && unit.inCombatWithMe &&
          (!unit.timeToDeath || unit.timeToDeath() > 6000)) {
        return unit;
      }
    }
    return null;
  }

  // ===== Mana Management =====
  getManaPercent() {
    if (this._manaFrame === wow.frameTime) return this._cachedMana;
    this._manaFrame = wow.frameTime;
    const max = me.maxPowerByType ? me.maxPowerByType(PowerType.Mana) : 1;
    this._cachedMana = max > 0 ? (me.powerByType(PowerType.Mana) / max) * 100 : 100;
    return this._cachedMana;
  }

  hasManaFor(spellType) {
    const mana = this.getManaPercent();
    if (mana < 10) return false;
    if (mana < 25 && spellType === 'radiance') return false;
    if (mana < 20 && spellType === 'flashHeal') return false;
    return true;
  }

  // ===== OOC Buff Helper =====
  _hasBuff(unit, id) {
    if (!unit) return false;
    return unit.hasVisibleAura(id) || unit.hasAura(id) ||
      (unit.auras && unit.auras.find(a => a.spellId === id) !== undefined);
  }

  // ===== BUILD =====
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: Power Word: Fortitude
      spell.cast(S.pwFortitude, () => me, () => {
        if (spell.getTimeSinceLastCast(S.pwFortitude) < 60000) return false;
        return !this._hasBuff(me, A.pwFortitude);
      }),

      // OOC healing — top people off between pulls
      new bt.Decorator(
        () => !me.inCombat(),
        new bt.Selector(
          // Surge of Light proc → free heal
          spell.cast(S.flashHeal, () => this.getHealTarget(85) || me, () =>
            me.hasAura(A.surgeOfLight)
          ),
          // PW:Shield on injured ally
          spell.cast(S.pwShield, () => {
            const t = this.getHealTarget(80);
            return (t && !t.hasAura(A.pwShield)) ? t : null;
          }),
          // Flash Heal on injured ally (mana permitting)
          spell.cast(S.flashHeal, () => this.getHealTarget(70), () =>
            this.getHealTarget(70) !== null && this.getManaPercent() > 60
          ),
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // Combat gate — allow healing if anyone is in combat OR anyone is injured
      new bt.Action(() => {
        if (me.inCombat()) return bt.Status.Failure;
        const friends = heal.friends.All;
        for (let i = 0; i < friends.length; i++) {
          if (friends[i] && friends[i].inCombat()) return bt.Status.Failure;
          if (friends[i] && !friends[i].deadOrGhost && friends[i].effectiveHealthPercent < 85) return bt.Status.Failure;
        }
        return bt.Status.Success;
      }),

      common.waitForCastOrChannel(),

      // Block briefly after Ultimate Penitence channel
      new bt.Action(() => {
        return spell.getTimeSinceLastCast(S.ultimatePenitence) < 400
          ? bt.Status.Success : bt.Status.Failure;
      }),

      // Version log + ramp system + debug + cache
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isVoidweaver() ? 'Voidweaver' : 'Oracle';
          const evangKey = KeyBinding.formatKeyBinding(KeyBinding.keybindings['FWDiscEvangKey']) || 'F1';
          const raptKey = KeyBinding.formatKeyBinding(KeyBinding.keybindings['FWDiscRaptureKey']) || 'F2';
          console.info(`[FW DiscPriest] Midnight 12.0.1 | Hero: ${hero} | Evang: ${evangKey} | Rapture: ${raptKey}`);
        }
        this.handleRampSystem();
        this._refreshHealCache();
        if (Settings.FWDiscDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const mana = Math.round(this.getManaPercent());
          const atone = this.getAtonementCount();
          const potds = me.hasAura(A.potds) ? 'Y' : 'N';
          const rift = me.hasAura(A.entropicRift) ? 'Y' : 'N';
          const rampState = this._evangRampActive ? 'EVANG-PRE' :
            this._raptureRampActive ? 'RAPT-PRE' :
            this.isPostEvangelism() ? 'EVANG-BURST' :
            this.isPostRapture() ? 'RAPT-BURST' : 'none';
          console.info(`[DiscPriest] Lowest:${Math.round(this._cachedLowestHP)}% Atone:${atone} Mana:${mana}% PotDS:${potds} Rift:${rift} Ramp:${rampState}`);
        }
        return bt.Status.Failure;
      }),

      // GCD gate
      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // 1. OFF-GCD: Fade (threat/DR)
          spell.cast(S.fade, () => me, () =>
            Settings.FWDiscFade && me.inCombat() &&
            (me.effectiveHealthPercent < 80 || me.isTanking()) &&
            spell.getTimeSinceLastCast(S.fade) > 10000
          ),

          // 2. Dispels (all priorities — Purify removes Magic + Disease from friendlies)
          spell.dispel(S.purify, true, DispelPriority.High, false, WoWDispelType.Magic),
          spell.dispel(S.purify, true, DispelPriority.High, false, WoWDispelType.Disease),
          spell.dispel(S.purify, true, DispelPriority.Medium, false, WoWDispelType.Magic),
          spell.dispel(S.purify, true, DispelPriority.Medium, false, WoWDispelType.Disease),
          spell.dispel(S.purify, true, DispelPriority.Low, false, WoWDispelType.Magic),
          spell.dispel(S.purify, true, DispelPriority.Low, false, WoWDispelType.Disease),

          // 3. Movement handling (Penance castable while moving)
          this.movementHealing(),

          // 4. Emergency healing (someone < 20%)
          this.emergencyHealing(),

          // 5. Self-defensives
          this.defensives(),

          // 6. Void Shield proc (MUST consume before next Penance — otherwise wasted)
          this.voidShieldConsume(),

          // 6b. Surge of Light — FREE instant Flash Heal, applies Atonement. Never waste.
          spell.cast(S.flashHeal, () => {
            // Priority: lowest HP ally, then anyone without Atonement, then self
            const hurt = this.getHealTarget(95);
            if (hurt) return hurt;
            const noAtone = this.getAllyWithoutAtonement();
            if (noAtone) return noAtone;
            return me;
          }, () => me.hasAura(A.surgeOfLight)),

          // 6c. Shadow Mend proc — empowered Flash Heal, don't let it expire
          spell.cast(S.flashHeal, () => this.getHealTarget(90) || me, () =>
            me.hasAura(A.shadowMend)
          ),

          // 6d. Dungeon tank focus (≤5 players — tank takes constant heavy damage)
          this.dungeonTankHealing(),

          // 7. Evangelism ramp (keybind-triggered: pre-ramp → press → burst)
          this.evangelismRamp(),

          // 8. Rapture ramp (keybind-triggered)
          this.raptureRamp(),

          // 9. Major CDs (Ultimate Penitence, Barrier, Mindbender)
          this.majorCooldowns(),

          // 10. Critical healing (someone < 40%, direct intervention)
          this.criticalHealing(),

          // 11. Core Atonement damage (this IS the healing)
          this.atonementDamage(),

          // 12. Atonement maintenance (apply/refresh)
          this.atonementMaintenance(),

          // 13. Idle: spread SW:P, blanket Atonement, damage fillers
          this.idleRotation(),
        )
      ),
    );
  }

  // ===== MOVEMENT HANDLING (Penance castable while moving) =====
  movementHealing() {
    return new bt.Decorator(
      () => me.isMoving(),
      new bt.Selector(
        // Defensive Penance on critically injured ally
        spell.cast(S.penance, () => this.getHealTarget(Settings.FWDiscEmergencyHP), () =>
          this._cachedLowestHP < Settings.FWDiscEmergencyHP
        ),
        // Void Shield proc → instant PW:S on hurt ally
        spell.cast(S.voidShield, () => this.getVoidShieldTarget(), () =>
          me.hasAura(A.voidShieldProc) && this.getVoidShieldTarget() !== null
        ),
        // Void Blast during Entropic Rift (Voidweaver — highest damage instant)
        spell.cast(S.voidBlast, () => this.getDpsTarget(), () =>
          this.isVoidweaver() && me.hasAura(A.entropicRift) && this.getDpsTarget() !== null
        ),
        // Offensive Penance for Atonement healing (blocked by Void Shield proc)
        spell.cast(S.penance, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null && !me.hasAura(A.voidShieldProc) &&
          this.getAtonementCount() >= 1
        ),
        // PW:Shield on hurt ally
        spell.cast(S.pwShield, () => {
          const t = this.getHealTarget(Settings.FWDiscMaintHP);
          return (t && !t.hasAura(A.pwShield)) ? t : null;
        }),
        // Plea (instant Atonement apply/refresh)
        spell.cast(S.plea, () => this.getAllyWithExpiringAtonement(4000) || this.getAllyWithoutAtonement()),
        // SW:Pain (instant DoT — Atonement healing + Expiation fuel)
        spell.cast(S.swPain, () => this.getSwPainTarget()),
        // SW:Death (instant damage — only when SW:P ticking for Expiation)
        spell.cast(S.swDeath, () => this.getDpsTarget(), () => {
          const t = this.getDpsTarget();
          if (!t || me.effectiveHealthPercent < 40) return false;
          return t.hasAuraByMe(A.swPain);
        }),
        // Block cast-time spells while moving
        new bt.Action(() => bt.Status.Success),
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== DUNGEON TANK HEALING (≤5 players — tank takes priority) =====
  dungeonTankHealing() {
    return new bt.Decorator(
      () => (heal.friends.All?.length || 0) <= 5 && this._cachedTankLowest !== null,
      new bt.Selector(
        // Pain Suppression on tank at critical HP
        spell.cast(S.painSuppression, () => this.getTankTarget(Settings.FWDiscCriticalHP), () => {
          const tank = this.getTankTarget(Settings.FWDiscCriticalHP);
          return Settings.FWDiscPainSupp && tank !== null && !tank.hasAura(A.painSuppression);
        }),

        // Defensive Penance on tank below urgent HP (direct heal)
        spell.cast(S.penance, () => this.getTankTarget(Settings.FWDiscUrgentHP), () =>
          this.getTankTarget(Settings.FWDiscUrgentHP) !== null && !me.hasAura(A.voidShieldProc)
        ),

        // PW:Shield on tank — absorb + Atonement (whenever available)
        spell.cast(S.pwShield, () => {
          const tank = this._cachedTankLowest;
          if (!tank || tank.deadOrGhost) return null;
          if (tank.hasAura(A.pwShield)) return null;
          // Always shield tank if below urgent, or if no Atonement
          if (tank.effectiveHealthPercent < Settings.FWDiscUrgentHP || !tank.hasAuraByMe(A.atonement)) return tank;
          return null;
        }),

        // Keep Atonement on tank at ALL times via Plea (cheap, instant)
        spell.cast(S.plea, () => {
          const tank = this._cachedTankLowest;
          if (!tank || tank.deadOrGhost || me.distanceTo(tank) > 40) return null;
          if (!tank.hasAuraByMe(A.atonement)) return tank;
          // Refresh if Atonement expiring soon (< 5s)
          const atone = tank.getAura(A.atonement);
          if (atone && atone.remaining < 5000) return tank;
          return null;
        }),

        // Flash Heal on tank below urgent HP (proc or hard-cast)
        spell.cast(S.flashHeal, () => this.getTankTarget(Settings.FWDiscUrgentHP), () => {
          if (this.getTankTarget(Settings.FWDiscUrgentHP) === null) return false;
          return me.hasAura(A.surgeOfLight) || me.hasAura(A.shadowMend) || this.hasManaFor('flashHeal');
        }),
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // ===== EMERGENCY HEALING (Tier 1: < 20%) =====
  emergencyHealing() {
    return new bt.Decorator(
      () => this._cachedBelow20 >= 1,
      new bt.Selector(
        // Desperate Prayer (self)
        spell.cast(S.desperatePrayer, () => me, () =>
          Settings.FWDiscDesPrayer && me.effectiveHealthPercent < Settings.FWDiscDesPrayerHP
        ),
        // Defensive Penance (direct heal on dying ally)
        spell.cast(S.penance, () => this.getHealTarget(Settings.FWDiscEmergencyHP)),
        // PW:Shield for absorb
        spell.cast(S.pwShield, () => {
          const t = this.getHealTarget(Settings.FWDiscEmergencyHP);
          return (t && !t.hasAura(A.pwShield)) ? t : null;
        }),
        // Surge of Light proc → free instant Flash Heal
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscEmergencyHP), () =>
          me.hasAura(A.surgeOfLight)
        ),
        // Shadow Mend proc → empowered Flash Heal
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscEmergencyHP), () =>
          me.hasAura(A.shadowMend)
        ),
        // Hard-cast Flash Heal (emergency only)
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscEmergencyHP), () =>
          this.hasManaFor('flashHeal')
        ),
      )
    );
  }

  // ===== SELF-DEFENSIVES =====
  defensives() {
    return new bt.Selector(
      // Pain Suppression (external DR, OFF by default)
      spell.cast(S.painSuppression, () => {
        const t = this.getHealTarget(Settings.FWDiscPainSuppHP);
        return (t && !t.hasAura(A.painSuppression)) ? t : null;
      }, () =>
        Settings.FWDiscPainSupp && me.inCombat()
      ),
      // Desperate Prayer (self)
      spell.cast(S.desperatePrayer, () => me, () =>
        Settings.FWDiscDesPrayer && me.inCombat() &&
        me.effectiveHealthPercent < Settings.FWDiscDesPrayerHP
      ),
    );
  }

  // ===== VOID SHIELD PROC (consume BEFORE next Penance) =====
  voidShieldConsume() {
    return spell.cast(S.voidShield, () => this.getVoidShieldTarget(), () =>
      me.hasAura(A.voidShieldProc) && this.getVoidShieldTarget() !== null
    );
  }

  // ===== CRITICAL HEALING (Tier 2: someone < 40%) =====
  criticalHealing() {
    return new bt.Decorator(
      () => this._cachedBelow40 >= 1 && !this.isRamping(),
      new bt.Selector(
        // Defensive Penance
        spell.cast(S.penance, () => this.getHealTarget(Settings.FWDiscCriticalHP), () =>
          this.getHealTarget(Settings.FWDiscCriticalHP) !== null
        ),
        // PW:Shield
        spell.cast(S.pwShield, () => {
          const t = this.getHealTarget(Settings.FWDiscCriticalHP);
          return (t && !t.hasAura(A.pwShield)) ? t : null;
        }),
        // Surge of Light / Shadow Mend proc
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscCriticalHP), () =>
          (me.hasAura(A.surgeOfLight) || me.hasAura(A.shadowMend)) &&
          this.getHealTarget(Settings.FWDiscCriticalHP) !== null
        ),
        // Flash Heal hard-cast
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscCriticalHP), () =>
          this.getHealTarget(Settings.FWDiscCriticalHP) !== null && this.hasManaFor('flashHeal')
        ),
      )
    );
  }

  // ===== EVANGELISM RAMP =====
  // Method sequence: SW:P → Void Shield → PW:S → Plea → Flash Heal(self) → Evangelism → 2x Radiance → burst
  evangelismRamp() {
    return new bt.Selector(
      // Phase 3: Post-Evangelism BURST — damage heals all Atonements
      new bt.Decorator(
        () => this.isPostEvangelism(),
        new bt.Selector(
          // Use buffed Radiances (instant, 40% cheaper) within first 6s — 1 in dungeon, 2 in raid
          new bt.Sequence(
            spell.cast(S.pwRadiance, () => me, () => {
              const maxCasts = (heal.friends.All?.length || 0) <= 5 ? 1 : 2;
              return this._rampRadianceCount < maxCasts &&
                spell.getCharges(S.pwRadiance) > 0 &&
                spell.getTimeSinceLastCast(S.evangelism) < 6000;
            }),
            new bt.Action(() => { this._rampRadianceCount++; return bt.Status.Success; }),
          ),
          // Burst damage → heals all Atonement targets
          this.burstDamage(),
        )
      ),

      // Phase 2: Press Evangelism (keybind ramp active + enough Atonements)
      spell.cast(S.evangelism, () => me, () => {
        if (spell.isOnCooldown(S.evangelism)) return false;
        if (!this._evangRampActive) return false;
        return this.getAtonementCount() >= Settings.FWDiscRampAtonements;
      }),

      // Phase 1: Pre-ramp — apply Atonements before pressing the CD
      // Method sequence: SW:P → Void Shield → PW:S → Plea → FH(self)
      new bt.Decorator(
        () => this._evangRampActive && !this.isPostEvangelism() && !spell.isOnCooldown(S.evangelism),
        new bt.Selector(
          // Step 1: SW:Pain refresh (Expiation fuel for upcoming burst)
          spell.cast(S.swPain, () => this.getSwPainTarget()),
          // Step 2: Void Shield proc → 3 Atonements at once (Voidweaver)
          spell.cast(S.voidShield, () => this.getVoidShieldTarget(), () =>
            me.hasAura(A.voidShieldProc) && this.getVoidShieldTarget() !== null
          ),
          // Step 3: PW:Shield on ally without Atonement
          spell.cast(S.pwShield, () => {
            const t = this.getAllyWithoutAtonement();
            return (t && !t.hasAura(A.pwShield)) ? t : null;
          }),
          // Step 4: Plea for cheap Atonement
          spell.cast(S.plea, () => this.getAllyWithoutAtonement()),
          // Step 5: Flash Heal for self-Atonement (Binding Heals)
          spell.cast(S.flashHeal, () => me, () =>
            !me.hasAuraByMe(A.atonement) && this.hasManaFor('flashHeal')
          ),
          // Step 6: PW:Radiance if still need more Atonements and have charges
          spell.cast(S.pwRadiance, () => me, () =>
            this.getAtonementCount() < Settings.FWDiscRampAtonements &&
            spell.getCharges(S.pwRadiance) > 0 && this.hasManaFor('radiance')
          ),
        )
      ),
    );
  }

  // ===== RAPTURE RAMP =====
  raptureRamp() {
    return new bt.Selector(
      // Post-Rapture: spam empowered PW:S (no CD, +80% absorb)
      new bt.Decorator(
        () => this.isPostRapture(),
        new bt.Selector(
          spell.cast(S.pwShield, () => this.getAllyWithoutShield()),
          this.burstDamage(),
        )
      ),

      // Press Rapture (keybind ramp active)
      spell.cast(S.rapture, () => me, () => {
        if (!spell.isSpellKnown(S.rapture) || spell.isOnCooldown(S.rapture)) return false;
        return this._raptureRampActive;
      }),
    );
  }

  // ===== MAJOR COOLDOWNS (OFF by default) =====
  majorCooldowns() {
    return new bt.Selector(
      // Ultimate Penitence (choice node — massive damage barrage)
      spell.cast(S.ultimatePenitence, () => this.getDpsTarget(), () => {
        if (!Settings.FWDiscUP || !spell.isSpellKnown(S.ultimatePenitence)) return false;
        return me.inCombat() && this.getAtonementCount() >= Settings.FWDiscUPAtonements &&
          this.getDpsTarget() !== null;
      }),

      // Power Word: Barrier (choice node — AoE DR zone)
      spell.cast(S.pwBarrier, () => this.getHealTarget(Settings.FWDiscBarrierHP), () => {
        if (!Settings.FWDiscBarrier || !spell.isSpellKnown(S.pwBarrier)) return false;
        return me.inCombat() && this.getFriendsBelow(Settings.FWDiscBarrierHP) >= Settings.FWDiscBarrierCount;
      }),

      // Mindbender (mana + damage)
      spell.cast(S.mindbender, () => this.getDpsTarget(), () =>
        spell.isSpellKnown(S.mindbender) && me.inCombat() &&
        this.getDpsTarget() !== null && this.getManaPercent() < 80
      ),
    );
  }

  // ===== BURST DAMAGE (during ramp windows) =====
  // Method Evangelist ramp sequence: Penance → Mind Blast → Penance → damage
  // Voidweaver: Void Blast spam during Entropic Rift after Mind Blast opens it
  burstDamage() {
    return new bt.Selector(
      // Void Shield proc (consume BEFORE Penance — otherwise wasted)
      spell.cast(S.voidShield, () => this.getVoidShieldTarget(), () =>
        me.hasAura(A.voidShieldProc) && this.getVoidShieldTarget() !== null
      ),
      // SW:Pain maintenance (Expiation fuel — must be ticking for SWD/MB to consume)
      spell.cast(S.swPain, () => this.getSwPainTarget()),
      // Void Blast HIGHEST priority during Entropic Rift (Voidweaver)
      // Per Method: "Spam Void Blast after Penance during Entropic Rift windows"
      spell.cast(S.voidBlast, () => this.getDpsTarget(), () =>
        this.isVoidweaver() && me.hasAura(A.entropicRift) && this.getDpsTarget() !== null
      ),
      // Mind Blast — Dark Indulgence guarantees PotDS → empowers next Penance
      // Voidweaver: also opens Entropic Rift
      // Priority: cast when PotDS not active (to generate it for Penance)
      spell.cast(S.mindBlast, () => this.getDpsTarget(), () =>
        this.getDpsTarget() !== null && !me.hasAura(A.potds)
      ),
      // Penance (offensive, empowered by PotDS, blocked by Void Shield proc)
      spell.cast(S.penance, () => this.getDpsTarget(), () =>
        this.getDpsTarget() !== null && !me.hasAura(A.voidShieldProc)
      ),
      // Mind Blast (use remaining charges — charge fractional capping)
      spell.cast(S.mindBlast, () => this.getDpsTarget(), () => {
        if (!this.getDpsTarget()) return false;
        return spell.getChargesFractional(S.mindBlast) > 1.4;
      }),
      // SW:Death — Expiation burst (consumes 1s SW:P for 300% damage)
      // Only when SW:P is ticking on target (otherwise wasted)
      spell.cast(S.swDeath, () => this.getDpsTarget(), () => {
        const t = this.getDpsTarget();
        if (!t || me.effectiveHealthPercent < 40) return false;
        return t.hasAuraByMe(A.swPain); // Expiation requires SW:P ticking
      }),
      // Smite filler (extends Atonement via Divine Procession)
      spell.cast(S.smite, () => this.getDpsTarget(), () =>
        this.getDpsTarget() !== null
      ),
    );
  }

  // ===== ATONEMENT DAMAGE (core healing outside ramp) =====
  // Method: "Always be casting Penance and Smite during downtime to maximize Atonement value"
  // Priority: SW:P → Void Blast (rift) → MB (no PotDS) → Penance → MB (capping) → SWD (Expiation) → Smite
  atonementDamage() {
    return new bt.Decorator(
      () => this._cachedLowestHP < Settings.FWDiscMaintHP && this.getAtonementCount() >= 1,
      new bt.Selector(
        // SW:Pain maintenance (Expiation fuel + Shadow Mend procs)
        spell.cast(S.swPain, () => this.getSwPainTarget()),
        // Void Blast during Entropic Rift (Voidweaver — HIGHEST damage priority)
        spell.cast(S.voidBlast, () => this.getDpsTarget(), () =>
          this.isVoidweaver() && me.hasAura(A.entropicRift) && this.getDpsTarget() !== null
        ),
        // Mind Blast to generate PotDS for next Penance
        spell.cast(S.mindBlast, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null && !me.hasAura(A.potds)
        ),
        // Penance (offensive, empowered by PotDS, blocked by Void Shield proc)
        spell.cast(S.penance, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null && !me.hasAura(A.voidShieldProc)
        ),
        // Mind Blast (use charges to avoid capping)
        spell.cast(S.mindBlast, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null && spell.getChargesFractional(S.mindBlast) > 1.4
        ),
        // SW:Death — Expiation burst (only when SW:P ticking)
        spell.cast(S.swDeath, () => this.getDpsTarget(), () => {
          const t = this.getDpsTarget();
          if (!t || me.effectiveHealthPercent < 40) return false;
          return t.hasAuraByMe(A.swPain);
        }),
        // Smite filler
        spell.cast(S.smite, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null
        ),
      )
    );
  }

  // ===== ATONEMENT MAINTENANCE (apply/refresh) =====
  atonementMaintenance() {
    return new bt.Selector(
      // PW:Radiance when 3+ injured without Atonement (charge fractional aware)
      spell.cast(S.pwRadiance, () => me, () => {
        if (!this.hasManaFor('radiance')) return false;
        return spell.getChargesFractional(S.pwRadiance) > 1.4 &&
          this.getFriendsBelow(Settings.FWDiscUrgentHP) >= 3;
      }),

      // Surge of Light proc → free instant Flash Heal (Atonement + heal)
      spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscMaintHP), () =>
        me.hasAura(A.surgeOfLight) && this.getHealTarget(Settings.FWDiscMaintHP) !== null
      ),

      // Shadow Mend proc → empowered Flash Heal
      spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscMaintHP), () =>
        me.hasAura(A.shadowMend) && this.getHealTarget(Settings.FWDiscMaintHP) !== null
      ),

      // PW:Shield on injured ally without Atonement
      spell.cast(S.pwShield, () => {
        const target = this.getHealTarget(Settings.FWDiscUrgentHP);
        if (target && !target.hasAura(A.pwShield) && !target.hasAuraByMe(A.atonement)) return target;
        return null;
      }),

      // Plea to refresh expiring Atonement (< 4s remaining)
      // Plea mana cost scales +100% per active Atonement — don't spam at high counts + low mana
      spell.cast(S.plea, () => this.getAllyWithExpiringAtonement(4000), () => {
        const atones = this.getAtonementCount();
        const mana = this.getManaPercent();
        if (atones >= 5 && mana < 40) return false;
        if (atones >= 8 && mana < 60) return false;
        return this.getAllyWithExpiringAtonement(4000) !== null;
      }),

      // Tank Atonement maintenance (always keep Atonement on tanks)
      spell.cast(S.pwShield, () => {
        const tanks = heal.friends.Tanks;
        if (!tanks) return null;
        for (let i = 0; i < tanks.length; i++) {
          const tank = tanks[i];
          if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40 &&
              !tank.hasAuraByMe(A.atonement) && !tank.hasAura(A.pwShield)) {
            return tank;
          }
        }
        return null;
      }),
      spell.cast(S.plea, () => {
        const tanks = heal.friends.Tanks;
        if (!tanks) return null;
        for (let i = 0; i < tanks.length; i++) {
          const tank = tanks[i];
          if (tank && !tank.deadOrGhost && me.distanceTo(tank) <= 40 && !tank.hasAuraByMe(A.atonement)) {
            return tank;
          }
        }
        return null;
      }),

      // Defensive Penance on moderately hurt ally (no Atonements to heal via damage)
      spell.cast(S.penance, () => this.getHealTarget(Settings.FWDiscUrgentHP), () => {
        const target = this.getHealTarget(Settings.FWDiscUrgentHP);
        return target !== null && !me.hasAura(A.voidShieldProc) &&
          this.getAtonementCount() < 2;
      }),

      // Flash Heal on urgent target (mana permitting)
      spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWDiscUrgentHP), () =>
        this.getHealTarget(Settings.FWDiscUrgentHP) !== null &&
        this.getManaPercent() > 50 && this.hasManaFor('flashHeal')
      ),
    );
  }

  // ===== IDLE ROTATION (everyone healthy — DPS for Atonement healing) =====
  // Method: "Always be casting" — maintain SW:P, blanket Atonement, damage fillers
  idleRotation() {
    return new bt.Decorator(
      () => me.inCombat(),
      new bt.Selector(
        // SW:P spread to additional targets (Expiation fuel + Shadow Mend procs)
        spell.cast(S.swPain, () => this.getSwPainSpreadTarget()),

        // Blanket Atonement via PW:S on anyone without
        spell.cast(S.pwShield, () => {
          const t = this.getAllyWithoutAtonement();
          return (t && !t.hasAura(A.pwShield)) ? t : null;
        }),

        // SW:P maintenance on primary target
        spell.cast(S.swPain, () => this.getSwPainTarget()),

        // Void Blast during Entropic Rift (Voidweaver — HIGHEST damage priority)
        spell.cast(S.voidBlast, () => this.getDpsTarget(), () =>
          this.isVoidweaver() && me.hasAura(A.entropicRift) && this.getDpsTarget() !== null
        ),

        // Mind Blast to generate PotDS (Dark Indulgence → PotDS for next Penance)
        spell.cast(S.mindBlast, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null && !me.hasAura(A.potds)
        ),

        // Penance (blocked by Void Shield proc)
        spell.cast(S.penance, () => this.getDpsTarget(), () => {
          if (!this.getDpsTarget() || me.hasAura(A.voidShieldProc)) return false;
          // Oracle: use charge fractional (extra charge via Guiding Light)
          if (this.isOracle()) return spell.getChargesFractional(S.penance) > 1.4;
          return true;
        }),

        // Mind Blast (use charges to avoid capping)
        spell.cast(S.mindBlast, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null && spell.getChargesFractional(S.mindBlast) > 1.4
        ),

        // SW:Death — Expiation burst (only when SW:P ticking)
        spell.cast(S.swDeath, () => this.getDpsTarget(), () => {
          const t = this.getDpsTarget();
          if (!t || me.effectiveHealthPercent < 50) return false;
          return t.hasAuraByMe(A.swPain);
        }),

        // Smite filler
        spell.cast(S.smite, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null
        ),
      )
    );
  }
}
