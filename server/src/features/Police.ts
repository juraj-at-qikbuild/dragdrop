// The player's side of the police chase that the server has to hear about (docs/plans/gameplay.md,
// Phase 1): buying off an arrest (Úplatok). Everything else about the chase (who sees whom, the
// description, the search, lying low) runs in the shared simulation (src/shared/sim/Pursuit.ts), and
// the offer itself comes from there too: Sim.bust sends it, this only takes the answer.
import type { RoomFeature } from './RoomFeature';
import type { Room, Session } from '../Room';

export class Police implements RoomFeature {
  readonly id = 'police';

  constructor(private room: Room) {}

  messages = {
    /** pay off the arrest on offer; Sim.bribe checks there is one, and the money */
    bribe: (s: Session) => {
      this.room.sim.bribe(s.player);
    },
  };
}
