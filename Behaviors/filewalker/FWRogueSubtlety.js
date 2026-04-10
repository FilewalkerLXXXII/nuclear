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
 * Subtlety Rogue Behavior - Midnight 12.0.1
 * Line-by-line match to SimC APL (midnight branch):
 *   actions (default), actions.cds, actions.finish, actions.build, actions.fill
 *
 * Auto-detects: Deathstalker (457052) vs Trickster (441146)
 * Resource: Energy (PowerType 3) + Combo Points (PowerType 4)
 * All melee instant -- no movement block needed
 *
 * Key mechanics:
 *   - Shadow Dance windows: enter with shd_cp conditions, burst with ST + Evis
 *   - Shadow Blades + Shadow Dance alignment for burst
 *   - Secret Technique as primary burst finisher (during Dance or low CD)
 *   - Symbols of Death: off-GCD damage buff, sync with Dance/Blades
 *   - Flagellation: burst sync CD during Shadow Blades windows
 *   - Cold Blood: empowered finisher during Dance
 *   - Darkest Night: empowered Eviscerate at max CP (Deathstalker)
 *   - Coup de Grace at Escalating Blade stacks (Trickster)
 *   - Shadow Techniques stack management: Shadowstrike at 5+ stacks before Dance
 *   - Deathstalker's Mark application via Shadowstrike
 *   - Premeditation + Danse Macabre: Shuriken Storm after Dance entry
 *   - Goremaw's Bite for CP generation at deficit >= 3
 *   - Vanish at low CP + energy for stealth re-entry
 *   - Rupture maintenance for single target
 *   - Slice and Dice (via Eviscerate) maintenance
 *   - Shuriken Tornado for AoE burst
 *   - Haste trinket snapshot for Trickster Dance entry
 *   - Bloodlust-aware potion timing
 *
 * Hotfixes March 17: Backstab +20%, Shadowstrike +15%, Evis +8%, BP -12%
 */

const S = {
  // Builders
  backstab:           53,
  gloomblade:         200758,
  shadowstrike:       185438,
  shurikenStorm:      197835,
  goremawsBite:       209782,
  // Finishers
  eviscerate:         196819,
  blackPowder:        319175,
  rupture:            1943,
  sliceAndDice:       5171,
  secretTechnique:    280719,
  coupDeGrace:        441776,
  // CDs
  shadowDance:        185313,
  shadowBlades:       121471,
  symbolsOfDeath:     212283,
  flagellation:       384631,
  coldBlood:          1264297,
  thistleTea:         381623,
  shurikenTornado:    277925,
  vanish:             1856,
  stealth:            1784,
  // Utility
  kick:               1766,
  shadowstep:         36554,
  berserking:         26297,
};

const A = {
  // Self buffs
  shadowDance:        185422,
  shadowBlades:       121471,
  symbolsOfDeath:     212283,
  flagellation:       384631,
  stealth:            1784,
  vanishBuff:         11327,
  subterfuge:         115192,
  sliceAndDice:       5171,
  coldBlood:          1264297,
  premeditation:      343160,
  ancientArts:        1268939,
  supercharge1:       470347,  // Supercharger buff
  // Deathstalker hero
  deathstalkersMark:  457129,   // Debuff on target (3 stacks)
  darkestNight:       457058,   // Empowered Evis buff
  clearTheWitnesses:  1248793,
  lingeringDarkness:  457056,
  // Trickster hero
  escalatingBlade:    441786,
  flawlessForm:       441326,
  fazed:              441224,
  // Shadow Techniques
  shadowTechniques:   196912,
  // Rupture debuff
  rupture:            1943,
  // Find Weakness debuff
  findWeakness:       316220,
  // Bloodlust
  bloodlust:          2825,
  heroism:            32182,
  timewarp:           80353,
  // Hero detection
  deathstalkerKnown:  457052,
  tricksterKnown:     441146,
};

// Talent IDs
const T = {
  deathstalkersMark:  457052,
  unseenBlade:        441146,   // Trickster talent
  potentPoisons:      1265952,  // Potent Powder: BP +30% mastery dmg at 5+ CP
  potentPowder:       381847,
  danseMacabre:       382528,
  symbolsOfDeath:     212283,
  flagellation:       384631,
  coldBlood:          1264297,
  shurikenTornado:    277925,
  goremawsBite:       209782,
};

export class SubtletyRogueBehavior extends Behavior {
  name = 'FW Subtlety Rogue';
  context = BehaviorContext.Any;
  specialization = Specialization.Rogue.Sublety; // Typo in framework enum
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _energyFrame = 0;
  _cachedEnergy = 0;
  _cpFrame = 0;
  _cachedCP = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;
  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWSubUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWSubAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWSubDebug', text: 'Debug Logging', default: false },
      ],
    },
  ];

  // =============================================
  // HERO TALENT DETECTION
  // =============================================
  isDeathstalker() { return spell.isSpellKnown(A.deathstalkerKnown); }
  isTrickster() { return !this.isDeathstalker(); }

  // =============================================
  // CACHED RESOURCE ACCESSORS
  // =============================================
  getCurrentTarget() {
    if (this._targetFrame === wow.frameTime) return this._cachedTarget;
    this._targetFrame = wow.frameTime;
    const t = me.target;
    if (t && common.validTarget(t) && me.distanceTo(t) <= 8 && me.isFacing(t)) {
      this._cachedTarget = t;
      return t;
    }
    if (me.inCombat()) {
      const ct = combat.bestTarget || (combat.targets && combat.targets[0]);
      if (ct && common.validTarget(ct) && me.distanceTo(ct) <= 8 && me.isFacing(ct)) {
        this._cachedTarget = ct;
        return ct;
      }
    }
    this._cachedTarget = null;
    return null;
  }

  getEnergy() {
    if (this._energyFrame === wow.frameTime) return this._cachedEnergy;
    this._energyFrame = wow.frameTime;
    this._cachedEnergy = me.powerByType(PowerType.Energy);
    return this._cachedEnergy;
  }

  getEnergyMax() { return me.maxPowerByType ? me.maxPowerByType(PowerType.Energy) : 100; }
  getEnergyDeficit() { return this.getEnergyMax() - this.getEnergy(); }

  getCP() {
    if (this._cpFrame === wow.frameTime) return this._cachedCP;
    this._cpFrame = wow.frameTime;
    this._cachedCP = me.powerByType(PowerType.ComboPoints);
    return this._cachedCP;
  }

  getCPMax() { return me.maxPowerByType ? me.maxPowerByType(PowerType.ComboPoints) : 7; }
  getCPDeficit() { return this.getCPMax() - this.getCP(); }

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

  // =============================================
  // SIMC VARIABLES
  // =============================================
  // variable.stealth = buff.shadow_dance.up|buff.stealth.up|buff.vanish.up
  inStealth() {
    return me.hasAura(A.shadowDance) || me.hasAura(A.stealth) || me.hasAura(A.vanishBuff) || me.hasAura(A.subterfuge);
  }

  inDance() { return me.hasAura(A.shadowDance); }
  inShadowBlades() { return me.hasAura(A.shadowBlades); }
  hasSymbols() { return me.hasAura(A.symbolsOfDeath); }
  hasDarkestNight() { return me.hasAura(A.darkestNight); }

  // variable.targets = spell_targets.shuriken_storm
  getTargets() { return this.getEnemyCount(); }

  // variable.shd_cp = combo_points<=2&talent.deathstalkers_mark|combo_points>=6&talent.unseen_blade|variable.targets>=5
  shdCP() {
    if (this.isDeathstalker() && this.getCP() <= 2) return true;
    if (this.isTrickster() && this.getCP() >= 6) return true;
    if (this.getTargets() >= 5) return true;
    return false;
  }

  // variable.racial_sync = (buff.shadow_blades.up&buff.shadow_dance.up)|fight_remains<20
  racialSync() {
    return (this.inShadowBlades() && this.inDance()) || this.targetTTD() < 20000;
  }

  // variable.haste_trinket_snapshot = (trinket.1.proc.haste.remains<=1&trinket.1.proc.haste.up)|(trinket.2.proc.haste.remains<=1&trinket.2.proc.haste.up)
  // Approximation: check if a haste trinket proc is about to end (within 1s)
  // Framework doesn't track trinket procs directly, but we can approximate via
  // checking if we recently snapshotted haste -- for now, always return false
  // as a safe fallback (the Dance entry still triggers via other conditions)
  hasHasteTrinketSnapshot() { return false; }

  getShadowTechStacks() {
    const a = me.getAura(A.shadowTechniques);
    return a ? a.stacks : 0;
  }

  getEscalatingBladeStacks() {
    const a = me.getAura(A.escalatingBlade);
    return a ? a.stacks : 0;
  }

  // Symbols of Death remaining
  getSymbolsRemaining() {
    const a = me.getAura(A.symbolsOfDeath);
    return a ? a.remaining : 0;
  }

  // Bloodlust check
  hasBloodlust() {
    return me.hasAura(A.bloodlust) || me.hasAura(A.heroism) || me.hasAura(A.timewarp);
  }

  // =============================================
  // BUILD -- Main behavior tree
  // =============================================
  build() {
    return new bt.Selector(
      common.waitForNotMounted(),
      common.waitForNotSitting(),
      // Combat check
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
          console.info(`[SubRogue] Midnight 12.0.1 | Hero: ${this.isDeathstalker() ? 'Deathstalker' : 'Trickster'}`);
        }
        if (Settings.FWSubDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[Sub] E:${Math.round(this.getEnergy())} CP:${this.getCP()}/${this.getCPMax()} Dance:${this.inDance()} SB:${this.inShadowBlades()} SoD:${this.hasSymbols()} DN:${this.hasDarkestNight()} ST:${this.getShadowTechStacks()} Tgts:${this.getTargets()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // SimC: actions+=/kick (implicit via interrupt)
          spell.interrupt(S.kick),

          // SimC: actions+=/call_action_list,name=cds
          this.cooldowns(),

          // SimC: shadowstrike special case before finishers
          // shadowstrike,if=(buff.darkest_night.up&variable.targets<=4|(talent.unseen_blade&buff.supercharge_1.up))&
          //   buff.shadow_techniques.stack>=5&!buff.ancient_arts.up&!cooldown.secret_technique.ready
          spell.cast(S.shadowstrike, () => this.getCurrentTarget(), () => {
            const dn = this.hasDarkestNight();
            const unseen = this.isTrickster();
            const sc1 = me.hasAura(A.supercharge1);
            const dnCheck = dn && this.getTargets() <= 4;
            const unseenCheck = unseen && sc1;
            if (!dnCheck && !unseenCheck) return false;
            if (this.getShadowTechStacks() < 5) return false;
            if (me.hasAura(A.ancientArts)) return false;
            const stReady = spell.getCooldown(S.secretTechnique)?.ready || false;
            return !stReady;
          }),

          // SimC: call_action_list,name=finish,if=combo_points>=cp_max_spend-!buff.darkest_night.up
          new bt.Decorator(
            () => {
              const threshold = this.getCPMax() - (this.hasDarkestNight() ? 0 : 1);
              return this.getCP() >= threshold;
            },
            this.finishers(),
            new bt.Action(() => bt.Status.Failure)
          ),

          // SimC: call_action_list,name=build,if=variable.stealth|energy>60
          new bt.Decorator(
            () => this.inStealth() || this.getEnergy() > 60,
            this.builders(),
            new bt.Action(() => bt.Status.Failure)
          ),
        )
      ),
    );
  }

  // =============================================
  // CDS -- SimC: actions.cds (6 lines + racials)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // SimC: symbols_of_death (off-GCD, use on cooldown during Dance or before Dance)
      // Not in SimC APL cds list explicitly but is a core buff -- use during Dance or before
      spell.cast(S.symbolsOfDeath, () => me, () => {
        if (!Settings.FWSubUseCDs) return false;
        if (!spell.isSpellKnown(T.symbolsOfDeath)) return false;
        if (this.hasSymbols()) return false;
        // Use during Shadow Dance or when about to Dance
        const danceReady = spell.getCooldown(S.shadowDance)?.ready || false;
        return this.inDance() || this.inShadowBlades() || danceReady;
      }),

      // SimC: flagellation (burst sync CD)
      spell.cast(S.flagellation, () => this.getCurrentTarget(), () => {
        if (!Settings.FWSubUseCDs) return false;
        if (!spell.isSpellKnown(T.flagellation)) return false;
        // Use during Shadow Blades + Dance for maximum burst
        return this.inShadowBlades() && this.inDance();
      }),

      // SimC: cold_blood (off-GCD finisher empower)
      spell.cast(S.coldBlood, () => me, () => {
        if (!Settings.FWSubUseCDs) return false;
        if (!spell.isSpellKnown(T.coldBlood)) return false;
        if (me.hasAura(A.coldBlood)) return false;
        // Use during Dance when about to finisher
        const threshold = this.getCPMax() - (this.hasDarkestNight() ? 0 : 1);
        return this.inDance() && this.getCP() >= threshold;
      }),

      // SimC: shuriken_tornado (AoE burst CD)
      spell.cast(S.shurikenTornado, () => me, () => {
        if (!Settings.FWSubUseCDs) return false;
        if (!spell.isSpellKnown(T.shurikenTornado)) return false;
        // Use during Dance for AoE
        return this.inDance() && this.getTargets() >= 3;
      }),

      // SimC: shadow_blades,if=variable.shd_cp&cooldown.shadow_dance.ready&cooldown.secret_technique.ready|fight_remains<=10
      spell.cast(S.shadowBlades, () => me, () => {
        if (!Settings.FWSubUseCDs) return false;
        if (this.targetTTD() <= 10000) return true;
        if (!this.shdCP()) return false;
        const danceReady = spell.getCooldown(S.shadowDance)?.ready || false;
        const stReady = spell.getCooldown(S.secretTechnique)?.ready || false;
        return danceReady && stReady;
      }),

      // SimC: shadow_dance,if=!variable.stealth&variable.shd_cp&energy>=30&
      //   ((cooldown.secret_technique.ready|buff.darkest_night.up)&(cooldown.shadow_blades.remains>=9)|
      //    (buff.shadow_blades.up&cooldown.secret_technique.duration>=18))|fight_remains<=10
      spell.cast(S.shadowDance, () => me, () => {
        if (!Settings.FWSubUseCDs) return false;
        if (this.inStealth()) return false;
        if (this.targetTTD() <= 10000) return true;
        if (!this.shdCP()) return false;
        if (this.getEnergy() < 30) return false;
        const stReady = spell.getCooldown(S.secretTechnique)?.ready || false;
        const dn = this.hasDarkestNight();
        const sbCD = spell.getCooldown(S.shadowBlades)?.timeleft || 0;
        const sbUp = this.inShadowBlades();
        const stDuration = spell.getCooldown(S.secretTechnique)?.duration || 18000;
        if ((stReady || dn) && sbCD >= 9000) return true;
        if (sbUp && stDuration >= 18000) return true;
        return false;
      }),

      // SimC: shadow_dance,if=buff.shadow_blades.up&talent.unseen_blade&variable.haste_trinket_snapshot&cooldown.secret_technique.remains<=4
      spell.cast(S.shadowDance, () => me, () => {
        if (!Settings.FWSubUseCDs) return false;
        if (this.inStealth()) return false;
        if (!this.inShadowBlades()) return false;
        if (!this.isTrickster()) return false;
        if (!this.hasHasteTrinketSnapshot()) return false;
        const stCD = spell.getCooldown(S.secretTechnique)?.timeleft || 99999;
        return stCD <= 4000;
      }),

      // SimC: vanish,if=!variable.stealth&energy>=50&!buff.subterfuge.up&combo_points<=1
      spell.cast(S.vanish, () => me, () => {
        if (!Settings.FWSubUseCDs) return false;
        if (this.inStealth()) return false;
        if (this.getEnergy() < 50) return false;
        if (me.hasAura(A.subterfuge)) return false;
        return this.getCP() <= 1;
      }),

      // SimC: berserking,if=variable.racial_sync
      spell.cast(S.berserking, () => me, () => this.racialSync()),
    );
  }

  // =============================================
  // FINISHERS -- SimC: actions.finish (5 lines)
  // =============================================
  finishers() {
    return new bt.Selector(
      // SimC: secret_technique,if=buff.shadow_dance.up|cooldown.secret_technique.duration<18&!cooldown.shadow_dance.ready
      spell.cast(S.secretTechnique, () => this.getCurrentTarget(), () => {
        if (this.inDance()) return true;
        const stDuration = spell.getCooldown(S.secretTechnique)?.duration || 18000;
        const danceReady = spell.getCooldown(S.shadowDance)?.ready || false;
        return stDuration < 18000 && !danceReady;
      }),

      // SimC: eviscerate,if=buff.darkest_night.up
      spell.cast(S.eviscerate, () => this.getCurrentTarget(), () => {
        return this.hasDarkestNight();
      }),

      // SimC: coup_de_grace,if=cooldown.secret_technique.remains>=3|buff.shadow_dance.up
      spell.cast(S.coupDeGrace, () => this.getCurrentTarget(), () => {
        if (!this.isTrickster()) return false;
        const stCD = spell.getCooldown(S.secretTechnique)?.timeleft || 0;
        return stCD >= 3000 || this.inDance();
      }),

      // SimC: black_powder,if=variable.targets>=3-talent.potent_powder
      spell.cast(S.blackPowder, () => this.getCurrentTarget(), () => {
        const potent = spell.isSpellKnown(T.potentPowder) ? 1 : 0;
        return this.getTargets() >= 3 - potent;
      }),

      // SimC: eviscerate,if=cooldown.secret_technique.remains>=3|buff.shadow_dance.up|buff.shadow_blades.up|talent.deathstalkers_mark
      // Note: Eviscerate applies Slice and Dice via talent (Cut to the Bone) so SnD is maintained implicitly
      spell.cast(S.eviscerate, () => this.getCurrentTarget(), () => {
        const stCD = spell.getCooldown(S.secretTechnique)?.timeleft || 0;
        if (stCD >= 3000) return true;
        if (this.inDance()) return true;
        if (this.inShadowBlades()) return true;
        if (this.isDeathstalker()) return true;
        // Fallback: maintain Slice and Dice if it's about to drop
        const snd = me.getAura(A.sliceAndDice);
        if (!snd || snd.remaining < 6000) return true;
        return false;
      }),
    );
  }

  // =============================================
  // BUILDERS -- SimC: actions.build (6 lines)
  // =============================================
  builders() {
    return new bt.Selector(
      // SimC: shuriken_storm,if=prev.shadow_dance&buff.premeditation.up&talent.danse_macabre
      spell.cast(S.shurikenStorm, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.danseMacabre)) return false;
        if (!me.hasAura(A.premeditation)) return false;
        // prev.shadow_dance approximation: Shadow Dance was just cast
        return spell.getTimeSinceLastCast(S.shadowDance) < 2000;
      }),

      // SimC: shadowstrike,if=!debuff.deathstalkers_mark.up&talent.deathstalkers_mark&!buff.darkest_night.up|variable.targets<=3|variable.priority_rotation
      spell.cast(S.shadowstrike, () => this.getCurrentTarget(), () => {
        if (!this.inStealth()) return false;
        if (this.isDeathstalker()) {
          const t = this.getCurrentTarget();
          const hasMark = t && t.getAuraByMe(A.deathstalkersMark) !== undefined;
          if (!hasMark && !this.hasDarkestNight()) return true;
        }
        return this.getTargets() <= 3;
      }),

      // SimC: shuriken_storm,if=variable.targets>1 (in stealth)
      spell.cast(S.shurikenStorm, () => this.getCurrentTarget(), () => {
        if (!this.inStealth()) return false;
        return this.getTargets() > 1;
      }),

      // SimC: shadowstrike (fallback in stealth)
      spell.cast(S.shadowstrike, () => this.getCurrentTarget(), () => {
        return this.inStealth();
      }),

      // SimC: goremaws_bite,if=combo_points.deficit>=3
      spell.cast(S.goremawsBite, () => this.getCurrentTarget(), () => {
        return this.getCPDeficit() >= 3;
      }),

      // Outside stealth builders
      // SimC: shuriken_storm,if=variable.targets>1 (outside stealth AoE)
      spell.cast(S.shurikenStorm, () => this.getCurrentTarget(), () => {
        return this.getTargets() > 1;
      }),

      // SimC: gloomblade,if=variable.targets<2
      spell.cast(S.gloomblade, () => this.getCurrentTarget(), () => {
        return spell.isSpellKnown(S.gloomblade) && this.getTargets() < 2;
      }),

      // SimC: backstab,if=variable.targets<2
      spell.cast(S.backstab, () => this.getCurrentTarget(), () => {
        return !spell.isSpellKnown(S.gloomblade) && this.getTargets() < 2;
      }),
    );
  }
}
