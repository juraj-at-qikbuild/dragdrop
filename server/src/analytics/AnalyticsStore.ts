import type Database from 'better-sqlite3';
import type { AnalyticsEntry, OutboxRow, PlaySnapshot } from './types';

export const ANALYTICS_MIGRATION = `
CREATE TABLE analytics_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
CREATE TABLE analytics_open (id TEXT PRIMARY KEY, player TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE analytics_claims (guest TEXT PRIMARY KEY, account TEXT NOT NULL);
`;

/** Durable, coalesced cumulative snapshots. An acknowledgment only removes exactly what was sent. */
export class AnalyticsStore {
  constructor(private db: Database.Database) {}
  put(key: string, entry: AnalyticsEntry) {
    this.db.prepare('INSERT INTO analytics_outbox(key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload')
      .run(key, JSON.stringify(entry));
  }
  checkpoint(snapshot: PlaySnapshot) {
    this.db.transaction(() => {
      this.put('session:' + snapshot.id, { kind: 'session', snapshot });
      if (snapshot.ended_at) this.db.prepare('DELETE FROM analytics_open WHERE id=?').run(snapshot.id);
      else this.db.prepare('INSERT INTO analytics_open VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload')
        .run(snapshot.id, snapshot.player, JSON.stringify(snapshot));
    })();
  }
  recover(): PlaySnapshot[] {
    return this.db.prepare('SELECT payload FROM analytics_open').all().map((r) => JSON.parse((r as {payload: string}).payload));
  }
  pending(limit = 200): OutboxRow[] {
    return this.db.prepare('SELECT id,key,payload FROM analytics_outbox ORDER BY id LIMIT ?').all(limit) as OutboxRow[];
  }
  acknowledge(rows: OutboxRow[]) {
    const q = this.db.prepare('DELETE FROM analytics_outbox WHERE id=? AND payload=?');
    this.db.transaction(() => { for (const row of rows) q.run(row.id, row.payload); })();
  }
  claim(from: string, to: string) {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO analytics_claims VALUES (?,?) ON CONFLICT(guest) DO UPDATE SET account=excluded.account').run(from, to);
      this.put('claim:' + from, { kind: 'claim', from, to });
    })();
  }
  forget(player: string) {
    this.db.transaction(() => {
      const guests = this.db.prepare('SELECT guest FROM analytics_claims WHERE account=?').all(player) as {guest:string}[];
      for (const key of [player, ...guests.map(g => g.guest)]) {
        this.db.prepare(`DELETE FROM analytics_outbox WHERE json_extract(payload,'$.snapshot.player')=?
          OR json_extract(payload,'$.player')=? OR json_extract(payload,'$.from')=? OR json_extract(payload,'$.to')=?`).run(key,key,key,key);
        this.db.prepare('DELETE FROM analytics_open WHERE player=?').run(key);
        this.put('delete:' + key, { kind: 'delete', player: key });
      }
      this.put('delete:' + player, { kind: 'delete', player });
    })();
  }
  seed() {
    const q = this.db.prepare('SELECT value FROM world WHERE key=?');
    if (q.get('analytics_seeded')) return;
    this.db.transaction(() => {
      const rows = this.db.prepare('SELECT token_hash,nickname,created_at,updated_at FROM players').all() as
        {token_hash:string; nickname:string; created_at:number; updated_at:number}[];
      for (const r of rows) this.put('player:' + r.token_hash, {kind:'player', player:r.token_hash, nick:r.nickname,
        first_seen:new Date(r.created_at).toISOString(), last_seen:new Date(r.updated_at).toISOString()});
      this.db.prepare("INSERT INTO world(key,value) VALUES ('analytics_seeded','1')").run();
    })();
  }
  count() { return (this.db.prepare('SELECT COUNT(*) AS n FROM analytics_outbox').get() as {n:number}).n; }
}
