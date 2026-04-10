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
 * Balance Druid Behavior - Midnight 12.0.1
 * Sources: SimC APL (dreamgrove/sims/owl/balance.txt) + Dreamgrove Compendium
 *          + Method Guide (all pages) + Wowhead Guide
 *
 * Auto-detects: Keeper of the Grove vs Elune's Chosen
 * Dispatches to: kotgSingleTarget / ecSingleTarget / aoeRotation
 *
 * Key SimC variables replicated:
 *   opener, eclipse_down, cd_window, cd_window_narrow, no_weaver_procs, ca_soon
 *
 * Eclipse entry: charge fractional > 1.5 (sustain) or charges = 2 (opener)
 * CA trigger: prev_gcd FoN (KotG) or charges_fractional < 1.5 (EC)
 * Convoke gating: AP < 40 during CA, off-burst if Convoke CD < CA CD
 * Starsurge formula: AP > cost*2 - procCount (KotG), AP > 80 (EC)
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC APL (Dreamgrove) + Compendium + Method + Wowhead — v2 optimized',
};

const S = {
  wrath:              190984,
  starfire:           194153,
  starsurge:          78674,
  starfall:           191034,
  moonfire:           8921,
  sunfire:            93402,
  celestialAlignment: 194223,
  incarnation:        102560,
  convoke:            391528,
  forceOfNature:      205636,
  furyOfElune:        202770,
  warriorOfElune:     202425,
  newMoon:            274281,
  halfMoon:           274282,
  fullMoon:           274283,
  wildMushroom:       88747,    // Confirmed Midnight 12.0.1 (3 charges, 30s recharge)
  solarEclipse:       1233346,
  lunarEclipse:       1233272,
  solarBeam:          78675,
  barkskin:           22812,
  moonkinForm:        24858,
  regrowth:           8936,
  renewal:            108238,
  naturesSwiftness:   132158,
  markOfTheWild:      1126,
  berserking:         26297,
};

const A = {
  moonkinForm:        24858,
  celestialAlignment: 194223,
  incarnation:        102560,
  naturesSwiftness:   132158,
  solarEclipse:       48517,
  lunarEclipse:       48518,
  moonfireDebuff:     164812,
  sunfireDebuff:      164815,
  starlord:           279709,
  starweaversWeft:    393944,   // Free Starsurge
  starweaversWarp:    393942,   // Free Starfall
  touchTheCosmos:     450360,   // Free spender from Wrath/Starfire (450356=talent, 394414=old tier set)
  harmonyOfTheGrove:  428735,   // Buff applied by FoN treants (+4% spell dmg each)
  treantsOfTheMoon:   428544,   // KotG passive
  warriorOfElune:     202425,
  ascendantStars:     1263382,  // Bolts from Eclipse entry (Ascendant Eclipses pt4)
  ascendantFires:     1263363,  // Instant Wrath/Starfire from Eclipse entry
  fungalGrowth:       81291,    // Wild Mushroom debuff on target
};

const MIN_DOT_TTD = 6000;
const STARSURGE_COST = 30;      // Base AP cost
const FON_DURATION = 10000;     // Force of Nature: 10s

export class BalanceDruidBehavior extends Behavior {
  name = 'FW Balance Druid';
  context = BehaviorContext.Any;
  specialization = Specialization.Druid.Balance;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _eclipseFrame = 0;
  _cachedSolar = null;
  _cachedLunar = null;
  _targetFrame = 0;
  _cachedTarget = null;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _apFrame = 0;
  _cachedAP = 0;

  // State
  _versionLogged = false;
  _lastDebug = 0;
  _opener = true;   // SimC variable.opener — clears on first CA/Inc usage

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWBalAutoCDs', text: 'Auto Cooldowns (ignore burst keybind)', default: false },
        { type: 'checkbox', uid: 'FWBalUsePotion', text: 'Use Potion (Light\'s Potential)', default: false },
        { type: 'slider', uid: 'FWBalAoECount', text: 'AoE Target Count', default: 2, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWBalDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives & Healing',
      options: [
        { type: 'checkbox', uid: 'FWBalBarkskin', text: 'Use Barkskin', default: true },
        { type: 'slider', uid: 'FWBalBarkskinHP', text: 'Barkskin HP %', default: 50, min: 10, max: 90 },
        { type: 'checkbox', uid: 'FWBalSelfHeal', text: 'Use Self-Healing', default: true },
        { type: 'slider', uid: 'FWBalRenewalHP', text: 'Renewal HP %', default: 30, min: 10, max: 60 },
        { type: 'slider', uid: 'FWBalRegrowthHP', text: 'NS+Regrowth HP %', default: 40, min: 10, max: 70 },
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

      // OOC: Mark of the Wild
      new bt.Decorator(
        () => !me.inCombat(),
        new bt.Selector(
          spell.cast(S.markOfTheWild, () => this.getMotwTarget(), () => this.getMotwTarget() !== null),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // Combat check
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),

      // Auto-target dead/invalid
      new bt.Action(() => {
        if (!me.target || !common.validTarget(me.target)) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),

      // Null target bail
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      // Cancel cast-time spells when moving (Wrath, Starfire) so instant rotation can fire
      new bt.Action(() => {
        if (me.isMoving() && me.isCastingOrChanneling) {
          const cast = me.currentCastOrChannel;
          if (cast && (cast.spellId === S.wrath || cast.spellId === S.starfire)) {
            me.stopCasting();
            return bt.Status.Failure;
          }
        }
        return bt.Status.Failure;
      }),
      common.waitForCastOrChannel(),

      // Moonkin Form
      new bt.Decorator(
        () => !me.hasAura(A.moonkinForm),
        spell.cast(S.moonkinForm),
        new bt.Action(() => bt.Status.Success)
      ),

      // Opener flag: clear on first CA/Inc usage
      new bt.Action(() => {
        if (this._opener && this.inCA()) this._opener = false;
        return bt.Status.Failure;
      }),

      // Version + Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[Bal] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | Hero: ${this.isKeeperOfTheGrove() ? 'KotG' : 'EC'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWBalDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          const sl = me.getAura(A.starlord);
          console.info(`[Bal] Ecl:${this.inSolar() ? 'Sol' : this.inLunar() ? 'Lun' : 'NONE'}(${this.eclipseRemains()}ms) CF:${this.getEclipseChargesFrac().toFixed(2)} AP:${this.getAP()} SL:${sl ? sl.stacks + '/' + Math.round(sl.remaining) : '-'} CA:${this.inCA()} Stars:${this.hasStars()} Fires:${this.hasFires()} Open:${this._opener} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.solarBeam),
          this.defensives(),

          // Trinkets: SimC use_items — during CA+Harmony or fight ending
          common.useTrinkets(() => this.getCurrentTarget(), () =>
            this.useCDs() && (
              this.inCA() && (this.hasHarmony() || !spell.isSpellKnown(S.forceOfNature)) ||
              this.targetTTD() < this.getCACdRemains()
            )
          ),

          // Potion: SimC — KotG:Harmony, EC:CA, opener:prev Solar Eclipse, fight<30
          new bt.Action(() => {
            if (!this.useCDs()) return bt.Status.Failure;
            if (!Settings.FWBalUsePotion) return bt.Status.Failure;
            const item = common.getItemByName("Light's Potential");
            if (!item || !item.cooldown.ready) return bt.Status.Failure;
            if (this.hasHarmony() && !this.isElunesChosen()) { item.use(); return bt.Status.Success; }
            if (this.inCA() && this.isElunesChosen()) { item.use(); return bt.Status.Success; }
            if (this._opener && spell.getTimeSinceLastCast(S.solarEclipse) < 1500) { item.use(); return bt.Status.Success; }
            if (this.targetTTD() <= 30000) { item.use(); return bt.Status.Success; }
            return bt.Status.Failure;
          }),

          // Berserking: during CA + Harmony (or fight ending)
          spell.cast(S.berserking, () => me, () =>
            this.useCDs() && (
              this.inCA() && (this.hasHarmony() || !spell.isSpellKnown(S.forceOfNature)) ||
              this.targetTTD() < this.getCACdRemains()
            )
          ),

          // Dispatch: EC ST → KotG ST → AoE
          new bt.Decorator(
            () => this.isElunesChosen() && this.getEnemyCount() < Settings.FWBalAoECount,
            this.ecSingleTarget(),
            new bt.Action(() => bt.Status.Failure)
          ),
          new bt.Decorator(
            () => this.getEnemyCount() < Settings.FWBalAoECount,
            this.kotgSingleTarget(),
            new bt.Action(() => bt.Status.Failure)
          ),
          this.aoeRotation(),
        )
      )
    );
  }

  // =============================================
  // KEEPER OF THE GROVE — Single Target
  // SimC: actions.kotg_st (19 lines)
  // =============================================
  kotgSingleTarget() {
    return new bt.Selector(
      // --- Movement: full instant-cast rotation ---
      new bt.Decorator(
        () => me.isMoving(),
        new bt.Selector(
          // CDs (instant/off-GCD)
          spell.cast(S.celestialAlignment, () => me, () =>
            this.useCDs() && (this.prevGcdFoN() || this.targetTTD() < 20000)
          ),
          spell.cast(S.incarnation, () => me, () =>
            this.useCDs() && (this.prevGcdFoN() || this.targetTTD() < 20000)
          ),
          spell.cast(S.forceOfNature, () => this.getCurrentTarget(), () => this.kotgFoNCond()),
          spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
            (this.inCA() && this.getAP() < 40) ||
            (!this.inCA() && this.getAP() < 40 && (spell.getCooldown(S.convoke)?.timeleft || 0) < this.getCACdRemains())
          ),
          // DoTs (refresh)
          spell.cast(S.moonfire, () => this.getCurrentTarget(), () => this.mfRefresh()),
          spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),
          // Starfall: 2+ targets or Warp proc
          spell.cast(S.starfall, () => this.getCurrentTarget(), () =>
            me.hasAura(A.starweaversWarp) || this.getEnemyCount() >= 2
          ),
          spell.cast(S.starsurge, () => this.getCurrentTarget(), () => this.kotgSSCond()),
          // Instants
          spell.cast(S.starfire, () => this.getCurrentTarget(), () => me.hasAura(A.warriorOfElune)),
          spell.cast(S.furyOfElune, () => this.getCurrentTarget(), () => this.kotgFoeCond()),
          this.enterSolar(),
          // Moonfire/Sunfire spam (always cast something while moving for DPS)
          spell.cast(S.sunfire, () => this.getCurrentTarget()),
          spell.cast(S.moonfire, () => this.getCurrentTarget()),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // === OPENER: DoTs first, then fast burst when player pre-cast 2x Wrath (AP >= 15) ===
      // Apply DoTs BEFORE burst CDs during opener
      new bt.Decorator(
        () => this._opener && this.getAP() >= 15,
        new bt.Selector(
          spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),
          spell.cast(S.moonfire, () => this.getCurrentTarget(), () => this.mfRefresh()),
          // Fast burst: skip FoE/FoN prev_gcd requirement during opener
          spell.cast(S.furyOfElune, () => this.getCurrentTarget()),
          spell.cast(S.forceOfNature, () => this.getCurrentTarget()),
          spell.cast(S.celestialAlignment, () => me, () => this.useCDs()),
          spell.cast(S.incarnation, () => me, () => this.useCDs()),
          spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
            this.inCA() && this.getAP() < 40
          ),
          new bt.Action(() => bt.Status.Failure) // Fall through to normal rotation
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // === Dreamgrove Burst Sequence: FoE → FoN → CA/Inc → Convoke (sustain) ===

      // 1. Fury of Elune: fires before FoN in burst prep
      spell.cast(S.furyOfElune, () => this.getCurrentTarget(), () => this.kotgFoeCond()),

      // 2. Force of Nature: fires before CA/Inc
      spell.cast(S.forceOfNature, () => this.getCurrentTarget(), () => this.kotgFoNCond()),

      // 3. CA/Inc: immediately after FoN
      spell.cast(S.celestialAlignment, () => me, () =>
        this.useCDs() && (this.prevGcdFoN() || this.targetTTD() < 20000)
      ),
      spell.cast(S.incarnation, () => me, () =>
        this.useCDs() && (this.prevGcdFoN() || this.targetTTD() < 20000)
      ),

      // 4. Convoke: IMMEDIATELY after CA/Inc
      spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
        (this.inCA() && this.getAP() < 40) ||
        (!this.inCA() && this.getAP() < 40 && (spell.getCooldown(S.convoke)?.timeleft || 0) < this.getCACdRemains())
      ),

      // 5. DoTs: Moonfire + Sunfire refresh
      spell.cast(S.moonfire, () => this.getCurrentTarget(), () => this.mfRefresh()),
      spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),

      // 6. Solar Eclipse
      this.enterSolar(),

      // 8. Wrath pooling (non-Convoke, FoN coming — NOT during opener)
      spell.cast(S.wrath, () => this.getCurrentTarget(), () =>
        !this._opener && !spell.isSpellKnown(S.convoke) && !this.hasStars() &&
        this.getAP() < 80 && this.noWeaverProcs() && this.getFoNCdRemains() < 15000
      ),

      // 9. Pre-burst Sunfire (line_cd=10)
      spell.cast(S.sunfire, () => this.getCurrentTarget(), () => {
        if (spell.getTimeSinceLastCast(S.sunfire) < 10000) return false;
        if (this._opener) return !this.hasStars();
        return this.getDebuffRemaining(S.sunfire) < 10000 &&
          this.caSoon() && this.getFoNCdRemains() < 3000;
      }),

      // 10. Starfall: PRIMARY spender on 2+ targets | Warp proc | TtC on 2+
      spell.cast(S.starfall, () => this.getCurrentTarget(), () => {
        if (me.hasAura(A.starweaversWarp)) return true; // Warp proc always
        if (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() >= 2) return true; // TtC on 2+
        if (this.getEnemyCount() >= 2 && this.getAP() > 50) return true; // 2+ targets = Starfall > Starsurge
        return false;
      }),

      // 11. Starsurge: ST spender (only when Starfall didn't fire)
      spell.cast(S.starsurge, () => this.getCurrentTarget(), () => this.kotgSSCond()),

      // 12. Starfire: Ascendant Fires + Lunar Eclipse (instant)
      spell.cast(S.starfire, () => this.getCurrentTarget(), () =>
        this.hasFires() && this.inLunar()
      ),

      // 13. Moon cycle (transforming spell — only current phase is castable)
      this.castMoon(),

      // 16. Wild Mushroom: no AP overcap, Fungal Growth not active
      spell.cast(S.wildMushroom, () => this.getCurrentTarget(), () => {
        if (this.apDeficit() < 10) return false;
        const t = this.getCurrentTarget();
        if (t && (t.hasAuraByMe(A.fungalGrowth) || t.getAuraByMe(A.fungalGrowth))) return false;
        return this.inSolar() || (spell.getFullRechargeTime(S.wildMushroom) || 99999) < this.getCACdRemains();
      }),

      // 17. Wrath filler
      spell.cast(S.wrath, () => this.getCurrentTarget())
    );
  }

  // =============================================
  // ELUNE'S CHOSEN — Single Target
  // SimC: actions.ec_st (16 lines)
  // =============================================
  ecSingleTarget() {
    return new bt.Selector(
      // --- Movement: full instant-cast rotation ---
      new bt.Decorator(
        () => me.isMoving(),
        new bt.Selector(
          // CDs (instant/off-GCD) — FoE first, CA/Inc requires prev_gcd FoE
          spell.cast(S.furyOfElune, () => this.getCurrentTarget()),
          spell.cast(S.celestialAlignment, () => me, () => {
            if (!this.useCDs()) return false;
            if (this.targetTTD() < 20000) return true;
            return this.prevGcdFoE() && this.eclipseDown();
          }),
          spell.cast(S.incarnation, () => me, () => {
            if (!this.useCDs()) return false;
            if (this.targetTTD() < 20000) return true;
            return this.prevGcdFoE() && this.eclipseDown();
          }),
          spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
            (this.inCA() && this.getAP() < 40) ||
            (spell.getCooldown(S.convoke)?.timeleft || 0) < this.getCACdRemains() ||
            this.targetTTD() < 30000
          ),
          spell.cast(S.forceOfNature, () => this.getCurrentTarget()),
          // DoTs
          spell.cast(S.moonfire, () => this.getCurrentTarget(), () => this.mfRefresh()),
          spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),
          // Starfall: 2+ targets or procs
          spell.cast(S.starfall, () => this.getCurrentTarget(), () =>
            me.hasAura(A.starweaversWarp) ||
            (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() >= 2) ||
            this.getEnemyCount() >= 2
          ),
          spell.cast(S.starsurge, () => this.getCurrentTarget(), () => this.ecSSCond()),
          // Eclipse entry (instant)
          spell.cast(S.lunarEclipse, () => me, () => {
            if (this.inEclipse()) return false;
            return this.getCAFullRecharge() > 15000 || this._opener;
          }),
          // Moonfire/Sunfire spam (always cast something while moving)
          spell.cast(S.sunfire, () => this.getCurrentTarget()),
          spell.cast(S.moonfire, () => this.getCurrentTarget()),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // === OPENER: DoTs first, then fast burst when player pre-cast 2x Wrath (AP >= 15) ===
      new bt.Decorator(
        () => this._opener && this.getAP() >= 15,
        new bt.Selector(
          spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),
          spell.cast(S.moonfire, () => this.getCurrentTarget(), () => this.mfRefresh()),
          spell.cast(S.furyOfElune, () => this.getCurrentTarget()),
          spell.cast(S.celestialAlignment, () => me, () => this.useCDs()),
          spell.cast(S.incarnation, () => me, () => this.useCDs()),
          spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
            this.inCA() && this.getAP() < 40
          ),
          new bt.Action(() => bt.Status.Failure)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 1. Fury of Elune FIRST — CA/Inc requires prev_gcd FoE for EC
      spell.cast(S.furyOfElune, () => this.getCurrentTarget()),

      // 2. CA/Inc: prev_gcd FoE + eclipse_down (Dreamgrove EC rule)
      spell.cast(S.celestialAlignment, () => me, () => {
        if (!this.useCDs()) return false;
        if (this.targetTTD() < 20000) return true;
        return this.prevGcdFoE() && this.eclipseDown();
      }),
      spell.cast(S.incarnation, () => me, () => {
        if (!this.useCDs()) return false;
        if (this.targetTTD() < 20000) return true;
        return this.prevGcdFoE() && this.eclipseDown();
      }),

      // 3. Moonfire
      spell.cast(S.moonfire, () => this.getCurrentTarget(), () => this.mfRefresh()),

      // 4. Sunfire
      spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),

      // 5. Convoke: CA+AP<40 | convoke_cd < ca_cd | fight<30
      spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
        (this.inCA() && this.getAP() < 40) ||
        (spell.getCooldown(S.convoke)?.timeleft || 0) < this.getCACdRemains() ||
        this.targetTTD() < 30000
      ),

      // 6. Lunar Eclipse: CA full recharge > 15 | opener
      spell.cast(S.lunarEclipse, () => me, () => {
        if (this.inEclipse()) return false;
        return this.getCAFullRecharge() > 15000 || this._opener;
      }),

      // 7. Starfall: PRIMARY spender on 2+ targets | Warp proc | TtC on 2+
      spell.cast(S.starfall, () => this.getCurrentTarget(), () => {
        if (me.hasAura(A.starweaversWarp)) return true;
        if (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() >= 2) return true;
        if (this.getEnemyCount() >= 2 && this.getAP() > 50) return true;
        return false;
      }),

      // 8. Starsurge: ST spender (only when Starfall didn't fire)
      spell.cast(S.starsurge, () => this.getCurrentTarget(), () => this.ecSSCond()),

      // 9. Force of Nature (unconditional if talented — rare for EC)
      spell.cast(S.forceOfNature, () => this.getCurrentTarget()),

      // 10. Moon cycle (transforming spell — only current phase is castable)
      this.castMoon(),

      // 13. Wild Mushroom: no AP overcap, Fungal Growth not active
      spell.cast(S.wildMushroom, () => this.getCurrentTarget(), () => {
        if (this.apDeficit() < 10) return false;
        const t = this.getCurrentTarget();
        if (t && (t.hasAuraByMe(A.fungalGrowth) || t.getAuraByMe(A.fungalGrowth))) return false;
        if (this.isElunesChosen()) return true; // EC: always use when available
        return this.inSolar() || (spell.getFullRechargeTime(S.wildMushroom) || 99999) < this.getCACdRemains();
      }),

      // 14. Starfire filler (in Eclipse — EC always Lunar, Starfire is empowered)
      spell.cast(S.starfire, () => this.getCurrentTarget(), () => !this.eclipseDown()),

      // 15. Wrath (outside Eclipse — SimC: wrath,if=variable.eclipse_down)
      spell.cast(S.wrath, () => this.getCurrentTarget(), () => this.eclipseDown())
    );
  }

  // =============================================
  // AOE — Both hero trees
  // SimC: actions.aoe (20 lines)
  // =============================================
  aoeRotation() {
    return new bt.Selector(
      // --- Movement: full instant-cast AoE rotation ---
      new bt.Decorator(
        () => me.isMoving(),
        new bt.Selector(
          // CDs (instant/off-GCD)
          spell.cast(S.celestialAlignment, () => me, () => {
            if (!this.useCDs()) return false;
            if (this.targetTTD() < 20000) return true;
            if (!this.isElunesChosen()) return this.prevGcdFoN();
            return this.prevGcdFoE() && this.eclipseDown();
          }),
          spell.cast(S.incarnation, () => me, () => {
            if (!this.useCDs()) return false;
            if (this.targetTTD() < 20000) return true;
            if (!this.isElunesChosen()) return this.prevGcdFoN();
            return this.prevGcdFoE() && this.eclipseDown();
          }),
          spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
            (this.inCA() && this.getAP() < 40) ||
            (!this.inCA() && this.getAP() < 40 && (spell.getCooldown(S.convoke)?.timeleft || 0) < this.getCACdRemains())
          ),
          spell.cast(S.forceOfNature, () => this.getCurrentTarget(), () =>
            !this._opener || !this.hasStars()
          ),
          spell.cast(S.furyOfElune, () => this.getCurrentTarget(), () => {
            if (this.isElunesChosen()) return true;
            if (this._opener) return !this.eclipseDown() && !this.hasStars();
            return this.hasHarmony() || this.getFoNCdRemains() < 1500 ||
              (spell.isSpellKnown(394121) && this.getFoNCdRemains() > 20000);
          }),
          // DoTs
          spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),
          spell.cast(S.moonfire, () => this.getCurrentTarget(), () => this.mfRefresh()),
          // Spenders (match AoE logic)
          spell.cast(S.starfall, () => this.getCurrentTarget(), () =>
            me.hasAura(A.starweaversWarp) ||
            (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() >= 3) ||
            (this.getEnemyCount() >= 3 && this.getAP() > 80)
          ),
          spell.cast(S.starsurge, () => this.getCurrentTarget(), () =>
            me.hasAura(A.starweaversWeft) ||
            (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() <= 2) ||
            (this.getEnemyCount() <= 2 && this.getAP() > 80) ||
            this.hasStars()
          ),
          // Instants
          spell.cast(S.starfire, () => this.getCurrentTarget(), () =>
            me.hasAura(A.warriorOfElune) || this.hasFires()
          ),
          // Eclipse entry (instant)
          this.enterSolar(),
          spell.cast(S.lunarEclipse, () => me, () => {
            if (this.inEclipse()) return false;
            if (this.isElunesChosen()) return this._opener || this.getCAFullRecharge() > 15000;
            if (this.getEnemyCount() <= 2) return false;
            const cf = this.getEclipseChargesFrac();
            if (this._opener && cf >= 2) return true;
            if (!this._opener && cf > 1.5 && this.cdWindow()) return true;
            return this.targetTTD() < 15000;
          }),
          // Moonfire/Sunfire spam (always cast something while moving)
          spell.cast(S.sunfire, () => this.getCurrentTarget()),
          spell.cast(S.moonfire, () => this.getCurrentTarget()),
          new bt.Action(() => bt.Status.Success)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 1. CA/Inc: KotG=prev_gcd FoN, EC=prev_gcd FoE + eclipse_down
      spell.cast(S.celestialAlignment, () => me, () => {
        if (!this.useCDs()) return false;
        if (this.targetTTD() < 20000) return true;
        if (!this.isElunesChosen()) return this.prevGcdFoN();
        return this.prevGcdFoE() && this.eclipseDown();
      }),
      spell.cast(S.incarnation, () => me, () => {
        if (!this.useCDs()) return false;
        if (this.targetTTD() < 20000) return true;
        if (!this.isElunesChosen()) return this.prevGcdFoN();
        return this.prevGcdFoE() && this.eclipseDown();
      }),

      // 2-3. DoTs (target_if: remains<2 | refreshable & eclipse_down)
      // Moonfire spreading to targets without it
      new bt.Action(() => {
        if (spell.getTimeSinceLastCast(S.moonfire) < 2000) return bt.Status.Failure;
        const target = this.findMoonfireTarget();
        if (!target) return bt.Status.Failure;
        if (target.timeToDeath && target.timeToDeath() < MIN_DOT_TTD) return bt.Status.Failure;
        const result = spell.cast(S.moonfire, () => target).execute({});
        return result === bt.Status.Success ? bt.Status.Success : bt.Status.Failure;
      }),
      spell.cast(S.sunfire, () => this.getCurrentTarget(), () => this.sfRefresh()),

      // 4. Fury of Elune: EC=unconditional, KotG=complex gating
      spell.cast(S.furyOfElune, () => this.getCurrentTarget(), () => {
        if (this.isElunesChosen()) return true; // EC: unconditional in AoE per SimC
        // KotG:
        if (this._opener) return !this.eclipseDown() && !this.hasStars();
        return this.hasHarmony() || this.getFoNCdRemains() < 1500 ||
          (spell.isSpellKnown(394121) && this.getFoNCdRemains() > 20000); // Radiant Moonlight
      }),

      // 5. Solar Eclipse (KotG AoE: charges_fractional + cd_window)
      spell.cast(S.solarEclipse, () => me, () => {
        if (this.isElunesChosen()) return false;
        if (this.inEclipse()) return false;
        const cf = this.getEclipseChargesFrac();
        if (this._opener && cf >= 2) return true;
        if (!this._opener && cf > 1.5 && this.cdWindow()) return true;
        if (spell.getCooldown(S.solarEclipse)?.ready && this.cdWindowNarrow()) return true;
        if (this.targetTTD() < 15000) return true;
        return false;
      }),

      // 6. Lunar Eclipse (EC always, or KotG 3+ targets)
      spell.cast(S.lunarEclipse, () => me, () => {
        if (this.inEclipse()) return false;
        if (this.isElunesChosen()) {
          return this._opener || this.getCAFullRecharge() > 15000;
        }
        // KotG: 3+ targets only
        if (this.getEnemyCount() <= 2) return false;
        const cf = this.getEclipseChargesFrac();
        if (this._opener && cf >= 2) return true;
        if (!this._opener && cf > 1.5 && this.cdWindow()) return true;
        if (spell.getCooldown(S.lunarEclipse)?.ready && this.cdWindowNarrow()) return true;
        if (this.targetTTD() < 15000) return true;
        return false;
      }),

      // 7. Convoke: CA+AP<40 | off-burst+AP<40+Convoke CD < CA CD
      spell.cast(S.convoke, () => this.getCurrentTarget(), () =>
        (this.inCA() && this.getAP() < 40) ||
        (!this.inCA() && this.getAP() < 40 && (spell.getCooldown(S.convoke)?.timeleft || 0) < this.getCACdRemains())
      ),

      // 8. Wrath pooling (non-Convoke, <3 targets, FoN coming)
      spell.cast(S.wrath, () => this.getCurrentTarget(), () =>
        !spell.isSpellKnown(S.convoke) && this.getEnemyCount() < 3 &&
        !this.hasStars() &&
        (this._opener ? this.getAP() < 50 :
          this.getAP() < 80 && this.noWeaverProcs() && this.getFoNCdRemains() < 15000)
      ),

      // 9. Pre-burst Sunfire (line_cd=10)
      spell.cast(S.sunfire, () => this.getCurrentTarget(), () => {
        if (spell.getTimeSinceLastCast(S.sunfire) < 10000) return false;
        if (this._opener) return !this.hasStars();
        return this.getDebuffRemaining(S.sunfire) < 10000 &&
          this.caSoon() && this.getFoNCdRemains() < 3000;
      }),

      // 10. Force of Nature
      spell.cast(S.forceOfNature, () => this.getCurrentTarget(), () =>
        !this._opener || !this.hasStars()
      ),

      // 10b. Wild Mushroom (EC AoE: step 7 per Dreamgrove — before Starfall)
      new bt.Decorator(
        () => this.isElunesChosen(),
        spell.cast(S.wildMushroom, () => this.getCurrentTarget(), () => {
          if (this.apDeficit() < 10) return false;
          const t = this.getCurrentTarget();
          if (t && (t.hasAuraByMe(A.fungalGrowth) || t.getAuraByMe(A.fungalGrowth))) return false;
          return true;
        }),
        new bt.Action(() => bt.Status.Failure)
      ),

      // 11. Starfall: Warp proc | TtC proc | 3+ targets overcap prevention
      spell.cast(S.starfall, () => this.getCurrentTarget(), () =>
        me.hasAura(A.starweaversWarp) ||
        (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() >= 3) ||
        (this.getEnemyCount() >= 3 && this.getAP() > 80)
      ),

      // 12. Starsurge: Weft proc | TtC on 2 targets | 2 targets overcap | Ascendant Stars
      spell.cast(S.starsurge, () => this.getCurrentTarget(), () =>
        me.hasAura(A.starweaversWeft) ||
        (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() <= 2) ||
        (this.getEnemyCount() <= 2 && this.getAP() > 80) ||
        this.hasStars()
      ),

      // 13. Starfire: Ascendant Fires + Lunar
      spell.cast(S.starfire, () => this.getCurrentTarget(), () =>
        this.hasFires() && this.inLunar()
      ),

      // 14. Moon cycle (transforming spell — only current phase is castable)
      this.castMoon(),

      // 17. Wild Mushroom: no AP overcap, Fungal Growth not active
      spell.cast(S.wildMushroom, () => this.getCurrentTarget(), () => {
        if (this.apDeficit() < 10) return false;
        const t = this.getCurrentTarget();
        if (t && (t.hasAuraByMe(A.fungalGrowth) || t.getAuraByMe(A.fungalGrowth))) return false;
        if (this.isElunesChosen()) return true;
        return this.inSolar() || (spell.getFullRechargeTime(S.wildMushroom) || 99999) < this.getCACdRemains();
      }),

      // 18. Starfire (complex AoE filler by EC/target count/CA)
      spell.cast(S.starfire, () => this.getCurrentTarget(), () => {
        if (this.isElunesChosen()) return true;
        if (this.eclipseDown() && this.getEnemyCount() > 6) return true;
        if (this.inLunar()) {
          const e = this.getEnemyCount();
          return (e > 2 && this.inCA()) || (e <= 2 && !this.inCA());
        }
        return false;
      }),

      // 19. Wrath fallback
      spell.cast(S.wrath, () => this.getCurrentTarget())
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.barkskin, () => me, () =>
        Settings.FWBalBarkskin && me.pctHealth <= Settings.FWBalBarkskinHP
      ),
      new bt.Decorator(
        () => Settings.FWBalSelfHeal,
        new bt.Selector(
          spell.cast(S.renewal, () => me, () => me.pctHealth <= Settings.FWBalRenewalHP),
          spell.cast(S.naturesSwiftness, () => me, () =>
            me.pctHealth <= Settings.FWBalRegrowthHP && !me.hasAura(A.naturesSwiftness)
          ),
          spell.cast(S.regrowth, () => me, () => me.hasAura(A.naturesSwiftness)),
          spell.cast(S.regrowth, () => me, () =>
            me.pctHealth <= 25 && spell.getTimeSinceLastCast(S.regrowth) > 4000
          ),
          new bt.Action(() => bt.Status.Failure)
        ),
        new bt.Action(() => bt.Status.Failure)
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // ECLIPSE ENTRY
  // =============================================
  // KotG ST Solar Eclipse (charges_fractional + cd_window + Starlord expiry)
  enterSolar() {
    return spell.cast(S.solarEclipse, () => me, () => {
      if (this.inEclipse()) return false;
      if (this.isElunesChosen()) return false;
      const cf = this.getEclipseChargesFrac();
      if (this._opener && cf >= 2) return true;
      if (!this._opener && cf > 1.5 && this.cdWindow()) return true;
      if (spell.getCooldown(S.solarEclipse)?.ready && this.cdWindowNarrow()) return true;
      // Dreamgrove: enter Solar when Starlord falls off (if talented)
      const sl = me.getAura(A.starlord);
      if (sl && sl.remaining < 2000 && cf >= 1) return true;
      if (this.targetTTD() < 15000) return true;
      return false;
    });
  }

  // =============================================
  // ECLIPSE DETECTION (cached per tick)
  // =============================================
  _refreshEclipseCache() {
    if (this._eclipseFrame === wow.frameTime) return;
    this._eclipseFrame = wow.frameTime;
    this._cachedSolar = me.auras.find(a =>
      a.spellId === 48517 || a.name.includes("Finsternis (Sonne") || a.name.includes("Eclipse (Solar")
    ) || null;
    this._cachedLunar = me.auras.find(a =>
      a.spellId === 48518 || a.name.includes("Finsternis (Mond") || a.name.includes("Eclipse (Lunar")
    ) || null;
  }

  inSolar() { this._refreshEclipseCache(); return this._cachedSolar !== null; }
  inLunar() { this._refreshEclipseCache(); return this._cachedLunar !== null; }
  inEclipse() { return this.inSolar() || this.inLunar(); }
  eclipseDown() { return !this.inSolar() && !this.inLunar(); }
  solarRemains() { this._refreshEclipseCache(); return this._cachedSolar ? this._cachedSolar.remaining : 0; }
  lunarRemains() { this._refreshEclipseCache(); return this._cachedLunar ? this._cachedLunar.remaining : 0; }
  eclipseRemains() { return Math.max(this.solarRemains(), this.lunarRemains()); }

  // Eclipse charge fractional (SimC: cooldown.eclipse.charges_fractional)
  getEclipseChargesFrac() {
    if (this.isElunesChosen()) return spell.getChargesFractional(S.lunarEclipse) || 0;
    return spell.getChargesFractional(S.solarEclipse) || 0;
  }

  // =============================================
  // SIMC VARIABLE HELPERS
  // =============================================

  // variable.cd_window = cooldown.force_of_nature.remains>15 | cooldown.ca_inc.remains<44
  cdWindow() {
    return this.getFoNCdRemains() > 15000 || this.getCACdRemains() < 44000;
  }

  // variable.cd_window_narrow = cooldown.force_of_nature.remains>30 | (ca_inc.remains>10 & <20)
  cdWindowNarrow() {
    const ca = this.getCACdRemains();
    return this.getFoNCdRemains() > 30000 || (ca > 10000 && ca < 20000);
  }

  // variable.no_weaver_procs = !touch_the_cosmos & !starweavers_warp
  noWeaverProcs() {
    return !me.hasAura(A.touchTheCosmos) && !me.hasAura(A.starweaversWarp);
  }

  // variable.ca_soon = cooldown.ca_inc.remains<3 | cooldown.ca_inc.charges_fractional>1
  caSoon() {
    const caCharges = spell.getChargesFractional(S.celestialAlignment) ||
      spell.getChargesFractional(S.incarnation) || 0;
    return this.getCACdRemains() < 3000 || caCharges > 1;
  }

  // Prev GCD checks (SimC: prev_gcd.1.X)
  prevGcdFoN() { return spell.getTimeSinceLastCast(S.forceOfNature) < 1500; }
  prevGcdFoE() { return spell.getTimeSinceLastCast(S.furyOfElune) < 1500; }

  // Ascendant Stars/Fires
  hasStars() { return me.hasAura(A.ascendantStars); }
  hasFires() { return me.hasAura(A.ascendantFires); }
  hasHarmony() { return me.hasAura(A.harmonyOfTheGrove); }

  // =============================================
  // SPENDER CONDITIONS
  // =============================================

  // KotG Starsurge: handles both Starweaver and Rattle the Stars builds
  // Starweaver: AP > cost*2 - procCount | solar | TtC+Stars | Weft
  // Rattle the Stars: AP overcap | solar | TtC | Ascendant Stars
  kotgSSCond() {
    const ap = this.getAP();
    const hasWeaver = spell.isSpellKnown(393940); // Starweaver talent
    if (hasWeaver) {
      const procs = (me.hasAura(A.starweaversWeft) ? 1 : 0) +
        (me.hasAura(A.touchTheCosmos) ? 1 : 0) +
        (me.hasAura(A.starweaversWarp) ? 1 : 0);
      return (ap > STARSURGE_COST * 2 - procs || this.inSolar()) ||
        (me.hasAura(A.touchTheCosmos) && this.hasStars()) ||
        me.hasAura(A.starweaversWeft);
    }
    // Rattle the Stars: reduced cost (27), spend in Solar or at overcap
    if (this.inSolar()) return ap > 27;
    if (me.hasAura(A.touchTheCosmos)) return true;
    if (this.hasStars()) return true;
    return ap > 80; // overcap prevention
  }

  // EC Starsurge: overcap AP | Ascendant Stars | Weft | TtC (ST only, AoE uses Starfall for TtC)
  ecSSCond() {
    return this.getAP() > 80 ||
      this.hasStars() ||
      me.hasAura(A.starweaversWeft) ||
      me.hasAura(A.touchTheCosmos);
  }

  // EC Starfall: Warp proc | TtC proc (on 2+ targets, ST prefers Starsurge for TtC)
  ecSFallCond() {
    if (me.hasAura(A.starweaversWarp)) return true;
    if (me.hasAura(A.touchTheCosmos) && this.getEnemyCount() >= 2) return true;
    return false;
  }

  // KotG FoE: opener(eclipse+!stars) | sustain(harmony | FoN<gcd | Radiant+FoN>20)
  kotgFoeCond() {
    if (this._opener) return !this.eclipseDown() && !this.hasStars();
    return this.hasHarmony() || this.getFoNCdRemains() < 1500 ||
      (spell.isSpellKnown(394121) && this.getFoNCdRemains() > 20000);
  }

  // KotG FoN: opener(stars down + SF>16) | sustain(eclipse.remains>FoN dur | !eclipse+eclipse coming)
  kotgFoNCond() {
    if (this.targetTTD() < 15000) return true;
    if (this._opener) {
      return !this.hasStars() && this.getDebuffRemaining(S.sunfire) > 16000;
    }
    if (this.eclipseRemains() > FON_DURATION) return true;
    if (!this.inEclipse()) {
      const eclCD = spell.getCooldown(S.solarEclipse)?.timeleft || 99999;
      if (eclCD < 1500) return true;
      const caReady = this.getCACdRemains() < 1500;
      if (caReady) {
        if (!spell.isSpellKnown(S.convoke)) return true;
        return (spell.getCooldown(S.convoke)?.timeleft || 99999) < 7500;
      }
    }
    return false;
  }

  // =============================================
  // DOT HELPERS — SimC: remains<2 | refreshable & eclipse_down
  // =============================================
  mfRefresh() {
    if (spell.getTimeSinceLastCast(S.moonfire) < 3000) return false;
    const t = this.getCurrentTarget();
    if (t && t.timeToDeath && t.timeToDeath() < MIN_DOT_TTD) return false;
    const rem = this.getDebuffRemaining(S.moonfire);
    return rem < 2000 || (rem < 5400 && this.eclipseDown()); // 18s * 0.3 = 5.4s pandemic
  }

  sfRefresh() {
    if (spell.getTimeSinceLastCast(S.sunfire) < 3000) return false;
    const t = this.getCurrentTarget();
    if (t && t.timeToDeath && t.timeToDeath() < MIN_DOT_TTD) return false;
    const rem = this.getDebuffRemaining(S.sunfire);
    return rem < 2000 || (rem < 5400 && this.eclipseDown());
  }

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isKeeperOfTheGrove() {
    return me.hasAura(A.treantsOfTheMoon) || spell.isSpellKnown(S.forceOfNature) ||
      spell.isSpellKnown(468743); // Whirling Stars = KotG exclusive
  }
  isElunesChosen() { return !this.isKeeperOfTheGrove(); }
  inCA() { return me.hasAura(A.celestialAlignment) || me.hasAura(A.incarnation); }

  // =============================================
  // COOLDOWN HELPERS
  // =============================================
  getCACdRemains() {
    const ca = spell.getCooldown(S.celestialAlignment);
    const inc = spell.getCooldown(S.incarnation);
    if (ca && ca.timeleft > 0) return ca.timeleft;
    if (inc && inc.timeleft > 0) return inc.timeleft;
    return 0;
  }
  getCAFullRecharge() {
    return spell.getFullRechargeTime(S.celestialAlignment) ||
      spell.getFullRechargeTime(S.incarnation) || 0;
  }
  getFoNCdRemains() { return spell.getCooldown(S.forceOfNature)?.timeleft || 0; }
  targetTTD() {
    const t = this.getCurrentTarget();
    if (!t || !t.timeToDeath) return 99999;
    return t.timeToDeath();
  }
  useCDs() { return combat.burstToggle || Settings.FWBalAutoCDs; }

  // =============================================
  // RESOURCE (cached per tick)
  // =============================================
  getAP() {
    if (this._apFrame === wow.frameTime) return this._cachedAP;
    this._apFrame = wow.frameTime;
    this._cachedAP = me.powerByType(PowerType.LunarPower);
    return this._cachedAP;
  }
  apDeficit() { return 120 - this.getAP(); }
  energize(id) {
    const a = { [S.forceOfNature]: 20, [S.wrath]: 10, [S.starfire]: 10,
      [S.newMoon]: 10, [S.halfMoon]: 20, [S.fullMoon]: 40 };
    return a[id] || 0;
  }

  // Moon cycle: New→Half→Full is a single transforming spell. Only the current phase is castable.
  castMoon() {
    return new bt.Selector(
      spell.cast(S.fullMoon, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(S.fullMoon) && this.apDeficit() > 40
      ),
      spell.cast(S.halfMoon, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(S.halfMoon) && this.apDeficit() > 20
      ),
      spell.cast(S.newMoon, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(S.newMoon) && this.apDeficit() > 10
      ),
    );
  }

  // =============================================
  // TARGET (cached per tick)
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const target = me.target;
    if (target !== null && common.validTarget(target) && me.distanceTo2D(target) <= 40 && me.isFacing(target)) {
      this._cachedTarget = target;
      return target;
    }
    if (me.inCombat()) {
      // Prefer targets we're facing to avoid cast stuttering
      const t = combat.targets.find(u => common.validTarget(u) && me.distanceTo2D(u) <= 40 && me.isFacing(u));
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

  findMoonfireTarget() {
    const ct = this.getCurrentTarget();
    if (ct && !this.unitHasMyDebuff(ct, S.moonfire)) return ct;
    const mfRem = this.getDebuffRemaining(S.moonfire);
    if (ct && (mfRem < 2000 || (mfRem < 5400 && this.eclipseDown()))) return ct;
    return combat.targets.find(u =>
      common.validTarget(u) && me.distanceTo2D(u) <= 40 && !this.unitHasMyDebuff(u, S.moonfire)
    ) || null;
  }

  unitHasMyDebuff(unit, id) {
    if (!unit) return false;
    const did = this.debuffId(id);
    return !!(unit.getAuraByMe(did) || unit.getAuraByMe(id));
  }

  // =============================================
  // MOTW
  // =============================================
  getMotwTarget() {
    if (spell.getTimeSinceLastCast(S.markOfTheWild) < 5000) return null;
    if (!this._hasMotw(me)) return me;
    const friends = me.getFriends ? me.getFriends(40) : [];
    return friends.find(u => u && !u.deadOrGhost && !this._hasMotw(u)) || null;
  }
  _hasMotw(unit) {
    if (!unit) return false;
    return unit.hasVisibleAura(S.markOfTheWild) || unit.hasAura(S.markOfTheWild) ||
      unit.auras.find(a => a.spellId === S.markOfTheWild) !== undefined;
  }

  // =============================================
  // DEBUFF
  // =============================================
  getDebuffRemaining(spellId) {
    const t = this.getCurrentTarget();
    if (!t) return 0;
    const did = this.debuffId(spellId);
    let d = t.getAuraByMe(did);
    if (!d && did !== spellId) d = t.getAuraByMe(spellId);
    if (!d) d = t.auras.find(a =>
      (a.spellId === did || a.spellId === spellId) && a.casterGuid?.equals(me.guid)
    );
    return d ? d.remaining : 0;
  }
  debuffId(id) {
    if (id === S.moonfire) return A.moonfireDebuff;
    if (id === S.sunfire) return A.sunfireDebuff;
    return id;
  }
}
