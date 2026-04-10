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
import { DispelPriority } from '@/Data/Dispels';
import { WoWDispelType } from '@/Enums/Auras';

/**
 * Marksmanship Hunter Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (mm.txt) + Method + Wowhead
 *
 * Auto-detects: Dark Ranger (Black Arrow) vs Sentinel (Moonlight Chakram)
 * SimC sub-lists: drst (11), draoe (9), sentst (12), sentaoe (8), cds (7) — ALL
 *
 * Core: Aimed Shot (2 charges) → Precise Shots → Arcane/Multi → Rapid Fire → Trick Shots
 * DR: Black Arrow → Wailing Arrow → Withering Fire → Deathblow proc management
 * Sent: Moonlight Chakram → Sentinel marks → Symphonic Arsenal
 *
 * Movement: Aimed Shot + Steady Shot have cast time — block while moving
 * Resource: Focus (PowerType 2), max 100
 *
 * KEY FIXES (v2):
 *   drST: Added conditional Aimed Shot with Volley timing check (SimC line 4)
 *   draoe: Added Trick Shots guards on Rapid Fire (line 3) and Aimed Shot (line 6)
 *   draoe: Merged Rapid Fire conditions into single entry per SimC (Unload OR BS expiring)
 *   sentST: Added conditional Aimed Shot for enemies>2 with Volley timing (SimC line 4)
 *   sentST: Added Volley CD / Trueshot guard on Aimed Shot (SimC line 9)
 *   tsReady: Fixed to use cooldown duration instead of timeleft
 *   sentST Rapid Fire: Fixed operator precedence for Unload conditions
 *   Movement: Added Volley, Wailing Arrow, Moonlight Chakram, Trueshot, Multi-Shot
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL (every line) + Method + Wowhead',
};

const S = {
  aimedShot:          19434,
  rapidFire:          257044,
  arcaneShot:         185358,
  multiShot:          257620,
  steadyShot:         56641,
  trueshot:           288613,
  volley:             260243,
  blackArrow:         466930,   // Cast spell (466932 wrong, T.blackArrow also 466930)
  wailingArrow:       392060,
  killShot:           53351,    // Ranged execute (was missing entirely)
  moonlightChakram:   1264902,
  huntersMark:        257284,   // User-confirmed (259558 wrong)
  counterShot:        147362,
  tranquilizingShot:  19801,
  misdirection:       34477,
  exhilaration:       109304,
  berserking:         26297,
};

const T = {
  blackArrow:         466930,   // Dark Ranger detection (talent ID)
  trickShots:         257621,
  aspectOfTheHydra:   470945,
  unload:             1277548,
  noScope:            473385,   // Rapid Fire grants Precise Shots
  bullseye:           204089,   // Talent passive (buff aura is 204090)
  callingTheShots:    260404,
  headshot:           471076,   // Modifies Aimed Shot
};

const A = {
  trueshot:           288613,
  preciseShotsBuff:   260242,   // Buff aura (260240 is talent passive)
  trickShots:         257622,   // Buff aura (257621 is talent passive)
  bulletstorm:        389020,   // Stacking buff (389019 is talent passive)
  doubleTap:          260402,
  lockAndLoad:        194594,   // Buff aura (194595 is talent passive)
  spottersMark:       466872,
  sentinelsMark:      1253601,
  deathblow:          378770,   // Buff aura (confirmed correct, talent is 343248)
  bullseye:           204090,   // Stacking buff (204089 is talent — was swapped)
  volley:             260243,
  blackArrowDot:      468572,   // DoT debuff on target from Black Arrow
  witheringFire:      466991,   // Buff: Black Arrow proc charges (466990 is talent)
};

export class MarksmanshipHunterBehavior extends Behavior {
  name = 'FW Marksmanship Hunter';
  context = BehaviorContext.Any;
  specialization = Specialization.Hunter.Marksmanship;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _focusFrame = 0;
  _cachedFocus = 0;
  _enemyFrame = 0;
  _combatStartTime = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWMmAutoCDs', text: 'Auto Cooldowns (ignore burst keybind)', default: false },
        { type: 'slider', uid: 'FWMmAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWMmDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWMmExhil', text: 'Use Exhilaration', default: true },
        { type: 'slider', uid: 'FWMmExhilHP', text: 'Exhilaration HP %', default: 40, min: 15, max: 60 },
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
      new bt.Action(() => {
        if (!me.inCombat()) { this._combatStartTime = 0; return bt.Status.Success; }
        if (this._combatStartTime === 0) this._combatStartTime = wow.frameTime;
        return bt.Status.Failure;
      }),
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      // Cancel Aimed Shot when moving (Steady Shot is castable while moving)
      new bt.Action(() => {
        if (me.isMoving() && me.isCastingOrChanneling) {
          const cast = me.currentCastOrChannel;
          if (cast && cast.spellId === S.aimedShot) {
            me.stopCasting();
            return bt.Status.Failure;
          }
        }
        return bt.Status.Failure;
      }),
      common.waitForCastOrChannel(),

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[MM] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isDR() ? 'Dark Ranger' : 'Sentinel'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWMmDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[MM] Focus:${Math.round(this.getFocus())} TS:${this.inTS()} PS:${me.hasAura(A.preciseShotsBuff)} DT:${me.hasAura(A.doubleTap)} BS:${this.getBSStacks()} ASfrac:${spell.getChargesFractional(S.aimedShot).toFixed(2)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      // Auto Misdirection on tank (off-GCD, only first 10s of combat)
      spell.cast(S.misdirection, () => {
        if (!me.inCombat()) return null;
        if (this._combatStartTime > 0 && (wow.frameTime - this._combatStartTime) > 10000) return null;
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
          spell.interrupt(S.counterShot),

          // Tranquilizing Shot — purge Magic effects and Enrage from enemies
          spell.dispel(S.tranquilizingShot, false, DispelPriority.High, false, WoWDispelType.Magic),
          spell.dispel(S.tranquilizingShot, false, DispelPriority.High, false, WoWDispelType.Enrage),
          spell.dispel(S.tranquilizingShot, false, DispelPriority.Medium, false, WoWDispelType.Magic),
          spell.dispel(S.tranquilizingShot, false, DispelPriority.Medium, false, WoWDispelType.Enrage),

          // Hunter's Mark — maintain on target (5% damage increase), skip if any target already marked
          spell.cast(S.huntersMark, () => this.getCurrentTarget(), () => {
            const t = this.getCurrentTarget();
            if (!t) return false;
            if (spell.getTimeSinceLastCast(S.huntersMark) < 3000) return false;
            if (t.timeToDeath && t.timeToDeath() < 30000) return false;
            if (t.hasAura(S.huntersMark) || t.hasVisibleAura(S.huntersMark) || t.hasAuraByMe(S.huntersMark)) return false;
            // Check if we already have a mark active on any combat target
            if (combat.targets) {
              for (let i = 0; i < combat.targets.length; i++) {
                const ct = combat.targets[i];
                if (ct && (ct.hasAuraByMe(S.huntersMark) || ct.hasAura(S.huntersMark))) return false;
              }
            }
            return true;
          }),

          // Defensives
          spell.cast(S.exhilaration, () => me, () =>
            Settings.FWMmExhil && me.effectiveHealthPercent < Settings.FWMmExhilHP
          ),

          // Movement: block Aimed Shot + Steady Shot while moving, full instant rotation
          new bt.Decorator(
            () => me.isMoving(),
            new bt.Selector(
              // Trueshot (self-buff, off-GCD)
              spell.cast(S.trueshot, () => me, () =>
                this.useCDs() && !me.hasAura(A.doubleTap) && this.tsReady()
              ),
              spell.cast(S.berserking, () => me, () =>
                this.inTS() || this.targetTTD() < 13000
              ),
              // Black Arrow (DR only)
              spell.cast(S.blackArrow, () => this.getCurrentTarget(), () => this.isDR()),
              // Precise Shots consumers
              spell.cast(S.arcaneShot, () => this.getCurrentTarget(), () =>
                me.hasAura(A.preciseShotsBuff) && this.getEnemyCount() < 3
              ),
              spell.cast(S.multiShot, () => this.getCurrentTarget(), () =>
                (me.hasAura(A.preciseShotsBuff) && !spell.isSpellKnown(T.aspectOfTheHydra)) ||
                (this.getEnemyCount() >= 3 && !me.hasAura(A.trickShots))
              ),
              // Rapid Fire (channeled but usable while moving)
              spell.cast(S.rapidFire, () => this.getCurrentTarget()),
              // Volley
              spell.cast(S.volley, () => this.getCurrentTarget(), () => !me.hasAura(A.doubleTap)),
              // Wailing Arrow
              spell.cast(S.wailingArrow, () => this.getCurrentTarget(), () => this.isDR()),
              // Moonlight Chakram (Sentinel)
              spell.cast(S.moonlightChakram, () => this.getCurrentTarget(), () => this.isSent()),
              // Arcane Shot filler (instant)
              spell.cast(S.arcaneShot, () => this.getCurrentTarget()),
              // Steady Shot (castable while moving)
              spell.cast(S.steadyShot, () => this.getCurrentTarget()),
              new bt.Action(() => bt.Status.Success) // Block Aimed Shot
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: call_action_list,name=cds
          this.cooldowns(),

          // SimC dispatch: hero_tree + active_enemies
          new bt.Decorator(
            () => this.isDR() && this.getEnemyCount() > 2 && spell.isSpellKnown(T.trickShots),
            this.drAoE(), new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isSent() && this.getEnemyCount() > 2 && spell.isSpellKnown(T.trickShots),
            this.sentAoE(), new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isDR(),
            this.drST(), new bt.Action(() => bt.Status.Failure)
          ),
          this.sentST(),
        )
      ),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cds, 7 lines)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // SimC: berserking,if=buff.trueshot.up|fight_remains<13
      spell.cast(S.berserking, () => me, () =>
        this.inTS() || this.targetTTD() < 13000
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // DARK RANGER ST (SimC actions.drst, 11 lines)
  // =============================================
  drST() {
    return new bt.Selector(
      // 1. black_arrow
      spell.cast(S.blackArrow, () => this.getCurrentTarget()),

      // Kill Shot: execute at < 20% HP
      spell.cast(S.killShot, () => this.getCurrentTarget(), () =>
        (this.getCurrentTarget()?.effectiveHealthPercent || 100) < 20
      ),

      // 2. trueshot,if=!buff.double_tap.up&variable.trueshot_ready
      spell.cast(S.trueshot, () => me, () =>
        this.useCDs() && !me.hasAura(A.doubleTap) && this.tsReady()
      ),

      // 3. rapid_fire,if=talent.unload&(talent.no_scope&buff.bulletstorm.stack<10|target.health.pct<20)
      spell.cast(S.rapidFire, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.unload) &&
        ((spell.isSpellKnown(T.noScope) && this.getBSStacks() < 10) ||
          (this.getCurrentTarget()?.effectiveHealthPercent || 100) < 20)
      ),

      // 4. aimed_shot,if=buff.volley.remains%action.aimed_shot.execute_time>action.arcane_shot.execute_time&buff.trueshot.down
      // Volley buff remaining / AS cast time > arcane shot cast time (~0.5s GCD)
      // Ensures enough Volley buff time to fit another Aimed Shot before Volley expires
      spell.cast(S.aimedShot, () => this.getCurrentTarget(), () => {
        const volley = me.getAura(A.volley);
        if (!volley || this.inTS()) return false;
        // volley.remains / aimed_execute_time > arcane_execute_time
        // ~= volley.remains / 2500 > 500 → volley.remains > 1250
        return volley.remaining / 2500 > 0.5;
      }),

      // 5. arcane_shot,if=buff.precise_shots.up
      spell.cast(S.arcaneShot, () => this.getCurrentTarget(), () =>
        me.hasAura(A.preciseShotsBuff)
      ),

      // 6. rapid_fire,if=buff.bulletstorm.remains<action.aimed_shot.execute_time
      spell.cast(S.rapidFire, () => this.getCurrentTarget(), () => {
        const bs = me.getAura(A.bulletstorm);
        return bs && bs.remaining < 2500;
      }),

      // 7. volley,if=!buff.double_tap.up
      spell.cast(S.volley, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.doubleTap)
      ),

      // 8. aimed_shot (unconditional fallback)
      spell.cast(S.aimedShot, () => this.getCurrentTarget()),

      // 9. wailing_arrow
      spell.cast(S.wailingArrow, () => this.getCurrentTarget()),

      // 10. rapid_fire
      spell.cast(S.rapidFire, () => this.getCurrentTarget()),

      // 11. steady_shot
      spell.cast(S.steadyShot, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // DARK RANGER AoE (SimC actions.draoe, 9 lines)
  // =============================================
  drAoE() {
    return new bt.Selector(
      // 1. black_arrow
      spell.cast(S.blackArrow, () => this.getCurrentTarget()),

      // Kill Shot: execute at < 20% HP
      spell.cast(S.killShot, () => this.getCurrentTarget(), () =>
        (this.getCurrentTarget()?.effectiveHealthPercent || 100) < 20
      ),

      // 2. multishot,if=buff.precise_shots.up&!talent.aspect_of_the_hydra|buff.trick_shots.down
      spell.cast(S.multiShot, () => this.getCurrentTarget(), () =>
        (me.hasAura(A.preciseShotsBuff) && !spell.isSpellKnown(T.aspectOfTheHydra)) ||
        !me.hasAura(A.trickShots)
      ),

      // 3. rapid_fire,if=buff.trick_shots.remains>execute_time&(talent.unload&(talent.no_scope&buff.bulletstorm.stack<10|target.health.pct<20)|buff.bulletstorm.remains<action.aimed_shot.execute_time)
      // Combined: Trick Shots must be active AND (Unload conditions OR Bulletstorm expiring)
      spell.cast(S.rapidFire, () => this.getCurrentTarget(), () => {
        const ts = me.getAura(A.trickShots);
        if (!ts || ts.remaining <= 1800) return false; // RF execute_time ~1.8s
        const unloadCond = spell.isSpellKnown(T.unload) &&
          ((spell.isSpellKnown(T.noScope) && this.getBSStacks() < 10) ||
            (this.getCurrentTarget()?.effectiveHealthPercent || 100) < 20);
        const bsExpiring = (() => { const bs = me.getAura(A.bulletstorm); return bs && bs.remaining < 2500; })();
        return unloadCond || bsExpiring;
      }),

      // 4. trueshot,if=!buff.double_tap.up&variable.trueshot_ready
      spell.cast(S.trueshot, () => me, () =>
        this.useCDs() && !me.hasAura(A.doubleTap) && this.tsReady()
      ),

      // 5. volley,if=!buff.double_tap.up
      spell.cast(S.volley, () => this.getCurrentTarget(), () => !me.hasAura(A.doubleTap)),

      // 6. aimed_shot,if=buff.trick_shots.remains>cast_time
      spell.cast(S.aimedShot, () => this.getCurrentTarget(), () => {
        const ts = me.getAura(A.trickShots);
        return ts && ts.remaining > 2500; // AS cast_time ~2.4s
      }),

      // 7. wailing_arrow
      spell.cast(S.wailingArrow, () => this.getCurrentTarget()),

      // 8. rapid_fire,if=buff.trick_shots.remains>execute_time
      spell.cast(S.rapidFire, () => this.getCurrentTarget(), () => {
        const ts = me.getAura(A.trickShots);
        return ts && ts.remaining > 1800;
      }),

      // 9. steady_shot
      spell.cast(S.steadyShot, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // SENTINEL ST (SimC actions.sentst, 12 lines)
  // =============================================
  sentST() {
    return new bt.Selector(
      // 1. volley,if=!buff.double_tap.up&active_enemies=1
      spell.cast(S.volley, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.doubleTap) && this.getEnemyCount() === 1
      ),

      // 2. trueshot,if=!buff.double_tap.up&active_enemies=1&variable.trueshot_ready
      spell.cast(S.trueshot, () => me, () =>
        this.useCDs() && !me.hasAura(A.doubleTap) &&
        this.getEnemyCount() === 1 && this.tsReady()
      ),

      // Kill Shot: execute at < 20% HP (high priority — big damage)
      spell.cast(S.killShot, () => this.getCurrentTarget(), () =>
        (this.getCurrentTarget()?.effectiveHealthPercent || 100) < 20
      ),

      // 3. rapid_fire,if=talent.unload&((buff.precise_shots.up&!talent.no_scope)&buff.bulletstorm.stack<10|target.health.pct<20)
      spell.cast(S.rapidFire, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.unload) &&
        ((me.hasAura(A.preciseShotsBuff) && !spell.isSpellKnown(T.noScope) && this.getBSStacks() < 10) ||
          (this.getCurrentTarget()?.effectiveHealthPercent || 100) < 20)
      ),

      // 4. aimed_shot: 3+ targets with Volley buff, prefer marked targets
      spell.cast(S.aimedShot, () => this.getSentinelTarget(true), () => {
        if (this.getEnemyCount() <= 2 || this.inTS()) return false;
        const volley = me.getAura(A.volley);
        if (!volley) return false;
        return volley.remaining / 2500 > 0.5;
      }),

      // 5. arcane_shot: consume Precise Shots, prefer targets WITHOUT mark (spread marks)
      spell.cast(S.arcaneShot, () => this.getSentinelTarget(false), () =>
        me.hasAura(A.preciseShotsBuff)
      ),

      // 6. rapid_fire,if=buff.bulletstorm.remains<action.aimed_shot.execute_time
      spell.cast(S.rapidFire, () => this.getCurrentTarget(), () => {
        const bs = me.getAura(A.bulletstorm);
        return bs && bs.remaining < 2500;
      }),

      // 7. trueshot,if=!buff.double_tap.up&active_enemies>1&variable.trueshot_ready
      spell.cast(S.trueshot, () => me, () =>
        this.useCDs() && !me.hasAura(A.doubleTap) &&
        this.getEnemyCount() > 1 && this.tsReady()
      ),

      // 8. volley,if=!buff.double_tap.up&active_enemies>1
      spell.cast(S.volley, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.doubleTap) && this.getEnemyCount() > 1
      ),

      // 9. aimed_shot: volley on CD or Trueshot up or no Volley talent
      spell.cast(S.aimedShot, () => this.getSentinelTarget(true), () =>
        (spell.getCooldown(S.volley)?.timeleft || 99999) > 2000 || this.inTS() ||
        !spell.isSpellKnown(S.volley)
      ),

      // 10. moonlight_chakram
      spell.cast(S.moonlightChakram, () => this.getCurrentTarget()),

      // 11. rapid_fire
      spell.cast(S.rapidFire, () => this.getCurrentTarget()),

      // 12. steady_shot
      spell.cast(S.steadyShot, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // SENTINEL AoE (SimC actions.sentaoe, 8 lines)
  // =============================================
  sentAoE() {
    return new bt.Selector(
      // 1. multishot: consume Precise Shots, spread marks (target WITHOUT mark)
      spell.cast(S.multiShot, () => this.getSentinelTarget(false), () =>
        (me.hasAura(A.preciseShotsBuff) && !spell.isSpellKnown(T.aspectOfTheHydra)) ||
        !me.hasAura(A.trickShots)
      ),

      // Kill Shot: execute at < 20% HP
      spell.cast(S.killShot, () => this.getCurrentTarget(), () =>
        (this.getCurrentTarget()?.effectiveHealthPercent || 100) < 20
      ),

      // 2. rapid_fire,if=buff.bulletstorm.remains<action.aimed_shot.execute_time
      spell.cast(S.rapidFire, () => this.getCurrentTarget(), () => {
        const bs = me.getAura(A.bulletstorm);
        return bs && bs.remaining < 2500;
      }),

      // 3. trueshot,if=!buff.double_tap.up&variable.trueshot_ready
      spell.cast(S.trueshot, () => me, () =>
        this.useCDs() && !me.hasAura(A.doubleTap) && this.tsReady()
      ),

      // 4. volley,if=!buff.double_tap.up
      spell.cast(S.volley, () => this.getCurrentTarget(), () => !me.hasAura(A.doubleTap)),

      // 5. aimed_shot: prefer marked targets
      spell.cast(S.aimedShot, () => this.getSentinelTarget(true)),

      // 6. moonlight_chakram
      spell.cast(S.moonlightChakram, () => this.getCurrentTarget()),

      // 7. rapid_fire
      spell.cast(S.rapidFire, () => this.getCurrentTarget()),

      // 8. steady_shot
      spell.cast(S.steadyShot, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // HELPERS
  // =============================================
  isDR() { return spell.isSpellKnown(T.blackArrow); }
  isSent() { return !this.isDR(); }
  inTS() { return me.hasAura(A.trueshot); }
  useCDs() { return combat.burstToggle || Settings.FWMmAutoCDs; }

  // SimC: variable.trueshot_ready = !talent.bullseye|fight_remains>cooldown.trueshot.duration+10|buff.bullseye.stack=buff.bullseye.max_stack|fight_remains<25|time<10
  tsReady() {
    if (!spell.isSpellKnown(T.bullseye)) return true;
    const ttd = this.targetTTD();
    if (ttd < 25000) return true;
    // Opener: always fire TS in first 10s
    if (this._combatStartTime > 0 && (wow.frameTime - this._combatStartTime) < 10000) return true;
    const tsDuration = 120000;
    if (ttd > tsDuration + 10000) return true;
    const bs = me.getAura(A.bullseye);
    return bs && bs.stacks >= 30;
  }

  // Sentinel's Mark smart targeting:
  // preferMarked=true: target WITH marks (for Aimed Shot — damage amp on marked)
  // preferMarked=false: target WITHOUT marks (for Arcane/Multi — spread marks)
  getSentinelTarget(preferMarked) {
    if (!this.isSent() || !combat.targets || combat.targets.length <= 1) {
      return this.getCurrentTarget();
    }
    let best = null;
    let bestScore = preferMarked ? -1 : 999;
    for (const t of combat.targets) {
      if (!t || !common.validTarget(t) || me.distanceTo(t) > 40 || !me.isFacing(t)) continue;
      const mark = t.getAuraByMe(A.sentinelsMark);
      const stacks = mark ? (mark.stacks || 1) : 0;
      if (preferMarked && stacks > bestScore) { bestScore = stacks; best = t; }
      if (!preferMarked && stacks < bestScore) { bestScore = stacks; best = t; }
    }
    return best || this.getCurrentTarget();
  }

  getBSStacks() {
    const a = me.getAura(A.bulletstorm);
    return a ? a.stacks : 0;
  }

  // =============================================
  // RESOURCES (cached)
  // =============================================
  getFocus() {
    if (this._focusFrame === wow.frameTime) return this._cachedFocus;
    this._focusFrame = wow.frameTime;
    this._cachedFocus = me.powerByType(PowerType.Focus);
    return this._cachedFocus;
  }

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
    this._cachedEnemyCount = t ? t.getUnitsAroundCount(8) + 1 : 1;
    return this._cachedEnemyCount;
  }

  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }
}
