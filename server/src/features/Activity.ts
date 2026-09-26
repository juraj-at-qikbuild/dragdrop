// Fire-and-forget writes to Supabase: the activity log (payouts and milestones, for the weekly
// leaderboard) and player reports (voice/conduct moderation). Both go through Supa's batched queue, so
// nothing here is ever awaited from the tick or a message handler (docs/plans/social-events.md).
import type { Session } from '../Room';
import type { Supa } from '../supa';
import type { RoomFeature } from './RoomFeature';

/** what log() needs from a player: a full Session, or just enough to stand in for one (e.g. a payout
 *  attributed after the session that earned it is already gone) */
export type PlayerLike = Session | { key: string; nick: string };

const identity = (s: PlayerLike): { key: string; nick: string } => ('player' in s ? { key: s.key, nick: s.player.nick } : s);

export class Activity implements RoomFeature {
  readonly id = 'activity';

  constructor(readonly supa: Supa) {}

  /** a payout or milestone (kind: the payout reason, e.g. 'kofolka' | 'bounty' | 'courier' | 'daily';
   *  amount is rounded to whole money); a no-op when Supabase is off */
  log(kind: string, s: PlayerLike, amount: number, meta: object = {}) {
    if (!this.supa.enabled) return;
    const { key, nick } = identity(s);
    this.supa.enqueue('activity', { kind, player: key, nick, amount: Math.round(amount), meta });
  }

  /** a voice/conduct report; context carries positions and whatever else the caller wants recorded */
  report(reporter: Session, target: Session, reason: string, context: object = {}) {
    if (!this.supa.enabled) return;
    this.supa.enqueue('reports', {
      reporter: reporter.key, reporter_nick: reporter.player.nick,
      target: target.key, target_nick: target.player.nick,
      reason, context,
    });
  }

  /** let the shared queue make its final attempt before the process exits. index.ts's SIGTERM handler
   *  also awaits room.supa directly with the same bound; Supa.shutdown() coalesces the two. */
  shutdown() {
    void this.supa.shutdown();
  }
}
