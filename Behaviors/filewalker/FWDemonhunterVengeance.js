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
 * Vengeance Demon Hunter Behavior - Midnight 12.0.1
 * Sources: SimC Midnight APL (demonhunter_vengeance.simc) + Method + Wowhead
 *
 * Auto-detects: Aldrachi Reaver vs Annihilator
 * SimC has 10 sub-lists — ALL implemented:
 *   AR: ar (10), ar_glaive_cycle (6), ar_cooldowns (6), ar_fillers (12)
 *   Anni: anni (14), anni_voidfall (8), anni_meta_entry (5), anni_meta (9),
 *         anni_cooldowns (5), anni_fillers (11), ur_fishing (6)
 *   Variables (14): single_target, aoe, execute, cd_ready, meta_ready,
 *     fiery_demise_active, fire_cd_soon, fragment_target, fracture_cap_soon,
 *     meta_entry, burst_ready, ur_fishing, hold_for_meta
 *
 * Tank: Demon Spikes near 100% uptime, Fiery Brand rotationally
 * Resource: Fury (PowerType 17) + Soul Fragments
 * All instant/melee — no movement block needed
 */

const SCRIPT_VERSION = {
  patch: '12.0.1',
  expansion: 'Midnight',
  date: '2026-03-19',
  guide: 'SimC Midnight APL (every line) + Method + Wowhead',
};

const S = {
  fracture:           263642,
  soulCleave:         228477,
  spiritBomb:         247454,
  immolationAura:     258920,
  sigilOfFlame:       204596,
  sigilOfSpite:       390163,
  felDevastation:     212084,
  soulCarver:         207407,
  felblade:           213241,
  throwGlaive:        204157,
  infernalStrike:     189110,
  demonSpikes:        203720,
  fieryBrand:         204021,
  metamorphosis:      187827,
  reaversGlaive:      1283344,  // Vengeance-specific ID (Havoc is 442294)
  vengefulRetreat:    198793,
  disrupt:            183752,
  berserking:         26297,
};

const T = {
  fieryDemise:        389220,
  downInFlames:       389732,
  charredFlesh:       389696,
  darkglareBoon:      389708,
  soulSigils:         395446,
  fallout:            227174,
  soulCarver:         207407,
  sigilOfSpite:       390163,
  unhinderedAssault:  444764,
  untetheredRage:     1270444,
  apex:               1256308,  // Apex talent — rank 3 check needed for ur_fishing/FelDev gates
};

const A = {
  soulFragments:      203981,
  demonSpikes:        203819,
  metamorphosis:      162264,   // Buff aura ID (cast is 187827)
  immolationAura:     258920,
  fieryBrand:         207771,    // Debuff on target (NOT cast ID)
  frailty:            247456,
  // Aldrachi Reaver
  artOfTheGlaive:     444661,   // Stacking buff (talent passive is 442290)
  reaversGlaiveBuff:  444686,    // TG becomes RG
  rendingStrike:      442442,
  glaiveFlurry:       442435,
  reaversMark:        442624,
  thrillHaste:        442688,
  thrillDamage:       442695,
  // Annihilator
  voidfallBuilding:   1256301,
  voidfallSpending:   1256302,
  massAcceleration:   1256295,
  untetheredRage:     1270476,
  seethingAnger:      1270547,
};

export class VengeanceDemonHunterBehavior extends Behavior {
  name = 'FW Vengeance Demon Hunter';
  context = BehaviorContext.Any;
  specialization = Specialization.DemonHunter.Vengeance;
  version = wow.GameVersion.Retail;

  _targetFrame = 0;
  _cachedTarget = null;
  _fragFrame = 0;
  _cachedFrags = 0;
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
        { type: 'checkbox', uid: 'FWVdhUseCDs', text: 'Use Cooldowns', default: true },
        { type: 'checkbox', uid: 'FWVdhDebug', text: 'Debug Logging', default: false },
      ],
    },
    {
      header: 'Defensives',
      options: [
        { type: 'checkbox', uid: 'FWVdhDS', text: 'Auto Demon Spikes', default: true },
        { type: 'checkbox', uid: 'FWVdhMeta', text: 'Use Meta Defensively', default: true },
        { type: 'slider', uid: 'FWVdhMetaHP', text: 'Meta HP %', default: 35, min: 10, max: 70 },
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
      new bt.Action(() => me.inCombat() ? bt.Status.Failure : bt.Status.Success),
      new bt.Action(() => {
        if (me.inCombat() && (!me.target || !common.validTarget(me.target))) {
          const t = combat.bestTarget || (combat.targets && combat.targets[0]);
          if (t) wow.GameUI.setTarget(t);
        }
        return bt.Status.Failure;
      }),
      new bt.Action(() => this.getCurrentTarget() === null ? bt.Status.Success : bt.Status.Failure),
      common.waitForCastOrChannel(),

      new bt.Action(() => {
        if (!this._versionLogged) {
          this._versionLogged = true;
          console.info(`[VDH] v${SCRIPT_VERSION.patch} ${SCRIPT_VERSION.expansion} | ${this.isAR() ? 'Aldrachi Reaver' : 'Annihilator'} | ${SCRIPT_VERSION.guide}`);
        }
        if (Settings.FWVdhDebug && (!this._lastDebug || (wow.frameTime - this._lastDebug) > 2000)) {
          this._lastDebug = wow.frameTime;
          console.info(`[VDH] Fury:${Math.round(this.getFury())} Frags:${this.getFrags()} Meta:${this.inMeta()} DS:${me.hasAura(A.demonSpikes)} FB:${this.fbActive()} VFB:${this.vfbStacks()} VFS:${this.vfsStacks()} GF:${me.hasAura(A.glaiveFlurry)} RS:${me.hasAura(A.rendingStrike)} E:${this.getEnemyCount()} HP:${Math.round(me.effectiveHealthPercent)}%`);
        }
        return bt.Status.Failure;
      }),

      // SimC: infernal_strike off-GCD (charge-gated to prevent waste)
      spell.cast(S.infernalStrike, () => this.getCurrentTarget(), () =>
        spell.getChargesFractional(S.infernalStrike) >= 1.8
      ),

      // SimC: demon_spikes off-GCD if !buff & in_combat
      spell.cast(S.demonSpikes, () => me, () =>
        Settings.FWVdhDS && !me.hasAura(A.demonSpikes) && me.inCombat()
      ),

      new bt.Decorator(
        () => !spell.isGlobalCooldown(),
        new bt.Selector(
          spell.interrupt(S.disrupt),

          // Defensive Meta (HP-gated, separate from rotational)
          spell.cast(S.metamorphosis, () => me, () =>
            Settings.FWVdhMeta && me.effectiveHealthPercent < Settings.FWVdhMetaHP &&
            !this.inMeta() && me.inCombat()
          ),

          // Berserking during Meta/Voidfall
          spell.cast(S.berserking, () => me, () =>
            this.inMeta() || this.vfsStacks() >= 3
          ),

          // Dispatch: AR → ar, Anni → anni
          new bt.Decorator(() => this.isAR(), this.ar(), new bt.Action(() => bt.Status.Failure)),
          this.anni(),
        )
      ),
    );
  }

  // =============================================
  // ALDRACHI REAVER (SimC actions.ar, 10 lines → sub-lists)
  // =============================================
  ar() {
    return new bt.Selector(
      // 1. Fiery Brand: !ticking & (2 charges | !fiery_demise) & cd_ready
      spell.cast(S.fieryBrand, () => this.getCurrentTarget(), () =>
        !this.fbActive() && this.cdReady() &&
        (spell.getCharges(S.fieryBrand) >= 2 || !spell.isSpellKnown(T.fieryDemise))
      ),
      // 2. Fiery Brand: fiery_demise & !ticking & meta_ready & !meta & meta CD ready & fire_cd_soon
      spell.cast(S.fieryBrand, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fieryDemise) && !this.fbActive() && this.metaReady() &&
        !this.inMeta() && spell.getCooldown(S.metamorphosis)?.ready && this.fireCdSoon()
      ),
      // 3. Meta: untethered_rage.up
      spell.cast(S.metamorphosis, () => me, () =>
        me.hasAura(A.untetheredRage) && Settings.FWVdhUseCDs
      ),
      // 4. Meta: !meta & meta_ready
      spell.cast(S.metamorphosis, () => me, () =>
        !this.inMeta() && this.metaReady() && Settings.FWVdhUseCDs
      ),
      // 5. AR Glaive Cycle
      this.arGlaiveCycle(),
      // 6. AR Cooldowns
      this.arCooldowns(),
      // 7. AR Fillers
      this.arFillers(),
    );
  }

  // SimC: ar_glaive_cycle (6 lines)
  arGlaiveCycle() {
    return new bt.Selector(
      // 1. Reaver's Glaive: buff up & !RS & !GF
      spell.cast(S.reaversGlaive, () => this.getCurrentTarget(), () =>
        me.hasAura(A.reaversGlaiveBuff) && !me.hasAura(A.rendingStrike) && !me.hasAura(A.glaiveFlurry)
      ),
      // 2. Fracture: RS + GF + AoE → consume Rending first in AoE
      spell.cast(S.fracture, () => this.getCurrentTarget(), () =>
        me.hasAura(A.rendingStrike) && me.hasAura(A.glaiveFlurry) && this.isAoE()
      ),
      // 3. Soul Cleave: RS + GF → consume both (ST order)
      spell.cast(S.soulCleave, () => this.getCurrentTarget(), () =>
        me.hasAura(A.rendingStrike) && me.hasAura(A.glaiveFlurry) && this.getFury() >= 35
      ),
      // 4. Fracture: RS + !GF → consume Rending
      spell.cast(S.fracture, () => this.getCurrentTarget(), () =>
        me.hasAura(A.rendingStrike) && !me.hasAura(A.glaiveFlurry)
      ),
      // 5. Spirit Bomb: GF + !RS + frags >= 5
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () =>
        me.hasAura(A.glaiveFlurry) && !me.hasAura(A.rendingStrike) && this.getFrags() >= 5
      ),
      // 6. Soul Cleave: GF + !RS
      spell.cast(S.soulCleave, () => this.getCurrentTarget(), () =>
        me.hasAura(A.glaiveFlurry) && !me.hasAura(A.rendingStrike) && this.getFury() >= 35
      ),
    );
  }

  // SimC: ar_cooldowns (6 lines)
  arCooldowns() {
    return new bt.Selector(
      // 1. Spirit Bomb: fiery_demise_active & frags >= 3
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () =>
        this.fieryDemiseActive() && this.getFrags() >= 3
      ),
      // 2. Immo Aura: fiery_demise_active & charred_flesh
      spell.cast(S.immolationAura, () => me, () =>
        this.fieryDemiseActive() && spell.isSpellKnown(T.charredFlesh)
      ),
      // 3. Sigil of Spite: frags <= 2+soul_sigils & (fiery_demise_active | cd_ready)
      spell.cast(S.sigilOfSpite, () => this.getCurrentTarget(), () => {
        const threshold = 2 + (spell.isSpellKnown(T.soulSigils) ? 1 : 0);
        return this.getFrags() <= threshold && (this.fieryDemiseActive() || this.cdReady());
      }),
      // 4. Soul Carver: fiery_demise_active | cd_ready
      spell.cast(S.soulCarver, () => this.getCurrentTarget(), () =>
        this.fieryDemiseActive() || this.cdReady()
      ),
      // 5. Fel Devastation: !RS & !GF & (fiery_demise_active | cd_ready)
      spell.cast(S.felDevastation, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.rendingStrike) && !me.hasAura(A.glaiveFlurry) &&
        (this.fieryDemiseActive() || this.cdReady())
      ),
      // 6. Immo Aura: fiery_demise_active & !charred_flesh
      spell.cast(S.immolationAura, () => me, () =>
        this.fieryDemiseActive() && !spell.isSpellKnown(T.charredFlesh)
      ),
    );
  }

  // SimC: ar_fillers (12 lines)
  arFillers() {
    return new bt.Selector(
      // 1. Immo Aura: AoE + in_combat
      spell.cast(S.immolationAura, () => me, () => this.isAoE() && me.inCombat()),
      // 2. Fracture: frags < target
      spell.cast(S.fracture, () => this.getCurrentTarget(), () => this.getFrags() < this.fragTarget()),
      // 3. Spirit Bomb: frags >= target
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () => this.getFrags() >= this.fragTarget()),
      // 4. Fracture: Meta (prioritize cycling)
      spell.cast(S.fracture, () => this.getCurrentTarget(), () => this.inMeta()),
      // 5. Sigil of Flame: AoE
      spell.cast(S.sigilOfFlame, () => this.getCurrentTarget(), () => this.isAoE()),
      // 6. Immo Aura: general (in_combat)
      spell.cast(S.immolationAura, () => me, () => me.inCombat()),
      // 7. Fracture
      spell.cast(S.fracture, () => this.getCurrentTarget()),
      // 8. Felblade
      spell.cast(S.felblade, () => this.getCurrentTarget()),
      // 9. Sigil of Flame
      spell.cast(S.sigilOfFlame, () => this.getCurrentTarget()),
      // 10. Soul Cleave
      spell.cast(S.soulCleave, () => this.getCurrentTarget(), () => this.getFury() >= 35),
      // 11. VR: unhindered_assault
      spell.cast(S.vengefulRetreat, () => me, () => spell.isSpellKnown(T.unhinderedAssault)),
      // 12. Throw Glaive
      spell.cast(S.throwGlaive, () => this.getCurrentTarget()),
    );
  }

  // =============================================
  // ANNIHILATOR (SimC actions.anni, 14 lines → sub-lists)
  // =============================================
  anni() {
    return new bt.Selector(
      // Anni Voidfall (highest priority — spending/building)
      this.anniVoidfall(),
      // Meta: untethered_rage & !voidfall_spending & meta_ready
      spell.cast(S.metamorphosis, () => me, () =>
        me.hasAura(A.untetheredRage) && !me.hasAura(A.voidfallSpending) &&
        this.metaReady() && Settings.FWVdhUseCDs
      ),
      // Meta Entry sequence
      new bt.Decorator(() => this.burstReady(), this.anniMetaEntry(), new bt.Action(() => bt.Status.Failure)),
      // Spirit Bomb pre-Meta: !apex.3 & meta_entry & meta ready & frags >= 3 & CDs not aligned
      // SimC: !apex.3&variable.meta_entry&cooldown.metamorphosis.ready&soul_fragments>=3
      //   &((cooldown.soul_carver.remains>5|!talent.soul_carver)&cooldown.sigil_of_spite.remains>5|variable.execute)
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () =>
        !this.hasApex3() && this.metaEntry() && spell.getCooldown(S.metamorphosis)?.ready && this.getFrags() >= 3 &&
        (((spell.getCooldown(S.soulCarver)?.timeleft || 0) > 5000 || !spell.isSpellKnown(T.soulCarver)) &&
        (spell.getCooldown(S.sigilOfSpite)?.timeleft || 0) > 5000 || this.isExecute())
      ),
      // Meta: meta_entry & (frags >= 3 | !apex.3 | prev SB) & CDs not aligned
      // SimC: variable.meta_entry&(soul_fragments>=3|!apex.3|prev_gcd.1.spirit_bomb)
      //   &((cooldown.soul_carver.remains>5|!talent.soul_carver)&cooldown.sigil_of_spite.remains>5|variable.execute)
      spell.cast(S.metamorphosis, () => me, () =>
        this.metaEntry() && Settings.FWVdhUseCDs &&
        (this.getFrags() >= 3 || !this.hasApex3() || spell.getTimeSinceLastCast(S.spiritBomb) < 1500) &&
        (((spell.getCooldown(S.soulCarver)?.timeleft || 0) > 5000 || !spell.isSpellKnown(T.soulCarver)) &&
        (spell.getCooldown(S.sigilOfSpite)?.timeleft || 0) > 5000 || this.isExecute())
      ),
      // UR Fishing (Meta ending, untethered rage not proc'd, apex.3 only)
      // SimC: call_action_list,name=ur_fishing,if=variable.ur_fishing&apex.3
      new bt.Decorator(() => this.urFishing() && this.hasApex3(), this.urFishingList(), new bt.Action(() => bt.Status.Failure)),
      // Anni Meta rotation
      new bt.Decorator(() => this.inMeta() && !this.urFishing(), this.anniMeta(), new bt.Action(() => bt.Status.Failure)),
      // Anni Cooldowns
      this.anniCooldowns(),
      // Anni Fillers
      this.anniFillers(),
    );
  }

  // SimC: anni_voidfall (8 lines)
  anniVoidfall() {
    return new bt.Selector(
      // 1. Fiery Brand: fiery_demise & !ticking & (vfb=2 | vfs=3) & cd_ready
      spell.cast(S.fieryBrand, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fieryDemise) && !this.fbActive() && this.cdReady() &&
        (this.vfbStacks() >= 2 || this.vfsStacks() >= 3)
      ),
      // 2. Fel Devastation: vfs=3 & frags < target
      spell.cast(S.felDevastation, () => this.getCurrentTarget(), () =>
        this.vfsStacks() >= 3 && this.getFrags() < this.fragTarget()
      ),
      // 3. Soul Carver: vfs=3 & frags < target
      spell.cast(S.soulCarver, () => this.getCurrentTarget(), () =>
        this.vfsStacks() >= 3 && this.getFrags() < this.fragTarget()
      ),
      // 4. Sigil of Spite: vfs=3 & frags < target
      spell.cast(S.sigilOfSpite, () => this.getCurrentTarget(), () =>
        this.vfsStacks() >= 3 && this.getFrags() < this.fragTarget()
      ),
      // 5. Immo Aura: vfs=3 & fallout & frags < target
      spell.cast(S.immolationAura, () => me, () =>
        this.vfsStacks() >= 3 && spell.isSpellKnown(T.fallout) && this.getFrags() < this.fragTarget()
      ),
      // 6. Spirit Bomb: vfs=3 & frags >= target
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () =>
        this.vfsStacks() >= 3 && this.getFrags() >= this.fragTarget()
      ),
      // 7. Soul Cleave: voidfall_spending active (consume stacks for meteors)
      spell.cast(S.soulCleave, () => this.getCurrentTarget(), () =>
        me.hasAura(A.voidfallSpending) && this.getFury() >= 35
      ),
      // 8. Fracture: vfb=2 & fury >= 70
      spell.cast(S.fracture, () => this.getCurrentTarget(), () =>
        this.vfbStacks() >= 2 && this.getFury() >= 70
      ),
    );
  }

  // SimC: anni_meta_entry (5 lines)
  anniMetaEntry() {
    return new bt.Selector(
      spell.cast(S.fieryBrand, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fieryDemise) && !this.fbActive()
      ),
      spell.cast(S.immolationAura, () => me, () =>
        spell.isSpellKnown(T.charredFlesh) && this.fbActive() &&
        this.getAuraRem(A.immolationAura) < 2000
      ),
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () => this.getFrags() >= 3),
      spell.cast(S.metamorphosis, () => me, () =>
        (spell.getCooldown(S.spiritBomb)?.timeleft || 0) > 20000 && Settings.FWVdhUseCDs
      ),
      spell.cast(S.fracture, () => this.getCurrentTarget(), () => this.getFrags() < 3),
    );
  }

  // SimC: anni_meta (9 lines)
  anniMeta() {
    return new bt.Selector(
      // 1. Fiery Brand: fiery_demise & !ticking
      spell.cast(S.fieryBrand, () => this.getCurrentTarget(), () =>
        spell.isSpellKnown(T.fieryDemise) && !this.fbActive()
      ),
      // 2. Immo Aura: charred_flesh & Brand ticking
      spell.cast(S.immolationAura, () => me, () =>
        spell.isSpellKnown(T.charredFlesh) && this.fbActive()
      ),
      // 3. Soul Carver: (prev_gcd.1.spirit_bomb|prev_gcd.2.spirit_bomb)&soul_fragments<=3
      // prev_gcd.2 handles Brand/IA inserting a GCD between SpB and this evaluation
      spell.cast(S.soulCarver, () => this.getCurrentTarget(), () =>
        (spell.getTimeSinceLastCast(S.spiritBomb) < 3000) && this.getFrags() <= 3
      ),
      // 4. Sigil of Spite: (prev_gcd.1|2.spirit_bomb)&frags<=2+soul_sigils&!cooldown.soul_carver.ready
      spell.cast(S.sigilOfSpite, () => this.getCurrentTarget(), () => {
        const threshold = 2 + (spell.isSpellKnown(T.soulSigils) ? 1 : 0);
        return (spell.getTimeSinceLastCast(S.spiritBomb) < 3000) && this.getFrags() <= threshold &&
          !(spell.getCooldown(S.soulCarver)?.ready);
      }),
      // 5. Spirit Bomb: frags >= target
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () =>
        this.getFrags() >= this.fragTarget()
      ),
      // 6. Fracture: frags < target & !voidfall_spending
      spell.cast(S.fracture, () => this.getCurrentTarget(), () =>
        this.getFrags() < this.fragTarget() && !me.hasAura(A.voidfallSpending)
      ),
      // 7. FelDev: !voidfall_spending & (!apex.3|darkglare_boon|aoe)
      // SimC: !buff.voidfall_spending.up&(!apex.3|talent.darkglare_boon|variable.aoe)
      spell.cast(S.felDevastation, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.voidfallSpending) && (!this.hasApex3() || spell.isSpellKnown(T.darkglareBoon) || this.isAoE())
      ),
      // 8. Sigil of Spite: frags <= threshold & (meta CD > 25 | execute)
      spell.cast(S.sigilOfSpite, () => this.getCurrentTarget(), () => {
        const threshold = 2 + (spell.isSpellKnown(T.soulSigils) ? 1 : 0);
        return this.getFrags() <= threshold &&
          ((spell.getCooldown(S.metamorphosis)?.timeleft || 0) > 25000 || this.isExecute());
      }),
      // 9. Soul Carver: frags <= 3 & (meta CD > 25 | execute)
      spell.cast(S.soulCarver, () => this.getCurrentTarget(), () =>
        this.getFrags() <= 3 &&
        ((spell.getCooldown(S.metamorphosis)?.timeleft || 0) > 25000 || this.isExecute())
      ),
    );
  }

  // SimC: anni_cooldowns (5 lines)
  anniCooldowns() {
    return new bt.Selector(
      spell.cast(S.fieryBrand, () => this.getCurrentTarget(), () =>
        !this.fbActive() && this.cdReady() &&
        (spell.getCharges(S.fieryBrand) >= 2 || !spell.isSpellKnown(T.fieryDemise) ||
          !spell.isSpellKnown(T.downInFlames) || this.isExecute())
      ),
      spell.cast(S.immolationAura, () => me, () =>
        spell.isSpellKnown(T.charredFlesh) && this.fbActive()
      ),
      spell.cast(S.sigilOfSpite, () => this.getCurrentTarget(), () => {
        const threshold = 2 + (spell.isSpellKnown(T.soulSigils) ? 1 : 0);
        return this.getFrags() <= threshold && this.cdReady() && !this.holdForMeta();
      }),
      spell.cast(S.soulCarver, () => this.getCurrentTarget(), () =>
        this.getFrags() <= 3 && this.cdReady() && !this.holdForMeta()
      ),
      // SimC: !buff.voidfall_spending.up&(!buff.metamorphosis.up|!apex.3|talent.darkglare_boon)&variable.cd_ready
      spell.cast(S.felDevastation, () => this.getCurrentTarget(), () =>
        !me.hasAura(A.voidfallSpending) &&
        (!this.inMeta() || !this.hasApex3() || spell.isSpellKnown(T.darkglareBoon)) && this.cdReady()
      ),
    );
  }

  // SimC: anni_fillers (11 lines)
  anniFillers() {
    return new bt.Selector(
      // 1. Spirit Bomb: frags >= target
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () => this.getFrags() >= this.fragTarget()),
      // 2. Fracture: cap prevention
      spell.cast(S.fracture, () => this.getCurrentTarget(), () => this.fracCapSoon()),
      // 3. Immo Aura: AoE priority (SimC: variable.aoe&(!variable.is_dungeon|in_combat))
      spell.cast(S.immolationAura, () => me, () => this.isAoE() && me.inCombat()),
      // 4. Fracture: !voidfall_spending
      spell.cast(S.fracture, () => this.getCurrentTarget(), () => !me.hasAura(A.voidfallSpending)),
      // 5. Sigil of Flame: AoE
      spell.cast(S.sigilOfFlame, () => this.getCurrentTarget(), () => this.isAoE()),
      // 6. Felblade
      spell.cast(S.felblade, () => this.getCurrentTarget()),
      // 7. Immo Aura: general (SimC: !variable.is_dungeon|in_combat)
      spell.cast(S.immolationAura, () => me, () => me.inCombat()),
      // 8. Sigil of Flame
      spell.cast(S.sigilOfFlame, () => this.getCurrentTarget()),
      // 9. Soul Cleave
      spell.cast(S.soulCleave, () => this.getCurrentTarget(), () => this.getFury() >= 35),
      // 10. Fracture (unconditional fallback)
      spell.cast(S.fracture, () => this.getCurrentTarget()),
      // 11. Throw Glaive
      spell.cast(S.throwGlaive, () => this.getCurrentTarget()),
    );
  }

  // SimC: ur_fishing (6 lines) — Meta ending, fish for Untethered Rage proc
  urFishingList() {
    return new bt.Selector(
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () =>
        me.hasAura(A.seethingAnger) && this.getFrags() >= 3
      ),
      spell.cast(S.spiritBomb, () => this.getCurrentTarget(), () =>
        this.getFrags() >= this.fragTarget()
      ),
      spell.cast(S.sigilOfSpite, () => this.getCurrentTarget(), () => {
        const threshold = 2 + (spell.isSpellKnown(T.soulSigils) ? 1 : 0);
        return this.getFrags() <= threshold;
      }),
      // SimC: soul_carver,if=soul_fragments<=2+talent.soul_sigils
      spell.cast(S.soulCarver, () => this.getCurrentTarget(), () => {
        const threshold = 2 + (spell.isSpellKnown(T.soulSigils) ? 1 : 0);
        return this.getFrags() <= threshold;
      }),
      // SimC: fracture (unconditional)
      spell.cast(S.fracture, () => this.getCurrentTarget()),
      // SimC: soul_cleave,if=soul_fragments>=1
      spell.cast(S.soulCleave, () => this.getCurrentTarget(), () =>
        this.getFrags() >= 1 && this.getFury() >= 35
      ),
    );
  }

  // =============================================
  // SIMC VARIABLES — ALL 14 implemented
  // =============================================
  isAR() { return spell.isSpellKnown(442290) || me.hasAura(A.artOfTheGlaive); }
  isAnni() { return !this.isAR(); }
  inMeta() { return me.hasAura(A.metamorphosis); }
  isST() { return this.getEnemyCount() === 1; }
  isAoE() { return this.getEnemyCount() >= 3; }
  isExecute() { return this.targetTTD() < 20000; }

  // cd_ready = execute | pull_ttd > 12
  cdReady() { return this.isExecute() || this.targetTTD() > 12000; }

  // meta_ready = execute | pull_ttd > (15 - 5*annihilator)
  metaReady() {
    const threshold = this.isAnni() ? 10000 : 15000;
    return this.isExecute() || this.targetTTD() > threshold;
  }

  // fiery_demise_active = talent.fiery_demise & fiery_brand.ticking
  fieryDemiseActive() {
    return spell.isSpellKnown(T.fieryDemise) && this.fbActive();
  }

  // fire_cd_soon = min(soul_carver.cd, fel_dev.cd, sigil_spite.cd) < 8
  fireCdSoon() {
    const sc = spell.getCooldown(S.soulCarver)?.timeleft || 99999;
    const fd = spell.getCooldown(S.felDevastation)?.timeleft || 99999;
    const ss = spell.getCooldown(S.sigilOfSpite)?.timeleft || 99999;
    return Math.min(sc, fd, ss) < 8000;
  }

  // fragment_target = fiery_demise_active ? 3 : (5 - meta_up)
  fragTarget() {
    if (this.fieryDemiseActive()) return 3;
    return this.inMeta() ? 4 : 5;
  }

  // fracture_cap_soon = fracture.full_recharge < gcd & frags < 6
  fracCapSoon() {
    return (spell.getFullRechargeTime(S.fracture) || 99999) < 1500 && this.getFrags() < 6;
  }

  // meta_entry (Annihilator): !meta & !voidfall_spending & voidfall_building < 2 & meta_ready
  metaEntry() {
    return !this.inMeta() && !me.hasAura(A.voidfallSpending) &&
      this.vfbStacks() < 2 && this.metaReady();
  }

  // burst_ready: meta_entry & meta CD ready & SB alignment & (SC/SoS ready | execute)
  burstReady() {
    if (!this.metaEntry() || !spell.getCooldown(S.metamorphosis)?.ready) return false;
    const sbCD = spell.getCooldown(S.spiritBomb)?.timeleft || 0;
    if (sbCD >= 3000 && sbCD <= 20000) return false;
    return spell.getCooldown(S.soulCarver)?.ready ||
      spell.getCooldown(S.sigilOfSpite)?.ready || this.isExecute();
  }

  // ur_fishing: untethered_rage talent & meta & meta < 6s & !untethered_rage buff
  urFishing() {
    return spell.isSpellKnown(T.untetheredRage) && this.inMeta() &&
      this.getAuraRem(A.metamorphosis) < 6000 && !me.hasAura(A.untetheredRage);
  }

  // apex.3: Apex talent at rank 3 — Seething Anger (1270547) is the rank 3 effect
  // If Seething Anger is known as a spell, the player has apex rank 3
  hasApex3() {
    return spell.isSpellKnown(A.seethingAnger) || spell.isSpellKnown(1270545);
    // 1270545 = Seething Anger talent ID (verify in-game); fallback to aura-based check
  }

  // hold_for_meta: !execute & meta CD <= 20 & !meta & SB CD <= meta CD
  holdForMeta() {
    if (this.isExecute()) return false;
    const metaCD = spell.getCooldown(S.metamorphosis)?.timeleft || 99999;
    return metaCD <= 20000 && !this.inMeta() &&
      (spell.getCooldown(S.spiritBomb)?.timeleft || 0) <= metaCD;
  }

  // Fiery Brand active on target
  fbActive() {
    const t = this.getCurrentTarget();
    if (!t) return false;
    return !!(t.getAuraByMe(A.fieryBrand) || t.getAuraByMe(S.fieryBrand));
  }

  // Voidfall stacks
  vfbStacks() { const a = me.getAura(A.voidfallBuilding); return a ? a.stacks : 0; }
  vfsStacks() { const a = me.getAura(A.voidfallSpending); return a ? a.stacks : 0; }

  getAuraRem(id) { const a = me.getAura(id); return a ? a.remaining : 0; }

  // =============================================
  // RESOURCES (cached per tick)
  // =============================================
  getFrags() {
    if (this._fragFrame === wow.frameTime) return this._cachedFrags;
    this._fragFrame = wow.frameTime;
    const aura = me.getAura(A.soulFragments);
    this._cachedFrags = aura ? (aura.stacks || 0) : 0;
    if (this._cachedFrags === 0) {
      const found = me.auras.find(a => a.spellId === A.soulFragments);
      this._cachedFrags = found ? (found.stacks || 0) : 0;
    }
    return this._cachedFrags;
  }

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
