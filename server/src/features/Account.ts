// GDPR account deletion (docs/plans/social-events.md, Features → Accounts: "Deleting an account").
// The SQLite rows are removed synchronously (Room stays synchronous in tick()); the Supabase side (the
// auth user, that player's `activity` rows) goes through the shared client, fire-and-forget, so an HTTP
// round trip never blocks a tick. Guests have no account to delete, so `accountDelete` is a no-op for them.
import type { Room, Session } from '../Room';
import type { RoomFeature } from './RoomFeature';

export class Account implements RoomFeature {
  readonly id = 'account';
  constructor(private room: Room) {}

  messages = {
    accountDelete: (s: Session) => {
      if (!s.player.account) return; // nothing server-side to delete for a guest
      const userId = s.key.slice('acct:'.length);
      this.room.store?.deletePlayer(s.key);
      this.room.store?.deleteAccount(userId);
      const supa = this.room.supa;
      if (supa?.enabled) {
        // never the key or the response body in the log: the path's shape and the error are enough
        supa.adminDeleteUser(userId).catch((e: Error) => console.error('account delete: auth user', e.message));
        supa.deleteRows('activity', `player=eq.${encodeURIComponent(s.key)}`).catch((e: Error) => console.error('account delete: activity', e.message));
      }
      this.room.sendTo(s, { t: 'bye', reason: 'deleted' });
      this.room.dropSession(s);
    },
  };
}
