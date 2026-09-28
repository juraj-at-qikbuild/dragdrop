// Referral links in SQLite (docs/referrals.md): which player key each code belongs to, and every
// friend who came in through one: how long they've actually played, what their referrer has been paid
// for them, and how much of that the referrer has been told about.
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { referralCode, referralSeed } from '../../../src/shared/referral';

export const REFERRAL_MIGRATION = `
CREATE TABLE referral_codes (code TEXT PRIMARY KEY, owner_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX referral_codes_owner ON referral_codes(owner_key);
CREATE TABLE referrals (
  referee_key TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  nick TEXT NOT NULL,
  active_ms INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX referrals_code ON referrals(code, created_at);
`;

/** a player key's own code (the client derives the same one: src/net/referral.ts) */
export const referralCodeOf = (playerKey: string) => referralCode(createHash('sha256').update(referralSeed(playerKey)).digest());

export interface ReferralRow {
  referee_key: string;
  code: string;
  nick: string;
  active_ms: number;
  paid: number;
  seen: number;
  created_at: number;
}

export class ReferralStore {
  private q;
  constructor(private db: Database.Database) {
    this.q = {
      register: db.prepare('INSERT INTO referral_codes (code, owner_key, created_at) VALUES (?, ?, ?) ON CONFLICT(code) DO NOTHING'),
      owner: db.prepare<[string], { owner_key: string }>('SELECT owner_key FROM referral_codes WHERE code = ?'),
      add: db.prepare('INSERT INTO referrals (referee_key, code, nick, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(referee_key) DO NOTHING'),
      get: db.prepare<[string], ReferralRow>('SELECT * FROM referrals WHERE referee_key = ?'),
      setActive: db.prepare('UPDATE referrals SET active_ms = MAX(active_ms, @ms), nick = @nick WHERE referee_key = @key'),
      setPaid: db.prepare('UPDATE referrals SET paid = @paid, seen = CASE WHEN @seen THEN @paid ELSE seen END WHERE referee_key = @key'),
      addMoney: db.prepare('UPDATE players SET money = money + ? WHERE token_hash = ?'),
      of: db.prepare<[string], ReferralRow>(
        'SELECT r.* FROM referrals r JOIN referral_codes c ON c.code = r.code WHERE c.owner_key = ? ORDER BY r.created_at DESC',
      ),
      seen: db.prepare('UPDATE referrals SET seen = paid WHERE code IN (SELECT code FROM referral_codes WHERE owner_key = ?)'),
      hasReferee: db.prepare<[string], { x: number }>('SELECT 1 AS x FROM referrals WHERE referee_key = ?'),
      rekeyReferee: db.prepare('UPDATE referrals SET referee_key = @to WHERE referee_key = @from'),
      rekeyCodes: db.prepare('UPDATE referral_codes SET owner_key = @to WHERE owner_key = @from'),
      deleteReferee: db.prepare('DELETE FROM referrals WHERE referee_key = ?'),
      deleteCodes: db.prepare('DELETE FROM referral_codes WHERE owner_key = ?'),
    };
  }

  /** `key` owns `code` (the first owner keeps a code: a collision never steals it) */
  register(code: string, key: string, now: number) {
    this.q.register.run(code, key, now);
  }

  owner(code: string): string | null {
    return this.q.owner.get(code)?.owner_key ?? null;
  }

  /** `referee` came in through `code`; false when they already had a referrer */
  add(referee: string, code: string, nick: string, now: number): boolean {
    return this.q.add.run(referee, code, nick, now).changes > 0;
  }

  get(referee: string): ReferralRow | null {
    return this.q.get.get(referee) ?? null;
  }

  /** a referee's active time so far (never less than what's saved) */
  setActive(referee: string, ms: number, nick: string) {
    this.q.setActive.run({ key: referee, ms: Math.floor(ms), nick });
  }

  /** Record that the referrer has now been paid `paid` in total for `referee` (`seen`: and told so).
   *  With `offlineOwner`, the difference goes onto that saved profile in the same transaction: false
   *  (and nothing changes) when it has no saved profile to pay into. */
  pay(referee: string, paid: number, seen: boolean, offlineOwner?: { key: string; amount: number }): boolean {
    return this.db.transaction(() => {
      if (offlineOwner && this.q.addMoney.run(offlineOwner.amount, offlineOwner.key).changes !== 1) return false;
      this.q.setPaid.run({ key: referee, paid, seen: seen ? 1 : 0 });
      return true;
    })();
  }

  /** every friend who came in through any of `owner`'s codes, newest first */
  of(owner: string): ReferralRow[] {
    return this.q.of.all(owner);
  }

  /** `owner` has been told about everything paid so far */
  markSeen(owner: string) {
    this.q.seen.run(owner);
  }

  /** a guest claimed into an account: their referrer and their own codes come along (their codes keep
   *  working, and pay the account). The account's own referrer, if it somehow already has one, wins. */
  claim(from: string, to: string) {
    this.db.transaction(() => {
      if (this.q.hasReferee.get(to)) this.q.deleteReferee.run(from);
      else this.q.rekeyReferee.run({ from, to });
      this.q.rekeyCodes.run({ from, to });
    })();
  }

  /** a deleted account: gone as a referee and as a referrer (friends it brought in stay unpaid) */
  forget(key: string) {
    this.db.transaction(() => {
      this.q.deleteReferee.run(key);
      this.q.deleteCodes.run(key);
    })();
  }
}
