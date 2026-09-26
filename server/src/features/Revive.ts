// The one bit of Revive that lives outside the shared rule (src/shared/sim/rules/Revive.ts): the
// player's own "give up" button. Being close enough to revive someone is decided every tick by the
// shared rule instead, since it has to run identically whether or not anyone asks for it.
// Plan: docs/plans/social-events.md ("Revive")
import type { RoomFeature } from './RoomFeature';
import type { Room, Session } from '../Room';

export class Revive implements RoomFeature {
  readonly id = 'revive';

  constructor(private room: Room) {}

  messages = {
    /** downed: skip the bleed-out wait and go straight to hospital */
    giveUp: (s: Session) => {
      if (s.player.state === 'downed') this.room.sim.wasted(s.player);
    },
  };
}
