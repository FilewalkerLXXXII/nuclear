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
 * Havoc Demon Hunter — Midnight 12.0.1 (CLEAN REWRITE)
 * Sources: SimC Midnight APL (line-by-line) + Method (all pages) + Wowhead + Class Discord
 *
 * Auto-detects: Aldrachi Reaver (Art of the Glaive 442290) vs Fel-Scarred (Demonic Intensity 452415)
 * SimC lists matched: default (~35 actions), meta (~17 actions), cooldown (~8 actions)
 *
 * Hero trees handled INLINE (as SimC does — no separate lists per tree)
 * Aldrachi Reaver: Reaver's Glaive cycle, rg_ds state, Glaive Flurry/Rending Strike empowerments
 * Fel-Scarred: Demonsurge tracking, Abyssal Gaze, Consuming Fire, DI buff management
 *
 * Key mechanics:
 *   Metamorphosis: CS→Annihilation, BD→Death Sweep, EB→Abyssal Gaze (FS), IA→Consuming Fire (FS)
 *   Demonic: Eye Beam → 5s demon form
 *   Inertia: VR → Felblade/Fel Rush → 18% damage 5s
 *   Initiative: VR → crit buff
 *   Essence Break: during Meta, Death Sweep + Annihilation deal bonus Chaos damage 4s
 *   Cycle of Hatred: -2.5s Eye Beam CD per stack
 *   Eternal Hunt: The Hunt empowers next Eye Beam (+100% dmg)
 *
 * All melee instant — no movement block needed (all abilities are instant cast)
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-04-04',
  guide: 'SimC APL (every line) + Method + Wowhead — clean rewrite',
};

// Cast spell IDs (verified in-game)
const S = {
  demonsBite:       162243,
  chaosStrike:      201427,   // Game ID is 162794 but framework can't resolve it — 201427 works for both CS and Annihilation
  annihilation:     201427,
  bladeDance:       188499,   // Becomes Death Sweep in Meta
  deathSweep:       210152,
  eyeBeam:          198013,   // User-confirmed (198030 is SimC internal, doesn't work in-game)
  metamorphosis:    191427,
  theHunt:          323639,
  essenceBreak:     258860,
  immolationAura:   258920,
  // felRush removed — displaces character, not safe for automation
  vengefulRetreat:  198793,
  felblade:         232893,   // User-confirmed (213241 not in spellbook)
  throwGlaive:      185123,
  reaversGlaive:    442294,   // Aldrachi Reaver exclusive
  abyssalGaze:      452497,   // Empowered Eye Beam (Fel-Scarred)
  consumingFire:    452487,   // Empowered Immolation Aura (Fel-Scarred)
  blur:             198589,
  disrupt:          183752,
  berserking:       26297,
};

// Talent IDs — for spell.isSpellKnown() checks
const T = {
  // Spec talents
  trailOfRuin:        206416,
  screamingBrutality: 1220506,
  burningBlades:      452408,
  soulscar:           388106,
  inertia:            427640,
  initiative:         388108,
  aFireInside:        427775,
  ragefire:           388107,
  chaoticTransform:   388112,
  demonic:            213410,
  cycleOfHatred:      258887,
  burningWound:       391189,
  eternalHunt:        1270898,
  blindFury:          203550,
  glaiveTempest:      342817,
  relentlessOnslaught: 390178,
  chaosTheory:        390195,
  furiousThrows:      393029,
  firstBlood:         391374,
  shatteredDestiny:   388116,
  collectiveAnguish:  390152,
  innerDemon:         390137,
  // Hero talent detection
  artOfTheGlaive:     442290,   // Aldrachi Reaver exclusive
  demonicIntensity:   452415,   // Fel-Scarred exclusive
};

// Aura IDs — for me.hasAura() / me.getAura() (buff/debuff aura, NOT talent passive)
const A = {
  metamorphosis:      162264,
  immolationAura:     258920,
  furiousGaze:        343312,   // Haste buff from Eye Beam
  innerDemon:         390145,   // Next Eye Beam triggers Inner Demon
  inertiaTrigger:     1215159,  // Ready to consume Inertia via Felblade/Fel Rush
  inertia:            427641,   // 18% damage buff (5s)
  initiative:         391215,   // Crit buff from Vengeful Retreat
  tacticalRetreat:    389890,   // Fury gen buff from VR
  essenceBreak:       320338,   // Debuff on target (4s bonus Chaos dmg from CS/BD)
  chaosTheory:        390195,   // Free CS proc from BD crit
  cycleOfHatred:      1214890,  // Active stacking buff (1214887 is passive talent = always 4 stacks)
  // Aldrachi Reaver
  artOfTheGlaive:     444661,   // Soul fragment tracking toward Reaver's Glaive
  glaiveFlurry:       442435,   // BD empowered by Reaver's Glaive
  rendingStrike:      442442,   // CS empowered by Reaver's Glaive
  reaversMark:        442624,   // Debuff on target (6% dmg per stack)
  reaversGlaive:      442302,   // Player buff: next TG → Reaver's Glaive
  thrillDamage:       442695,   // Thrill of the Fight: +30% next RG
  thrillHaste:        442688,   // Thrill of the Fight: 6% Haste 30s
  eternalHunt:        1271092,  // Empowered next Eye Beam buff
  // Fel-Scarred
  demonsurge:         452416,   // Demonsurge buff (tracks available empowerments)
  demonsurgeDI:       452489,   // Demonic Intensity buff
  empoweredEyeBeam:   1271144,  // Eye Beam empowered by The Hunt (Eternal Hunt)
  studentOfSuffering: 453239,   // Mastery buff from Eye Beam (Fel-Scarred)
  // Misc
  burningWound:       391191,   // DoT on target
  blur:               212800,   // DR buff
  outOfRange:         0,        // Not trackable — skip
};

export class HavocDemonHunterBehavior extends Behavior {
  name = 'FW Havoc Demon Hunter';
  context = BehaviorContext.Any;
  specialization = Specialization.DemonHunter.Havoc;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;  _cachedTarget = null;
  _furyFrame = 0;    _cachedFury = 0;
  _enemyFrame = 0;   _cachedEnemyCount = 0;
  _cohFrame = 0;     _cachedCoH = 0;

  // State tracking
  _metaEntryTime = 0;
  _lastDSCast = 0;
  _lastAnnCast = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWHavocAutoCDs', text: 'Auto Cooldowns (ignore burst keybind)', default: false },
        { type: 'slider', uid: 'FWHavocAoECount', text: 'AoE Target Count (Blade Dance)', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWHavocDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWHavocBlur', text: 'Use Blur', default: true },
        { type: 'slider', uid: 'FWHavocBlurHP', text: 'Blur HP %', default: 50, min: 15, max: 70 },
      ],
    },
  ];

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isAR() { return spell.isSpellKnown(T.artOfTheGlaive); }
  isFS() { return !this.isAR(); }

  // CS/Annihilation: use name-based casting to avoid "spell not found" during Meta transitions
  castCS(targetFn, conditionFn) {
    return new bt.Selector(
      new bt.Decorator(
        () => this.inMeta(),
        spell.cast("Annihilation", targetFn, conditionFn),
        new bt.Action(() => bt.Status.Failure)
      ),
      new bt.Decorator(
        () => !this.inMeta(),
        spell.cast("Chaos Strike", targetFn, conditionFn),
        new bt.Action(() => bt.Status.Failure)
      ),
    );
  }

  // =============================================
  // BUILD
  // =============================================
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

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

      // Meta entry/exit tracking + Demonsurge state
      new bt.Action(() => {
        if (this.inMeta()) {
          if (this._metaEntryTime === 0) this._metaEntryTime = wow.frameTime;
        } else {
          this._metaEntryTime = 0;
        }
        // Track last DS/Annihilation cast times for Demonsurge availability (only in Meta)
        if (this.inMeta()) {
          const dsSince = spell.getTimeSinceLastCast("Death Sweep");
          if (dsSince < 500 && dsSince > 0) this._lastDSCast = wow.frameTime;
          const annSince = spell.getTimeSinceLastCast("Annihilation");
          if (annSince < 500 && annSince > 0) this._lastAnnCast = wow.frameTime;
        }
        return bt.Status.Failure;
      }),

      // Version + debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Havoc] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isAR() ? 'Aldrachi Reaver' : 'Fel-Scarred'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWHavocDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Havoc] Fury:${Math.round(this.getFury())} Meta:${this.inMeta()} EB:${this.hasEB()} CoH:${this.getCoHStacks()} BD:${this.useBD()} Inertia:${me.hasAura(A.inertia)} Init:${me.hasAura(A.initiative)} DSurge:${this.dsAvail()}/${this.annAvail()} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // ===== INTERRUPT =====
          spell.interrupt(S.disrupt),

          // ===== DEFENSIVES =====
          spell.cast(S.blur, () => me, () =>
            Settings.FWHavocBlur && me.effectiveHealthPercent < Settings.FWHavocBlurHP
          ),

          // ===== TRINKETS: align with Eye Beam =====
          common.useTrinkets(() => this.getCurrentTarget(), () =>
            this.useCDs() && (!spell.isOnCooldown(S.eyeBeam) || this.targetTTD() < 15000)
          ),

          // ===== ALDRACHI REAVER: Glaive Cycle (ongoing) =====
          // CS/Annihilation when both Rending Strike + Glaive Flurry up (spend empowerments)
          // AoE: CS first → BD second for max Fury of the Aldrachi slashes
          // AR glaive empowerment: spend Rending Strike + Glaive Flurry
          this.castCS(() => this.getCurrentTarget(), () =>
            this.isAR() && me.hasAura(A.rendingStrike) && me.hasAura(A.glaiveFlurry) &&
            (this.getEnemyCount() > 1 || !this.inMeta())
          ),

          // Reaver's Glaive: cast when both empower buffs down + EB not active
          spell.cast(S.reaversGlaive, () => this.getCurrentTarget(), () => {
            if (!this.isAR()) return false;
            if (me.hasAura(A.glaiveFlurry) || me.hasAura(A.rendingStrike)) return false;
            if (this.hasEB()) return false;
            const metaAura = me.getAura(A.metamorphosis);
            return (metaAura && metaAura.remaining > 2000) ||
              (spell.getCooldown(S.eyeBeam)?.timeleft || 99999) < 10000 ||
              this.targetTTD() < 10000;
          }),

          // ===== VENGEFUL RETREAT: Cancel meta at end (Initiative) =====
          spell.cast(S.vengefulRetreat, () => me, () => {
            if (!spell.isSpellKnown(T.initiative)) return false;
            if (me.hasAura(A.innerDemon)) return false;
            if (!this.inMeta()) return false;
            const metaCD = spell.getCooldown(S.metamorphosis)?.timeleft || 99999;
            if (metaCD > 1500) return false; // Meta not ready to re-enter
            if (spell.isSpellKnown(T.chaoticTransform) &&
                (!spell.isOnCooldown(S.eyeBeam) || !spell.isOnCooldown(S.bladeDance))) return false;
            if (this.dsAvail() || this.annAvail()) return false;
            return true;
          }),

          // ===== IA: pre-meta Demonic Intensity consume =====
          spell.cast(S.immolationAura, () => me, () => {
            if (!this.hasEB()) return false;
            if (this.inMeta()) return false;
            if (!spell.isSpellKnown(T.demonicIntensity)) return false;
            const metaCD = spell.getCooldown(S.metamorphosis)?.timeleft || 99999;
            return metaCD < 5000 && spell.isSpellKnown(T.aFireInside) &&
              (spell.isSpellKnown(T.burningWound) || this.getEnemyCount() > 1);
          }),

          // ===== COOLDOWNS =====
          this.cooldowns(),

          // ===== IA: Ragefire AoE dump =====
          spell.cast(S.immolationAura, () => me, () =>
            this.getEnemyCount() > 2 && spell.isSpellKnown(T.ragefire) &&
            !this.hasEB() && (!this.inMeta() || this.metaRemains() > 5000)
          ),

          // ===== IA: A Fire Inside charge capping prevention =====
          spell.cast(S.immolationAura, () => me, () => {
            if (!spell.isSpellKnown(T.aFireInside)) return false;
            if (this.hasEB()) return false;
            const charges = spell.getChargesFractional(S.immolationAura);
            return (charges >= 1.8 || spell.getFullRechargeTime(S.immolationAura) < 3000) &&
              this.bdNotBlocking();
          }),

          // ===== IA: general usage =====
          spell.cast(S.immolationAura, () => me, () =>
            (this.getEnemyCount() > (1 - (spell.isSpellKnown(T.burningWound) ? 1 : 0) + (this.inMeta() ? 1 : 0))) &&
            this.bdNotBlocking()
          ),

          // ===== FELBLADE: consume Inertia trigger =====
          spell.cast(S.felblade, () => this.getCurrentTarget(), () => {
            if (!this.inertiaReady()) return false;
            return this.inertiaConsumerSoon() ||
              (this.metaRemains() > 5000 && this.getCoHStacks() < 4 &&
                (spell.getCooldown(S.eyeBeam)?.timeleft || 0) > 5000);
          }),

          // ===== VR: Inertia trigger generation =====
          spell.cast(S.vengefulRetreat, () => me, () => {
            if (!spell.isSpellKnown(T.inertia)) return false;
            if (me.hasAura(A.inertiaTrigger)) return false;
            const metaCD = spell.getCooldown(S.metamorphosis)?.timeleft || 99999;
            if (metaCD < 5000) return false;
            const ebCD = spell.getCooldown(S.eyeBeam)?.timeleft || 0;
            const bdCD = spell.getCooldown(S.bladeDance)?.timeleft || 0;
            return (ebCD <= 3000 || (bdCD <= 7000 &&
              (!spell.isSpellKnown(T.cycleOfHatred) || this.getCoHStacks() < 3) &&
              (ebCD >= 15000 - this.getCoHStacks() * 2500 || this.metaRemains() >= 5000))) &&
              this.targetTTD() > 5000;
          }),

          // ===== VR: Initiative (non-Inertia) =====
          spell.cast(S.vengefulRetreat, () => me, () => {
            if (!spell.isSpellKnown(T.initiative) || spell.isSpellKnown(T.inertia)) return false;
            if (me.hasAura(A.initiative)) return false;
            const ebCD = spell.getCooldown(S.eyeBeam)?.timeleft || 0;
            const bdCD = spell.getCooldown(S.bladeDance)?.timeleft || 0;
            return ebCD <= 1500 || (bdCD <= 3000 &&
              (ebCD >= 15000 - this.getCoHStacks() * 2500 || this.metaRemains() >= 5000) &&
              (!spell.isSpellKnown(T.cycleOfHatred) || this.getCoHStacks() < 4));
          }),

          // ===== DISPATCH: Meta rotation when Metamorphosis active =====
          new bt.Decorator(
            () => this.inMeta(),
            this.metaRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // ===== IA: end-of-fight Ragefire =====
          spell.cast(S.immolationAura, () => me, () =>
            this.targetTTD() < 15000 && spell.isSpellKnown(T.ragefire) &&
            (this.useBD() ? spell.isOnCooldown(S.bladeDance) : true)
          ),

          // ===== EYE BEAM: outside Meta =====
          spell.cast(S.eyeBeam, () => this.getCurrentTarget(), () => {
            if (me.hasAura(A.innerDemon)) return false;
            const bdCD = spell.getCooldown(S.bladeDance)?.timeleft || 0;
            if (this.useBD() && bdCD > 7000 && this.getEnemyCount() < 5) return false;
            if (!this.ebAligned() && this.getEnemyCount() < 5) return false;
            if (spell.isSpellKnown(T.eternalHunt)) {
              const huntCD = spell.getCooldown(S.theHunt)?.timeleft || 99999;
              if (huntCD <= 5000 && !this.isFS()) return false;
            }
            return this.targetTTD() > 5000 || this.targetTTD() < 10000;
          }),

          // ===== BLADE DANCE: outside Meta =====
          spell.cast(S.bladeDance, () => this.getCurrentTarget(), () => {
            if (!this.useBD()) return false;
            if (spell.isSpellKnown(T.demonic) && !spell.isOnCooldown(S.eyeBeam) &&
                this.getEnemyCount() < 5 && !this.hasEB()) return false;
            if (this.poolGT() && this.getFury() < 60) return false;
            return true;
          }),

          // ===== CHAOS STRIKE: Essence Break window =====
          this.castCS(() => this.getCurrentTarget(), () => this.hasEB()),

          // ===== FELBLADE: fury generation =====
          spell.cast(S.felblade, () => this.getCurrentTarget(), () => {
            if (me.hasAura(A.inertiaTrigger)) return false;
            if (this.furyDeficit() < 15 + this.furyGen() * 0.5) return false;
            const bdCD = spell.getCooldown(S.bladeDance)?.timeleft || 0;
            return bdCD >= 500 || !this.useBD() || this.getFury() < 40 ||
              (spell.getCooldown(S.eyeBeam)?.timeleft || 99999) < 3000;
          }),

          // ===== IA: fury deficit filler =====
          spell.cast(S.immolationAura, () => me, () =>
            this.furyDeficit() > 20 + this.furyGen() * 1.5
          ),

          // ===== THROW GLAIVE: Soulscar =====
          spell.cast(S.throwGlaive, () => this.getCurrentTarget(), () => {
            if (!spell.isSpellKnown(T.soulscar)) return false;
            if (this.hasEB()) return false;
            if (spell.isSpellKnown(T.furiousThrows) && !this.bdNotBlocking()) return false;
            if (spell.isSpellKnown(T.screamingBrutality) &&
                spell.getCharges(S.throwGlaive) < 2 &&
                spell.getFullRechargeTime(S.throwGlaive) >= (spell.getCooldown(S.bladeDance)?.timeleft || 0)) return false;
            return true;
          }),

          // ===== CHAOS STRIKE: main spender =====
          this.castCS(() => this.getCurrentTarget(), () => {
            const furyThreshold = 75 - this.furyGen() * 1.5 -
              (this.csMachine() ? 20 : 0) + (this.poolGT() ? 25 : 0);
            // Don't pool for EB — idle GCDs are worse than slightly suboptimal fury
            return this.bdNotBlocking() || this.getFury() >= furyThreshold;
          }),

          // ===== IA: low priority filler =====
          spell.cast(S.immolationAura, () => me, () => this.getEnemyCount() > 2),

          // ===== FELBLADE: emergency fury =====
          spell.cast(S.felblade, () => this.getCurrentTarget(), () =>
            !me.hasAura(A.inertiaTrigger) && this.getFury() < 40
          ),

          // ===== THROW GLAIVE: non-Furious filler =====
          spell.cast(S.throwGlaive, () => this.getCurrentTarget(), () =>
            !this.hasEB() && this.useFiller() && !spell.isSpellKnown(T.furiousThrows)
          ),

          // ===== ABSOLUTE FILLER: CS if any fury, else wait (Demon Blades = passive fury gen) =====
          this.castCS(() => this.getCurrentTarget(), () => this.getFury() >= 40),
        )
      ),
    );
  }

  // =============================================
  // META ROTATION (SimC actions.meta — runs when Meta active)
  // =============================================
  metaRotation() {
    return new bt.Selector(
      // Guard: bail if Meta dropped mid-tick (race condition with Decorator)
      new bt.Action(() => !this.inMeta() ? bt.Status.Success : bt.Status.Failure),

      // 1. Death Sweep: meta expiring | pool GT + EB coming | Blind Fury dump | EB window
      spell.cast("Death Sweep", () => this.getCurrentTarget(), () => {
        if (this.metaRemains() < 1500 &&
            (!this.isFS() || (me.hasAura(A.demonsurgeDI) && spell.isOnCooldown(S.eyeBeam)))) return true;
        if (this.poolGT() && this.getFury() >= 60 && !spell.isOnCooldown(S.eyeBeam) &&
            (spell.getCooldown(S.metamorphosis)?.timeleft || 0) >= 5000) return true;
        if (spell.isSpellKnown(T.blindFury) && !spell.isOnCooldown(S.eyeBeam) &&
            this.getFury() > 90 - this.furyGen() * 3) return true;
        if (this.hasEB()) return true;
        return false;
      }),

      // 2. Annihilation: meta expiring | EB window
      spell.cast("Annihilation", () => this.getCurrentTarget(), () => {
        if (this.metaRemains() < 1500 &&
            (!this.isFS() || (me.hasAura(A.demonsurgeDI) && spell.isOnCooldown(S.eyeBeam)))) return true;
        if (this.hasEB()) return true;
        return false;
      }),

      // 3. Essence Break: fury>=35, BD aligned, inertia safe, EB>5s, Meta>5s
      spell.cast(S.essenceBreak, () => this.getCurrentTarget(), () => {
        if (this.getFury() < 35) return false;
        const bdCD = spell.getCooldown(S.bladeDance)?.timeleft || 0;
        if (bdCD > 3000 && this.getEnemyCount() >= 3) return false;
        if (me.hasAura(A.inertiaTrigger) &&
            !(me.hasAura(A.inertia) && (me.getAura(A.inertia)?.remaining || 0) >= 4500) &&
            spell.isSpellKnown(T.inertia)) return false;
        if ((spell.getCooldown(S.eyeBeam)?.timeleft || 0) <= 5000) return false;
        if ((spell.getCooldown(S.metamorphosis)?.timeleft || 0) <= 5000) return false;
        if (this.metaRemains() <= 5000) return false;
        return true;
      }),

      // 4. Death Sweep: Demonsurge available (Fel-Scarred) + Inertia
      spell.cast("Death Sweep", () => this.getCurrentTarget(), () =>
        this.dsAvail() && (me.hasAura(A.inertia) || !spell.isSpellKnown(T.inertia))
      ),

      // 5. Annihilation: Demonsurge available + BD on CD + Inertia
      spell.cast("Annihilation", () => this.getCurrentTarget(), () =>
        this.annAvail() && spell.isOnCooldown(S.bladeDance) &&
        (me.hasAura(A.inertia) || !spell.isSpellKnown(T.inertia))
      ),

      // 6. IA: extend Demonsurge before it expires
      spell.cast(S.immolationAura, () => me, () => {
        if (!this.isFS()) return false;
        const ds = me.getAura(A.demonsurge);
        return ds && ds.remaining > 0 && ds.remaining < 1500;
      }),

      // 7. VR: Inertia trigger in meta
      spell.cast(S.vengefulRetreat, () => me, () => {
        if (!spell.isSpellKnown(T.inertia)) return false;
        if (me.hasAura(A.inertiaTrigger)) return false;
        const metaCD = spell.getCooldown(S.metamorphosis)?.timeleft || 99999;
        if (metaCD === 0) return false;
        const ebCD = spell.getCooldown(S.eyeBeam)?.timeleft || 0;
        const coh = this.getCoHStacks();
        return ebCD > 5000 || ebCD <= 3000 || !spell.isOnCooldown(S.eyeBeam);
      }),

      // 8. Eye Beam: in meta (avoid EB window, inner demon, demonsurge pending)
      spell.cast(S.eyeBeam, () => this.getCurrentTarget(), () => {
        if (this.hasEB()) return false;
        if (me.hasAura(A.innerDemon)) return false;
        if (this.dsAvail() || this.annAvail()) return false;
        if (!this.ebAligned()) return false;
        if (spell.isSpellKnown(T.eternalHunt)) {
          const huntCD = spell.getCooldown(S.theHunt)?.timeleft || 99999;
          if (huntCD <= 5000 && !this.isFS()) return false;
        }
        return true;
      }),

      // 9. Death Sweep: standard BD rotation
      spell.cast("Death Sweep", () => this.getCurrentTarget(), () => {
        if (!this.useBD()) return false;
        if (me.hasAura(A.chaosTheory)) return false;
        if (this.poolGT() && this.getFury() < 60 && this.metaRemains() > 5000) return false;
        return true;
      }),

      // 10. Annihilation: Chaos Theory proc + BD available
      spell.cast("Annihilation", () => this.getCurrentTarget(), () =>
        me.hasAura(A.chaosTheory) && !spell.isOnCooldown(S.bladeDance) &&
        this.metaRemains() >= 1500
      ),

      // 11. Throw Glaive: Soulscar filler in meta
      spell.cast(S.throwGlaive, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.soulscar)) return false;
        if (this.hasEB()) return false;
        if (spell.isSpellKnown(T.furiousThrows)) {
          return this.bdNotBlocking() &&
            (this.furyDeficit() < this.furyGen() * 1.5 || this.getEnemyCount() > 2);
        }
        return this.useFiller();
      }),

      // 12. Annihilation: main fury spender in meta
      spell.cast("Annihilation", () => this.getCurrentTarget(), () => {
        const furyThreshold = 75 - this.furyGen() * 1.5 -
          (!this.useBD() ? 15 : 0) - (this.csMachine() ? 20 : 0) + (this.poolGT() ? 25 : 0);
        const lowMeta = this.metaRemains() < 5000;
        return (this.getFury() >= furyThreshold || lowMeta) &&
          (spell.isOnCooldown(S.bladeDance) || !this.useBD() || lowMeta);
      }),

      // 13. Felblade: fury gen in meta (not near meta end)
      spell.cast(S.felblade, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.inertiaTrigger) && this.furyDeficit() > 15 + this.furyGen() * 0.5 &&
        this.metaRemains() > 5000 &&
        (!spell.isSpellKnown(T.inertia) || (spell.getCooldown(S.vengefulRetreat)?.timeleft || 0) > 4000)
      ),

      // 14. IA: in meta
      spell.cast(S.immolationAura, () => me),

      // 15. Felblade: emergency
      spell.cast(S.felblade, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.inertiaTrigger) && this.getFury() < 35
      ),

      // 16. Throw Glaive: filler in meta (non-Furious)
      spell.cast(S.throwGlaive, () => this.getCurrentTarget(), () =>
        !this.hasEB() && this.useFiller() && !spell.isSpellKnown(T.furiousThrows) &&
        (this.metaRemains() > 5000 || this.getEnemyCount() > 3)
      ),

      // 18. Filler: Annihilation if any fury (Demon Blades = passive fury gen, no Demon's Bite)
      spell.cast("Annihilation", () => this.getCurrentTarget(), () => this.getFury() >= 40),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cooldown)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // Metamorphosis: complex gating
      spell.cast(S.metamorphosis, () => me, () => {
        if (!this.useCDs()) return false;
        if (me.hasAura(A.innerDemon)) return false;
        if (this.dsAvail() || this.annAvail()) return false;
        // BD must be on CD (avoid losing CT reset value)
        if (spell.isSpellKnown(T.chaoticTransform)) {
          const bdCD = spell.getCooldown(S.bladeDance)?.timeleft || 0;
          if (bdCD < 3000 && !spell.isOnCooldown(S.bladeDance)) return false;
        }
        const ebCD = spell.getCooldown(S.eyeBeam)?.timeleft || 0;
        // FS: prefer when Empowered Eye Beam is up
        if (this.isFS() && me.hasAura(A.empoweredEyeBeam)) return true;
        // General: EB aligned or fight ending
        return ebCD >= 10000 - (spell.isSpellKnown(T.collectiveAnguish) ? 4 : 0) * 1000 ||
          (spell.isSpellKnown(T.cycleOfHatred) && ebCD >= 13000) ||
          this.targetTTD() < 30000;
      }),

      // The Hunt
      spell.cast(S.theHunt, () => this.getCurrentTarget(), () => {
        if (!this.useCDs()) return false;
        if (this.hasEB()) return false;
        if (me.hasAura(A.reaversGlaive) && this.isAR()) return false; // Don't waste existing RG
        if (spell.isSpellKnown(T.initiative) && me.hasAura(A.inertiaTrigger) &&
            !me.hasAura(A.initiative)) return false;
        // Eternal Hunt: wait for Eye Beam to be ready within 12s
        if (spell.isSpellKnown(T.eternalHunt) && !this.isFS()) {
          const ebCD = spell.getCooldown(S.eyeBeam)?.timeleft || 0;
          if (ebCD > 10000 && (spell.getCooldown(S.metamorphosis)?.timeleft || 99999) > 5000) return false;
        }
        return this.targetTTD() > 10000 || this.targetTTD() < 30000;
      }),

      // Berserking: align with Meta or fight ending
      spell.cast(S.berserking, () => me, () =>
        this.useCDs() && (this.inMeta() || this.targetTTD() < 15000)
      ),
    );
  }

  // =============================================
  // SIMC VARIABLE HELPERS
  // =============================================
  inMeta() { return me.hasAura(A.metamorphosis); }
  metaRemains() { const a = me.getAura(A.metamorphosis); return a ? a.remaining : 0; }
  hasEB() { const t = this.getCurrentTarget(); return t && t.hasAuraByMe(A.essenceBreak); }
  useCDs() { return combat.burstToggle || Settings.FWHavocAutoCDs; }

  // use_blade_dance: 3+ targets (2+ with Trail of Ruin), always with First Blood or SB+synergies
  useBD() {
    const e = this.getEnemyCount();
    return e >= 3 - (spell.isSpellKnown(T.trailOfRuin) ? 1 : 0) ||
      spell.isSpellKnown(T.firstBlood) ||
      (spell.isSpellKnown(T.screamingBrutality) &&
        (spell.isSpellKnown(T.burningBlades) || spell.isSpellKnown(T.soulscar)));
  }

  poolGT() { return spell.isSpellKnown(T.glaiveTempest) && this.getEnemyCount() >= 3; }

  bdNotBlocking() {
    return (spell.getCooldown(S.bladeDance)?.timeleft || 0) >= 1500 || !this.useBD();
  }

  csMachine() {
    return spell.isSpellKnown(T.relentlessOnslaught) && spell.isSpellKnown(T.chaosTheory);
  }

  useFiller() {
    return spell.isOnCooldown(S.felblade) && spell.isOnCooldown(S.immolationAura) &&
      spell.isOnCooldown(S.eyeBeam) && this.bdNotBlocking() &&
      (this.furyDeficit() > this.furyGen() * 1.5);
  }

  // Inertia helpers
  inertiaReady() {
    if (!spell.isSpellKnown(T.inertia)) return false;
    if (!me.hasAura(A.inertiaTrigger)) return false;
    if (this.hasEB()) return false;
    const inertia = me.getAura(A.inertia);
    return !inertia || inertia.remaining < 1500 || this.inertiaConsumerSoon();
  }

  inertiaConsumerSoon() {
    if (!spell.isSpellKnown(T.inertia)) return false;
    const huntCD = spell.getCooldown(S.theHunt)?.timeleft || 99999;
    const ebCD = spell.getCooldown(S.eyeBeam)?.timeleft || 99999;
    const vrCD = spell.getCooldown(S.vengefulRetreat)?.timeleft || 99999;
    const trigger = me.getAura(A.inertiaTrigger);
    return huntCD <= 3500 ||
      (ebCD <= 500 && !this.dsAvail() && !this.annAvail()) ||
      vrCD <= 1000 ||
      (trigger && trigger.remaining < 1500);
  }

  inertiaConsumerSoonRush() {
    if (!spell.isSpellKnown(T.inertia)) return false;
    const huntCD = spell.getCooldown(S.theHunt)?.timeleft || 99999;
    const ebCD = spell.getCooldown(S.eyeBeam)?.timeleft || 99999;
    const vrCD = spell.getCooldown(S.vengefulRetreat)?.timeleft || 99999;
    const trigger = me.getAura(A.inertiaTrigger);
    return huntCD <= 2000 ||
      (ebCD <= 500 && !this.dsAvail() && !this.annAvail()) ||
      vrCD <= 1500 ||
      (trigger && trigger.remaining < 1500);
  }

  // eb_aligned: safe to cast Eye Beam without missing VR/Inertia window
  ebAligned() {
    const vrCD = spell.getCooldown(S.vengefulRetreat)?.timeleft || 0;
    if (!spell.isSpellKnown(T.inertia)) {
      return (!spell.isSpellKnown(T.initiative) || vrCD >= 3000 ||
        me.hasAura(A.initiative) || this.inMeta());
    }
    const metaCD = spell.getCooldown(S.metamorphosis)?.timeleft || 99999;
    return me.hasAura(A.inertia) || (vrCD >= 3000 &&
      ((spell.getCooldown(S.theHunt)?.timeleft || 99999) >= 3000 || !spell.isSpellKnown(T.eternalHunt)) &&
      !me.hasAura(A.inertiaTrigger)) || metaCD <= 5000;
  }

  // Demonsurge availability (Fel-Scarred: first DS/Ann since meta entry)
  dsAvail() {
    if (!this.isFS() || !this.inMeta()) return false;
    return this._metaEntryTime > this._lastDSCast;
  }
  annAvail() {
    if (!this.isFS() || !this.inMeta()) return false;
    return this._metaEntryTime > this._lastAnnCast;
  }

  // Fury generation per second estimate
  furyGen() {
    let gen = 5.9; // Base melee Demon Blades (~9.5 per 2.6s swing / haste)
    if (this.isFS() && this.inMeta()) gen += 3; // Demonsurge bonus
    const ia = me.getAura(A.immolationAura);
    if (ia) gen += (ia.stacks || 1) * 4;
    if (me.hasAura(A.tacticalRetreat)) gen += 8;
    if (me.hasAura(A.studentOfSuffering)) gen += 2.5;
    return gen;
  }

  // =============================================
  // RESOURCE (cached per tick)
  // =============================================
  getFury() {
    if (this._furyFrame === wow.frameTime) return this._cachedFury;
    this._furyFrame = wow.frameTime;
    this._cachedFury = me.powerByType(PowerType.Fury);
    return this._cachedFury;
  }
  furyDeficit() { return 120 - this.getFury(); }

  getCoHStacks() {
    if (this._cohFrame === wow.frameTime) return this._cachedCoH;
    this._cohFrame = wow.frameTime;
    const a = me.getAura(A.cycleOfHatred);
    this._cachedCoH = a ? (a.stacks || 0) : 0;
    return this._cachedCoH;
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 8 && me.isFacing(target)) {
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
