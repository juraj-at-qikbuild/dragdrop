// Závod?: the transport side of the shared Race rule (src/shared/sim/rules/Race.ts), which owns
// every actual decision (validation, the destination, stakes, the countdown, the payout). This
// feature only turns the two ClientMsgs into calls on that rule and rate-limits `challenge`.
// Plan: docs/plans/social-events.md ("Závod?")
import type { RoomFeature } from './RoomFeature';
import type { Room, Session } from '../Room';
import type { ClientMsg } from '../../../src/shared/net/protocol';
import type { Race as RaceRule } from '../../../src/shared/sim/rules/Race';

/** one challenge every 5 s per challenger (not a per-connection Bucket: this outlives a reconnect) */
const CHALLENGE_COOLDOWN_MS = 5000;

export class Race implements RoomFeature {
  readonly id = 'race';
  /** challenger's player id -> room.wallNow() of their last challenge */
  private lastChallengeAt = new Map<number, number>();

  constructor(private room: Room) {}

  messages = {
    challenge: (s: Session, msg: Extract<ClientMsg, { t: 'challenge' }>) => {
      const now = this.room.wallNow();
      const last = this.lastChallengeAt.get(s.player.id) ?? -Infinity;
      if (now - last < CHALLENGE_COOLDOWN_MS) {
        this.room.sim.events.toPlayer(s.player.id, { k: 'msg', title: '', text: 'Ešte chvíľu počkaj, kým môžeš znova niekoho vyzvať.', time: 2.5, color: '#ffd740' });
        return;
      }
      // every attempt this far spends the cooldown, even a bad target: never a free retry loop
      this.lastChallengeAt.set(s.player.id, now);
      const target = this.room.sessionById(msg.target);
      if (!target?.conn || target === s) return; // offline, or itself: nothing to challenge
      const err = this.rule()?.challenge(s.player, target.player);
      if (err) this.room.sim.events.toPlayer(s.player.id, { k: 'msg', title: '', text: err, time: 3, color: '#ff8a80' });
    },
    challengeAnswer: (s: Session, msg: Extract<ClientMsg, { t: 'challengeAnswer' }>) => {
      this.rule()?.answer(s.player, msg.from, msg.ok);
    },
  };

  private rule() {
    return this.room.sim.rule<RaceRule>('race');
  }
}
