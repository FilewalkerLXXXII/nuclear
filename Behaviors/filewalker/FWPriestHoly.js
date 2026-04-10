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
 * Holy Priest Behavior - Midnight 12.0.1
 * Sources: Method Guide (all pages) + Wowhead + WarcraftPriests community
 *
 * Auto-detects: Archon (Halo) vs Oracle (extra PoM charge)
 *
 * Midnight changes:
 *   - Heal (2060) REMOVED
 *   - Renew (139) REMOVED as castable — only triggered via Benediction talent
 *   - Shadow Word: Pain (589) REMOVED for Holy
 *   - Shadowfiend, Symbol of Hope, Divine Star, Divine Word REMOVED
 *   - Power Word: Shield REMOVED for Holy
 *   - Ultimate Serenity: combines Sanctify into Serenity (Serenity cleaves + AoE spells reduce its CD)
 *   - Halo is now Archon-exclusive
 *
 * Tiered healing: Emergency (<20%) → Critical (<40%) → Urgent (<65%) → Maintenance (<85%) → DPS (>85%)
 * Serendipity: Flash Heal reduces Serenity CD by 6s, Prayer of Healing reduces Sanctify CD by 6s
 * Long CDs (Divine Hymn, Apotheosis, Guardian Spirit) OFF by default for raid assignment
 *
 * Archon: Halo on CD, Spiritwell (SoL procs on PoH), stronger burst via Apotheosis+Halo
 * Oracle: Extra PoM charge, PoM-centric passive healing, Prompt Prognosis, Guiding Light
 */

const S = {
  // Core heals
  flashHeal:          2061,
  holyWordSerenity:   2050,     // 2 charges, 45s CD each
  holyWordSanctify:   34861,    // 2 charges, 45s CD each (removed by Ultimate Serenity)
  prayerOfMending:    33076,    // 2 charges (Oracle gets 3rd charge-like via Piety)
  prayerOfHealing:    596,
  circleOfHealing:    204883,
  // Long CDs (raid assignment)
  divineHymn:         64843,
  apotheosis:         200183,
  guardianSpirit:     47788,
  // Defensives
  desperatePrayer:    19236,
  fade:               586,
  // Dispel
  purify:             527,
  // DPS
  smite:              585,
  holyFire:           14914,
  shadowWordDeath:    32379,
  holyNova:           132157,
  holyWordChastise:   88625,
  // Utility
  powerWordFortitude: 21562,
  // Archon
  halo:               120517,
  // Racials
  berserking:         26297,
};

const A = {
  surgeOfLight:       114255,   // Instant Flash Heal proc, stacks to 2
  lightweaver:        390992,   // Flash Heal → empowered Prayer of Healing (up to 4 stacks)
  guardianSpirit:     47788,
  apotheosis:         200183,
  divineHymn:         64843,
  prayerOfMending:    33076,    // Bouncing buff on target
  powerWordFortitude: 21562,
  resonantWords:      372313,   // Holy Word → empowered next Flash Heal/Heal/PoH
  trailOfLight:       234946,   // Flash Heal also heals previous target for 25%
  empyrealBlaze:      372616,   // Holy Word: Chastise buff for DPS — next 2 Holy Fires instant, no CD
  burningVehemence:   372307,   // Chastise → AoE fire damage
  benediction:        451569,   // Upgraded Flash Heal talent (stronger + Cosmic Ripple)
  // Hero talent detection
  archonHalo:         120517,   // Archon exclusive ability
  // Ultimate Serenity (talent removes Sanctify, merges into Serenity)
  ultimateSerenity:   449937,   // Talent known check
};

export class HolyPriestBehavior extends Behavior {
  name = 'FW Holy Priest';
  context = BehaviorContext.Any;
  specialization = Specialization.Priest.Holy;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedDpsTarget = null;
  _healFrame = 0;
  _cachedLowest = null;
  _cachedLowestHP = 100;
  _cachedTankLowest = null;
  _cachedTankLowestHP = 100;
  _cachedBelow20 = 0;
  _cachedBelow40 = 0;
  _cachedBelow65 = 0;
  _cachedBelow85 = 0;
  _cachedFriends = [];
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'Healing Thresholds',
      options: [
        { type: 'slider', uid: 'FWHpEmergencyHP', text: 'Emergency HP %', default: 20, min: 5, max: 35 },
        { type: 'slider', uid: 'FWHpCriticalHP', text: 'Critical HP %', default: 40, min: 20, max: 55 },
        { type: 'slider', uid: 'FWHpUrgentHP', text: 'Urgent HP %', default: 65, min: 40, max: 80 },
        { type: 'slider', uid: 'FWHpMaintHP', text: 'Maintenance HP %', default: 85, min: 70, max: 95 },
        { type: 'slider', uid: 'FWHpDpsThreshold', text: 'DPS when all above %', default: 85, min: 70, max: 100 },
      ],
    },
    {
      header: 'Major Cooldowns (OFF = manual/raid assignment)',
      options: [
        { type: 'checkbox', uid: 'FWHpDivineHymn', text: 'Auto Divine Hymn', default: false },
        { type: 'slider', uid: 'FWHpDivineHymnHP', text: 'Divine Hymn avg HP %', default: 40, min: 15, max: 60 },
        { type: 'slider', uid: 'FWHpDivineHymnCount', text: 'Divine Hymn min targets', default: 3, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWHpApotheosis', text: 'Auto Apotheosis', default: false },
        { type: 'slider', uid: 'FWHpApotheosisHP', text: 'Apotheosis trigger HP %', default: 35, min: 15, max: 55 },
        { type: 'slider', uid: 'FWHpApotheosisCount', text: 'Apotheosis min targets below critical', default: 2, min: 1, max: 5 },
        { type: 'checkbox', uid: 'FWHpGuardianSpirit', text: 'Auto Guardian Spirit', default: false },
        { type: 'slider', uid: 'FWHpGuardianSpiritHP', text: 'Guardian Spirit HP %', default: 20, min: 5, max: 40 },
      ],
    },
    {
      header: 'Self-Defense',
      options: [
        { type: 'checkbox', uid: 'FWHpDesperatePrayer', text: 'Use Desperate Prayer', default: true },
        { type: 'slider', uid: 'FWHpDesperatePrayerHP', text: 'Desperate Prayer HP %', default: 30, min: 10, max: 50 },
        { type: 'checkbox', uid: 'FWHpFade', text: 'Auto Fade on aggro', default: true },
      ],
    },
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWHpDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  build() {
    if (!this._versionLogged) {
      this._versionLogged = true;
      const hero = this.isArchon() ? 'Archon' : 'Oracle';
      const hasSanctify = !this.hasUltimateSerenity();
      console.info(`[FW Holy Priest] Midnight 12.0.1 | Hero: ${hero} | UltSerenity: ${!hasSanctify}`);
    }

    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),

      // OOC: Power Word: Fortitude
      new bt.Decorator(
        () => !me.inCombat(),
        new bt.Selector(
          spell.cast(S.powerWordFortitude, () => this.getFortTarget(), () =>
            this.getFortTarget() !== null
          ),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      common.waitForCastOrChannel(),

      // Debug + cache refresh
      new bt.Action(() => {
        this._refreshHealCache();
        if (Settings.FWHpDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const mana = Math.round(this.getManaPercent());
          const hero = this.isArchon() ? 'Archon' : 'Oracle';
          const sol = me.hasAura(A.surgeOfLight);
          const lw = this.getLightweaverStacks();
          const serenFrac = spell.getChargesFractional(S.holyWordSerenity).toFixed(2);
          const pomFrac = spell.getChargesFractional(S.prayerOfMending).toFixed(2);
          const rw = me.hasAura(A.resonantWords) ? 'Y' : 'N';
          console.info(`[HPriest] Low:${Math.round(this._cachedLowestHP)}% B40:${this._cachedBelow40} B65:${this._cachedBelow65} B85:${this._cachedBelow85} Mana:${mana}% SoL:${sol} LW:${lw} Seren:${serenFrac} PoM:${pomFrac} RW:${rw} Hero:${hero}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // --- Off-GCD: Self-defense ---
          spell.cast(S.desperatePrayer, () => me, () =>
            Settings.FWHpDesperatePrayer && me.pctHealth <= Settings.FWHpDesperatePrayerHP
          ),
          spell.cast(S.fade, () => me, () =>
            Settings.FWHpFade && me.inCombat() && spell.getTimeSinceLastCast(S.fade) > 10000
          ),

          // --- Dispels (HIGH priority) ---
          spell.dispel(S.purify, true, DispelPriority.High, false, WoWDispelType.Magic, WoWDispelType.Disease),
          spell.dispel(S.purify, true, DispelPriority.Medium, false, WoWDispelType.Magic, WoWDispelType.Disease),

          // --- Movement: instants only ---
          new bt.Decorator(
            () => me.isMoving(),
            new bt.Selector(
              this.movementHealing(),
              this.movementDps(),
              new bt.Action(() => bt.Status.Success) // Block cast-time spells
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // --- Tier 1: EMERGENCY (<20%) ---
          this.emergencyHealing(),

          // --- Tier 2: MAJOR CDs (all OFF by default) ---
          this.majorCooldowns(),

          // --- Tier 3-4: HEALING ROTATION ---
          this.healingRotation(),

          // --- Tier 5: DPS ---
          this.dpsRotation()
        )
      )
    );
  }

  // =============================================
  // TIER 1: EMERGENCY — someone < 20%
  // =============================================
  emergencyHealing() {
    return new bt.Decorator(
      () => this._cachedBelow20 >= 1,
      new bt.Selector(
        // Guardian Spirit on dying tank (if enabled)
        spell.cast(S.guardianSpirit, () => this.getTankBelow(Settings.FWHpGuardianSpiritHP), () =>
          Settings.FWHpGuardianSpirit &&
          this.getTankBelow(Settings.FWHpGuardianSpiritHP) !== null
        ),

        // Holy Word: Serenity — biggest instant single-target heal
        spell.cast(S.holyWordSerenity, () => this.getHealTarget(Settings.FWHpEmergencyHP), () =>
          this.getHealTarget(Settings.FWHpEmergencyHP) !== null
        ),

        // Surge of Light → instant Flash Heal (free, no mana)
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWHpEmergencyHP), () =>
          me.hasAura(A.surgeOfLight) && this.getHealTarget(Settings.FWHpEmergencyHP) !== null
        ),

        // Resonant Words empowered Flash Heal (after Holy Word cast)
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWHpEmergencyHP), () =>
          me.hasAura(A.resonantWords) && this.getHealTarget(Settings.FWHpEmergencyHP) !== null
        ),

        // Flash Heal — cast time but critical
        spell.cast(S.flashHeal, () => this.getHealTarget(Settings.FWHpEmergencyHP), () =>
          this.getHealTarget(Settings.FWHpEmergencyHP) !== null && this.hasManaFor('flashHeal')
        ),
      )
    );
  }

  // =============================================
  // TIER 2: MAJOR CDS (all OFF by default)
  // =============================================
  majorCooldowns() {
    return new bt.Selector(
      // Divine Hymn — group-wide channeled heal
      spell.cast(S.divineHymn, () => me, () =>
        Settings.FWHpDivineHymn &&
        this._cachedBelow40 >= Settings.FWHpDivineHymnCount
      ),

      // Apotheosis — rapid Holy Word resets
      spell.cast(S.apotheosis, () => me, () =>
        Settings.FWHpApotheosis &&
        this._cachedBelow40 >= Settings.FWHpApotheosisCount &&
        this._cachedLowestHP <= Settings.FWHpApotheosisHP
      ),
    );
  }

  // =============================================
  // TIER 3-4: HEALING ROTATION (triage by severity)
  // Method guide priorities:
  //   Oracle: PoM at 2 charges > Holy Words at 2 charges > Benediction > PoM > Holy Words > Holy Nova (Lightburst) > PoH/FH(SoL)
  //   Archon: Holy Words at 2 charges > PoM > Benediction > Holy Words > Holy Nova (Lightburst) > PoH
  // =============================================
  healingRotation() {
    const urgentHP = Settings.FWHpUrgentHP;
    const critHP = Settings.FWHpCriticalHP;
    const maintHP = Settings.FWHpMaintHP;

    return new bt.Selector(
      // --- CRITICAL: < 40% ---

      // Holy Word: Serenity — biggest heal, use on critically injured
      spell.cast(S.holyWordSerenity, () => this.getHealTarget(critHP), () =>
        this.getHealTarget(critHP) !== null
      ),

      // Holy Word: Sanctify — AoE heal when multiple critical (only if no Ultimate Serenity)
      spell.cast(S.holyWordSanctify, () => this.getHealTarget(critHP), () =>
        !this.hasUltimateSerenity() && this._cachedBelow40 >= 2
      ),

      // Circle of Healing — instant AoE heal
      spell.cast(S.circleOfHealing, () => this.getHealTarget(critHP), () =>
        this._cachedBelow65 >= 2
      ),

      // Surge of Light → instant free Flash Heal (consume at 2 stacks to avoid waste)
      spell.cast(S.flashHeal, () => this.getHealTarget(critHP), () => {
        if (!this.getHealTarget(critHP)) return false;
        const sol = me.getAura(A.surgeOfLight);
        return sol && sol.stacks >= 1;
      }),

      // --- URGENT: < 65% ---

      // Prayer of Mending — HIGHEST PRIORITY for Oracle at 2 charges
      spell.cast(S.prayerOfMending, () => this.getTankTarget(95) || this.getHealTarget(urgentHP) || this.getAnyFriend(), () => {
        const frac = spell.getChargesFractional(S.prayerOfMending);
        // Oracle: PoM is primary healer — cast at 2 charges IMMEDIATELY
        if (this.isOracle() && frac >= 1.9) return true;
        // Both: don't waste charges
        return frac > 1.4;
      }),

      // Holy Word: Serenity approaching 2 charges
      spell.cast(S.holyWordSerenity, () => this.getHealTarget(urgentHP), () => {
        if (!this.getHealTarget(urgentHP)) return false;
        return spell.getChargesFractional(S.holyWordSerenity) > 1.4;
      }),

      // Halo — Archon only, 60s CD, AoE heal+damage, grants 4x SoL procs
      spell.cast(S.halo, () => me, () =>
        this.isArchon() && spell.isSpellKnown(S.halo) &&
        this._cachedBelow65 >= 2
      ),

      // Surge of Light at 2 stacks — consume before cap
      spell.cast(S.flashHeal, () => this.getHealTarget(urgentHP), () => {
        if (!this.getHealTarget(urgentHP)) return false;
        const sol = me.getAura(A.surgeOfLight);
        return sol && sol.stacks >= 2;
      }),

      // Resonant Words empowered Flash Heal (proc from Holy Word cast — limited window)
      spell.cast(S.flashHeal, () => this.getHealTarget(urgentHP), () => {
        if (!this.getHealTarget(urgentHP)) return false;
        const rw = me.getAura(A.resonantWords);
        return rw && rw.remaining > 0;
      }),

      // Lightweaver empowered Prayer of Healing (2+ stacks, multiple injured)
      spell.cast(S.prayerOfHealing, () => this.getHealTarget(urgentHP), () =>
        this.getLightweaverStacks() >= 2 &&
        this._cachedBelow65 >= 3 &&
        this.hasManaFor('prayerOfHealing')
      ),

      // Holy Word: Serenity (use even without charge cap on urgent targets)
      spell.cast(S.holyWordSerenity, () => this.getHealTarget(urgentHP), () =>
        this.getHealTarget(urgentHP) !== null
      ),

      // Flash Heal — CDR for Serenity via Serendipity + builds Lightweaver
      spell.cast(S.flashHeal, () => this.getHealTarget(urgentHP), () =>
        this.getHealTarget(urgentHP) !== null && this.hasManaFor('flashHeal')
      ),

      // Holy Word: Sanctify — AoE when multiple hurt (if not Ultimate Serenity)
      spell.cast(S.holyWordSanctify, () => this.getHealTarget(urgentHP), () =>
        !this.hasUltimateSerenity() && this._cachedBelow65 >= 3
      ),

      // --- MAINTENANCE: < 85% ---

      // Prayer of Mending — keep rolling (Oracle: always spend, Archon: fractional check)
      spell.cast(S.prayerOfMending, () => this.getTankTarget(95) || this.getHealTarget(maintHP) || this.getAnyFriend(), () => {
        const frac = spell.getChargesFractional(S.prayerOfMending);
        if (this.isOracle()) return frac > 1.2; // Oracle: aggressive PoM usage
        return frac > 1.7;
      }),

      // Circle of Healing — instant, use when multiple hurt
      spell.cast(S.circleOfHealing, () => this.getHealTarget(maintHP), () =>
        this._cachedBelow85 >= 3
      ),

      // Halo — Archon: use on CD for healing + SoL procs (per Method: "use on CD unless big dmg incoming")
      spell.cast(S.halo, () => me, () =>
        this.isArchon() && spell.isSpellKnown(S.halo) &&
        this._cachedBelow85 >= 2
      ),

      // Archon: Prayer of Healing is strongest source (per Method)
      spell.cast(S.prayerOfHealing, () => this.getHealTarget(maintHP), () =>
        this.isArchon() &&
        this._cachedBelow85 >= 3 &&
        this.getLightweaverStacks() >= 1 &&
        this.hasManaFor('prayerOfHealing')
      ),

      // Surge of Light → free instant Flash Heal (don't waste proc)
      spell.cast(S.flashHeal, () => this.getHealTarget(maintHP), () => {
        if (!this.getHealTarget(maintHP)) return false;
        const sol = me.getAura(A.surgeOfLight);
        if (!sol) return false;
        // Consume at 2 stacks or when expiring (<4s remaining)
        return sol.stacks >= 2 || sol.remaining < 4000;
      }),

      // Resonant Words → empowered Flash Heal (consume before expiry)
      spell.cast(S.flashHeal, () => this.getHealTarget(maintHP), () => {
        if (!this.getHealTarget(maintHP)) return false;
        const rw = me.getAura(A.resonantWords);
        return rw && rw.remaining > 0;
      }),

      // Holy Word: Serenity — use if nearing cap
      spell.cast(S.holyWordSerenity, () => this.getHealTarget(maintHP), () => {
        if (!this.getHealTarget(maintHP)) return false;
        return spell.getChargesFractional(S.holyWordSerenity) > 1.7;
      }),

      // Oracle: Prayer of Healing with Lightweaver stacks
      spell.cast(S.prayerOfHealing, () => this.getHealTarget(maintHP), () =>
        this.isOracle() &&
        this._cachedBelow85 >= 3 &&
        this.getLightweaverStacks() >= 1 &&
        this.hasManaFor('prayerOfHealing')
      ),

      // Flash Heal — mana-efficient CDR builder, Lightweaver stacks
      spell.cast(S.flashHeal, () => this.getHealTarget(maintHP), () => {
        if (!this.getHealTarget(maintHP)) return false;
        const mana = this.getManaPercent();
        if (mana < 30) return false;
        if (mana < 50 && this._cachedLowestHP > urgentHP) return false;
        return true;
      }),
    );
  }

  // =============================================
  // MOVEMENT HEALING (instants only)
  // =============================================
  movementHealing() {
    const urgentHP = Settings.FWHpUrgentHP;
    const maintHP = Settings.FWHpMaintHP;
    return new bt.Selector(
      // Emergency: Serenity
      spell.cast(S.holyWordSerenity, () => this.getHealTarget(Settings.FWHpEmergencyHP), () =>
        this.getHealTarget(Settings.FWHpEmergencyHP) !== null
      ),
      // Surge of Light → instant Flash Heal
      spell.cast(S.flashHeal, () => this.getHealTarget(urgentHP), () =>
        me.hasAura(A.surgeOfLight) && this.getHealTarget(urgentHP) !== null
      ),
      // Holy Word: Serenity on urgent
      spell.cast(S.holyWordSerenity, () => this.getHealTarget(urgentHP), () =>
        this.getHealTarget(urgentHP) !== null
      ),
      // Holy Word: Sanctify (AoE, if available)
      spell.cast(S.holyWordSanctify, () => this.getHealTarget(urgentHP), () =>
        !this.hasUltimateSerenity() && this._cachedBelow65 >= 2
      ),
      // Circle of Healing — instant AoE
      spell.cast(S.circleOfHealing, () => this.getHealTarget(urgentHP), () =>
        this._cachedBelow65 >= 2
      ),
      // Prayer of Mending — instant, bouncing
      spell.cast(S.prayerOfMending, () => this.getTankTarget(95) || this.getHealTarget(maintHP) || this.getAnyFriend(), () =>
        spell.getChargesFractional(S.prayerOfMending) > 1.2
      ),
      // Halo — Archon instant AoE
      spell.cast(S.halo, () => me, () =>
        this.isArchon() && spell.isSpellKnown(S.halo) && this._cachedBelow85 >= 2
      ),
    );
  }

  // =============================================
  // TIER 5: DPS ROTATION (nobody needs healing)
  // Method: Chastise → (Empyreal Blaze → 2x instant Holy Fire) → Holy Fire → Smite
  // =============================================
  dpsRotation() {
    return new bt.Decorator(
      () => this._cachedLowestHP >= Settings.FWHpDpsThreshold && me.inCombat(),
      new bt.Selector(
        // Holy Word: Chastise — triggers Empyreal Blaze (next 2 Holy Fires instant+no CD)
        spell.cast(S.holyWordChastise, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null
        ),

        // Empyreal Blaze active: spam Holy Fire (instant, no CD during buff)
        spell.cast(S.holyFire, () => this.getDpsTarget(), () => {
          if (!this.getDpsTarget()) return false;
          return me.hasAura(A.empyrealBlaze);
        }),

        // Holy Fire — keep on CD (normal cooldown)
        spell.cast(S.holyFire, () => this.getDpsTarget(), () => {
          if (!this.getDpsTarget()) return false;
          if (spell.getTimeSinceLastCast(S.holyFire) < 3000) return false;
          return true;
        }),

        // Halo — Archon DPS + healing
        spell.cast(S.halo, () => me, () =>
          this.isArchon() && spell.isSpellKnown(S.halo)
        ),

        // Shadow Word: Death — execute (< 20%)
        spell.cast(S.shadowWordDeath, () => this.getDpsTarget(), () => {
          const t = this.getDpsTarget();
          return t && t.effectiveHealthPercent <= 20;
        }),

        // Holy Nova — AoE DPS (4+ targets, or Lightburst talented)
        spell.cast(S.holyNova, () => me, () =>
          this.getEnemyCount() >= 4
        ),

        // Smite — filler
        spell.cast(S.smite, () => this.getDpsTarget(), () =>
          this.getDpsTarget() !== null
        ),
      )
    );
  }

  // =============================================
  // MOVEMENT DPS (instants)
  // =============================================
  movementDps() {
    return new bt.Selector(
      // Empyreal Blaze: instant Holy Fire spam during buff
      spell.cast(S.holyFire, () => this.getDpsTarget(), () =>
        this.getDpsTarget() !== null && me.hasAura(A.empyrealBlaze)
      ),
      spell.cast(S.holyWordChastise, () => this.getDpsTarget(), () =>
        this.getDpsTarget() !== null
      ),
      spell.cast(S.holyFire, () => this.getDpsTarget(), () =>
        this.getDpsTarget() !== null
      ),
      spell.cast(S.shadowWordDeath, () => this.getDpsTarget(), () => {
        const t = this.getDpsTarget();
        return t && t.effectiveHealthPercent <= 20;
      }),
      spell.cast(S.halo, () => me, () =>
        this.isArchon() && spell.isSpellKnown(S.halo) && this.getDpsTarget() !== null
      ),
    );
  }

  // =============================================
  // HEAL TARGET HELPERS (cached per tick)
  // =============================================
  _refreshHealCache() {
    if (this._healFrame === wow.frameTime) return;
    this._healFrame = wow.frameTime;

    let lowest = null, lowestHP = 100;
    let tankLowest = null, tankLowestHP = 100;
    let below20 = 0, below40 = 0, below65 = 0, below85 = 0;
    const validFriends = [];

    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const unit = friends[i];
      if (!unit || unit.deadOrGhost || me.distanceTo(unit) > 40) continue;
      validFriends.push(unit);
      const hp = unit.effectiveHealthPercent;
      if (hp < lowestHP) { lowestHP = hp; lowest = unit; }
      if (hp <= 20) below20++;
      if (hp <= 40) below40++;
      if (hp <= 65) below65++;
      if (hp <= 85) below85++;
    }

    // Include self if not already in list
    const selfInList = validFriends.some(u => u.guid && u.guid.equals && u.guid.equals(me.guid));
    if (!selfInList) {
      const selfHP = me.effectiveHealthPercent;
      if (selfHP < lowestHP) { lowestHP = selfHP; lowest = me; }
      if (selfHP <= 20) below20++;
      if (selfHP <= 40) below40++;
      if (selfHP <= 65) below65++;
      if (selfHP <= 85) below85++;
    }

    // Tanks
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
    this._cachedFriends = validFriends;
  }

  getHealTarget(maxHP) {
    this._refreshHealCache();
    return this._cachedLowestHP <= maxHP ? this._cachedLowest : null;
  }

  getTankTarget(maxHP) {
    this._refreshHealCache();
    return this._cachedTankLowestHP <= maxHP ? this._cachedTankLowest : null;
  }

  getTankBelow(maxHP) {
    return this.getTankTarget(maxHP);
  }

  getAnyFriend() {
    this._refreshHealCache();
    // Return a tank if available, otherwise any friend
    if (this._cachedTankLowest) return this._cachedTankLowest;
    return this._cachedFriends.length > 0 ? this._cachedFriends[0] : null;
  }

  // =============================================
  // DPS TARGET (cached per tick)
  // =============================================
  getDpsTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedDpsTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo2D(target) <= 40) {
      this._cachedDpsTarget = target;
      return target;
    }
    this._cachedDpsTarget = combat.bestTarget || (combat.targets.length > 0 ? combat.targets[0] : null);
    return this._cachedDpsTarget;
  }

  // =============================================
  // MANA MANAGEMENT
  // =============================================
  getManaPercent() {
    const max = me.maxPowerByType ? me.maxPowerByType(PowerType.Mana) : 1;
    return max > 0 ? (me.powerByType(PowerType.Mana) / max) * 100 : 100;
  }

  hasManaFor(spellType) {
    const mana = this.getManaPercent();
    if (mana < 15) return false;
    if (mana < 30 && spellType === 'prayerOfHealing') return false;
    if (mana < 20 && spellType === 'flashHeal') return false;
    return true;
  }

  // =============================================
  // PROC / BUFF HELPERS
  // =============================================
  getLightweaverStacks() {
    const aura = me.getAura(A.lightweaver);
    return aura ? aura.stacks : 0;
  }

  getLightweaverRemaining() {
    const aura = me.getAura(A.lightweaver);
    return aura ? aura.remaining : 0;
  }

  hasUltimateSerenity() {
    return spell.isSpellKnown(A.ultimateSerenity) || !spell.isSpellKnown(S.holyWordSanctify);
  }

  // =============================================
  // OOC BUFF: Power Word: Fortitude
  // =============================================
  getFortTarget() {
    if (spell.getTimeSinceLastCast(S.powerWordFortitude) < 60000) return null;
    if (!this._hasBuff(me, A.powerWordFortitude)) return me;
    const friends = heal.friends.All;
    for (let i = 0; i < friends.length; i++) {
      const u = friends[i];
      if (u && !u.deadOrGhost && me.distanceTo(u) <= 40 && !this._hasBuff(u, A.powerWordFortitude)) {
        return u;
      }
    }
    return null;
  }

  _hasBuff(unit, id) {
    if (!unit) return false;
    return unit.hasVisibleAura(id) || unit.hasAura(id) ||
      (unit.auras && unit.auras.find(a => a.spellId === id) !== undefined);
  }

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isArchon() {
    return spell.isSpellKnown(S.halo);
  }

  isOracle() {
    return !this.isArchon();
  }

  // =============================================
  // UTILITIES
  // =============================================
  getEnemyCount() {
    const t = this.getDpsTarget();
    return t ? t.getUnitsAroundCount(10) + 1 : 0;
  }
}
