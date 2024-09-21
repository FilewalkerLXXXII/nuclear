import objMgr, { me } from "../Core/ObjectManager";
import { GroupRole } from "../Enums/UnitEnums";

/**
 * Home is your open-world groups
 * Instance is like battle-grounds, LFR, LFG etc
 * Auto looks first at instance then at home and picks which exist first
 * Instance is pretty much any group that you are automatically added to without needing to accept an invite
 * 99% of the time current party will work but if you for example are in a LFR then teleport out of that raid and is in a home group you need to use home party to find those party members
 */

Object.defineProperties(wow.Party.prototype, {

  getGroupUnits: {
    /**
     * Get an array of group units within a certain distance.
     * @returns {Array<wow.CGUnit>} - An array of valid group members within 40 yards.
     */
    value: function () {
      const members = [];

      // Check if the player is in a group
      const group = wow.Party.currentParty;

      // If the player is not in a group, return the player unit
      if (!group || group.numMembers === 0) {
        members.push(me);
      } else {
        // Iterate over party members and retrieve valid units within range
        for (const m of group.members) {
          const unit = m.toUnit();
          if (unit && me.distanceTo(unit) <= 40) {
            // Check if the unit is alive and not a ghost
            const valid = !unit.deadOrGhost;
            if (valid) {
              members.push(unit);
            }
          }
        }
      }

      return members;
    }
  },

  getPartyMemberByGuid: {
    /**
     * Get a party member unit by guid
     * @param {Guid} guid - The GUID of the party member.
     * @returns {wow.PartyMember | undefined} - A partyMember or undefined if not found.
     */
    value: function (guid) {
      const group = wow.Party.currentParty;

      if (!group || group.numMembers === 0) return undefined;

      // Iterate through the party members and find by GUID
      for (const m of group.members) {
        if (m.guid.equals(guid)) {
          return m;
        }
      }

      return undefined;
    }
  },

  getTankUnits: {
    /**
     * Get an array of tank units within 40 yards in the current group.
     * @returns {Array<wow.CGUnit>} - An array of tank units within the group.
     */
    value: function () {
      const tanks = [];

      // Check if the player is in a group
      const group = wow.Party.currentParty;

      // If the player is not in a group, return an empty array
      if (!group || group.numMembers === 0) return [];

      // Iterate through the party members
      for (const m of group.members) {
        // Check if the member has a Tank role
        if (m.isTank()) {
          const unit = m.guid.toUnit(); // Retrieve object by GUID

          // Check if the unit is within 40 yards and is valid
          if (unit && me.distanceTo(unit) <= 40) {
            tanks.push(unit);
          }
        }
      }

      return tanks;
    }
  },

  isUnitInCombatWithParty: {
    /**
     * Check if a unit is in combat with any party member (excluding the player).
     * @param {wow.CGUnit} unit - The unit to check.
     * @returns {boolean} - Returns true if the unit is in combat with any party member, false otherwise.
     */
    value: function (unit) {
      if (!unit.inCombat() || !unit.target) {
        return false;
      }
      return this.members.find(member =>
        !member.guid.equals(me.guid) &&
        member.guid.equals(unit.target.guid)
      );
    }
  }
});

export default true;
