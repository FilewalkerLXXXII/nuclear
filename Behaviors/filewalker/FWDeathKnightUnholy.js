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
 * Unholy Death Knight Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (deathknight_unholy.simc) + Method (all pages) + Wowhead
 *
 * Auto-detects: Rider of the Apocalypse vs San'layn
 * No hero-specific rotation lists — Midnight APL uses shared lists with talent checks
 *
 * SimC action lists matched line-by-line:
 *   variables (5): spending_rp, st_planning, adds_remain, cds_active, epidemic_prio
 *   racials (8): berserking/blood_fury during cds_active
 *   cooldowns (7): outbreak, army, DT, soul_reaper, putrefy (complex)
 *   single_target (6): Festering Scythe maint, spending RP, FS build, SS consume, Putrefy, DC filler
 *   aoe (9): DnD, Festering Scythe, Epidemic/DC spending, FS build, SS consume, Putrefy, Epi/DC filler
 *
 * Core Midnight mechanic: Lesser Ghoul stacking
 *   Festering Strike → generates Lesser Ghoul stacks (buff.lesser_ghoul_ready)
 *   Scourge Strike → consumes stacks to summon Lesser Ghouls
 *   Resource: Runes + Runic Power. All melee instant — no movement block needed.
 *
 * Hotfixes March 17-18: -20% base, +8% partial revert, DC +30%, SS/VS +25%, FS +35%
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL + Method + Wowhead',
};

const S = {
  festeringStrike:    85948,
  scourgeStrike:      55090,
  deathCoil:          47541,
  epidemic:           207317,
  outbreak:           77575,
  darkTransformation: 1233448,  // Midnight cast ID (confirmed)
  armyOfTheDead:      42650,
  soulReaper:         343294,
  putrefy:            1247378,
  deathAndDecay:      43265,
  raiseDead:          46584,
  // Defensives
  antiMagicShell:     48707,
  iceboundFortitude:  48792,
  deathStrike:        49998,
  // Interrupt
  mindFreeze:         47528,
  // Racials
  berserking:         26297,
};

// Talent IDs for spell.isSpellKnown() checks
const T = {
  festeringScythe:    458128,  // Spell/talent ID (confirmed)
  pestilence:         1271974,
  inflictionOfSorrow: 434143,
  blightburst:        1254552,
  summonGargoyle:     1242147,
  soulReaper:         343294,
  desecrate:          1234559,  // DnD talent variant (confirmed)
  reaping:            377514,
  armyOfTheDead:      42650,
  commanderOfTheDead: 390259,
};

const A = {
  // Core procs
  suddenDoom:         49530,
  lesserGhoulReady:   1254252,  // Stacks: FS generates, SS consumes
  festeringScythe:    458123,   // Player buff: proc from Festering Strike (confirmed)
  festeringScytheDeb: 458123,  // Same as buff — no separate debuff ID known
  // Diseases
  virulentPlague:     191587,
  dreadPlague:        1240996,
  // Buffs
  darkTransformation: 1233448,  // DT active buff (confirmed)
  darkTransformationAlt: 1233448, // Same as primary (63560 doesn't exist in Midnight)
  forbiddenKnowledge: 1242158,  // 30s after Army
  pestilenceBuff:     1271975,  // Pestilence upgrade active (confirmed)
  reapingBuff:        377514,   // Reaping active during DT — TODO: verify
  // San'layn
  giftOfSanlayn:      434152,
  essenceBloodQueen:  433925,
  vampiricStrikeProc: 433899,
  // Hero detection
  ridersChampion:     444005,
  vampiricStrike:     433901,
};

export class UnholyDeathknightBehavior extends Behavior {
  name = 'FW Unholy Death Knight';
  context = BehaviorContext.Any;
  specialization = Specialization.DeathKnight.Unholy;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _rpFrame = 0;
  _cachedRP = 0;
  _runeFrame = 0;
  _cachedRunes = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;

  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWUdkUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWUdkAoECount', text: 'AoE Target Count', default: 4, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWUdkDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWUdkAMS', text: 'Use AMS for RP', default: true },
        { type: 'checkbox', uid: 'FWUdkIBF', text: 'Use IBF', default: true },
        { type: 'slider', uid: 'FWUdkIBFHP', text: 'IBF HP %', default: 35, min: 10, max: 50 },
        { type: 'checkbox', uid: 'FWUdkDS', text: 'Use Death Strike', default: true },
        { type: 'slider', uid: 'FWUdkDSHP', text: 'Death Strike HP %', default: 40, min: 15, max: 60 },
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

      // OOC: Raise Dead (permanent ghoul)
      spell.cast(S.raiseDead, () => me, () => !me.inCombat() && (!me.pet || me.pet.deadOrGhost)),

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

      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      // Version + Debug
      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          const hero = this.isRider() ? 'Rider' : "San'layn";
          console.info(`[UnholyDK] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${hero} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWUdkDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[UnholyDK] RP:${Math.round(this.getRP())} Runes:${this.getRunes()} LG:${this.getLGStacks()} DT:${this.inDT()} FK:${this.hasFK()} SD:${this.hasSD()} CDsAct:${this.cdsActive()} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.mindFreeze),
          this.defensives(),

          // SimC: racials — Berserking during cds_active
          spell.cast(S.berserking, () => me, () => this.cdsActive()),

          // SimC: cooldowns
          this.cooldowns(),

          // SimC dispatch: AoE >= 4, else ST
          new bt.Decorator(
            () => this.getEnemyCount() >= Settings.FWUdkAoECount,
            this.aoeRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),
          this.stRotation(),
        )
      ),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cooldowns, 7 lines)
  // =============================================
  cooldowns() {
    return new bt.Selector(
      // 1. Outbreak: VP ticks_remain < 3 & complex conditions
      // SimC: outbreak,if=dot.virulent_plague.ticks_remain<3&!buff.pestilence.up&fight_remains>5&(!talent.blightburst|talent.blightburst&cooldown.putrefy.remains_expected>7)|buff.pestilence.up&dot.virulent_plague.ticking&(!talent.infliction_of_sorrow&cooldown.dark_transformation.remains<3|talent.infliction_of_sorrow&!buff.gift_of_the_sanlayn.up|fight_remains>7|...)
      spell.cast(S.outbreak, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t || this.targetTTD() < 5000) return false;
        const vp = t.getAuraByMe(A.virulentPlague);
        const vpLow = !vp || vp.remaining < 5000; // ~3 ticks remaining
        const hasPest = me.hasAura(A.pestilenceBuff);
        if (!hasPest) {
          // No Pestilence: refresh when VP low & (!blightburst | putrefy CD > 7)
          if (!vpLow) return false;
          if (spell.isSpellKnown(T.blightburst)) {
            return (spell.getCooldown(S.putrefy)?.timeleft || 0) > 7000;
          }
          return true;
        }
        // Pestilence up & VP ticking: complex refresh conditions
        if (!vp) return false;
        if (spell.isSpellKnown(T.inflictionOfSorrow)) {
          // IoS: refresh when NOT in Gift of the San'layn
          return !this.inGift();
        }
        // Non-IoS: refresh before DT (CD < 3s) or fight > 7s
        const dtCD = spell.getCooldown(S.darkTransformation)?.timeleft || 99999;
        return dtCD < 3000 || this.targetTTD() > 7000;
      }),

      // 2. Army of the Dead: (st_planning|adds_remain) & (Gargoyle+RP>=30 | FestScythe debuff | !FestScythe)
      // SimC: army_of_the_dead,if=(variable.st_planning|variable.adds_remain)&(talent.summon_gargoyle&runic_power>=30|debuff.festering_scythe_debuff.up|!talent.festering_scythe)
      spell.cast(S.armyOfTheDead, () => me, () => {
        if (!Settings.FWUdkUseCDs || !this.sendingCDs()) return false;
        if (spell.isSpellKnown(T.summonGargoyle) && this.getRP() < 30) return false;
        if ((spell.isSpellKnown(T.festeringScythe) || spell.isSpellKnown(A.festeringScythe))) {
          return this.targetHasFSDebuff();
        }
        return true;
      }),

      // 3. Dark Transformation: (st_planning|adds_remain) & (army active | army CD > 30 | !army)
      // SimC: dark_transformation,if=(variable.st_planning|variable.adds_remain)&pet.lesser_ghoul_army.active|cooldown.army_of_the_dead.remains>30|!talent.army_of_the_dead
      spell.cast(S.darkTransformation, () => me, () => {
        if (!Settings.FWUdkUseCDs) return false;
        // Army active approximation
        const armyRecent = spell.getTimeSinceLastCast(S.armyOfTheDead) < 15000;
        if (this.sendingCDs() && armyRecent) return true;
        const armyCD = spell.getCooldown(S.armyOfTheDead)?.timeleft || 99999;
        return armyCD > 30000 || !spell.isSpellKnown(T.armyOfTheDead);
      }),

      // 4. Soul Reaper: !pestilence | (pestilence & IoS & (DT.remains<5 | reaping<=gcd)) | target<35%
      // SimC: soul_reaper,if=!talent.pestilence|talent.pestilence&talent.infliction_of_sorrow&(buff.dark_transformation.remains<5|buff.reaping.remains<=gcd.max)|target.health.pct<=35
      spell.cast(S.soulReaper, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.soulReaper)) return false;
        const t = this.getCurrentTarget();
        if (!t) return false;
        if (t.effectiveHealthPercent <= 35) return true;
        if (!spell.isSpellKnown(T.pestilence)) return true;
        if (spell.isSpellKnown(T.inflictionOfSorrow)) {
          const dtAura = this.getDTAura();
          if (dtAura && dtAura.remaining < 5000) return true;
          const reaping = me.getAura(A.reapingBuff);
          if (reaping && reaping.remaining <= 1500) return true;
        }
        return false;
      }),

      // 5. Putrefy: complex conditions
      // SimC: putrefy,if=(variable.st_planning|variable.adds_remain)&(cooldown.dark_transformation.remains>15&runic_power<90&(talent.soul_reaper&target.health.pct>35&!action.soul_reaper.ready|!talent.soul_reaper&(talent.commander_of_the_dead&!cooldown.dark_transformation.ready|!talent.commander_of_the_dead))|charges=max_charges&(cooldown.dark_transformation.remains>gcd.max|!talent.reaping)|buff.reaping.up&talent.infliction_of_sorrow&talent.pestilence&buff.dark_transformation.remains>10&(charges=max_charges|!dot.virulent_plague.ticking&talent.blightburst))
      spell.cast(S.putrefy, () => this.getCurrentTarget(), () => {
        if (!Settings.FWUdkUseCDs || !this.sendingCDs()) return false;
        const dtCD = spell.getCooldown(S.darkTransformation)?.timeleft || 0;
        const putCharges = spell.getCharges(S.putrefy) || 0;
        const putMaxCharges = 2;
        const t = this.getCurrentTarget();

        // Branch 1: dt.cd > 15 & RP < 90 & (soul_reaper checks | commander checks)
        if (dtCD > 15000 && this.getRP() < 90) {
          if (spell.isSpellKnown(T.soulReaper)) {
            if (t && t.effectiveHealthPercent > 35 && !(spell.getCooldown(S.soulReaper)?.ready)) return true;
          } else {
            if (spell.isSpellKnown(T.commanderOfTheDead)) {
              if (!(spell.getCooldown(S.darkTransformation)?.ready)) return true;
            } else {
              return true;
            }
          }
        }

        // Branch 2: charges = max & (dt.cd > gcd | !reaping)
        if (putCharges >= putMaxCharges) {
          if (dtCD > 1500 || !spell.isSpellKnown(T.reaping)) return true;
        }

        // Branch 3: reaping.up & IoS & pestilence & DT.remains > 10 & (max_charges | !vp & blightburst)
        const reaping = me.getAura(A.reapingBuff);
        if (reaping && spell.isSpellKnown(T.inflictionOfSorrow) && spell.isSpellKnown(T.pestilence)) {
          const dtAura = this.getDTAura();
          if (dtAura && dtAura.remaining > 10000) {
            if (putCharges >= putMaxCharges) return true;
            if (spell.isSpellKnown(T.blightburst)) {
              const vp = t?.getAuraByMe(A.virulentPlague);
              if (!vp) return true;
            }
          }
        }

        return false;
      }),
    );
  }

  // =============================================
  // SINGLE TARGET (SimC actions.single_target, 6 lines)
  // =============================================
  stRotation() {
    return new bt.Selector(
      // 1. Festering Scythe: buff up → cast transformed spell (458128), else Festering Strike
      spell.cast(T.festeringScythe, () => this.getCurrentTarget(), () => me.hasAura(A.festeringScythe)),
      spell.cast(S.festeringStrike, () => this.getCurrentTarget(), () => me.hasAura(A.festeringScythe)),

      // 2. Death Coil: spending_rp
      // SimC: death_coil,if=variable.spending_rp
      // Note: Sudden Doom makes DC free, so no RP check when SD is up
      spell.cast(S.deathCoil, () => this.getCurrentTarget(), () =>
        this.spendingRP() && (this.hasSD() || this.getRP() >= 30)
      ),

      // 3. Festering Strike: lesser_ghoul_ready.stack = 0
      // SimC: festering_strike,if=buff.lesser_ghoul_ready.stack=0
      spell.cast(S.festeringStrike, () => this.getCurrentTarget(), () =>
        this.getLGStacks() === 0
      ),

      // 4. Scourge Strike: lesser_ghoul_ready.stack >= 1
      // SimC: scourge_strike,if=buff.lesser_ghoul_ready.stack>=1
      spell.cast(S.scourgeStrike, () => this.getCurrentTarget(), () =>
        this.getLGStacks() >= 1
      ),

      // 5. Putrefy: !soul_reaper & DT CD > 12
      // SimC: putrefy,if=!talent.soul_reaper&cooldown.dark_transformation.remains>12
      spell.cast(S.putrefy, () => this.getCurrentTarget(), () =>
        !spell.isSpellKnown(T.soulReaper) &&
        (spell.getCooldown(S.darkTransformation)?.timeleft || 0) > 12000
      ),

      // 6. Death Coil (absolute filler)
      // SimC: death_coil (no condition = unconditional)
      // SD makes it free; otherwise need RP
      spell.cast(S.deathCoil, () => this.getCurrentTarget(), () =>
        this.hasSD() || this.getRP() >= 30
      ),
    );
  }

  // =============================================
  // AOE (SimC actions.aoe, 9 lines, 4+ targets)
  // =============================================
  aoeRotation() {
    return new bt.Selector(
      // 1. Death and Decay: !ticking & talent.desecrate
      // SimC: death_and_decay,if=!death_and_decay.ticking&talent.desecrate
      spell.cast(S.deathAndDecay, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.desecrate) && spell.getTimeSinceLastCast(S.deathAndDecay) > 10000
      ),

      // 2. Festering Strike: Festering Scythe maintenance (same as ST)
      // SimC: festering_strike,if=talent.festering_scythe&(buff.festering_scythe.up&(buff.festering_scythe.remains<=3|debuff.festering_scythe_debuff.remains<3)|!buff.festering_scythe.up&debuff.festering_scythe_debuff.remains<3)
      spell.cast(S.festeringStrike, () => this.getCurrentTarget(), () => {
        if (!(spell.isSpellKnown(T.festeringScythe) || spell.isSpellKnown(A.festeringScythe))) return false;
        const fsBuff = me.getAura(A.festeringScythe);
        const t = this.getCurrentTarget();
        if (!t) return false;
        const fsDebuff = t.getAuraByMe(A.festeringScytheDeb);
        if (fsBuff) {
          return fsBuff.remaining <= 3000 || (fsDebuff ? fsDebuff.remaining < 3000 : true);
        }
        return !fsDebuff || fsDebuff.remaining < 3000;
      }),

      // 3. Epidemic: spending_rp & epidemic_prio
      // SimC: epidemic,if=variable.spending_rp&variable.epidemic_prio
      spell.cast(S.epidemic, () => this.getCurrentTarget(), () =>
        this.spendingRP() && this.epidemicPrio() && (this.hasSD() || this.getRP() >= 30)
      ),

      // 4. Death Coil: spending_rp & !epidemic_prio
      // SimC: death_coil,if=variable.spending_rp&!variable.epidemic_prio
      spell.cast(S.deathCoil, () => this.getCurrentTarget(), () =>
        this.spendingRP() && !this.epidemicPrio() && (this.hasSD() || this.getRP() >= 30)
      ),

      // 5. Festering Strike: lesser_ghoul_ready.stack = 0
      spell.cast(S.festeringStrike, () => this.getCurrentTarget(), () =>
        this.getLGStacks() === 0
      ),

      // 6. Scourge Strike: lesser_ghoul_ready.stack >= 1
      spell.cast(S.scourgeStrike, () => this.getCurrentTarget(), () =>
        this.getLGStacks() >= 1
      ),

      // 7. Putrefy (on CD in AoE — SimC: putrefy, no condition)
      spell.cast(S.putrefy, () => this.getCurrentTarget()),

      // 8. Epidemic: epidemic_prio (filler)
      // SimC: epidemic,if=variable.epidemic_prio
      spell.cast(S.epidemic, () => this.getCurrentTarget(), () =>
        this.epidemicPrio() && (this.hasSD() || this.getRP() >= 30)
      ),

      // 9. Death Coil: !epidemic_prio (filler)
      // SimC: death_coil,if=!variable.epidemic_prio
      spell.cast(S.deathCoil, () => this.getCurrentTarget(), () =>
        !this.epidemicPrio() && (this.hasSD() || this.getRP() >= 30)
      ),
    );
  }

  // =============================================
  // DEFENSIVES
  // =============================================
  defensives() {
    return new bt.Selector(
      spell.cast(S.antiMagicShell, () => me, () =>
        Settings.FWUdkAMS && (125 - this.getRP()) > 40 && this.getRunes() < 2
      ),
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () =>
        Settings.FWUdkDS && me.effectiveHealthPercent < Settings.FWUdkDSHP && this.getRP() >= 35
      ),
      spell.cast(S.iceboundFortitude, () => me, () =>
        Settings.FWUdkIBF && me.effectiveHealthPercent < Settings.FWUdkIBFHP
      ),
      new bt.Action(() => bt.Status.Failure)
    );
  }

  // =============================================
  // SIMC VARIABLE HELPERS
  // =============================================
  isRider() { return spell.isSpellKnown(A.ridersChampion); }
  isSanlayn() { return !this.isRider(); }

  // variable.spending_rp = rune<2 | (forbidden_knowledge.up & rune<4) | sudden_doom.react
  // SimC: variable,name=spending_rp,value=rune<2|buff.forbidden_knowledge.up&rune<4|buff.sudden_doom.react
  spendingRP() {
    if (this.getRunes() < 2) return true;
    if (this.hasFK() && this.getRunes() < 4) return true;
    if (this.hasSD()) return true;
    return false;
  }

  // variable.cds_active = lesser_ghoul_army.active | forbidden_knowledge.up | DT.up & DT.remains>5
  // SimC: variable,name=cds_active,value=pet.lesser_ghoul_army.active|buff.forbidden_knowledge.up|buff.dark_transformation.up&buff.dark_transformation.remains>5
  cdsActive() {
    if (spell.getTimeSinceLastCast(S.armyOfTheDead) < 15000) return true; // army active approx
    if (this.hasFK()) return true;
    const dt = this.getDTAura();
    return dt && dt.remaining > 5000;
  }

  // variable.sending_cds: (st_planning | adds_remain)
  // Simplified: CDs enabled + TTD > 15s
  sendingCDs() { return Settings.FWUdkUseCDs && this.targetTTD() > 15000; }

  // variable.epidemic_prio = active_enemies >= 4 - pet.whitemane.active & !FK | active_enemies >= 6 - pet.whitemane.active & FK
  // SimC: variable,name=epidemic_prio,value=active_enemies>=4-pet.whitemane.active&!buff.forbidden_knowledge.up|active_enemies>=6-pet.whitemane.active&buff.forbidden_knowledge.up
  epidemicPrio() {
    const enemies = this.getEnemyCount();
    // Whitemane active: Rider + Army recently cast
    const whitemane = this.isRider() && spell.getTimeSinceLastCast(S.armyOfTheDead) < 15000;
    const adj = whitemane ? 1 : 0;
    if (!this.hasFK()) return enemies >= (4 - adj);
    return enemies >= (6 - adj);
  }

  // Buff helpers
  hasSD() { return me.hasAura(A.suddenDoom); }
  hasFK() { return me.hasAura(A.forbiddenKnowledge); }
  inDT() { return me.hasAura(A.darkTransformation) || me.hasAura(A.darkTransformationAlt); }
  inGift() { return this.isSanlayn() && this.inDT(); }

  getDTAura() {
    return me.getAura(A.darkTransformation) || me.getAura(A.darkTransformationAlt);
  }

  getLGStacks() {
    const aura = me.getAura(A.lesserGhoulReady);
    return aura ? aura.stacks : 0;
  }

  targetHasFSDebuff() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    return !!(t.getAuraByMe(A.festeringScytheDeb));
  }

  // =============================================
  // RESOURCE HELPERS (cached per tick)
  // =============================================
  getRP() {
    if (this._rpFrame === wow.frameTime) return this._cachedRP;
    this._rpFrame = wow.frameTime;
    this._cachedRP = me.powerByType(PowerType.RunicPower);
    return this._cachedRP;
  }

  getRunes() {
    if (this._runeFrame === wow.frameTime) return this._cachedRunes;
    this._runeFrame = wow.frameTime;
    this._cachedRunes = me.powerByType(PowerType.Runes);
    return this._cachedRunes;
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
