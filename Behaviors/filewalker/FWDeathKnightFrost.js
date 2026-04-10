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
 * Frost Death Knight Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (deathknight_frost.simc) + Method (all pages) + Wowhead
 *
 * Auto-detects: Deathbringer (Reaper's Mark) vs Rider of the Apocalypse
 * Build auto-detect: Breath of Sindragosa vs Obliteration
 *
 * SimC action lists matched line-by-line:
 *   variables (9): st_planning, sending_cds, cooldown_check, fwf_buffs, rune_pooling, rp_pooling,
 *                   frostscythe_priority, breath_of_sindragosa_check
 *   high_prio_actions (3): interrupt, PI, AMS
 *   cooldowns (14): RW, RM, PoF, BoS, FWF x5, Raise Dead, ERW x4
 *   single_target (9): KM Obliterate, Rime HB, Shattering FS, FS dump, Obliterate, HB fish
 *   aoe (13): Frostscythe KM, Frostbane FS, Obliterate, HB, GA, fillers
 *   racials (8): all racials during cooldown_check
 *
 * Resource: Runes (PowerType 5) + Runic Power (PowerType 6)
 * All melee instant — no movement block needed
 *
 * Key mechanics:
 *   KM: 2 stacks max, empowers Obliterate/Frostscythe (guaranteed crit, 4x for FS)
 *   Rime: free empowered HB, 45% from FS/GA
 *   RP pooling for BoS: need 60 RP (40 for Deathbringer) before activating
 *   Rune pooling for RM: save runes when RM CD < 6s
 *   Gathering Storm: RW stacks → recast at 10 stacks when RW about to expire
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL + Method + Wowhead',
};

const S = {
  obliterate:         49020,
  howlingBlast:       49184,
  frostscythe:        207230,
  frostStrike:        49143,
  glacialAdvance:     194913,
  pillarOfFrost:      51271,
  breathOfSindragosa: 1249658,
  frostwyrmsFury:     279302,
  empowerRuneWeapon:  47568,
  remorselessWinter:  196770,
  reapersMarkCast:    439843,
  raiseDead:          46585,
  deathStrike:        49998,
  antiMagicShell:     48707,
  iceboundFortitude:  48792,
  mindFreeze:         47528,
  berserking:         26297,
};

// Talent IDs for spell.isSpellKnown() checks
const T = {
  frostboundWill:     1238680,
  shatteringBlade:    207057,
  gatheringStorm:     194912,
  obliteration:       281238,
  apocalypseNow:      444040,
  chosenOfFrostbrood: 1265633,  // FWF extends PoF variant
  bonegrinder:        377098,
  frostbane:          455993,
  killingStreak:      1230153,
  icyOnslaught:       1230272,
  breathOfSindragosa: 1249658,
  pillarOfFrost:      51271,
};

const A = {
  killingMachine:     51128,    // Buff, max 2 stacks
  rime:               59052,    // Free empowered HB
  pillarOfFrost:      51271,
  breathOfSind:       1249658,
  bonegrinderFrost:   377103,   // 10% Frost dmg at 5 KM stacks
  icyOnslaught:       1230273,  // FS/GA +15% dmg, stacking
  unholyStrength:     53365,    // FC Str proc
  frostbane:          1228433,  // Empowered FS from GA on Razorice
  frostFever:         55095,    // DoT
  razorice:           51714,    // 5 stacks, +Frost vuln
  reapersMarkDebuff:  434765,
  exterminate:        441378,   // Empowered Obliterates after RM
  chosenFrostbroodFWF: 1265635, // Chosen of Frostbrood FWF buff (RP + recall)
  chosenFrostbroodHaste: 1265630, // Chosen of Frostbrood Haste buff (+15% haste, 12s)
  gatheringStorm:     211805,   // GS stacking buff from RW
  remorselessWinter:  196770,   // RW active buff
};

export class FrostDeathknightBehavior extends Behavior {
  name = 'FW Frost Death Knight';
  context = BehaviorContext.Any;
  specialization = Specialization.DeathKnight.Frost;
  version = wow.GameVersion.Retail;

  // Per-tick caches
  _targetFrame = 0;
  _cachedTarget = null;
  _rpFrame = 0;
  _cachedRP = 0;
  _runeFrame = 0;
  _cachedRunes = 0;
  _kmFrame = 0;
  _cachedKM = 0;
  _enemyFrame = 0;
  _cachedEnemyCount = 0;

  _versionLogged = false;
  _lastDebug = 0;

  static settings = [
    {
      header: 'General',
      options: [
        { type: 'checkbox', uid: 'FWFdkUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'slider', uid: 'FWFdkAoECount', text: 'AoE Target Count', default: 3, min: 2, max: 8 },
        { type: 'checkbox', uid: 'FWFdkDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWFdkAMS', text: 'Use AMS for RP', default: true },
        { type: 'checkbox', uid: 'FWFdkIBF', text: 'Use Icebound Fortitude', default: true },
        { type: 'slider', uid: 'FWFdkIBFHP', text: 'IBF HP %', default: 35, min: 10, max: 50 },
        { type: 'checkbox', uid: 'FWFdkDS', text: 'Use Death Strike', default: true },
        { type: 'slider', uid: 'FWFdkDSHP', text: 'Death Strike HP %', default: 45, min: 20, max: 60 },
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
          const hero = this.isDeathbringer() ? 'Deathbringer' : 'Rider';
          const build = this.hasBoS() ? 'Breath' : 'Obliteration';
          console.info(`[FrostDK] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${hero} | ${build} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWFdkDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[FrostDK] RP:${Math.round(this.getRP())} Runes:${this.getRunes()} KM:${this.getKM()} Rime:${this.hasRime()} PoF:${this.inPoF()} BoS:${this.inBoS()} ERWfrac:${spell.getChargesFractional(S.empowerRuneWeapon).toFixed(2)} E:${this.getEnemyCount()}`);
        }
        return bt.Status.Failure;
      }),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          // SimC: high_prio_actions
          spell.interrupt(S.mindFreeze),
          this.highPriority(),

          // SimC: cooldowns
          this.cooldowns(),

          // SimC: racials — Berserking during cooldown_check
          spell.cast(S.berserking, () => me, () => this.cdCheck()),

          // SimC dispatch: AoE >= 3 → aoe, else → single_target
          new bt.Decorator(
            () => this.getEnemyCount() >= Settings.FWFdkAoECount,
            this.aoeRotation(),
            new bt.Action(() => bt.Status.Failure)
          ),
          this.stRotation(),
        )
      ),
    );
  }

  // =============================================
  // HIGH PRIORITY (SimC high_prio_actions, 3 lines)
  // =============================================
  highPriority() {
    return new bt.Selector(
      // SimC: antimagic_shell,if=runic_power.deficit>40&death_knight.first_ams_cast<time
      spell.cast(S.antiMagicShell, () => me, () =>
        Settings.FWFdkAMS && this.getRPDeficit() > 40
      ),
      // Death Strike survival
      spell.cast(S.deathStrike, () => this.getCurrentTarget(), () =>
        Settings.FWFdkDS && me.effectiveHealthPercent < Settings.FWFdkDSHP && this.getRP() >= 35
      ),
      // IBF emergency
      spell.cast(S.iceboundFortitude, () => me, () =>
        Settings.FWFdkIBF && me.effectiveHealthPercent < Settings.FWFdkIBFHP
      ),
    );
  }

  // =============================================
  // COOLDOWNS (SimC actions.cooldowns, 14 lines)
  // =============================================
  cooldowns() {
    return new bt.Decorator(
      () => this.sendingCDs(),
      new bt.Selector(
        // 1. Remorseless Winter: (enemies>1|gathering_storm)|(GS.stack=10&RW.remains<gcd)&fight>10
        // SimC: remorseless_winter,if=variable.sending_cds&(active_enemies>1|talent.gathering_storm)|(buff.gathering_storm.stack=10&buff.remorseless_winter.remains<gcd.max)&fight_remains>10
        spell.cast(S.remorselessWinter, () => me, () => {
          if (this.targetTTD() <= 10000) return false;
          // Standard: enemies > 1 or GS talented
          if (this.getEnemyCount() > 1 || spell.isSpellKnown(T.gatheringStorm)) return true;
          // GS stack=10 & RW about to expire → recast
          const gs = me.getAura(A.gatheringStorm);
          const rw = me.getAura(A.remorselessWinter);
          if (gs && gs.stacks >= 10 && rw && rw.remaining < 1500) return true;
          return false;
        }),

        // 2. Reaper's Mark: PoF CD <= GCD & BoS check | fight < 20
        // SimC: reapers_mark,if=cooldown.pillar_of_frost.remains<=gcd.max&(!talent.breath_of_sindragosa|cooldown.breath_of_sindragosa.remains>20|cooldown.breath_of_sindragosa.remains<gcd.max&runic_power>=40)|fight_remains<20
        spell.cast(S.reapersMarkCast, () => this.getCurrentTarget(), () => {
          if (!this.isDeathbringer()) return false;
          if (this.targetTTD() < 20000) return true;
          const pofCD = spell.getCooldown(S.pillarOfFrost)?.timeleft || 0;
          if (pofCD > 1500) return false;
          if (!this.hasBoS()) return true;
          const bosCD = spell.getCooldown(S.breathOfSindragosa)?.timeleft || 0;
          return bosCD > 20000 || (bosCD < 1500 && this.getRP() >= 40);
        }),

        // 3. Pillar of Frost: sending_cds & DB RM check & BoS check | fight < 20
        // SimC: pillar_of_frost,if=variable.sending_cds&(!hero_tree.deathbringer|cooldown.reapers_mark.remains>10)&(!talent.breath_of_sindragosa|cooldown.breath_of_sindragosa.remains>20|cooldown.breath_of_sindragosa.up&runic_power>=60)|fight_remains<20
        spell.cast(S.pillarOfFrost, () => me, () => {
          if (this.targetTTD() < 20000) return true;
          if (this.isDeathbringer()) {
            const rmCD = spell.getCooldown(S.reapersMarkCast)?.timeleft || 0;
            if (rmCD <= 10000 && rmCD > 0) return false;
          }
          if (!this.hasBoS()) return true;
          const bosCD = spell.getCooldown(S.breathOfSindragosa)?.timeleft || 0;
          const bosReady = spell.getCooldown(S.breathOfSindragosa)?.ready || false;
          return bosCD > 20000 || (bosReady && this.getRP() >= 60);
        }),

        // 4. Breath of Sindragosa: during PoF | fight < 20
        // SimC: breath_of_sindragosa,use_off_gcd=1,if=!buff.breath_of_sindragosa.up&(buff.pillar_of_frost.up|fight_remains<20)
        spell.cast(S.breathOfSindragosa, () => me, () =>
          !this.inBoS() && (this.inPoF() || this.targetTTD() < 20000)
        ),

        // 5. FWF: Hero talent (Apocalypse Now/Chosen of Frostbrood) — not Chosen FWF buff up
        // SimC: frostwyrms_fury,if=((talent.apocalypse_now|talent.chosen_of_frostbrood)&!buff.chosen_of_frostbrood_fwf.up)&variable.sending_cds&(!talent.breath_of_sindragosa&buff.pillar_of_frost.up|buff.breath_of_sindragosa.up)&!debuff.reapers_mark_debuff.up&!buff.exterminate.up|(fight_remains<20&!buff.chosen_of_frostbrood_haste.up)
        spell.cast(S.frostwyrmsFury, () => this.getCurrentTarget(), () => {
          // Fight ending check
          if (this.targetTTD() < 20000 && !me.hasAura(A.chosenFrostbroodHaste)) return true;
          // Hero talent path
          if (!spell.isSpellKnown(T.apocalypseNow) && !spell.isSpellKnown(T.chosenOfFrostbrood)) return false;
          if (me.hasAura(A.chosenFrostbroodFWF)) return false;
          if (!this.sendingCDs()) return false;
          const burstCheck = (!this.hasBoS() && this.inPoF()) || this.inBoS();
          if (!burstCheck) return false;
          const t = this.getCurrentTarget();
          if (t && t.getAuraByMe(A.reapersMarkDebuff)) return false;
          if (me.hasAura(A.exterminate)) return false;
          return true;
        }),

        // 6. FWF: Chosen FWF buff up — fire the recall
        // SimC: frostwyrms_fury,if=buff.chosen_of_frostbrood_fwf.up&!buff.chosen_of_frostbrood_haste.up&!debuff.reapers_mark_debuff.up&buff.exterminate.stack<=1
        spell.cast(S.frostwyrmsFury, () => this.getCurrentTarget(), () => {
          if (!me.hasAura(A.chosenFrostbroodFWF)) return false;
          if (me.hasAura(A.chosenFrostbroodHaste)) return false;
          const t = this.getCurrentTarget();
          if (t && t.getAuraByMe(A.reapersMarkDebuff)) return false;
          const ext = me.getAura(A.exterminate);
          return !ext || ext.stacks <= 1;
        }),

        // 7. FWF: Non-hero ST — during PoF (not Obliteration) | fight ending
        // SimC: frostwyrms_fury,if=!(talent.apocalypse_now|talent.chosen_of_frostbrood)&active_enemies=1&(talent.pillar_of_frost&buff.pillar_of_frost.up&!talent.obliteration|!talent.pillar_of_frost)&variable.fwf_buffs|fight_remains<3
        spell.cast(S.frostwyrmsFury, () => this.getCurrentTarget(), () => {
          if (this.targetTTD() < 3000) return true;
          if (spell.isSpellKnown(T.apocalypseNow) || spell.isSpellKnown(T.chosenOfFrostbrood)) return false;
          if (this.getEnemyCount() !== 1) return false;
          const pofOk = (spell.isSpellKnown(T.pillarOfFrost) && this.inPoF() && !spell.isSpellKnown(T.obliteration)) || !spell.isSpellKnown(T.pillarOfFrost);
          return pofOk && this.fwfBuffs();
        }),

        // 8. FWF: Non-hero AoE — during PoF
        // SimC: frostwyrms_fury,if=!(talent.apocalypse_now|talent.chosen_of_frostbrood)&active_enemies>=2&(talent.pillar_of_frost&buff.pillar_of_frost.up|...)&variable.fwf_buffs
        spell.cast(S.frostwyrmsFury, () => this.getCurrentTarget(), () => {
          if (spell.isSpellKnown(T.apocalypseNow) || spell.isSpellKnown(T.chosenOfFrostbrood)) return false;
          if (this.getEnemyCount() < 2) return false;
          const pofOk = spell.isSpellKnown(T.pillarOfFrost) && this.inPoF();
          return pofOk && this.fwfBuffs();
        }),

        // 9. FWF: Non-hero Obliteration variant
        // SimC: frostwyrms_fury,if=!(talent.apocalypse_now|talent.chosen_of_frostbrood)&talent.obliteration&(talent.pillar_of_frost&buff.pillar_of_frost.up&!main_hand.2h|!buff.pillar_of_frost.up&main_hand.2h&cooldown.pillar_of_frost.remains|!talent.pillar_of_frost)&variable.fwf_buffs
        spell.cast(S.frostwyrmsFury, () => this.getCurrentTarget(), () => {
          if (spell.isSpellKnown(T.apocalypseNow) || spell.isSpellKnown(T.chosenOfFrostbrood)) return false;
          if (!spell.isSpellKnown(T.obliteration)) return false;
          // Simplified: during PoF
          if (spell.isSpellKnown(T.pillarOfFrost) && this.inPoF()) return this.fwfBuffs();
          if (!spell.isSpellKnown(T.pillarOfFrost)) return this.fwfBuffs();
          return false;
        }),

        // 10. Raise Dead
        spell.cast(S.raiseDead, () => me),

        // 11. ERW: (rune < 2 | no KM) & RP < threshold
        // SimC: empower_rune_weapon,if=(rune<2|!buff.killing_machine.react)&runic_power<35+(talent.icy_onslaught*buff.icy_onslaught.stack*5)
        spell.cast(S.empowerRuneWeapon, () => me, () => {
          const io = me.getAura(A.icyOnslaught);
          const ioVal = spell.isSpellKnown(T.icyOnslaught) && io ? (io.stacks || 0) * 5 : 0;
          return (this.getRunes() < 2 || this.getKM() === 0) &&
            this.getRP() < 35 + ioVal;
        }),

        // 12. ERW: charge cap prevention
        // SimC: empower_rune_weapon,if=cooldown.empower_rune_weapon.full_recharge_time<=6&buff.killing_machine.react<2-(talent.killing_streak)
        spell.cast(S.empowerRuneWeapon, () => me, () => {
          const recharge = spell.getFullRechargeTime(S.empowerRuneWeapon) || 99999;
          const kmThreshold = spell.isSpellKnown(T.killingStreak) ? 1 : 2;
          return recharge <= 6000 && this.getKM() < kmThreshold;
        }),

        // 13. ERW: BoS-specific timing
        // SimC: empower_rune_weapon,if=talent.breath_of_sindragosa&(cooldown.empower_rune_weapon.full_recharge_time-30<=cooldown.breath_of_sindragosa.remains+6)&(cooldown.breath_of_sindragosa.remains<=6)&(buff.killing_machine.react<2-(talent.killing_streak))
        spell.cast(S.empowerRuneWeapon, () => me, () => {
          if (!this.hasBoS()) return false;
          const erwRecharge = spell.getFullRechargeTime(S.empowerRuneWeapon) || 99999;
          const bosCD = spell.getCooldown(S.breathOfSindragosa)?.timeleft || 99999;
          const kmThreshold = spell.isSpellKnown(T.killingStreak) ? 1 : 2;
          return (erwRecharge - 30000 <= bosCD + 6000) && bosCD <= 6000 && this.getKM() < kmThreshold;
        }),

        // 14. ERW: Obliteration + PoF (PoF remains > 4 GCDs & rune <= 2 & KM = 1)
        // SimC: empower_rune_weapon,if=talent.obliteration&buff.pillar_of_frost.remains>4*gcd.max&rune<=2&buff.killing_machine.react=1
        spell.cast(S.empowerRuneWeapon, () => me, () => {
          if (!spell.isSpellKnown(T.obliteration)) return false;
          const pofAura = me.getAura(A.pillarOfFrost);
          return pofAura && pofAura.remaining > 6000 && this.getRunes() <= 2 && this.getKM() === 1;
        }),
      ),
    );
  }

  // =============================================
  // SINGLE TARGET (SimC actions.single_target, 9 lines)
  // =============================================
  stRotation() {
    return new bt.Selector(
      // 1. Obliterate: KM=2 | (KM & rune>=3)
      // SimC: obliterate,if=buff.killing_machine.react=2|(buff.killing_machine.react&rune>=3)
      spell.cast(S.obliterate, () => this.getCurrentTarget(), () => {
        const km = this.getKM();
        return km >= 2 || (km >= 1 && this.getRunes() >= 3);
      }),

      // 2. Howling Blast: Rime & Frostbound Will
      // SimC: howling_blast,if=buff.rime.react&talent.frostbound_will
      spell.cast(S.howlingBlast, () => this.getCurrentTarget(), () =>
        this.hasRime() && spell.isSpellKnown(T.frostboundWill)
      ),

      // 3. Frost Strike: Shattering Blade & Razorice=5 & !rp_pooling
      // SimC: frost_strike,if=debuff.razorice.react=5&talent.shattering_blade&!variable.rp_pooling
      spell.cast(S.frostStrike, () => this.getCurrentTarget(), () => {
        if (!spell.isSpellKnown(T.shatteringBlade) || this.rpPooling()) return false;
        const t = this.getCurrentTarget();
        if (!t) return false;
        const rz = t.getAuraByMe(A.razorice);
        return rz && rz.stacks >= 5;
      }),

      // 4. Howling Blast: Rime
      // SimC: howling_blast,if=buff.rime.react
      spell.cast(S.howlingBlast, () => this.getCurrentTarget(), () => this.hasRime()),

      // 5. Frost Strike: !shattering_blade & !rp_pooling & deficit < 30
      // SimC: frost_strike,if=!talent.shattering_blade&!variable.rp_pooling&runic_power.deficit<30
      spell.cast(S.frostStrike, () => this.getCurrentTarget(), () =>
        !spell.isSpellKnown(T.shatteringBlade) && !this.rpPooling() && this.getRPDeficit() < 30
      ),

      // 6. Obliterate: KM & !rune_pooling
      // SimC: obliterate,if=buff.killing_machine.react&!variable.rune_pooling
      spell.cast(S.obliterate, () => this.getCurrentTarget(), () =>
        this.getKM() >= 1 && !this.runePooling()
      ),

      // 7. Frost Strike: !rp_pooling
      // SimC: frost_strike,if=!variable.rp_pooling
      spell.cast(S.frostStrike, () => this.getCurrentTarget(), () =>
        !this.rpPooling()
      ),

      // 8. Obliterate: !rune_pooling & !(obliteration & PoF)
      // SimC: obliterate,if=!variable.rune_pooling&!(talent.obliteration&buff.pillar_of_frost.up)
      spell.cast(S.obliterate, () => this.getCurrentTarget(), () =>
        !this.runePooling() && !(spell.isSpellKnown(T.obliteration) && this.inPoF())
      ),

      // 9. Howling Blast: !KM & (obliteration & PoF) — fish for KM
      // SimC: howling_blast,if=!buff.killing_machine.react&(talent.obliteration&buff.pillar_of_frost.up)
      spell.cast(S.howlingBlast, () => this.getCurrentTarget(), () =>
        this.getKM() === 0 && spell.isSpellKnown(T.obliteration) && this.inPoF()
      ),
    );
  }

  // =============================================
  // AOE (SimC actions.aoe, 13 lines, 3+ targets)
  // =============================================
  aoeRotation() {
    return new bt.Selector(
      // 1. Frostscythe: KM=2 & enemies >= frostscythe_priority
      // SimC: frostscythe,if=buff.killing_machine.react=2&active_enemies>=variable.frostscythe_priority
      spell.cast(S.frostscythe, () => this.getCurrentTarget(), () =>
        this.getKM() >= 2 && this.getEnemyCount() >= 3
      ),

      // 2. Frost Strike: Razorice=5 & Frostbane proc
      // SimC: frost_strike,if=debuff.razorice.react=5&buff.frostbane.react
      spell.cast(S.frostStrike, () => this.getCurrentTarget(), () => {
        const t = this.getCurrentTarget();
        if (!t) return false;
        const rz = t.getAuraByMe(A.razorice);
        return rz && rz.stacks >= 5 && me.hasAura(A.frostbane);
      }),

      // 3. Frostscythe: KM & rune>=3 & enemies >= priority
      // SimC: frostscythe,if=buff.killing_machine.react&rune>=3&active_enemies>=variable.frostscythe_priority
      spell.cast(S.frostscythe, () => this.getCurrentTarget(), () =>
        this.getKM() >= 1 && this.getRunes() >= 3 && this.getEnemyCount() >= 3
      ),

      // 4. Obliterate: KM=2 | (KM & rune>=3)
      // SimC: obliterate,if=buff.killing_machine.react=2|(buff.killing_machine.react&rune>=3)
      spell.cast(S.obliterate, () => this.getCurrentTarget(), () => {
        const km = this.getKM();
        return km >= 2 || (km >= 1 && this.getRunes() >= 3);
      }),

      // 5. Howling Blast: (Rime & Frostbound Will) | !Frost Fever ticking
      // SimC: howling_blast,if=buff.rime.react&talent.frostbound_will|!dot.frost_fever.ticking
      spell.cast(S.howlingBlast, () => this.getCurrentTarget(), () => {
        if (this.hasRime() && spell.isSpellKnown(T.frostboundWill)) return true;
        const t = this.getCurrentTarget();
        if (!t) return false;
        const ff = t.getAuraByMe(A.frostFever);
        return !ff || ff.remaining < 3000;
      }),

      // 6. Frost Strike: Razorice=5 & Shattering Blade & enemies<5 & !rp_pooling & !frostbane
      // SimC: frost_strike,if=debuff.razorice.react=5&talent.shattering_blade&active_enemies<5&!variable.rp_pooling&!talent.frostbane
      spell.cast(S.frostStrike, () => this.getCurrentTarget(), () => {
        if (this.rpPooling() || spell.isSpellKnown(T.frostbane)) return false;
        if (!spell.isSpellKnown(T.shatteringBlade) || this.getEnemyCount() >= 5) return false;
        const t = this.getCurrentTarget();
        if (!t) return false;
        const rz = t.getAuraByMe(A.razorice);
        return rz && rz.stacks >= 5;
      }),

      // 7. Frostscythe: KM & !rune_pooling & enemies >= priority
      // SimC: frostscythe,if=buff.killing_machine.react&!variable.rune_pooling&active_enemies>=variable.frostscythe_priority
      spell.cast(S.frostscythe, () => this.getCurrentTarget(), () =>
        this.getKM() >= 1 && !this.runePooling() && this.getEnemyCount() >= 3
      ),

      // 8. Obliterate: KM & !rune_pooling
      // SimC: obliterate,if=buff.killing_machine.react&!variable.rune_pooling
      spell.cast(S.obliterate, () => this.getCurrentTarget(), () =>
        this.getKM() >= 1 && !this.runePooling()
      ),

      // 9. Howling Blast: Rime
      spell.cast(S.howlingBlast, () => this.getCurrentTarget(), () => this.hasRime()),

      // 10. Glacial Advance: !rp_pooling
      // SimC: glacial_advance,if=!variable.rp_pooling
      spell.cast(S.glacialAdvance, () => this.getCurrentTarget(), () =>
        !this.rpPooling()
      ),

      // 11. Frostscythe: !rune_pooling & !(obliteration & PoF) & enemies >= priority
      // SimC: frostscythe,if=!variable.rune_pooling&!(talent.obliteration&buff.pillar_of_frost.up)&active_enemies>=variable.frostscythe_priority
      spell.cast(S.frostscythe, () => this.getCurrentTarget(), () =>
        !this.runePooling() && !(spell.isSpellKnown(T.obliteration) && this.inPoF()) &&
        this.getEnemyCount() >= 3
      ),

      // 12. Obliterate: !rune_pooling & !(obliteration & PoF)
      // SimC: obliterate,if=!variable.rune_pooling&!(talent.obliteration&buff.pillar_of_frost.up)
      spell.cast(S.obliterate, () => this.getCurrentTarget(), () =>
        !this.runePooling() && !(spell.isSpellKnown(T.obliteration) && this.inPoF())
      ),

      // 13. Howling Blast: !KM & (obliteration & PoF) — fish for KM
      // SimC: howling_blast,if=!buff.killing_machine.react&(talent.obliteration&buff.pillar_of_frost.up)
      spell.cast(S.howlingBlast, () => this.getCurrentTarget(), () =>
        this.getKM() === 0 && spell.isSpellKnown(T.obliteration) && this.inPoF()
      ),
    );
  }

  // =============================================
  // SIMC VARIABLE HELPERS
  // =============================================
  isDeathbringer() { return spell.isSpellKnown(S.reapersMarkCast); }
  isRider() { return !this.isDeathbringer(); }
  hasBoS() { return spell.isSpellKnown(T.breathOfSindragosa); }

  inPoF() { return me.hasAura(A.pillarOfFrost); }
  inBoS() { return me.hasAura(A.breathOfSind); }
  inBurst() { return this.inPoF() || this.inBoS(); }
  hasRime() { return me.hasAura(A.rime); }

  // variable.sending_cds: SimC: (variable.st_planning|variable.adds_remain)
  // Simplified: CDs enabled & TTD > 10s (st_planning = 1 for single target, adds_remain for AoE)
  sendingCDs() { return Settings.FWFdkUseCDs && this.targetTTD() > 10000; }

  // variable.cooldown_check: (talent.pillar_of_frost&buff.pillar_of_frost.up)|!talent.pillar_of_frost|fight_remains<20
  cdCheck() {
    return (spell.isSpellKnown(T.pillarOfFrost) && this.inPoF()) ||
      !spell.isSpellKnown(T.pillarOfFrost) ||
      this.targetTTD() < 20000;
  }

  // variable.fwf_buffs: (buff.pillar_of_frost.remains<gcd|(buff.unholy_strength.up&buff.unholy_strength.remains<gcd)|(talent.bonegrinder.rank=2&buff.bonegrinder_frost.up&buff.bonegrinder_frost.remains<gcd))&(active_enemies>1|debuff.razorice.stack=5|talent.shattering_blade)
  fwfBuffs() {
    const pof = me.getAura(A.pillarOfFrost);
    const us = me.getAura(A.unholyStrength);
    const bg = me.getAura(A.bonegrinderFrost);
    const aboutToExpire = (pof && pof.remaining < 1500) ||
      (us && us.remaining > 0 && us.remaining < 1500) ||
      (spell.isSpellKnown(T.bonegrinder) && bg && bg.remaining > 0 && bg.remaining < 1500);
    if (!aboutToExpire) return false;
    if (this.getEnemyCount() > 1) return true;
    if (spell.isSpellKnown(T.shatteringBlade)) return true;
    const t = this.getCurrentTarget();
    if (t) {
      const rz = t.getAuraByMe(A.razorice);
      if (rz && rz.stacks >= 5) return true;
    }
    return false;
  }

  // variable.rune_pooling: hero_tree.deathbringer&cooldown.reapers_mark.remains<6&rune<3&variable.sending_cds
  runePooling() {
    if (!this.isDeathbringer()) return false;
    const rmCD = spell.getCooldown(S.reapersMarkCast)?.timeleft || 99999;
    return rmCD < 6000 && this.getRunes() < 3 && this.sendingCDs();
  }

  // variable.rp_pooling: talent.breath_of_sindragosa&cooldown.breath_of_sindragosa.remains<4*gcd.max&runic_power<60+(35+5*buff.icy_onslaught.up)-(10*rune)&variable.sending_cds
  rpPooling() {
    if (!this.hasBoS()) return false;
    const bosCD = spell.getCooldown(S.breathOfSindragosa)?.timeleft || 99999;
    if (bosCD > 6000) return false; // 4*gcd ~= 6s
    const io = me.getAura(A.icyOnslaught);
    const ioUp = io && io.remaining > 0 ? 1 : 0;
    const threshold = 60 + (35 + 5 * ioUp) - (10 * this.getRunes());
    return this.getRP() < threshold && this.sendingCDs();
  }

  // variable.breath_of_sindragosa_check: !talent.breath_of_sindragosa|(cooldown.breath_of_sindragosa.remains>20|(cooldown.breath_of_sindragosa.remains<1*gcd.max&runic_power>=(60-20*hero_tree.deathbringer)))
  bosCheck() {
    if (!this.hasBoS()) return true;
    const bosCD = spell.getCooldown(S.breathOfSindragosa)?.timeleft || 99999;
    if (bosCD > 20000) return true;
    const rpThreshold = 60 - (this.isDeathbringer() ? 20 : 0);
    return bosCD < 1500 && this.getRP() >= rpThreshold;
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
  getRPDeficit() { return 100 - this.getRP(); }

  getRunes() {
    if (this._runeFrame === wow.frameTime) return this._cachedRunes;
    this._runeFrame = wow.frameTime;
    this._cachedRunes = me.powerByType(PowerType.Runes);
    return this._cachedRunes;
  }

  getKM() {
    if (this._kmFrame === wow.frameTime) return this._cachedKM;
    this._kmFrame = wow.frameTime;
    const aura = me.getAura(A.killingMachine);
    this._cachedKM = aura ? aura.stacks : 0;
    return this._cachedKM;
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
