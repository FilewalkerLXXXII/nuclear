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
 * Enhancement Shaman Behavior - Midnight 12.0.1
 * Sources: SimC APL (midnight/shaman_enhancement.simc) + Method + Wowhead + Icy Veins
 *
 * Auto-detects: Stormbringer vs Totemic
 * Dispatches to: stormbringerST / totemicST / aoeRotation
 *
 * Key mechanics:
 *   Thorim's Invocation priming (ti_lb / ti_cl) via last MW spender tracking
 *   Whirling motes (Fire/Earth/Air) for Totemic
 *   MW spend: 10 optimal, 8+ during specific conditions, 5+ filler
 *   Stormstrike charges_fractional >= 1.8 cap prevention
 *   Elemental Tempo: LB when LL CD would be reduced enough by MW spend
 *   All melee instant — no movement block needed
 *
 * Hotfixes (March 17): All damage +8%, LB/CL +10%, Primordial Storm +10%
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC APL + Method + Wowhead + Icy Veins',
};

const S = {
  stormstrike:        17364,
  windstrike:         115356,
  lavaLash:           60103,
  crashLightning:     187874,
  lightningBolt:      188196,
  chainLightning:     188443,
  doomWinds:          384352,
  ascendance:         114051,
  sundering:          197214,
  surgingTotem:       444995,
  tempest:            454009,
  voltaicBlaze:       470057,
  primordialStorm:    1218090,  // Cast ID (confirmed)
  flameShock:         188389,
  iceStrike:          342240,
  frostShock:         196840,
  elementalBlast:     117014,
  totemicRecall:      108285,
  windShear:          57994,
  purge:              370,        // Remove 1 Magic buff from enemy
  cleanseSpirit:      51886,     // Remove Curse from friendly ally
  skyfury:            462854,
  astralShift:        108271,
  healingSurge:       8004,
  berserking:         26297,
  // Weapon Imbuements + Shield (precombat, must maintain)
  windfuryWeapon:     33757,
  flametongueWeapon:  318038,
  lightningShield:    192106,
};

// Talent IDs used in conditions
const T = {
  surgingElements:    382042,
  feralSpirit:        51533,
  thorimInvocation:   384444,
  stormUnleashed:     1262713,
  fireNova:           1260666,
  splitstream:        445035,
  elementalTempo:     1250364,
  surgingTotem:       444995,
  ashenCatalyst:      390370,
  lashingFlames:      334046,
  primordialWave:     375982,
};

const A = {
  maelstromWeapon:    344179,
  doomWinds:          466772,  // Buff aura (cast spell is 384352, 8s +100% WF proc)
  ascendance:         114051,
  hotHand:            215785,  // Hot Hand buff aura (SimC: find_spell(215785), 8s. Talent passive=201900)
  stormsurge:         201846,
  crashLightning:     1252415,  // Buff aura ID (confirmed)
  crashLightningAlt:  187878,   // Legacy fallback
  flameShock:         188389,
  tempest:            454009,
  primordialStorm:    1218090,  // Buff aura — TODO: verify if buff ID differs from cast
  whirlingFire:       453405,
  whirlingEarth:      453406,
  whirlingAir:        453409,
  lashingFlames:      334168,   // Debuff on target
  stormblast:         319930,
  convergingStorms:   198300,   // Buff aura ID (not talent 384363)
  legacyFrostWitch:   384450,
  totemicMomentum:    1260644,
  amplificationCore:  445029,
  skyfury:            462854,
  windfuryWeapon:     319773,   // WF weapon buff aura (confirmed)
  flametongueWeapon:  319778,   // FT weapon buff aura (confirmed)
  lightningShield:    192106,   // LS buff on player
  ashenCatalyst:      390371,  // Stacking buff (+8% LL dmg/stack, 8 max, 15s)
};

export class EnhancementShamanBehavior extends Behavior {
  name = 'FW Enhancement Shaman';
  context = BehaviorContext.Any;
  specialization = Specialization.Shaman.Enhancement;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _mwFrame = 0;
  _cachedMW = 0;
  _targetFrame = 0;
  _cachedTarget = null;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;

  // State
  _versionLogged = false;
  _lastDebug = 0;
  _combatStart = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWEnhAutoCDs', text: 'Auto Cooldowns (ignore burst keybind)', default: false },
        { type: 'slider', uid: 'FWEnhAoECount', text: 'AoE Target Count', default: 2, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWEnhDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWEnhAstralShift', text: 'Use Astral Shift', default: true },
        { type: 'slider', uid: 'FWEnhAstralShiftHP', text: 'Astral Shift HP %', default: 45, min: 10, max: 80 },
        { type: 'checkbox', uid: 'FWEnhHealingSurge', text: 'Use Healing Surge', default: true },
        { type: 'slider', uid: 'FWEnhHealingSurgeHP', text: 'Healing Surge HP %', default: 35, min: 10, max: 60 },
      ],
    },
  ];

  // =============================================
  // BUILD — Main behavior tree
  // =============================================
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: Weapon Imbuements + Lightning Shield + Skyfury
      new bt.Decorator(
        () => !me.inCombat(),
        new bt.Selector(
          // Windfury Weapon — CRITICAL: ~15-20% of total damage
          spell.cast(S.windfuryWeapon, () => me, () =>
            !me.hasAura(A.windfuryWeapon) && spell.getTimeSinceLastCast(S.windfuryWeapon) > 5000
          ),
          // Flametongue Weapon — significant damage amp
          spell.cast(S.flametongueWeapon, () => me, () =>
            !me.hasAura(A.flametongueWeapon) && spell.getTimeSinceLastCast(S.flametongueWeapon) > 5000
          ),
          // Lightning Shield
          spell.cast(S.lightningShield, () => me, () =>
            !me.hasAura(A.lightningShield) && spell.getTimeSinceLastCast(S.lightningShield) > 5000
          ),
          // Skyfury party buff
          spell.cast(S.skyfury, () => this.getSkyfuryTarget(), () => this.getSkyfuryTarget() !== null),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Auto-target
      new bt.Action(() => {
        if (!me.target || !common.validTarget(me.target)) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),

      // Null target bail
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      // Combat timer + opener tracking
      new bt.Action(() => {
        if (me.inCombat() && !this._combatStart) this._combatStart = wow.frameTime;
        if (!me.inCombat()) this._combatStart = 0;
        return bt.Status.Failure;
      }),

      // Version + Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Enh] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | Hero: ${this.isTotemic() ? 'Totemic' : 'Stormbringer'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWEnhDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Enh] MW:${this.getMW()} DW:${this.inDW()} Asc:${this.inAsc()} HH:${this.hasHotHand()} WF:${this.hasWhirlingFire()} WE:${this.hasWhirlingEarth()} WA:${this.hasWhirlingAir()} TI:${this.getTiPrimed()} SSfrac:${spell.getChargesFractional(S.stormstrike).toFixed(2)} E:${this.getEnemyCount()}`);
          // Aura IDs verified: HH=215785 (proc, not talent 201900), DW=466772 (buff, not cast 384352)
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.windShear),

          // Purge — remove Magic buffs from enemies
          spell.dispel(S.purge, false, DispelPriority.High, false, WoWDispelType.Magic),
          spell.dispel(S.purge, false, DispelPriority.Medium, false, WoWDispelType.Magic),

          // Cleanse Spirit — remove Curse from friendly allies
          spell.dispel(S.cleanseSpirit, true, DispelPriority.High, false, WoWDispelType.Curse),
          spell.dispel(S.cleanseSpirit, true, DispelPriority.Medium, false, WoWDispelType.Curse),

          this.defensives(),

          // Trinkets: fire BEFORE DW — Algethar Puzzle Box has 2s cast, must pre-cast
          // Trigger when DW is about to come off CD (within 3s) or already active
          common.useTrinkets(() => this.getCurrentTarget(), () => {
            if (!this.useCDs()) return false;
            if (this.targetTTD() < 20000) return true;
            if (this.inDW()) return true;
            const dwCD = spell.getCooldown(S.doomWinds)?.timeleft || 99999;
            return dwCD <= 3000;
          }),

          // Berserking: during DW window for burst alignment
          spell.cast(S.berserking, () => me, () =>
            this.useCDs() && this.inDW()
          ),

          // Dispatch: AoE → Totemic ST → Stormbringer ST
          new bt.Decorator(
            () => this.getEnemyCount() >= Settings.FWEnhAoECount,
            this.aoeRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.isTotemic(),
            this.totemicST(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => !this.isTotemic(),
            this.stormbringerST(),
            new bt.Action(() => bt.Status.Failure)
          ),
        )
      )
    );
  }

  // =============================================
  // STORMBRINGER — Single Target
  // SimC: actions.single_sb (24 lines)
  // =============================================
  stormbringerST() {
    return new bt.Selector(
      // 1. Primordial Storm: MW>=9 | (PS.remains<=4 & MW>=5)
      spell.cast(S.primordialStorm, () => this.getCurrentTarget(), () => {
        const mw = this.getMW();
        const ps = me.getAura(A.primordialStorm);
        return mw >= 9 || (ps && ps.remaining <= 4000 && mw >= 5);
      }),

      // 2. Voltaic Blaze: no Flame Shock & opener (time<5)
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () =>
        !this.targetHasFS() && this.isOpener()
      ),

      // 3. Flame Shock: !ticking
      spell.cast(S.flameShock, () => this.getCurrentTarget(), () => {
        if (spell.getTimeSinceLastCast(S.flameShock) < 3000) return false;
        return !this.targetHasFS();
      }),

      // 4. Lava Lash: no Lashing Flames & opener
      spell.cast(S.lavaLash, () => this.getCurrentTarget(), () => !this.targetHasLF() && this.isOpener()),

      // 6. Sundering: Surging Elements | Feral Spirit talented
      spell.cast(S.sundering, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.surgingElements) || spell.isSpellKnown(T.feralSpirit)
      ),

      // 7. Doom Winds (on CD, self-buff)
      // Doom Winds (direct cast — spell.cast() wrapper blocks it)
      new bt.Action(() => {
        if (this.targetTTD() <= 5000) return bt.Status.Failure;
        const dw = spell.getSpell(S.doomWinds);
        if (!dw || !dw.cooldown.ready || !dw.isUsable) return bt.Status.Failure;
        const t = this.getCurrentTarget();
        if (t && dw.cast(t)) return bt.Status.Success;
        if (dw.cast(me)) return bt.Status.Success;
        return bt.Status.Failure;
      }),

      // 8. Crash Lightning: !buff | Storm Unleashed
      spell.cast(S.crashLightning, () => this.getCurrentTarget(), () =>
        !this.hasCLBuff() || spell.isSpellKnown(T.stormUnleashed)
      ),

      // 9. Voltaic Blaze: DW & MW>=threshold & MW!=10 & Thorim's
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () => {
        if (!this.inDW() || !this.hasThorims()) return false;
        const mw = this.getMW();
        const threshold = 10 - (1 + (spell.isSpellKnown(T.fireNova) ? 2 : 0));
        return mw >= threshold && mw !== 10;
      }),

      // 10. Windstrike: MW>0 & Thorim's
      spell.cast(S.windstrike, () => this.getCurrentTarget(), () =>
        this.getMW() > 0 && this.hasThorims()
      ),

      // 11. Ascendance (on CD, self-buff)
      // SimC: ascendance — UNCONDITIONAL (not burst-gated)
      spell.cast(S.ascendance, () => me, () => this.targetTTD() > 15000),

      // 12. Stormstrike: DW & Thorim's
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () =>
        this.inDW() && this.hasThorims()
      ),

      // 13. Crash Lightning: DW & Thorim's
      spell.cast(S.crashLightning, () => this.getCurrentTarget(), () =>
        this.inDW() && this.hasThorims()
      ),

      // 14. Tempest: MW=10
      spell.cast(S.tempest, () => this.getCurrentTarget(), () => this.getMW() >= 10),

      // 15. Lightning Bolt: MW=10
      spell.cast(S.lightningBolt, () => this.getCurrentTarget(), () => this.getMW() >= 10),

      // 16. Stormstrike: charges_fractional >= 1.8
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () =>
        spell.getChargesFractional(S.stormstrike) >= 1.8
      ),

      // 17. Lava Lash (direct cast — Hot Hand makes usable while CD shows remaining)
      spell.cast(S.lavaLash, () => this.getCurrentTarget()),

      // 18. Stormstrike
      spell.cast(S.stormstrike, () => this.getCurrentTarget()),

      // 19. Voltaic Blaze
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget()),

      // 20. Sundering (filler)
      spell.cast(S.sundering, () => this.getCurrentTarget()),

      // 21. Lightning Bolt: MW>=8
      spell.cast(S.lightningBolt, () => this.getCurrentTarget(), () => this.getMW() >= 8),

      // 22. Crash Lightning
      spell.cast(S.crashLightning, () => this.getCurrentTarget()),

      // 23. Lightning Bolt: MW>=5
      spell.cast(S.lightningBolt, () => this.getCurrentTarget(), () => this.getMW() >= 5),

      // 24. Flame Shock (absolute filler)
      spell.cast(S.flameShock, () => this.getCurrentTarget())
    );
  }

  // =============================================
  // TOTEMIC — Single Target
  // SimC: actions.single_totemic (22 lines)
  // =============================================
  totemicST() {
    return new bt.Selector(
      // === Totemic ST (Method priority + SimC Thorim's DW burst) ===
      // Method: method.gg/guides/enhancement-shaman/playstyle-and-rotation
      // SimC: Thorim's Invocation DW interactions added back for burst damage

      // 1. Voltaic Blaze: apply Flame Shock if missing
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () => !this.targetHasFS()),

      // Surging Totem: maintain (Method opener #2, must keep active)
      spell.cast(S.surgingTotem, () => me, () => !me.hasAura(1221347)),

      // 2. Lava Lash in Hot Hand OR Whirling Fire — HIGHEST melee priority (Method #2)
      spell.cast(S.lavaLash, () => this.getCurrentTarget(), () =>
        this.hasHotHand() || this.hasWhirlingFire()
      ),

      // Sundering: Whirling Earth proc or Surging Elements
      spell.cast(S.sundering, () => this.getCurrentTarget(), () =>
        this.hasWhirlingEarth() || spell.isSpellKnown(T.surgingElements)
      ),

      // Doom Winds: on CD (Method opener #5, direct cast bypass)
      new bt.Action(() => {
        if (this.targetTTD() <= 5000) return bt.Status.Failure;
        const dw = spell.getSpell(S.doomWinds);
        if (!dw || !dw.cooldown.ready || !dw.isUsable) return bt.Status.Failure;
        const t = this.getCurrentTarget();
        if (t && dw.cast(t)) return bt.Status.Success;
        if (dw.cast(me)) return bt.Status.Success;
        return bt.Status.Failure;
      }),

      // === DW BURST WINDOW — Thorim's Invocation synergies (SimC #12-13) ===
      // During DW: CL triggers TI chain lightning, SS triggers TI nature damage
      // These are HIGH priority during the 8s DW window
      spell.cast(S.crashLightning, () => this.getCurrentTarget(), () =>
        this.inDW() && this.hasThorims()
      ),
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () =>
        this.inDW() && this.hasThorims()
      ),
      // SS without Thorim's during DW (Method #5)
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () => this.inDW()),

      // === OUTSIDE DW — normal priority ===

      // 3. Crash Lightning — maintain buff + Storm Unleashed (Method #3)
      spell.cast(S.crashLightning, () => this.getCurrentTarget(), () =>
        !this.hasCLBuff() || spell.isSpellKnown(T.stormUnleashed)
      ),

      // 4. Primordial Storm at MW>=10 or expiring (Method #4)
      spell.cast(S.primordialStorm, () => this.getCurrentTarget(), () => {
        const mw = this.getMW();
        const ps = me.getAura(A.primordialStorm);
        return mw >= 10 || (ps && ps.remaining < 3500 && mw >= 5);
      }),

      // Windstrike during Ascendance (if talented)
      spell.cast(S.windstrike, () => this.getCurrentTarget(), () =>
        this.hasThorims() && this.inAsc()
      ),

      // Ascendance (if talented)
      spell.cast(S.ascendance, () => me, () => this.isTiLB() && this.targetTTD() > 15000),

      // 5. Stormstrike: charges capping prevention
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () =>
        spell.getChargesFractional(S.stormstrike) >= 1.8
      ),

      // 6. Lava Lash filler (Method #7)
      spell.cast(S.lavaLash, () => this.getCurrentTarget()),

      // 7. Stormstrike filler (Method #8)
      spell.cast(S.stormstrike, () => this.getCurrentTarget()),

      // Sundering filler: Surging Totem CD > 25s
      spell.cast(S.sundering, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.surgingTotem)?.timeleft || 0) > 25000
      ),

      // 8. Voltaic Blaze filler (Method #9)
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget()),

      // 9. Crash Lightning filler (extra cleave + CL buff refresh)
      spell.cast(S.crashLightning, () => this.getCurrentTarget()),

      // 10. Lightning Bolt — last resort MW dump (Method #6/#10)
      spell.cast(S.lightningBolt, () => this.getCurrentTarget(), () => this.getMW() >= 10),
      spell.cast(S.lightningBolt, () => this.getCurrentTarget(), () => this.getMW() >= 5),

      // Absolute filler
      spell.cast(S.flameShock, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // AOE — Both hero trees (shared with talent checks)
  // SimC: actions.aoe (34 lines)
  // =============================================
  aoeRotation() {
    return new bt.Selector(
      // 1. Voltaic Blaze: Totemic & no Flame Shock
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () =>
        this.isTotemic() && !this.targetHasFS()
      ),

      // 2. Flame Shock: !ticking (Totemic applies FS passively — skip entirely)
      new bt.Decorator(
        () => !this.isTotemic(),
        spell.cast(S.flameShock, () => this.getCurrentTarget(), () => {
          if (spell.getTimeSinceLastCast(S.flameShock) < 3000) return false;
          return !this.targetHasFS();
        }),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 3. Surging Totem (SimC: unconditional for Totemic — only when totem not active)
      spell.cast(S.surgingTotem, () => me, () => this.isTotemic() && !me.hasAura(1221347)),

      // 4. Ascendance: ti_chain_lightning (SimC: NOT burst-gated, only TI priming)
      spell.cast(S.ascendance, () => me, () => this.isTiCL() && this.targetTTD() > 15000),

      // 6. Sundering: Surging Elements | Whirling Earth
      spell.cast(S.sundering, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.surgingElements) || this.hasWhirlingEarth()
      ),

      // 7. Lava Lash: Whirling Fire
      spell.cast(S.lavaLash, () => this.getCurrentTarget(), () => this.hasWhirlingFire()),

      // 8. Doom Winds (direct cast — spell.cast() wrapper blocks it)
      new bt.Action(() => {
        if (this.targetTTD() <= 5000) return bt.Status.Failure;
        const dw = spell.getSpell(S.doomWinds);
        if (!dw || !dw.cooldown.ready || !dw.isUsable) return bt.Status.Failure;
        const t = this.getCurrentTarget();
        if (t && dw.cast(t)) return bt.Status.Success;
        if (dw.cast(me)) return bt.Status.Success;
        return bt.Status.Failure;
      }),

      // 9. Crash Lightning: Thorim's & Whirling Air & (DW | Asc)
      spell.cast(S.crashLightning, () => this.getCurrentTarget(), () =>
        this.hasThorims() && this.hasWhirlingAir() && (this.inDW() || this.inAsc())
      ),

      // 10. Windstrike: Thorim's & Whirling Air
      spell.cast(S.windstrike, () => this.getCurrentTarget(), () =>
        this.hasThorims() && this.hasWhirlingAir()
      ),

      // 11. Stormstrike: Thorim's & DW & Whirling Air
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () =>
        this.hasThorims() && this.inDW() && this.hasWhirlingAir()
      ),

      // 12. Lava Lash: Splitstream & Hot Hand
      spell.cast(S.lavaLash, () => this.getCurrentTarget(), () => spell.isSpellKnown(T.splitstream) && this.hasHotHand()),

      // 13. Tempest: MW>=10 & (!Asc | !DW) — Stormbringer only
      spell.cast(S.tempest, () => this.getCurrentTarget(), () =>
        !this.isTotemic() && this.getMW() >= 10 && (!this.inAsc() || !this.inDW())
      ),

      // 14. Primordial Storm: MW>=10
      spell.cast(S.primordialStorm, () => this.getCurrentTarget(), () => this.getMW() >= 10),

      // 15. Crash Lightning: Thorim's & (DW | Asc) & Splitstream & Hot Hand
      spell.cast(S.crashLightning, () => this.getCurrentTarget(), () =>
        this.hasThorims() && (this.inDW() || this.inAsc()) &&
        spell.isSpellKnown(T.splitstream) && this.hasHotHand()
      ),

      // 16. Windstrike: Thorim's & Splitstream & Hot Hand
      spell.cast(S.windstrike, () => this.getCurrentTarget(), () =>
        this.hasThorims() && spell.isSpellKnown(T.splitstream) && this.hasHotHand()
      ),

      // 17. Stormstrike: Thorim's & DW & Splitstream & Hot Hand
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () =>
        this.hasThorims() && this.inDW() && spell.isSpellKnown(T.splitstream) && this.hasHotHand()
      ),

      // 18. Chain Lightning: MW>=(9+totemic) & Splitstream & Hot Hand
      spell.cast(S.chainLightning, () => this.getCurrentTarget(), () => {
        const threshold = this.isTotemic() ? 10 : 9;
        return this.getMW() >= threshold && spell.isSpellKnown(T.splitstream) && this.hasHotHand();
      }),

      // 19. Voltaic Blaze: Fire Nova talented
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fireNova)
      ),

      // 20. Crash Lightning (high prio filler)
      spell.cast(S.crashLightning, () => this.getCurrentTarget()),

      // 21. Windstrike: Thorim's
      spell.cast(S.windstrike, () => this.getCurrentTarget(), () => this.hasThorims()),

      // 22. Stormstrike: Thorim's & DW
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () =>
        this.hasThorims() && this.inDW()
      ),

      // 23. Chain Lightning: MW>=(9+totemic)
      spell.cast(S.chainLightning, () => this.getCurrentTarget(), () => {
        const threshold = this.isTotemic() ? 10 : 9;
        return this.getMW() >= threshold;
      }),

      // 24. Sundering: Feral Spirit talented
      spell.cast(S.sundering, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.feralSpirit)
      ),

      // 25. Voltaic Blaze (filler)
      spell.cast(S.voltaicBlaze, () => this.getCurrentTarget()),

      // 26. Lava Lash: Searing Totem active (Totemic, totem recently cast)
      spell.cast(S.lavaLash, () => this.getCurrentTarget(), () => this.isTotemic() && spell.getTimeSinceLastCast(S.surgingTotem) < 25000),

      // 27. Windstrike (filler)
      spell.cast(S.windstrike, () => this.getCurrentTarget()),

      // 28. Stormstrike: charges_fractional>=1.8 | Converging Storms max
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () => {
        if (spell.getChargesFractional(S.stormstrike) >= 1.8) return true;
        const cs = me.getAura(A.convergingStorms);
        return !!(cs && cs.stacks >= 6);
      }),

      // 29. Sundering: Surging Totem CD > 25
      spell.cast(S.sundering, () => this.getCurrentTarget(), () =>
        (spell.getCooldown(S.surgingTotem)?.timeleft || 0) > 25000
      ),

      // 30. Stormstrike: !Totemic
      spell.cast(S.stormstrike, () => this.getCurrentTarget(), () => !this.isTotemic()),

      // 31. Lava Lash (filler — direct cast)
      spell.cast(S.lavaLash, () => this.getCurrentTarget()),

      // 32. Stormstrike (filler)
      spell.cast(S.stormstrike, () => this.getCurrentTarget()),

      // 33. Chain Lightning: MW>=5
      spell.cast(S.chainLightning, () => this.getCurrentTarget(), () => this.getMW() >= 5),

      // 34. Flame Shock (absolute filler — Stormbringer only)
      new bt.Decorator(
        () => !this.isTotemic(),
        spell.cast(S.flameShock, () => this.getCurrentTarget()),
        new bt.Action(() => bt.Status.Failure)
      )
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.astralShift, () => me, () =>
        Settings.FWEnhAstralShift && me.pctHealth <= Settings.FWEnhAstralShiftHP
      ),
      spell.cast(S.healingSurge, () => me, () => {
        if (!Settings.FWEnhHealingSurge) return false;
        if (spell.getTimeSinceLastCast(S.healingSurge) < 4000) return false;
        if (this.getMW() < 5) return false;
        const threshold = this.inBurst()
          ? Math.min(Settings.FWEnhHealingSurgeHP + 15, 60)
          : Settings.FWEnhHealingSurgeHP;
        return me.pctHealth <= threshold;
      }),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isTotemic() {
    return me.hasAura(A.totemicMomentum) || me.hasAura(A.amplificationCore) ||
      spell.isSpellKnown(S.surgingTotem);
  }
  isStormbringer() { return !this.isTotemic(); }

  // =============================================
  // BURST STATE
  // =============================================
  inBurst() { return this.inDW() || this.inAsc() || this.isSurgingTotemActive(); }
  inDW() { return me.hasAura(A.doomWinds); }
  inAsc() { return me.hasAura(A.ascendance); }
  isSurgingTotemActive() {
    return this.isTotemic() && spell.getTimeSinceLastCast(S.surgingTotem) < 25000;
  }

  // =============================================
  // THORIM'S INVOCATION PRIMING (ti_lb / ti_cl)
  // Tracks last MW spender to determine what Thorim's auto-fires
  // =============================================
  hasThorims() { return spell.isSpellKnown(T.thorimInvocation); }

  getTiPrimed() {
    const lb = spell.getTimeSinceLastCast(S.lightningBolt);
    const cl = spell.getTimeSinceLastCast(S.chainLightning);
    const tp = this.isTotemic() ? 60000 : spell.getTimeSinceLastCast(S.tempest);
    const eb = spell.getTimeSinceLastCast(S.elementalBlast);
    let minTime = 60000;
    let result = 'none';
    if (lb < minTime) { minTime = lb; result = 'lb'; }
    if (tp < minTime) { minTime = tp; result = 'lb'; } // Tempest = LB for TI
    if (eb < minTime) { minTime = eb; result = 'lb'; } // EB = LB for TI
    if (cl < minTime) { minTime = cl; result = 'cl'; }
    if (minTime >= 60000) return 'none';
    return result;
  }

  isTiLB() { return this.getTiPrimed() === 'lb'; }
  isTiCL() { return this.getTiPrimed() === 'cl'; }

  // =============================================
  // OPENER CHECK (SimC: time<5)
  // =============================================
  isOpener() {
    return this._combatStart > 0 && (wow.frameTime - this._combatStart) < 5000;
  }

  // =============================================
  // PROC / BUFF CHECKS
  // =============================================
  hasHotHand() { return me.hasAura(A.hotHand); }
  hasWhirlingFire() { return me.hasAura(A.whirlingFire); }
  hasWhirlingEarth() { return me.hasAura(A.whirlingEarth); }
  hasWhirlingAir() { return me.hasAura(A.whirlingAir); }

  hasCLBuff() {
    return me.hasAura(A.crashLightning) || me.hasAura(A.crashLightningAlt);
  }

  // =============================================
  // FLAME SHOCK / LASHING FLAMES on target
  // =============================================
  targetHasFS() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    return !!(t.getAuraByMe(A.flameShock) ||
      t.auras.find(a => a.spellId === A.flameShock && a.casterGuid?.equals(me.guid)));
  }

  targetHasLF() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    return !!(t.getAuraByMe(A.lashingFlames) ||
      t.auras.find(a => a.spellId === A.lashingFlames && a.casterGuid?.equals(me.guid)));
  }

  // =============================================
  // MAELSTROM WEAPON (cached per tick)
  // =============================================
  getMW() {
    if (this._mwFrame === wow.frameTime) return this._cachedMW;
    this._mwFrame = wow.frameTime;
    const aura = me.getAura(A.maelstromWeapon);
    this._cachedMW = aura ? (aura.stacks || 0) : 0;
    if (this._cachedMW === 0) {
      const found = me.auras.find(a => a.spellId === A.maelstromWeapon);
      this._cachedMW = found ? (found.stacks || 0) : 0;
    }
    return this._cachedMW;
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target !== null && common.validTarget(target) && me.distanceTo2D(target) <= 10) {
      // Valid manual target — use it if facing, skip tick if not (DON'T switch)
      if (me.isFacing(target)) {
        this._cachedTarget = target;
        return target;
      }
      this._cachedTarget = null;
      return null; // Not facing manual target — wait, don't auto-switch
    }
    // No valid manual target (dead/null/out of range) — auto-pick
    if (me.inCombat()) {
      const t = combat.targets.find(u => common.validTarget(u) && me.distanceTo2D(u) <= 10 && me.isFacing(u));
      if (t) { wow.GameUI.setTarget(t); this._cachedTarget = t; return t; }
    }
    this._cachedTarget = null;
    return null;
  }

  getEnemyCount() {
    if (this._enemyFrame === wow.frameTime) return this._cachedEnemyCount;
    this._enemyFrame = wow.frameTime;
    const t = this.getCurrentTarget();
    this._cachedEnemyCount = t ? t.getUnitsAroundCount(10) + 1 : 0;
    return this._cachedEnemyCount;
  }

  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }

  useCDs() { return combat.burstToggle || Settings.FWEnhAutoCDs; }

  // =============================================
  // SKYFURY (OOC buff)
  // =============================================
  getSkyfuryTarget() {
    if (spell.getTimeSinceLastCast(S.skyfury) < 60000) return null;
    if (!this._hasBuff(me, S.skyfury)) return me;
    // Skyfury is a raid-wide buff — casting once applies to everyone. Only check self.
    return null;
  }

  _hasBuff(unit, id) {
    if (!unit) return false;
    if (unit.hasVisibleAura(id) || unit.hasAura(id)) return true;
    if (unit.auras.find(a => a.spellId === id)) return true;
    // Skyfury: cast ID may differ from buff aura — fallback to name match
    if (id === S.skyfury) return unit.auras.find(a =>
      a.name.includes("Skyfury") || a.name.includes("Himmelszorn") || a.spellId === A.skyfury
    ) !== undefined;
    return false;
  }
}
