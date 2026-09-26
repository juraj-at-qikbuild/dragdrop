// SQLite persistence on the Fly volume: online profiles (money, landmarks, Čumils, nickname, social
// stats), each player's last session (position, health, weapons, wanted level: so a deploy doesn't
// lose them), world state (clock/weather, and any other cached key/value such as a JWKS), party invite
// links and account nicknames (docs/plans/social-events.md).
// Players and sessions are keyed by **player key**: sha256(guestToken) for a guest (the same hash the
// `token_hash` column always held, so existing rows keep working with no data migration) or
// 'acct:'+userId for a Supabase account. `server/src/Room.ts` computes the key; this module never
// hashes a token itself (it only re-exports `hashToken` for Room and tests).
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Profile, SimPlayer } from '../../src/shared/sim/SimPlayer';
import type { WeaponId } from '../../src/shared/entities/Ped';
import type { ClockSync } from '../../src/shared/net/protocol';
import type { Level } from '../../src/shared/world/World';

export interface SessionRow {
  x: number;
  y: number;
  level: Level;
  health: number;
  armor: number;
  weapon: WeaponId;
  ammo: { pistol: number; uzi: number; shotgun: number };
  wanted: number;
  savedAt: number;
}

/** Applied in order, tracked by SQLite's `user_version`. Append a new entry for a schema change;
 *  never edit one that has already shipped (existing databases have already run it as written). */
export const MIGRATIONS = [
  `CREATE TABLE players (
     token_hash TEXT PRIMARY KEY,
     nickname TEXT NOT NULL,
     money INTEGER NOT NULL DEFAULT 0,
     found TEXT NOT NULL DEFAULT '[]',
     cumils TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY REFERENCES players(token_hash) ON DELETE CASCADE,
     x REAL NOT NULL, y REAL NOT NULL, level INTEGER NOT NULL,
     health REAL NOT NULL, armor REAL NOT NULL, weapon TEXT NOT NULL, ammo TEXT NOT NULL, wanted REAL NOT NULL,
     saved_at INTEGER NOT NULL
   );
   CREATE TABLE world (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // v7 social features (docs/plans/social-events.md): per-player counters, invite links, accounts.
  `ALTER TABLE players ADD COLUMN stats TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE invites (
     code TEXT PRIMARY KEY,
     inviter_key TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX invites_inviter_key ON invites(inviter_key);
   CREATE TABLE accounts (
     user_id TEXT PRIMARY KEY,
     nick TEXT NOT NULL,
     nick_lower TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL
   );`,
];

/** sessions older than this aren't resumed (you start fresh at the square) */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** a guest's player key: the same SHA-256 the `token_hash` column has always stored */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  private db: Database.Database;
  private q: ReturnType<Store['prepare']>;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.q = this.prepare();
  }

  private migrate() {
    const v = this.db.pragma('user_version', { simple: true }) as number;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]);
      this.db.pragma(`user_version = ${i + 1}`);
    }
  }

  private prepare() {
    const db = this.db;
    return {
      getPlayer: db.prepare<[string], { nickname: string; money: number; found: string; cumils: string; stats: string }>(
        'SELECT nickname, money, found, cumils, stats FROM players WHERE token_hash = ?',
      ),
      upsertPlayer: db.prepare(
        `INSERT INTO players (token_hash, nickname, money, found, cumils, stats, created_at, updated_at) VALUES (@h, @nick, @money, @found, @cumils, @stats, @now, @now)
         ON CONFLICT(token_hash) DO UPDATE SET nickname = @nick, money = @money, found = @found, cumils = @cumils, stats = @stats, updated_at = @now`,
      ),
      getSession: db.prepare<[string], { x: number; y: number; level: number; health: number; armor: number; weapon: string; ammo: string; wanted: number; saved_at: number }>(
        'SELECT x, y, level, health, armor, weapon, ammo, wanted, saved_at FROM sessions WHERE token_hash = ?',
      ),
      upsertSession: db.prepare(
        `INSERT INTO sessions (token_hash, x, y, level, health, armor, weapon, ammo, wanted, saved_at) VALUES (@h, @x, @y, @level, @health, @armor, @weapon, @ammo, @wanted, @now)
         ON CONFLICT(token_hash) DO UPDATE SET x = @x, y = @y, level = @level, health = @health, armor = @armor, weapon = @weapon, ammo = @ammo, wanted = @wanted, saved_at = @now`,
      ),
      hasPlayer: db.prepare<[string], { x: number }>('SELECT 1 AS x FROM players WHERE token_hash = ?'),
      // copy first (so the new key exists as a parent), THEN rekey sessions, THEN drop the old row:
      // players/sessions has no ON UPDATE CASCADE, so updating a PK in place would trip the FK check
      copyPlayerAs: db.prepare(
        `INSERT INTO players (token_hash, nickname, money, found, cumils, stats, created_at, updated_at)
         SELECT @to, nickname, money, found, cumils, stats, created_at, updated_at FROM players WHERE token_hash = @from`,
      ),
      rekeySessions: db.prepare('UPDATE sessions SET token_hash = @to WHERE token_hash = @from'),
      deletePlayer: db.prepare('DELETE FROM players WHERE token_hash = ?'),
      getWorld: db.prepare<[string], { value: string }>('SELECT value FROM world WHERE key = ?'),
      setWorld: db.prepare('INSERT INTO world (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      count: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM players'),
      createInvite: db.prepare(
        `INSERT INTO invites (code, inviter_key, created_at, expires_at) VALUES (@code, @inviterKey, @now, @exp)
         ON CONFLICT(code) DO UPDATE SET inviter_key = @inviterKey, created_at = @now, expires_at = @exp`,
      ),
      getInvite: db.prepare<[string], { inviter_key: string; expires_at: number }>('SELECT inviter_key, expires_at FROM invites WHERE code = ?'),
      deleteInvitesOf: db.prepare('DELETE FROM invites WHERE inviter_key = ?'),
      getAccount: db.prepare<[string], { nick: string }>('SELECT nick FROM accounts WHERE user_id = ?'),
      getNickOwner: db.prepare<[string], { user_id: string }>('SELECT user_id FROM accounts WHERE nick_lower = ?'),
      upsertAccount: db.prepare(
        `INSERT INTO accounts (user_id, nick, nick_lower, created_at) VALUES (@userId, @nick, @nickLower, @now)
         ON CONFLICT(user_id) DO UPDATE SET nick = @nick, nick_lower = @nickLower`,
      ),
      deleteAccount: db.prepare('DELETE FROM accounts WHERE user_id = ?'),
    };
  }

  // ---------------------------------------------------------------- players/sessions (by player key)
  loadProfile(key: string): { nick: string; profile: Profile } | null {
    const r = this.q.getPlayer.get(key);
    if (!r) return null;
    return { nick: r.nickname, profile: { money: r.money, done: [], found: safeJson(r.found, []), cumils: safeJson(r.cumils, []), stats: safeJson(r.stats, {}) } };
  }

  loadSession(key: string, now = Date.now()): SessionRow | null {
    const r = this.q.getSession.get(key);
    if (!r || now - r.saved_at > SESSION_TTL_MS) return null;
    return {
      x: r.x, y: r.y, level: r.level === 1 || r.level === 2 || r.level === -1 ? r.level : 0, health: r.health, armor: r.armor, weapon: (r.weapon as WeaponId) ?? 'fist',
      ammo: { pistol: 0, uzi: 0, shotgun: 0, ...safeJson(r.ammo, {}) }, wanted: r.wanted, savedAt: r.saved_at,
    };
  }

  /** save a batch of players (profile + session) in one transaction */
  savePlayers(list: { key: string; nick: string; player: SimPlayer }[], now = Date.now()) {
    this.db.transaction(() => {
      for (const { key: h, nick, player: p } of list) {
        this.q.upsertPlayer.run({ h, nick, money: Math.round(p.profile.money), found: JSON.stringify(p.profile.found), cumils: JSON.stringify(p.profile.cumils), stats: JSON.stringify(p.profile.stats ?? {}), now });
        const f = p.focus();
        this.q.upsertSession.run({
          h, x: f.x, y: f.y, level: p.ped.level, health: p.state === 'play' ? Math.max(1, p.ped.health) : 100, armor: p.ped.armor, weapon: p.ped.weapon,
          ammo: JSON.stringify({ pistol: p.ammo.pistol, uzi: p.ammo.uzi, shotgun: p.ammo.shotgun }), wanted: p.state === 'play' ? p.wanted : 0, now,
        });
      }
    })();
  }

  hasPlayer(key: string): boolean {
    return !!this.q.hasPlayer.get(key);
  }

  deletePlayer(key: string) {
    this.q.deletePlayer.run(key);
  }

  /** Move a guest's progress under a new key (claiming into an account): only when `toKey` is still
   *  empty. Returns whether it moved anything. */
  movePlayer(fromKey: string, toKey: string): boolean {
    if (fromKey === toKey || !this.hasPlayer(fromKey) || this.hasPlayer(toKey)) return false;
    return this.db.transaction(() => {
      this.q.copyPlayerAs.run({ from: fromKey, to: toKey });
      this.q.rekeySessions.run({ from: fromKey, to: toKey });
      this.q.deletePlayer.run(fromKey);
      return true;
    })();
  }

  // -------------------------------------------------------------------------------------- invites
  createInvite(code: string, inviterKey: string, now: number, ttlMs: number) {
    this.q.createInvite.run({ code, inviterKey, now, exp: now + ttlMs });
  }

  getInvite(code: string, now: number): { inviterKey: string } | null {
    const r = this.q.getInvite.get(code);
    return r && now < r.expires_at ? { inviterKey: r.inviter_key } : null;
  }

  deleteInvitesOf(inviterKey: string) {
    this.q.deleteInvitesOf.run(inviterKey);
  }

  // ------------------------------------------------------------------------------------- accounts
  getAccount(userId: string): { nick: string } | null {
    return this.q.getAccount.get(userId) ?? null;
  }

  /** Reserve (or update) an account's nickname. False when another account already holds it,
   *  case-insensitively; true also when this account already held it and just changed case/spelling. */
  reserveNick(userId: string, nick: string, now: number): boolean {
    const nickLower = nick.toLowerCase();
    return this.db.transaction(() => {
      const owner = this.q.getNickOwner.get(nickLower);
      if (owner && owner.user_id !== userId) return false;
      this.q.upsertAccount.run({ userId, nick, nickLower, now });
      return true;
    })();
  }

  deleteAccount(userId: string) {
    this.q.deleteAccount.run(userId);
  }

  // ----------------------------------------------------------------- world (generic key/value store)
  getWorld(key: string): string | null {
    return this.q.getWorld.get(key)?.value ?? null;
  }

  setWorld(key: string, value: string) {
    this.q.setWorld.run(key, value);
  }

  loadClock(): ClockSync | null {
    const v = this.getWorld('clock');
    return v ? safeJson<ClockSync | null>(v, null) : null;
  }

  saveClock(c: ClockSync) {
    this.setWorld('clock', JSON.stringify(c));
  }

  playerCount() {
    return this.q.count.get()!.n;
  }

  close() {
    this.db.close();
  }
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
