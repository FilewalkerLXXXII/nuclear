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
 * Devourer Demon Hunter Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (demonhunter_devourer.simc) + Method + Wowhead + Maxroll
 *
 * NEW SPEC: Ranged Intellect DPS (25yd), dual resource (Fury + Soul Fragments)
 * Auto-detects: Annihilator (Voidfall meteors) vs Void-Scarred (Voidsurge bursts)
 *
 * SimC action lists matched:
 *   math_for_wizards (1): should_use_star variable
 *   main rotation (19 lines): inline Meta/non-Meta with sub-list calls
 *   reaps (3): eradicate → cull → reap
 *   melee_combo (7): vengeful_retreat, hungering_slash, pierce_the_veil, etc.
 *
 * No CD on Meta — gated by 50 Soul Fragments (35 w/ Soul Glutton)
 * Meta lasts until Fury reaches 0 — Void Ray pauses drain
 * Cast-time spells: Consume/Devour (2s, castable moving), Void Ray (3s channel, roots), CS (3s cast)
 *
 * Hotfixes March 17: All Devourer damage -4%, Blind Focus fix, Mass Acceleration fix
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL + Method + Wowhead + Maxroll',
};

const S = {
  // Core — shared build/spend
  consume:            473662,   // Filler, 2s cast (castable moving), 8 Fury + fragments
  devour:             1217610,  // Upgraded Consume in Meta
  reap:               1226019,  // 2 charges, 8s CD, collects 4 souls
  cull:               1245453,  // Upgraded Reap in Meta, +30% dmg
  voidRay:            473728,   // Channel 3s, costs 100 Fury (free in Meta)
  voidMeta:           1217605,  // Void Metamorphosis cast
  collapsingStar:     1221150,  // 3s cast, requires 30 frags in Meta
  eradicate:          1225826,  // Cast after VR (SimC uses 1225826)
  // Melee combo
  voidblade:          1245412,  // Charge, 30s CD (SimC: 1245414 — verify)
  hungeringSlash:     1239519,  // Post-Voidblade AoE (SimC: 1239123 — verify)
  theHunt:            1246167,  // 1.5min CD, charge
  soulImmolation:     1241937,  // 1min CD, 30 Fury + 3 frags over 5s
  vengefulRetreat:    198793,
  // Void-Scarred Meta upgrades
  pierceTheVeil:      1245483,  // Upgraded Voidblade in Meta
  reapersToll:        1245470,  // Upgraded Hungering Slash in Meta
  predatorsWake:      1259431,  // Upgraded The Hunt in Meta
  // Defensives
  blur:               198589,
  darkness:           196718,
  // Interrupt
  disrupt:            183752,
  // Racials
  berserking:         26297,
};

// Talent IDs
const T = {
  eradicate:          1225826,
  devourersBite:      1241530,  // Voidblade/Hunt applies +12% debuff
  voidsurge:          1246161,  // Void-Scarred hero mechanic
  voidfall:           1256296,  // Annihilator hero mechanic
  voidrush:           1223155,  // CDR via Voidstep
  dutyEternal:        1232305,  // ST melee modifier
  hungeringSlash:     1239121,  // Talent ID enabling the ability
  collapsingStar:     1221167,  // Talent enabling CS (1221148 was wrong, dump shows 1221167)
  starFragments:      1232296,  // Frag gen from CS
  emptiness:          1242500,  // Haste ramping in Meta
  momentOfCraving:    1238493,  // Talent: Moment of Craving
  apex:               1256308,  // Apex talent (Dark Matter = rank 1 indicator)
};

const A = {
  voidMeta:           1217607,  // Active Meta buff
  voidMetaStacks:     1225789,  // Fragment counter toward Meta
  collapsingStarStack: 1227702, // Frags collected during current Meta
  momentOfCraving:    1238495,  // After full VR: resets Reap, +6 frags (SimC ID)
  momentOfCravingAlt: 1238488,  // FW original — verify which works
  devourersBite:      1241532,  // +12% dmg taken debuff on target
  eradicate:          1239524,  // Next Reap = frontal AoE (buff)
  darkMatter:         1256308,  // CS always crits (Annihilator)
  voidfallBuilding:   1256301,  // 35% proc from Consume, 3 stacks (SimC ID)
  voidfallSpending:   1256302,  // Active spending stacks (confirmed from dump, Stacks:3)
  voidstep:           1223157,  // Free VR after Hungering Slash
  hungeringSlashBuff: 1239525,  // HS active buff
  // Voidsurge per-ability tracking (Void-Scarred)
  voidsurgePtV:       1246163,  // Voidsurge: Pierce the Veil (verify in-game)
  voidsurgeRT:        1246165,  // Voidsurge: Reaper's Toll (verify in-game)
  soulFragments:      1245577,  // Soul Fragment counter (collected, stacks toward Meta)
  soulFragsGround:    1245584,  // Soul Fragments on ground (pending pickup, has remaining time)
  soulImmolationDot:  1266696,  // Soul Immolation active debuff
  // Defensives
  blur:               212800,
};

export class DevourerDemonhunterBehavior extends Behavior {
  name = 'FW Devourer Demon Hunter';
  context = BehaviorContext.Any;
  specialization = Specialization.DemonHunter.Devourer;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _furyFrame = 0;
  _cachedFury = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;

  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWDevUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWDevAoECount', text: 'AoE Target Count', default: 2, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWDevDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWDevBlur', text: 'Use Blur', default: true },
        { type: 'slider', uid: 'FWDevBlurHP', text: 'Blur HP %', default: 50, min: 15, max: 80 },
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

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Auto-target (25yd range)
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),

      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      // Cancel Void Ray and Collapsing Star when moving (likely dodging mechanics)
      // Keep Consume/Devour casting (castable while moving)
      new bt.Action(() => {
        if (me.isMoving() && me.isCastingOrChanneling) {
          const cast = me.currentCastOrChannel;
          if (cast && (cast.spellId === S.voidRay || cast.spellId === 1221150)) {
            me.stopCasting();
            return bt.Status.Failure;
          }
        }
        return bt.Status.Failure;
      }),
      common.waitForCastOrChannel(),

      // Version + Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Devourer] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isAnnihilator() ? 'Annihilator' : 'Void-Scarred'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWDevDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Devourer] Fury:${Math.round(this.getFury())} Meta:${this.inMeta()} CSstack:${this.getCSStacks()} MetaStacks:${this.metaStacksMax()} MoC:${this.hasMoC()} Erad:${this.hasEradicate()} VF:${this.getVFStacks()} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.disrupt),
          this.defensives(),

          // Movement: Devour/Consume primary (castable while moving), NO Void Ray (roots you)
          new bt.Decorator(
            () => me.isMoving(),
            new bt.Selector(
              // Devour/Consume first — castable while moving, keeps DPS going
              new bt.Decorator(
                () => this.inMeta(),
                spell.cast(S.devour, () => this.getCurrentTarget()),
                new bt.Action(() => bt.Status.Failure)
              ),
              spell.cast(S.consume, () => this.getCurrentTarget()),
              // Instants: reaps, melee combo, soul immolation
              this.reaps(),
              this.meleeCombo(),
              spell.cast("Soul Immolation", () => me, () => !this.inMeta()),
              new bt.Action(() => bt.Status.Success)
            ),
            new bt.Action(() => bt.Status.Failure)
          ),

          // Trinkets: align with Meta
          common.useTrinkets(() => this.getCurrentTarget(), () =>
            Settings.FWDevUseCDs && (this.inMeta() || this.targetTTD() < 15000)
          ),

          // Berserking during Meta
          spell.cast(S.berserking, () => me, () => this.inMeta()),

          // SimC main rotation (19 lines)
          this.mainRotation(),
        )
      ),
    );
  }

  // =============================================
  // MAIN ROTATION (SimC actions, 19 lines)
  // =============================================
  mainRotation() {
    // Annihilator vs Void-Scarred have fundamentally different priorities
    if (this.isAnnihilator()) return this.annihilatorRotation();
    return this.voidScarredRotation();
  }

  // =============================================
  // ANNIHILATOR ST/AoE — Method + Wowhead + SimC
  // Focus: Voidfall at 3 stacks, maximize Collapsing Stars in Meta
  // =============================================
  annihilatorRotation() {
    return new bt.Selector(
      // === INSIDE VOID METAMORPHOSIS ===
      new bt.Decorator(
        () => this.inMeta(),
        new bt.Selector(
          // 0. Soul Smuggling: collect ground fragments immediately after Meta entry
          new bt.Decorator(
            () => this.getGroundFragments() >= 3 && spell.getTimeSinceLastCast(S.voidMeta) < 3000,
            this.reaps(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // 1. Void Ray: #1 priority in Meta (pauses Fury drain, generates Voidfall, resets Reap)
          spell.cast(S.voidRay, () => this.getCurrentTarget()),

          // 2. Voidblade: apply Devourer's Bite 12% debuff early in Meta for CS/Cull amp
          this.castMelee("Voidblade", () => this.getCurrentTarget(), { skipRangeCheck: true }),

          // 3. Collapsing Star: cast ASAP — aim for 5 per Meta window
          spell.cast(1221150, () => this.getCurrentTarget()),

          // 4. Cull: ONLY at 3 Voidfall stacks (triggers Void Meteors)
          new bt.Decorator(
            () => this.getVFStacks() >= 3,
            spell.cast("Cull", () => this.getCurrentTarget()),
            new bt.Action(() => bt.Status.Failure)
          ),

          // 5. Devour: filler — skip only if VR ready within ~1 GCD (Devour cast time ~1s with haste)
          spell.cast(S.devour, () => this.getCurrentTarget(), () =>
            (spell.getCooldown(S.voidRay)?.timeleft || 0) > 500
          ),
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // === OUTSIDE VOID METAMORPHOSIS ===

      // 1. Voidblade: right before entering Meta (Devourer's Bite buff for Meta burst)
      this.castMelee("Voidblade", () => this.getCurrentTarget(), () =>
        this.metaStacksMax()
      , { skipRangeCheck: true }),

      // 2. Void Ray: on CD (builds Fury, generates Voidfall, resets Reap)
      spell.cast(S.voidRay, () => this.getCurrentTarget()),

      // 3. Metamorphosis: enter when ready (Annihilator auto-procs Voidfall + resets Reap)
      spell.cast(S.voidMeta, () => me),

      // 4. Reap: ONLY at 3 Voidfall stacks — SKIP if Soul Smuggling (save frags for Meta)
      new bt.Decorator(
        () => this.getVFStacks() >= 3 && !this.shouldSmuggle(),
        this.reaps(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 5. Soul Immolation (outside Meta only — never inside Meta)
      spell.cast("Soul Immolation", () => me, () =>
        !me.hasAura(A.soulImmolationDot)
      ),

      // 6. Melee combo (VR on Voidstep, Hungering Slash AoE, etc.)
      this.meleeCombo(),

      // 7. Consume: primary filler
      spell.cast(S.consume, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // VOID-SCARRED ST/AoE — SimC APL (original rotation)
  // =============================================
  voidScarredRotation() {
    return new bt.Selector(
      // 1. AoE Eradicate opener: Void Ray before Meta on 2+ enemies (Voidsurge only)
      spell.cast(S.voidRay, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.eradicate) && this.hasVoidsurgeTalent() &&
        this.getEnemyCount() > 1 && !this.hasEradicate()
      ),

      // 2. Voidblade/Hunt at max stacks (Devourer's Bite + Voidsurge)
      this.castMelee("Voidblade", () => this.getCurrentTarget(), () =>
        this.metaStacksMax() && this.hasDevourersBiteTalent() && this.hasVoidsurgeTalent()
      ),
      this.castMelee("The Hunt", () => this.getCurrentTarget(), () =>
        this.metaStacksMax() && this.hasDevourersBiteTalent() && this.hasVoidsurgeTalent()
      ),

      // 3. Metamorphosis: Eradicate up | no Eradicate talent | ST
      spell.cast(S.voidMeta, () => me, () =>
        this.hasEradicate() || !spell.isSpellKnown(T.eradicate) || this.getEnemyCount() === 1
      ),

      // 4. Reaps: Moment of Craving + Meta + VR coming + won't overcap CS
      new bt.Decorator(
        () => spell.isSpellKnown(T.momentOfCraving) && this.inMeta() &&
          (spell.getCooldown(S.voidRay)?.timeleft || 99999) <= 1500 && this.wontOvercapCStar(),
        this.reaps(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 5. Void Ray: don't waste Eradicate on AoE
      spell.cast(S.voidRay, () => this.getCurrentTarget(), () =>
        !this.hasEradicate() || this.getEnemyCount() === 1
      ),

      // 6. Pierce the Veil: MoC + should_use_star + CS stacks >= 30 + Devourer's Bite
      new bt.Decorator(
        () => this.inMeta(),
        this.castMelee("Pierce the Veil", () => this.getCurrentTarget(), () =>
          this.hasMoC() && this.shouldUseStar() && this.getCSStacks() >= 30 &&
          this.hasDevourersBiteTalent()
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 7. Collapsing Star
      new bt.Decorator(
        () => this.inMeta(),
        spell.cast(1221150, () => this.getCurrentTarget(), () => this.shouldUseStar()),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 8. Reaps: Eradicate AoE
      new bt.Decorator(
        () => this.hasEradicate() && this.getEnemyCount() > 1,
        this.reaps(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 9. Melee combo
      this.meleeCombo(),

      // 10. Annihilator Reap: Voidfall spending stacks >= 3
      new bt.Decorator(
        () => {
          const vf = me.getAura(A.voidfallSpending);
          return vf && vf.stacks >= 3;
        },
        this.reaps(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 11. Star Accelerator: reap during Meta to feed CS stacks
      new bt.Decorator(
        () => this.inMeta() && this.shouldUseStar() &&
          (this.getCSStacks() + 4) >= 30 && this.wontOvercapCStar(),
        this.reaps(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 12. Beam Accelerator: ST Voidsurge reap for Void Ray
      new bt.Decorator(
        () => this.hasVoidsurgeTalent() && this.getEnemyCount() === 1 &&
          !this.inMeta() && this.rayAfterReap(),
        this.reaps(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 13. Fallback reap: Meta/MoC/enough souls
      new bt.Decorator(
        () => (this.inMeta() && (this.getEnemyCount() === 1 || this.hasEradicate() || !spell.isSpellKnown(T.eradicate)) ||
            this.hasMoC() ||
            (!spell.isSpellKnown(T.momentOfCraving))) &&
          this.wontOvercapCStar(),
        this.reaps(),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 14. Soul Immolation (outside Meta)
      spell.cast("Soul Immolation", () => me, () =>
        !me.hasAura(A.soulImmolationDot) && !this.inMeta()
      ),

      // 15. Devour (Meta only)
      new bt.Decorator(
        () => this.inMeta(),
        spell.cast(S.devour, () => this.getCurrentTarget()),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 16. Consume (filler)
      spell.cast(S.consume, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // REAPS sub-list (SimC actions.reaps, 3 lines)
  // =============================================
  reaps() {
    return new bt.Selector(
      // Eradicate: frontal AoE after VR (only when buff active)
      spell.cast(S.eradicate, () => this.getCurrentTarget(), () => this.hasEradicate()),
      // Cull: Meta-only upgraded Reap — Decorator gate to prevent "spell not found"
      new bt.Decorator(
        () => this.inMeta(),
        spell.cast("Cull", () => this.getCurrentTarget()),
        new bt.Action(() => bt.Status.Failure)
      ),
      // Reap: base version — use name (framework can't resolve 1226019)
      spell.cast("Reap", () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // MELEE COMBO sub-list (SimC actions.melee_combo, 7 lines)
  // =============================================
  meleeCombo() {
    return new bt.Selector(
      // 1. Vengeful Retreat: voidstep & (cs<30 | voidblade.up | predators_wake.up | cs<=38)
      spell.cast(S.vengefulRetreat, () => me, () => {
        if (!me.hasAura(A.voidstep)) return false;
        const cs = this.getCSStacks();
        return cs < 30 || cs <= 38;
      }),

      // 2. Hungering Slash / Reaper's Toll: base or Meta-upgraded (AoE)
      // Reaper's Toll replaces Hungering Slash in Meta — try upgraded first
      new bt.Decorator(
        () => this.inMeta() && this.getEnemyCount() > 1,
        this.castMelee("Reaper's Toll", () => this.getCurrentTarget()),
        new bt.Action(() => bt.Status.Failure)
      ),
      this.castMelee("Hungering Slash", () => this.getCurrentTarget(), () =>
        this.getEnemyCount() > 1
      ),

      // 3. Reaper's Toll: voidsurge proc (Meta only)
      new bt.Decorator(
        () => this.inMeta() && A.voidsurgeRT && me.hasAura(A.voidsurgeRT),
        this.castMelee("Reaper's Toll", () => this.getCurrentTarget()),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 4. The Hunt / Predator's Wake: base or Meta-upgraded
      new bt.Decorator(
        () => this.inMeta(),
        this.castMelee("Predator's Wake", () => this.getCurrentTarget(), () => {
          const vs = this.hasVoidsurgeTalent();
          const db = this.hasDevourersBiteTalent();
          return (!vs && !db) || (db && !vs);
        }),
        new bt.Action(() => bt.Status.Failure)
      ),
      this.castMelee("The Hunt", () => this.getCurrentTarget(), () => {
        if (this.inMeta()) return false; // Use Predator's Wake in Meta
        const vs = this.hasVoidsurgeTalent();
        const db = this.hasDevourersBiteTalent();
        return !vs && !db;
      }),

      // 5. Pierce the Veil / Voidblade: Meta-upgraded first, then base
      new bt.Decorator(
        () => this.inMeta(),
        this.castMelee("Pierce the Veil", () => this.getCurrentTarget(), () => {
          if (A.voidsurgePtV && me.hasAura(A.voidsurgePtV)) return true;
          if (spell.isSpellKnown(T.dutyEternal) && this.getEnemyCount() === 1) return true;
          if (this.hasDevourersBiteTalent()) return true;
          if (spell.isSpellKnown(T.hungeringSlash) && this.getEnemyCount() > 1) return true;
          return false;
        }),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 6. Predator's Wake unconditional (Meta only — already gated)
      new bt.Decorator(
        () => this.inMeta(),
        this.castMelee("Predator's Wake", () => this.getCurrentTarget()),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 7. Voidblade (base — outside Meta)
      this.castMelee("Voidblade", () => this.getCurrentTarget(), () => {
        const db = this.hasDevourersBiteTalent();
        const vs = this.hasVoidsurgeTalent();
        if (!db) {
          return (spell.isSpellKnown(T.dutyEternal) && this.getEnemyCount() === 1) ||
            (spell.isSpellKnown(T.hungeringSlash) && this.getEnemyCount() > 1);
        }
        return false; // devourersBite + Meta uses Pierce the Veil instead
      }),
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.blur, () => me, () =>
        Settings.FWDevBlur && me.effectiveHealthPercent < Settings.FWDevBlurHP
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // SIMC VARIABLE: should_use_star
  // = enemies>1 | apex.1 | dark_matter.up | (star_fragments & emptiness)
  // =============================================
  // SimC: variable.should_use_star = (active_enemies>1|apex.1|buff.dark_matter.up|talent.star_fragments&talent.emptiness)
  // apex.1 = has at least rank 1 of apex talent (Dark Matter aura = rank 1 indicator)
  shouldUseStar() {
    // Always use in AoE
    if (this.getEnemyCount() > 1) return true;
    // ST: use with Dark Matter or Star Fragments + Emptiness
    if (me.hasAura(A.darkMatter)) return true;
    if (me.hasAura(1256307)) return true; // Dark Matter alt ID
    if (me.hasAura(1240204) && me.hasAura(1242492)) return true; // Star Fragments + Emptiness (dump confirmed)
    if (spell.isSpellKnown(T.apex)) return true;
    return true; // Default: always use CS if available (cast will fail naturally if not talented)
  }

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  // Melee cast helper: try name, then original ID, then SimC alt ID
  castMelee(nameOrId, targetFn, conditionFn) {
    const opts = { skipRangeCheck: true };
    if (conditionFn) return spell.cast(nameOrId, targetFn, conditionFn, opts);
    return spell.cast(nameOrId, targetFn, opts);
  }

  isAnnihilator() { return me.hasAura(1253304); } // Voidfall hero talent passive (confirmed from dump)
  isVoidScarred() { return !this.isAnnihilator(); }
  hasVoidsurgeTalent() { return me.hasAura(T.voidsurge) || me.hasAura(1246161); }

  // =============================================
  // STATE HELPERS
  // =============================================
  inMeta() { return me.hasAura(A.voidMeta); }

  metaStacksMax() {
    const aura = me.getAura(A.voidMetaStacks);
    if (!aura) return false;
    return aura.stacks >= (aura.maxStacks || 50);
  }

  hasMoC() {
    return me.hasAura(A.momentOfCraving) || me.hasAura(A.momentOfCravingAlt);
  }

  hasEradicate() { return me.hasAura(A.eradicate); }

  hasDevourersBite() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    return t.hasAuraByMe(A.devourersBite);
  }

  // Check if Devourer's Bite talent is active (framework can't resolve talent ID)
  hasDevourersBiteTalent() {
    return me.hasAura(1240201); // Devourer's Bite passive (confirmed from dump)
  }

  // SimC: variable.wont_overcap_cstar = (stack+souls)<=max | !should_use_star
  wontOvercapCStar() {
    if (!this.shouldUseStar()) return true;
    return (this.getCSStacks() + 4) <= this.getCSMaxStacks();
  }

  // SimC: variable.ray_after_reap = fury + 4*souls + 10*scythes_embrace >= 100
  rayAfterReap() {
    return this.getFury() + 4 * 4 + 10 >= 100; // 4 souls from Reap, scythes_embrace ~10
  }

  getCSStacks() {
    const aura = me.getAura(A.collapsingStarStack);
    return aura ? aura.stacks : 0;
  }

  getCSMaxStacks() {
    const aura = me.getAura(A.collapsingStarStack);
    return aura ? (aura.maxStacks || 50) : 50;
  }

  // SimC: active_dot.soul_immolation=0
  hasSoulImmolationDot() {
    return me.hasAura(A.soulImmolationDot);
  }

  getVFStacks() {
    // 1256302 has Remaining:0ms (react-style) — getAura may skip it, scan manually
    const aura = me.getAura(A.voidfallSpending);
    if (aura && aura.stacks) return aura.stacks;
    // Fallback: scan auras directly
    const found = me.auras.find(a => a.spellId === 1256302);
    return found ? (found.stacks || 0) : 0;
  }

  getSoulFragments() {
    const aura = me.getAura(A.soulFragments);
    return aura ? aura.stacks : 0;
  }

  getGroundFragments() {
    const aura = me.getAura(A.soulFragsGround);
    if (aura && aura.stacks) return aura.stacks;
    const found = me.auras.find(a => a.spellId === 1245584);
    return found ? (found.stacks || 0) : 0;
  }

  // Soul Smuggling: near Meta entry, don't Reap — save ground frags for after Meta entry
  shouldSmuggle() {
    if (this.inMeta()) return false; // Already in Meta, smuggling done
    if (!this.metaStacksNear()) return false; // Not close to Meta
    return this.getGroundFragments() >= 2; // Have frags worth smuggling
  }

  metaStacksNear() {
    const aura = me.getAura(A.voidMetaStacks);
    if (!aura) return false;
    const max = aura.maxStacks || 50;
    return aura.stacks >= max - 8; // Within 8 fragments of Meta
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

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target && common.validTarget(target) && me.distanceTo(target) <= 25 && me.isFacing(target)) {
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
