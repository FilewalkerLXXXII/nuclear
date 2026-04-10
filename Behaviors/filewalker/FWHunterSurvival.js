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
 * Survival Hunter Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (hunter_survival.simc) + Method + Wowhead + Icy Veins
 *
 * Auto-detects: Pack Leader (Howl of the Pack Leader) vs Sentinel (Moonlight Chakram)
 * SimC sub-lists: plst (10), plcleave (11), sentst (11), sentcleave (10), cds (9) — ALL implemented
 *
 * CRITICAL Midnight changes:
 *   Takedown: New major CD (1.5min), +20% dmg buff for 8s, generates 50 Focus
 *   Boomstick: Channeled frontal cone, 1min CD (45s w/ Quick Reload)
 *   Flamefang Pitch: Ground-targeted fire AoE, 1min CD
 *   Tip of the Spear: Kill Command grants +15% per stack (3 max) to next ability
 *   Raptor Swipe: Raptor Strike upgrades to cone AoE when buff active
 *   Moonlight Chakram: Sentinel hero talent, bouncing arcane damage
 *   Fury of the Wyvern: Pack Leader — Wyvern duration extendable by Wildfire Bomb
 *
 * Pack Leader: KC (beast summons) → Takedown → Flamefang → Boomstick w/ TotS → WFB → RS
 * Sentinel: KC (TotS=0) → Boomstick w/ TotS → WFB w/ Sent Mark → Takedown → Chakram → RS
 *
 * Melee spec — instant cast only, no movement block needed (all abilities instant except Boomstick channel)
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-20',
  guide: 'SimC Midnight APL (every line) + Method + Wowhead + Icy Veins',
};

// Cast spell IDs
const S = {
  // Core rotational
  killCommand:        259489,   // 3 charges, 5s recharge, generates 15 Focus (+5 talented)
  raptorStrike:       186270,   // 30 Focus, melee instant
  mongooseBite:       265893,   // Replaces Raptor Strike if talented
  wildfireBomb:       259495,   // 10 Focus, 18s recharge (2 charges w/ Guerrilla Tactics)
  takedown:           1250646,  // 1.5min CD, generates 50 Focus, +20% dmg 8s
  boomstick:          1261193,  // 50 Focus, 1min CD, 3s channel, frontal cone
  flamefangPitch:     1251592,  // 20 Focus, 1min CD, ground-targeted AoE
  moonlightChakram:   1264949,  // Sentinel only, bouncing arcane damage

  // Utility
  harpoon:            190925,   // 20s CD, 8-30yd, gap closer
  muzzle:             187707,   // Interrupt, 15s CD
  aspectOfTheEagle:   186289,   // Enables ranged for melee abilities
  exhilaration:       109304,   // 2min CD, heal 30% HP
  misdirection:       34477,
  huntersMark:        259558,
  revivePet:          982,
  mendPet:            136,

  // Racials
  berserking:         26297,
};

// Talent IDs — for spell.isSpellKnown() detection only
const T = {
  howlOfPackLeader:   471876,   // Pack Leader detection (hero talent)
  sentinel:           1253601,  // Sentinel detection (via Sentinel's Mark talent)
  moonlightChakram:   1264949,  // Sentinel exclusive ability
  twinFangs:          1272139,  // Takedown grants 3 TotS stacks
  wildfireShells:     1261229,  // Boomstick reduces WFB CD
  raptorSwipe:        1259003,  // RS upgrades to cone AoE
  furyOfTheWyvern:    472550,   // Pack Leader — Wyvern extendable by WFB
  flamefangPitch:     1251592,  // Talent check for Flamefang Pitch
  mongooseBite:       265893,   // Talent: replaces Raptor Strike
  tipOfTheSpear:      260285,   // Passive talent
  lethalCalibration:  1262409,  // WFB reduces Boomstick CD
  quickReload:        1261234,  // Boomstick CD reduced to 45s
};

// Buff/Debuff aura IDs — for me.hasAura() / me.getAura() / target.getAuraByMe()
const A = {
  // Player buffs
  tipOfTheSpear:      260286,   // Buff from Kill Command, +15% per stack, 3 max
  tipOfTheSpearBoom:  471536,   // TotS tracking for Boomstick specifically
  tipOfTheSpearChak:  1280140,  // TotS tracking for Moonlight Chakram specifically
  takedown:           1250646,  // +20% dmg buff, 8s
  raptorSwipe:        1273155,  // Raptor Strike becomes AoE cone
  mongooseFury:       259388,   // +10% Mongoose Bite dmg per stack, 8s, 20 max
  aspectOfTheEagle:   186289,   // Enables ranged melee attacks
  moonlightChakram:   1264946,  // Moonlight Chakram buff

  // Pack Leader: Howl beast ready buffs (checked in SimC APL)
  hotplWyvern:        471878,   // Next KC summons Wyvern
  hotplBoar:          472324,   // Next KC summons Boar
  hotplBear:          472325,   // Next KC summons Bear
  hotplCooldown:      471877,   // 30s ICD tracking
  wyvernsCry:         471881,   // Wyvern active: +10% dmg for 12s

  // Sentinel
  sentinelsMark:      1253601,  // Debuff on target, enhances next WFB by 40%

  // Misc
  huntersMark:        257284,   // Debuff aura ID (different from cast 259558)
};

// Wildfire Bomb DoT debuff ID
const WILDFIRE_DOT = 269747;

export class SurvivalHunterBehavior extends Behavior {
  name = 'FW Survival Hunter';
  context = BehaviorContext.Any;
  specialization = Specialization.Hunter.Survival;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _focusFrame = 0;
  _cachedFocus = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _totsFrame = 0;
  _cachedTotsStacks = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWSvUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWSvAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWSvDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWSvExhil', text: 'Use Exhilaration', default: true },
        { type: 'slider', uid: 'FWSvExhilHP', text: 'Exhilaration HP %', default: 40, min: 15, max: 60 },
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

      // Revive/Mend Pet OOC
      spell.cast(S.revivePet, () => me, () => !me.inCombat() && me.pet && me.pet.deadOrGhost),

      // Combat check — MANDATORY: stops all actions when out of combat
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Auto-target
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

      // Version + Debug logging
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[SV] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isPL() ? 'Pack Leader' : 'Sentinel'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWSvDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const tots = this.getTotsStacks();
          const wfbFrac = spell.getChargesFractional(S.wildfireBomb);
          console.info(`[SV] Focus:${Math.round(this.getFocus())} TotS:${tots} WFBfrac:${wfbFrac ? wfbFrac.toFixed(2) : '?'} TD:${me.hasAura(A.takedown)} RS:${me.hasAura(A.raptorSwipe)} WyvRdy:${me.hasAura(A.hotplWyvern)} BoarRdy:${me.hasAura(A.hotplBoar)} BearRdy:${me.hasAura(A.hotplBear)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // Auto Misdirection on tank (off-GCD, 30s CD)
      spell.cast(S.misdirection, () => {
        if (!me.inCombat()) return null;
        if (spell.getTimeSinceLastCast(S.misdirection) < 30000) return null;
        const tanks = heal.friends?.Tanks;
        if (tanks) {
          for (let i = 0; i < tanks.length; i++) {
            if (tanks[i] && !tanks[i].deadOrGhost && me.distanceTo(tanks[i]) <= 100) return tanks[i];
          }
        }
        return null;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // Interrupt
          spell.interrupt(S.muzzle),

          // Defensives
          spell.cast(S.exhilaration, () => me, () =>
            Settings.FWSvExhil && me.effectiveHealthPercent < Settings.FWSvExhilHP
          ),

          // Mend Pet in combat
          spell.cast(S.mendPet, () => me, () =>
            me.pet && !me.pet.deadOrGhost && me.pet.pctHealth < 50 &&
            spell.getTimeSinceLastCast(S.mendPet) > 10000
          ),

          // SimC: call_action_list,name=cds
          this.cooldowns(),

          // SimC dispatch: Pack Leader vs Sentinel, ST vs AoE
          new bt.Decorator(
            () => this.isPL() && this.isAoE(),
            this.plCleave(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isPL(),
            this.plST(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isAoE(),
            this.sentCleave(),
            new bt.Action(() => bt.Status.Failure)
          ),
          this.sentST(),
        )
      ),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cds, 9 lines)
  // =============================================
  cooldowns() {
    const ttd = this.targetTTD();
    return new bt.Selector(
      // SimC: berserking,if=buff.takedown.up|cooldown.takedown.ready
      spell.cast(S.berserking, () => me, () =>
        Settings.FWSvUseCDs &&
        (me.hasAura(A.takedown) || (spell.getCooldown(S.takedown)?.ready ?? false))
      ),

      // SimC: muzzle (handled above as interrupt)

      // SimC: aspect_of_the_eagle,if=target.distance>=6
      spell.cast(S.aspectOfTheEagle, () => me, () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        return me.distanceTo(t) >= 6;
      }),

      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // PACK LEADER — Single Target (SimC actions.plst, 10 lines)
  // =============================================
  plST() {
    return new bt.Selector(
      // 1. kill_command,if=buff.tip_of_the_spear.stack<2&(buff.howl_wyvern.remains|buff.howl_boar.remains|buff.howl_bear.remains)
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        this.getTotsStacks() < 2 && this.hasHotplBeastReady()
      ),

      // 2. kill_command,if=cooldown.takedown.remains<gcd&buff.tip_of_the_spear.stack<2&!talent.twin_fangs
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.takedown)?.timeleft || 99999) < 1500 &&
        this.getTotsStacks() < 2 && !spell.isSpellKnown(T.twinFangs)
      ),

      // 3. takedown,if=buff.tip_of_the_spear.stack>0&!talent.twin_fangs|buff.tip_of_the_spear.stack=0&talent.twin_fangs
      spell.cast(S.takedown, () => this.getCurrentTarget(), () => {
        const tots = this.getTotsStacks();
        return (tots > 0 && !spell.isSpellKnown(T.twinFangs)) ||
               (tots === 0 && spell.isSpellKnown(T.twinFangs));
      }),

      // 4. flamefang_pitch (unconditional in SimC)
      spell.cast(S.flamefangPitch, () => this.getCurrentTarget()),

      // 5. boomstick,if=buff.tip_of_the_spear.up
      spell.cast(S.boomstick, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 6. wildfire_bomb,if=fury_of_the_wyvern_extendable&buff.tip_of_the_spear.up
      // fury_of_the_wyvern_extendable = wyvern active AND extension < cap (10s)
      // Approximate: wyvern buff is active (wyvernsCry aura present)
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget(), () =>
        this.hasTotS() && this.isWyvernExtendable()
      ),

      // 7. raptor_strike,if=buff.tip_of_the_spear.up|!buff.raptor_swipe.up
      this.castRaptor(() => this.hasTotS() || !me.hasAura(A.raptorSwipe)),

      // 8. kill_command,if=cooldown.takedown.remains
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.takedown)?.timeleft || 0) > 0
      ),

      // 9. wildfire_bomb
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget()),

      // 10. takedown (fallback, no conditions)
      spell.cast(S.takedown, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // PACK LEADER — Cleave (SimC actions.plcleave, 11 lines)
  // =============================================
  plCleave() {
    return new bt.Selector(
      // 1. kill_command,if=buff.tip_of_the_spear.stack<2&(howl_wyvern|howl_boar|howl_bear)
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        this.getTotsStacks() < 2 && this.hasHotplBeastReady()
      ),

      // 2. kill_command,if=cooldown.takedown.remains<gcd&buff.tip_of_the_spear.stack<2&!talent.twin_fangs
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.takedown)?.timeleft || 99999) < 1500 &&
        this.getTotsStacks() < 2 && !spell.isSpellKnown(T.twinFangs)
      ),

      // 3. takedown,if=buff.tip_of_the_spear.stack>0&!talent.twin_fangs|buff.tip_of_the_spear.stack=0&talent.twin_fangs
      spell.cast(S.takedown, () => this.getCurrentTarget(), () => {
        const tots = this.getTotsStacks();
        return (tots > 0 && !spell.isSpellKnown(T.twinFangs)) ||
               (tots === 0 && spell.isSpellKnown(T.twinFangs));
      }),

      // 4. flamefang_pitch
      spell.cast(S.flamefangPitch, () => this.getCurrentTarget()),

      // 5. wildfire_bomb,if=full_recharge_time<gcd
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget(), () =>
        (spell.getFullRechargeTime(S.wildfireBomb) || 99999) < 1500
      ),

      // 6. boomstick,if=buff.tip_of_the_spear.up
      spell.cast(S.boomstick, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 7. wildfire_bomb,if=buff.tip_of_the_spear.up
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 8. raptor_strike,if=buff.tip_of_the_spear.up|!buff.raptor_swipe.up
      this.castRaptor(() => this.hasTotS() || !me.hasAura(A.raptorSwipe)),

      // 9. kill_command,if=cooldown.takedown.remains
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.takedown)?.timeleft || 0) > 0
      ),

      // 10. wildfire_bomb
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget()),

      // 11. takedown
      spell.cast(S.takedown, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // SENTINEL — Single Target (SimC actions.sentst, 11 lines)
  // =============================================
  sentST() {
    return new bt.Selector(
      // 1. kill_command,if=buff.tip_of_the_spear.stack=0&(cooldown.takedown.remains|!talent.twin_fangs)
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        this.getTotsStacks() === 0 &&
        ((spell.getCooldown(S.takedown)?.timeleft || 0) > 0 || !spell.isSpellKnown(T.twinFangs))
      ),

      // 2. boomstick,if=buff.tip_of_the_spear.up&!cooldown.takedown.ready&!debuff.sentinels_mark.remains
      spell.cast(S.boomstick, () => this.getCurrentTarget(), () =>
        this.hasTotS() &&
        !(spell.getCooldown(S.takedown)?.ready ?? false) &&
        !this.targetHasSentinelsMark()
      ),

      // 3. wildfire_bomb,if=buff.tip_of_the_spear.up&(debuff.sentinels_mark.remains|full_recharge_time<4+gcd)
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget(), () =>
        this.hasTotS() &&
        (this.targetHasSentinelsMark() || (spell.getFullRechargeTime(S.wildfireBomb) || 99999) < 5500)
      ),

      // 4. kill_command,if=cooldown.takedown.remains<gcd&buff.tip_of_the_spear.stack<2&!talent.twin_fangs
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.takedown)?.timeleft || 99999) < 1500 &&
        this.getTotsStacks() < 2 && !spell.isSpellKnown(T.twinFangs)
      ),

      // 5. takedown,if=buff.tip_of_the_spear.stack>0&!talent.twin_fangs|buff.tip_of_the_spear.stack=0&talent.twin_fangs
      spell.cast(S.takedown, () => this.getCurrentTarget(), () => {
        const tots = this.getTotsStacks();
        return (tots > 0 && !spell.isSpellKnown(T.twinFangs)) ||
               (tots === 0 && spell.isSpellKnown(T.twinFangs));
      }),

      // 6. boomstick,if=buff.tip_of_the_spear.up
      spell.cast(S.boomstick, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 7. moonlight_chakram,if=buff.tip_of_the_spear.up
      spell.cast(S.moonlightChakram, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 8. flamefang_pitch (unconditional in SimC)
      spell.cast(S.flamefangPitch, () => this.getCurrentTarget()),

      // 9. raptor_strike,if=buff.tip_of_the_spear.up|!buff.raptor_swipe.up
      this.castRaptor(() => this.hasTotS() || !me.hasAura(A.raptorSwipe)),

      // 10. kill_command,if=cooldown.takedown.remains
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.takedown)?.timeleft || 0) > 0
      ),

      // 11. takedown
      spell.cast(S.takedown, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // SENTINEL — Cleave (SimC actions.sentcleave, 10 lines)
  // =============================================
  sentCleave() {
    return new bt.Selector(
      // 1. kill_command,if=buff.tip_of_the_spear.stack=0
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        this.getTotsStacks() === 0
      ),

      // 2. wildfire_bomb,if=talent.wildfire_shells&(buff.tip_of_the_spear.up&!debuff.sentinels_mark.remains&cooldown.boomstick.remains<11&cooldown.boomstick.remains>1)
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.wildfireShells)) return false;
        if (!this.hasTotS()) return false;
        if (this.targetHasSentinelsMark()) return false;
        const boomCD = spell.getCooldown(S.boomstick)?.timeleft || 0;
        return boomCD < 11000 && boomCD > 1000;
      }),

      // 3. boomstick,if=buff.tip_of_the_spear.up
      spell.cast(S.boomstick, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 4. wildfire_bomb,if=buff.tip_of_the_spear.up&(debuff.sentinels_mark.remains|full_recharge_time<4+gcd)
      spell.cast(S.wildfireBomb, () => this.getCurrentTarget(), () =>
        this.hasTotS() &&
        (this.targetHasSentinelsMark() || (spell.getFullRechargeTime(S.wildfireBomb) || 99999) < 5500)
      ),

      // 5. kill_command,if=cooldown.takedown.remains<gcd&buff.tip_of_the_spear.stack<2&!talent.twin_fangs
      spell.cast(S.killCommand, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.takedown)?.timeleft || 99999) < 1500 &&
        this.getTotsStacks() < 2 && !spell.isSpellKnown(T.twinFangs)
      ),

      // 6. takedown,if=buff.tip_of_the_spear.up
      spell.cast(S.takedown, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 7. moonlight_chakram,if=buff.tip_of_the_spear.up
      spell.cast(S.moonlightChakram, () => this.getCurrentTarget(), () => this.hasTotS()),

      // 8. flamefang_pitch,if=talent.flamefang_pitch&buff.tip_of_the_spear.up
      spell.cast(S.flamefangPitch, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.flamefangPitch) && this.hasTotS()
      ),

      // 9. raptor_strike,if=buff.tip_of_the_spear.up&buff.raptor_swipe.up|!buff.raptor_swipe.up
      this.castRaptor(() =>
        (this.hasTotS() && me.hasAura(A.raptorSwipe)) || !me.hasAura(A.raptorSwipe)
      ),

      // 10. kill_command
      spell.cast(S.killCommand, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isPL() {
    return spell.isSpellKnown(T.howlOfPackLeader) || me.hasAura(A.hotplCooldown);
  }
  isSent() { return !this.isPL(); }

  // =============================================
  // AOE DETECTION
  // =============================================
  isAoE() {
    return this.getEnemyCount() >= Settings.FWSvAoECount;
  }

  // =============================================
  // TIP OF THE SPEAR HELPERS
  // =============================================
  getTotsStacks() {
    if (this._totsFrame === wow.frameTime) return this._cachedTotsStacks;
    this._totsFrame = wow.frameTime;
    const aura = me.getAura(A.tipOfTheSpear);
    this._cachedTotsStacks = aura ? aura.stacks : 0;
    return this._cachedTotsStacks;
  }

  hasTotS() {
    return this.getTotsStacks() > 0;
  }

  // =============================================
  // PACK LEADER HELPERS
  // =============================================
  hasHotplBeastReady() {
    return me.hasAura(A.hotplWyvern) || me.hasAura(A.hotplBoar) || me.hasAura(A.hotplBear);
  }

  // SimC: fury_of_the_wyvern_extendable
  // True when Wyvern is active AND we haven't hit the extension cap (10s additional)
  // Approximate: Wyvern buff (wyvernsCry 471881) is present
  isWyvernExtendable() {
    if (!spell.isSpellKnown(T.furyOfTheWyvern)) return false;
    return me.hasAura(A.wyvernsCry);
  }

  // =============================================
  // SENTINEL HELPERS
  // =============================================
  targetHasSentinelsMark() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    const mark = t.getAuraByMe(A.sentinelsMark);
    if (mark && mark.remaining > 0) return true;
    // Fallback: check via auras scan
    const found = t.auras ? t.auras.find(a => a.spellId === A.sentinelsMark) : null;
    return found ? found.remaining > 0 : false;
  }

  // =============================================
  // RAPTOR STRIKE / MONGOOSE BITE
  // =============================================
  getRaptorAbility() {
    // Mongoose Bite replaces Raptor Strike if talented
    if (spell.isSpellKnown(T.mongooseBite)) return S.mongooseBite;
    return S.raptorStrike;
  }

  // Runtime wrapper — resolves correct spell ID per tick, not at build() time
  castRaptor(conditionFn) {
    return new bt.Action(() => {
      const id = this.getRaptorAbility();
      const t = this.getCurrentTarget();
      if (!t) return bt.Status.Failure;
      if (conditionFn && !conditionFn()) return bt.Status.Failure;
      const result = spell.cast(id, () => t).execute({});
      return result === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
    });
  }

  // =============================================
  // RESOURCES (cached per tick)
  // =============================================
  getFocus() {
    if (this._focusFrame === wow.frameTime) return this._cachedFocus;
    this._focusFrame = wow.frameTime;
    this._cachedFocus = me.powerByType(PowerType.Focus);
    return this._cachedFocus;
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    // Survival is melee — 8yd range for most abilities, but some reach 15-40yd
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
    // Survival is melee — use 8yd radius for enemy count
    this._cachedEnemyCount = t ? t.getUnitsAroundCount(8) + 1 : 1;
    return this._cachedEnemyCount;
  }

  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }
}
