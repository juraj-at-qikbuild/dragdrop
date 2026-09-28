// The wire hookup for the mini-games (docs/plans/minigames.md): the `mini` message -> the shared rule
// (src/shared/sim/rules/minigames/MiniGames.ts), which runs every round and sends each player their
// private `mini` state itself; the rounds others can still join ride along in `wev` as `mg`. A server
// with it says 'mini' in its welcome's caps, and a client only sends `mini` to such a server.
import type { RoomFeature } from './RoomFeature';
import type { Room, Session } from '../Room';
import type { ClientMsg, WevMsg } from '../../../src/shared/net/protocol';
import type { MiniGames as MiniGamesRule } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { isMiniReq } from '../../../src/shared/sim/rules/minigames/types';

export class MiniGames implements RoomFeature {
  readonly id = 'minigames';

  constructor(private room: Room) {}

  private get rule() {
    return this.room.sim.rule<MiniGamesRule>('minigames');
  }

  messages = {
    mini: (s: Session, msg: Extract<ClientMsg, { t: 'mini' }>) => {
      const rule = this.rule;
      if (!rule || !isMiniReq(msg)) return;
      rule.req(s.player, msg);
    },
  };

  wev(out: WevMsg) {
    const open = this.rule?.open() ?? [];
    if (open.length) out.mg = open;
  }

  /** tests: start a round of `mini` for this player and cut its lobby short */
  onDebug(s: Session, msg: Extract<ClientMsg, { t: 'debug' }>) {
    const rule = this.rule;
    if (!rule || !msg.mini) return;
    if (rule.start(s.player, msg.mini)) rule.go(s.player);
  }

  shutdown() {
    this.rule?.stopAll();
  }

  stats() {
    return { miniRounds: this.rule?.all.length ?? 0 };
  }
}
