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
 * Elemental Shaman Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (shaman_elemental.simc) + Method + Wowhead + SEL
 *
 * Auto-detects: Stormbringer (Tempest) vs Farseer (Ancestral Swiftness)
 * SimC lists: single_target (13), aoe (19), default (17), precombat (8)
 *
 * Core MoTE alternation: LvB (Fire) → Nature spell (Tempest/LB/ES/EB) → repeat
 * Burst: Stormkeeper → Ascendance → Tempest/LB(SK) → ES/EB → LvB cycle
 * Lightning Rod: applied by ES/EB/EQ/Tempest, duplicates 10% LB/CL/Tempest damage
 *
 * Resource: Maelstrom (PowerType 11), base cap 100 (+50 Swelling Maelstrom talent 381707)
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL (every line) + Method + Wowhead + SEL',
};

const S = {
  lightningBolt:      188196,
  lavaBurst:          51505,
  chainLightning:     188443,
  earthShock:         8042,
  earthquake:         61882,
  elementalBlast:     117014,
  flameShock:         188389,
  frostShock:         196840,
  voltaicBlaze:       470057,
  tempest:            454009,
  stormkeeper:        191634,
  ascendance:         114050,
  fireElemental:      198067,
  ancestralSwiftness: 443454,
  naturesSwiftness:   378081,
  spiritwalkerGrace:  79206,
  windShear:          57994,
  astralShift:        108271,
  healingSurge:       8004,
  skyfury:            462854,
  lightningShield:    192106,
  berserking:         26297,
};

const T = {
  masterOfElements:   16166,
  moltenWrath:        1258843,
  callOfAncestors:    443450,
  fusionOfElements:   462840,
  purgingFlames:      1259471,
  infernoArc:         1259047,
  swellingMaelstrom:  381707,
  firstAscendant:     462440,
  preeminence:        462443,
};

const A = {
  masterOfElements:   260734,
  lavaSurge:          77762,
  stormkeeper:        191634,
  ascendance:         114050,
  flameShock:         188389,
  tempest:            454009,
  powerOfMaelstrom:   191877,
  purgingFlames:      1259471,
  fireElemental:      198067,
  lightningShield:    192106,
  spiritwalkerGrace:  79206,
  skyfury:            462854,
  lightningRod:       210689,
};

export class ElementalShamanBehavior extends Behavior {
  name = 'FW Elemental Shaman';
  context = BehaviorContext.Any;
  specialization = Specialization.Shaman.Elemental;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _moteFrame = 0;
  _cachedMote = false;
  _tempFrame = 0;
  _cachedTemp = 0;
  _skFrame = 0;
  _cachedSK = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _maelCapFrame = 0;
  _cachedMaelCap = 100;
  _versionLogged = false;
  _lastDebug = 0;
  _combatStart = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWEleUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWEleAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWEleDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWEleAstral', text: 'Use Astral Shift', default: true },
        { type: 'slider', uid: 'FWEleAstralHP', text: 'Astral Shift HP %', default: 45, min: 10, max: 80 },
        { type: 'checkbox', uid: 'FWEleHS', text: 'Use Healing Surge', default: true },
        { type: 'slider', uid: 'FWEleHSHP', text: 'Healing Surge HP %', default: 30, min: 10, max: 60 },
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

      // OOC: Skyfury + Lightning Shield
      new bt.Decorator(
        () => !me.inCombat(),
        new bt.Selector(
          spell.cast(S.lightningShield, () => me, () =>
            !me.hasAura(A.lightningShield) && spell.getTimeSinceLastCast(S.lightningShield) > 5000
          ),
          spell.cast(S.skyfury, () => this.getSkyfuryTarget(), () => this.getSkyfuryTarget() !== null),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Combat timer
      new bt.Action(() => {
        if (me.inCombat() && !this._combatStart) this._combatStart = wow.frameTime;
        if (!me.inCombat()) this._combatStart = 0;
        return bt.Status.Failure;
      }),

      // Auto-target
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),

      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      // Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Ele] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isSB() ? 'Stormbringer' : 'Farseer'} | MaelCap:${this.getMaelCap()} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWEleDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          this.refreshCaches();
          console.info(`[Ele] Mael:${this.getMael()}/${this.getMaelCap()} MoTE:${this._cachedMote} SK:${this._cachedSK} Temp:${this._cachedTemp} LvBfrac:${spell.getChargesFractional(S.lavaBurst).toFixed(2)} PoM:${this.getPoMStacks()} FE:${me.hasAura(A.fireElemental)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.windShear),
          this.defensives(),

          // SimC: spiritwalkers_grace,moving=1,if=movement.distance>6
          spell.cast(S.spiritwalkerGrace, () => me, () =>
            me.isMoving() && !me.hasAura(A.spiritwalkerGrace) && me.hasAura(A.ascendance)
          ),

          // SimC: Fire Elemental on CD (not in APL but auto-cast by SimC; major DPS CD)
          spell.cast(S.fireElemental, () => me, () =>
            Settings.FWEleUseCDs && this.targetTTD() > 15000 &&
            spell.getTimeSinceLastCast(S.fireElemental) > 5000
          ),

          // SimC: berserking (unconditional racial, gate behind TTD)
          spell.cast(S.berserking, () => me, () => this.targetTTD() > 8000),

          // SimC: lightning_shield,if=buff.lightning_shield.down
          spell.cast(S.lightningShield, () => me, () => !me.hasAura(A.lightningShield)),

          // SimC: natures_swiftness (unconditional in SimC APL — no hero talent gate)
          spell.cast(S.naturesSwiftness, () => me),

          // SimC dispatch: AoE >= 3 → aoe, else → single_target
          new bt.Decorator(
            () => this.getEnemyCount() >= Settings.FWEleAoECount,
            this.aoeRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),
          this.stRotation(),
        )
      ),
    );
  }

  // =============================================
  // SINGLE TARGET (SimC actions.single_target, 13 lines + 3 moving)
  // =============================================
  stRotation() {
    this.refreshCaches();
    return new bt.Selector(
      // Movement block — all instant-cast abilities
      new bt.Decorator(
        () => me.isMoving() && !me.hasAura(A.spiritwalkerGrace),
        new bt.Selector(
          spell.cast(S.flameShock, () => this.getCurrentTarget(), () => this.fsRefreshable()),
          spell.cast(S.voltaicBlaze, () => this.getCurrentTarget()),
          spell.cast(S.tempest, () => this.getCurrentTarget(), () => this._cachedTemp > 0),
          spell.cast(S.earthShock, () => this.getCurrentTarget(), () => this.getMael() >= 60),
          spell.cast(S.elementalBlast, () => this.getCurrentTarget(), () => this.getMael() >= 60),
          spell.cast(S.lavaBurst, () => this.getCurrentTarget(), () => me.hasAura(A.lavaSurge)),
          spell.cast(S.frostShock, () => this.getCurrentTarget()),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 1. stormkeeper,if=cooldown.ascendance.remains>10|cooldown.ascendance.remains<gcd|fight_remains<20
      spell.cast(S.stormkeeper, () => me, () =>
        Settings.FWEleUseCDs && (this.ascCD() > 10000 || this.ascCD() < 1500 || this.targetTTD() < 20000)
      ),

      // 2. ancestral_swiftness (unconditional in SimC — Farseer only has it)
      spell.cast(S.ancestralSwiftness, () => this.getCurrentTarget()),

      // 3. ascendance,if=cooldown.stormkeeper.remains>15|fight_remains<20
      spell.cast(S.ascendance, () => me, () =>
        Settings.FWEleUseCDs && !me.hasAura(A.ascendance) &&
        ((spell.getCooldown(S.stormkeeper)?.timeleft || 0) > 15000 || this.targetTTD() < 20000)
      ),

      // 4. flame_shock,if=!buff.master_of_the_elements.up&((dot.flame_shock.refreshable&cooldown.ascendance.remains>5)|(buff.fire_elemental.up&buff.fire_elemental.remains<2))
      spell.cast(S.flameShock, () => this.getCurrentTarget(), () => {
        if (this._cachedMote) return false;
        if (spell.getTimeSinceLastCast(S.flameShock) < 3000) return false;
        if (this.fsRefreshable() && this.ascCD() > 5000) return true;
        const feRemains = this.getFeRemains();
        return feRemains > 0 && feRemains < 2000;
      }),

      // 5. voltaic_blaze,if=!buff.master_of_the_elements.up&((dot.flame_shock.refreshable&cooldown.ascendance.remains>5)|(buff.fire_elemental.up&buff.fire_elemental.remains<2)|talent.purging_flames&spell_targets.chain_lightning=2)
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () => {
        if (this._cachedMote) return false;
        if (this.fsRefreshable() && this.ascCD() > 5000) return true;
        const feRemains = this.getFeRemains();
        if (feRemains > 0 && feRemains < 2000) return true;
        return spell.isSpellKnown(T.purgingFlames) && this.getEnemyCount() === 2;
      }),

      // 6. lava_burst,if=!buff.master_of_the_elements.up&maelstrom.deficit>15&(talent.master_of_the_elements|talent.molten_wrath|talent.call_of_the_ancestors|buff.lava_surge.up|talent.fusion_of_elements&(!buff.storm_elemental.up|buff.wind_gust.stack=4))
      spell.cast(S.lavaBurst, () => this.getCurrentTarget(), () => {
        if (this._cachedMote) return false;
        if (this.maelDeficit() <= 15) return false;
        if (spell.isSpellKnown(T.masterOfElements)) return true;
        if (spell.isSpellKnown(T.moltenWrath)) return true;
        if (spell.isSpellKnown(T.callOfAncestors)) return true;
        if (me.hasAura(A.lavaSurge)) return true;
        // fusion_of_elements&(!buff.storm_elemental.up|buff.wind_gust.stack=4)
        // Storm Elemental alternative — if FE taken, storm_elemental.up is always false → condition true
        if (spell.isSpellKnown(T.fusionOfElements)) return true;
        return spell.getChargesFractional(S.lavaBurst) >= 1.8;
      }),

      // 7. tempest,if=buff.master_of_the_elements.up|!talent.master_of_the_elements
      spell.cast(S.tempest, () => this.getCurrentTarget(), () =>
        this.isSB() && this._cachedTemp > 0 && (this._cachedMote || !spell.isSpellKnown(T.masterOfElements))
      ),

      // 8. lightning_bolt,if=buff.stormkeeper.up&(buff.master_of_the_elements.up|!talent.master_of_the_elements)
      spell.cast(S.lightningBolt, () => this.getCurrentTarget(), () =>
        this._cachedSK > 0 && (this._cachedMote || !spell.isSpellKnown(T.masterOfElements))
      ),

      // 9. elemental_blast (unconditional in SimC — SimC checks cost internally)
      spell.cast(S.elementalBlast, () => this.getCurrentTarget(), () => this.getMael() >= 60),

      // 10. earth_shock (unconditional in SimC — SimC checks cost internally)
      spell.cast(S.earthShock, () => this.getCurrentTarget(), () => this.getMael() >= 60),

      // 11. tempest (unconditional)
      spell.cast(S.tempest, () => this.getCurrentTarget(), () =>
        this.isSB() && this._cachedTemp > 0
      ),

      // 12. chain_lightning,if=talent.call_of_the_ancestors&spell_targets.chain_lightning=2
      spell.cast(S.chainLightning, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.callOfAncestors) && this.getEnemyCount() === 2
      ),

      // 13. lightning_bolt (filler)
      spell.cast(S.lightningBolt, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // AOE (SimC actions.aoe, 19 lines + 3 moving, 3+ targets)
  // =============================================
  aoeRotation() {
    this.refreshCaches();
    return new bt.Selector(
      // Movement block — all instant-cast abilities
      new bt.Decorator(
        () => me.isMoving() && !me.hasAura(A.spiritwalkerGrace),
        new bt.Selector(
          spell.cast(S.flameShock, () => this.getCurrentTarget(), () => this.fsRefreshable()),
          spell.cast(S.voltaicBlaze, () => this.getCurrentTarget()),
          spell.cast(S.tempest, () => this.getCurrentTarget(), () => this._cachedTemp > 0),
          spell.cast(S.earthquake, () => this.getCurrentTarget(), () => this.getMael() >= 60),
          spell.cast(S.frostShock, () => this.getCurrentTarget()),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 1. stormkeeper,if=cooldown.ascendance.remains>10|cooldown.ascendance.remains<gcd|fight_remains<20
      spell.cast(S.stormkeeper, () => me, () =>
        Settings.FWEleUseCDs && (this.ascCD() > 10000 || this.ascCD() < 1500 || this.targetTTD() < 20000)
      ),

      // 2. voltaic_blaze,if=time<3&talent.purging_flames
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () =>
        this.combatTime() < 3000 && spell.isSpellKnown(T.purgingFlames)
      ),

      // 3. ancestral_swiftness (unconditional in SimC)
      spell.cast(S.ancestralSwiftness, () => this.getCurrentTarget()),

      // 4. ascendance,if=cooldown.stormkeeper.remains>15|fight_remains<20
      spell.cast(S.ascendance, () => me, () =>
        Settings.FWEleUseCDs && !me.hasAura(A.ascendance) &&
        ((spell.getCooldown(S.stormkeeper)?.timeleft || 0) > 15000 || this.targetTTD() < 20000)
      ),

      // 5. flame_shock,if=!buff.master_of_the_elements.up&((dot.flame_shock.refreshable&cooldown.ascendance.remains>5)|(buff.fire_elemental.up&buff.fire_elemental.remains<2))&talent.master_of_the_elements&talent.inferno_arc&spell_targets.chain_lightning=3
      spell.cast(S.flameShock, () => this.getCurrentTarget(), () => {
        const enemies = this.getEnemyCount();
        if (this._cachedMote) return false;
        if (!spell.isSpellKnown(T.masterOfElements) || !spell.isSpellKnown(T.infernoArc) || enemies !== 3) return false;
        if (spell.getTimeSinceLastCast(S.flameShock) < 3000) return false;
        if (this.fsRefreshable() && this.ascCD() > 5000) return true;
        const feRemains = this.getFeRemains();
        return feRemains > 0 && feRemains < 2000;
      }),

      // 6. voltaic_blaze,if=!buff.master_of_the_elements.up&((dot.flame_shock.refreshable&cooldown.ascendance.remains>5)|(buff.fire_elemental.up&buff.fire_elemental.remains<2)|talent.purging_flames&!buff.ascendance.up)
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () => {
        if (this._cachedMote) return false;
        if (this.fsRefreshable() && this.ascCD() > 5000) return true;
        const feRemains = this.getFeRemains();
        if (feRemains > 0 && feRemains < 2000) return true;
        return spell.isSpellKnown(T.purgingFlames) && !me.hasAura(A.ascendance);
      }),

      // 7. earthquake,if=buff.tempest.stack<2&lightning_rod<active_enemies&spell_targets.chain_lightning>=3+talent.elemental_blast
      spell.cast(S.earthquake, () => this.getCurrentTarget(), () => {
        const enemies = this.getEnemyCount();
        return this._cachedTemp < 2 && this.getMael() >= 60 &&
          enemies >= (3 + (spell.isSpellKnown(S.elementalBlast) ? 1 : 0));
      }),

      // 8. elemental_blast,if=buff.tempest.stack<2&lightning_rod<active_enemies&spell_targets.chain_lightning=3
      spell.cast(S.elementalBlast, () => this.getCurrentTarget(), () => {
        const enemies = this.getEnemyCount();
        return this._cachedTemp < 2 && enemies === 3 && this.getMael() >= 60;
      }),

      // 9. lava_burst,if=buff.purging_flames.up&(buff.lava_surge.up|cooldown.voltaic_blaze.remains<2)
      spell.cast(S.lavaBurst, () => this.getCurrentTarget(), () =>
        me.hasAura(A.purgingFlames) &&
        (me.hasAura(A.lavaSurge) || (spell.getCooldown(S.voltaicBlaze)?.timeleft || 99999) < 2000)
      ),

      // 10. lava_burst,if=buff.tempest.up&buff.lava_surge.up&talent.master_of_the_elements&spell_targets.chain_lightning=3
      spell.cast(S.lavaBurst, () => this.getCurrentTarget(), () =>
        this._cachedTemp > 0 && me.hasAura(A.lavaSurge) &&
        spell.isSpellKnown(T.masterOfElements) && this.getEnemyCount() === 3
      ),

      // 11. tempest,if=buff.master_of_the_elements.up
      spell.cast(S.tempest, () => this.getCurrentTarget(), () =>
        this.isSB() && this._cachedTemp > 0 && this._cachedMote
      ),

      // 12. tempest,if=buff.stormkeeper.stack<4&buff.tempest.stack=2
      spell.cast(S.tempest, () => this.getCurrentTarget(), () =>
        this.isSB() && this._cachedTemp >= 2 && this._cachedSK < 4
      ),

      // 13. chain_lightning,if=buff.stormkeeper.up&maelstrom.deficit>spell_targets.chain_lightning*(2+spell_targets.chain_lightning+2)
      spell.cast(S.chainLightning, () => this.getCurrentTarget(), () => {
        const enemies = this.getEnemyCount();
        return this._cachedSK > 0 && this.maelDeficit() > enemies * (2 + enemies + 2);
      }),

      // 14. earthquake,if=!talent.elemental_blast&maelstrom.deficit<15
      spell.cast(S.earthquake, () => this.getCurrentTarget(), () =>
        !spell.isSpellKnown(S.elementalBlast) && this.maelDeficit() < 15 && this.getMael() >= 60
      ),

      // 15. elemental_blast (unconditional in SimC)
      spell.cast(S.elementalBlast, () => this.getCurrentTarget(), () => this.getMael() >= 60),

      // 16. tempest (unconditional)
      spell.cast(S.tempest, () => this.getCurrentTarget(), () =>
        this.isSB() && this._cachedTemp > 0
      ),

      // 17. chain_lightning (filler)
      spell.cast(S.chainLightning, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.astralShift, () => me, () =>
        Settings.FWEleAstral && me.effectiveHealthPercent < Settings.FWEleAstralHP
      ),
      spell.cast(S.healingSurge, () => me, () =>
        Settings.FWEleHS && me.effectiveHealthPercent < Settings.FWEleHSHP &&
        spell.getTimeSinceLastCast(S.healingSurge) > 4000
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // HELPERS
  // =============================================
  isSB() { return spell.isSpellKnown(S.tempest) || me.hasAura(A.tempest); }
  isFarseer() { return !this.isSB(); }

  refreshCaches() {
    if (this._moteFrame === wow.frameTime) return;
    this._moteFrame = wow.frameTime;
    this._cachedMote = me.hasAura(A.masterOfElements);
    const temp = me.getAura(A.tempest);
    this._cachedTemp = temp ? (temp.stacks || 1) : 0;
    const sk = me.getAura(A.stormkeeper);
    this._cachedSK = sk ? (sk.stacks || 0) : 0;
  }

  getPoMStacks() {
    const a = me.getAura(A.powerOfMaelstrom);
    return a ? a.stacks : 0;
  }

  /** Fire Elemental buff remaining time in ms. Returns 0 if not active. */
  getFeRemains() {
    const fe = me.getAura(A.fireElemental);
    return fe ? fe.remaining : 0;
  }

  fsRefreshable() {
    const t = this.getCurrentTarget();
    if (!t) return true;
    let d = t.getAuraByMe(A.flameShock) || t.getAuraByMe(S.flameShock);
    if (!d) d = t.auras.find(a => (a.spellId === A.flameShock || a.spellId === S.flameShock) &&
      a.casterGuid?.equals(me.guid));
    return !d || d.remaining < 6000;
  }

  ascCD() { return spell.getCooldown(S.ascendance)?.timeleft || 0; }
  combatTime() { return this._combatStart ? wow.frameTime - this._combatStart : 99999; }

  getMael() { return me.powerByType(PowerType.Maelstrom); }

  /** Maelstrom cap: 100 base + 50 if Swelling Maelstrom talented */
  getMaelCap() {
    if (this._maelCapFrame === wow.frameTime) return this._cachedMaelCap;
    this._maelCapFrame = wow.frameTime;
    this._cachedMaelCap = spell.isSpellKnown(T.swellingMaelstrom) ? 150 : 100;
    return this._cachedMaelCap;
  }

  maelDeficit() { return this.getMaelCap() - this.getMael(); }

  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 40 && me.isFacing(target)) {
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

  getSkyfuryTarget() {
    if (spell.getTimeSinceLastCast(S.skyfury) < 60000) return null;
    if (!this._hasBuff(me, S.skyfury)) return me;
    const friends = me.getFriends ? me.getFriends(40) : [];
    return friends.find(u => u && !u.deadOrGhost && !this._hasBuff(u, S.skyfury)) || null;
  }

  _hasBuff(unit, id) {
    if (!unit) return false;
    if (unit.hasVisibleAura(id) || unit.hasAura(id)) return true;
    if (unit.auras.find(a => a.spellId === id)) return true;
    if (id === S.skyfury) return unit.auras.find(a =>
      a.name.includes("Skyfury") || a.name.includes("Himmelszorn")
    ) !== undefined;
    return false;
  }
}
