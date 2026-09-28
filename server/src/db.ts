// SQLite persistence on the Fly volume: online profiles (money, landmarks, Čumils, nickname, social
// stats, gear), each player's last session (position, health, weapons, wanted level: so a deploy doesn't
// lose them), world state (clock/weather, and any other cached key/value such as a JWKS), party invite
// links and account nicknames (docs/plans/social-events.md), and the leaderboard's point totals
// (docs/plans/leaderboard.md).
// Players and sessions are keyed by **player key**: sha256(guestToken) for a guest (the same hash the
// `token_hash` column always held, so existing rows keep working with no data migration) or
// 'acct:'+userId for a Supabase account. `server/src/Room.ts` computes the key; this module never
// hashes a token itself (it only re-exports `hashToken` for Room and tests).
import Database from 'better-sqlite3';
import { AnalyticsStore, ANALYTICS_MIGRATION } from './analytics/AnalyticsStore';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Profile, SimPlayer } from '../../src/shared/sim/SimPlayer';
import type { WeaponId } from '../../src/shared/entities/Ped';
import { RESUME_MS, type ClockSync } from '../../src/shared/net/protocol';
import type { Level } from '../../src/shared/world/World';
import { SPECS, type VehicleKind } from '../../src/shared/entities/Vehicle';
import { cleanMods, tuned, type Mods } from '../../src/shared/sim/shops/catalog';
import { cleanGear } from '../../src/shared/sim/shops/gear';

/** the car a player was driving when last saved: it leaves the city with them and waits for them
 *  when they're back (docs/plans/pause-resume.md) */
export interface SavedCar {
  kind: VehicleKind;
  color: string;
  hp: number;
  /** [front, rear, left, right], 0..1 */
  dmg: [number, number, number, number];
  /** heading, radians */
  a: number;
  /** its tuning (docs/plans/gameplay.md, Phase 2), when it has any */
  mods?: Mods;
}

export interface SessionRow {
  x: number;
  y: number;
  level: Level;
  health: number;
  armor: number;
  weapon: WeaponId;
  ammo: { pistol: number; uzi: number; shotgun: number };
  wanted: number;
  /** null: on foot (or in a car that doesn't come along: police, event vehicles) */
  car: SavedCar | null;
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
  // pausing and coming back (docs/plans/pause-resume.md): the car a player drove off with
  `ALTER TABLE sessions ADD COLUMN car TEXT;`,
  // the leaderboard (docs/plans/leaderboard.md): point totals per period ('d2026-09-27', 'w2026-W39',
  // 'all'), board and player, added to as points come in, so a page of a board is one index scan
  `CREATE TABLE scores (
     period TEXT NOT NULL,
     board TEXT NOT NULL,
     key TEXT NOT NULL,
     nick TEXT NOT NULL,
     points INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (period, board, key)
   ) WITHOUT ROWID;
   CREATE INDEX scores_top ON scores(period, board, points DESC, updated_at);
   CREATE INDEX scores_key ON scores(key);`,
  // what money buys (docs/plans/gameplay.md, Phase 2): clothes, garages and the cars in them, the
  // collection, a lawyer (JSON, checked field by field on load: shops/gear.ts cleanGear)
  `ALTER TABLE players ADD COLUMN gear TEXT NOT NULL DEFAULT '{}';`,
  ANALYTICS_MIGRATION,
];

/** a row of a leaderboard: the player key, their nickname (as saved with their profile, else as when
 *  they last scored) and their points */
export interface ScoreRow {
  key: string;
  nick: string;
  points: number;
}

/** sessions older than this aren't resumed (you start fresh at the square) */
const SESSION_TTL_MS = RESUME_MS;

/** a guest's player key: the same SHA-256 the `token_hash` column has always stored */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  readonly analytics: AnalyticsStore;
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
    this.analytics = new AnalyticsStore(this.db);
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
      getPlayer: db.prepare<[string], { nickname: string; money: number; found: string; cumils: string; stats: string; gear: string }>(
        'SELECT nickname, money, found, cumils, stats, gear FROM players WHERE token_hash = ?',
      ),
      upsertPlayer: db.prepare(
        `INSERT INTO players (token_hash, nickname, money, found, cumils, stats, gear, created_at, updated_at) VALUES (@h, @nick, @money, @found, @cumils, @stats, @gear, @now, @now)
         ON CONFLICT(token_hash) DO UPDATE SET nickname = @nick, money = @money, found = @found, cumils = @cumils, stats = @stats, gear = @gear, updated_at = @now`,
      ),
      getSession: db.prepare<[string], { x: number; y: number; level: number; health: number; armor: number; weapon: string; ammo: string; wanted: number; car: string | null; saved_at: number }>(
        'SELECT x, y, level, health, armor, weapon, ammo, wanted, car, saved_at FROM sessions WHERE token_hash = ?',
      ),
      upsertSession: db.prepare(
        `INSERT INTO sessions (token_hash, x, y, level, health, armor, weapon, ammo, wanted, car, saved_at) VALUES (@h, @x, @y, @level, @health, @armor, @weapon, @ammo, @wanted, @car, @now)
         ON CONFLICT(token_hash) DO UPDATE SET x = @x, y = @y, level = @level, health = @health, armor = @armor, weapon = @weapon, ammo = @ammo, wanted = @wanted, car = @car, saved_at = @now`,
      ),
      hasPlayer: db.prepare<[string], { x: number }>('SELECT 1 AS x FROM players WHERE token_hash = ?'),
      // copy first (so the new key exists as a parent), THEN rekey sessions, THEN drop the old row:
      // players/sessions has no ON UPDATE CASCADE, so updating a PK in place would trip the FK check
      copyPlayerAs: db.prepare(
        `INSERT INTO players (token_hash, nickname, money, found, cumils, stats, gear, created_at, updated_at)
         SELECT @to, nickname, money, found, cumils, stats, gear, created_at, updated_at FROM players WHERE token_hash = @from`,
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
      addScore: db.prepare(
        `INSERT INTO scores (period, board, key, nick, points, updated_at) VALUES (@period, @board, @key, @nick, @points, @now)
         ON CONFLICT(period, board, key) DO UPDATE SET points = points + @points, nick = @nick, updated_at = @now`,
      ),
      topScores: db.prepare<[string, string, number], ScoreRow>(
        `SELECT s.key AS key, COALESCE(p.nickname, s.nick) AS nick, s.points AS points FROM scores s
         LEFT JOIN players p ON p.token_hash = s.key
         WHERE s.period = ? AND s.board = ? ORDER BY s.points DESC, s.updated_at ASC LIMIT ?`,
      ),
      scoreOf: db.prepare<[string, string, string], { points: number }>('SELECT points FROM scores WHERE period = ? AND board = ? AND key = ?'),
      scoresAbove: db.prepare<[string, string, number], { n: number }>('SELECT COUNT(*) AS n FROM scores WHERE period = ? AND board = ? AND points > ?'),
      boardSize: db.prepare<[string, string], { n: number }>('SELECT COUNT(*) AS n FROM scores WHERE period = ? AND board = ?'),
      hasScores: db.prepare<[string], { x: number }>('SELECT 1 AS x FROM scores WHERE key = ? LIMIT 1'),
      // 'd…' and 'w…' periods sort by date as plain strings; 'all' sorts before both and stays
      pruneScores: db.prepare(`DELETE FROM scores WHERE (period >= 'd' AND period < @day) OR (period >= 'w' AND period < @week)`),
      mergeScores: db.prepare(
        `INSERT INTO scores (period, board, key, nick, points, updated_at) SELECT period, board, @to, nick, points, updated_at FROM scores WHERE key = @from
         ON CONFLICT(period, board, key) DO UPDATE SET points = points + excluded.points, updated_at = MAX(updated_at, excluded.updated_at)`,
      ),
      deleteScores: db.prepare('DELETE FROM scores WHERE key = ?'),
    };
  }

  // ---------------------------------------------------------------- players/sessions (by player key)
  loadProfile(key: string): { nick: string; profile: Profile } | null {
    const r = this.q.getPlayer.get(key);
    if (!r) return null;
    return {
      nick: r.nickname,
      profile: { money: r.money, done: [], found: safeJson(r.found, []), cumils: safeJson(r.cumils, []), stats: safeJson(r.stats, {}), gear: cleanGear(safeJson(r.gear, {})) },
    };
  }

  loadSession(key: string, now = Date.now()): SessionRow | null {
    const r = this.q.getSession.get(key);
    if (!r || now - r.saved_at > SESSION_TTL_MS) return null;
    return {
      x: r.x, y: r.y, level: r.level === 1 || r.level === 2 || r.level === -1 ? r.level : 0, health: r.health, armor: r.armor, weapon: (r.weapon as WeaponId) ?? 'fist',
      ammo: { pistol: 0, uzi: 0, shotgun: 0, ...safeJson(r.ammo, {}) }, wanted: r.wanted, car: savedCar(safeJson(r.car ?? 'null', null)), savedAt: r.saved_at,
    };
  }

  /** save a batch of players (profile + session, with the car they drive when it comes along) in one
   *  transaction */
  savePlayers(list: { key: string; nick: string; player: SimPlayer; car?: SavedCar | null }[], now = Date.now()) {
    this.db.transaction(() => {
      for (const { key: h, nick, player: p, car } of list) {
        this.q.upsertPlayer.run({
          h, nick, money: Math.round(p.profile.money), found: JSON.stringify(p.profile.found), cumils: JSON.stringify(p.profile.cumils), stats: JSON.stringify(p.profile.stats ?? {}),
          gear: JSON.stringify(p.profile.gear ?? {}), now,
        });
        const f = p.focus();
        this.q.upsertSession.run({
          h, x: f.x, y: f.y, level: p.ped.level, health: p.state === 'play' ? Math.max(1, p.ped.health) : 100, armor: p.ped.armor, weapon: p.ped.weapon,
          ammo: JSON.stringify({ pistol: p.ammo.pistol, uzi: p.ammo.uzi, shotgun: p.ammo.shotgun }), wanted: p.state === 'play' ? p.wanted : 0,
          car: car ? JSON.stringify(car) : null, now,
        });
      }
    })();
  }

  hasPlayer(key: string): boolean {
    return !!this.q.hasPlayer.get(key);
  }

  /** a player's progress and their leaderboard points (GDPR: an account deleting itself) */
  deletePlayer(key: string) {
    this.db.transaction(() => {
      this.q.deletePlayer.run(key);
      this.q.deleteScores.run(key);
    })();
  }

  /** Move a guest's progress under a new key (claiming into an account): only when `toKey` is still
   *  empty. Returns whether it moved anything. */
  movePlayer(fromKey: string, toKey: string): boolean {
    if (fromKey === toKey || !this.hasPlayer(fromKey) || this.hasPlayer(toKey)) return false;
    return this.db.transaction(() => {
      this.q.copyPlayerAs.run({ from: fromKey, to: toKey });
      this.q.rekeySessions.run({ from: fromKey, to: toKey });
      this.q.deletePlayer.run(fromKey);
      // the guest's points come along (added to any the account somehow already has)
      this.q.mergeScores.run({ from: fromKey, to: toKey });
      this.q.deleteScores.run(fromKey);
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

  // ----------------------------------------------------------------------- leaderboard scores
  /** Add `points` to `key`'s totals on `board` and on 'all' (a board's points always count on the
   *  whole board too), in every one of `periods`, in one transaction. */
  addScore(key: string, nick: string, board: string, points: number, periods: readonly string[], now: number) {
    this.db.transaction(() => {
      for (const period of periods) {
        this.q.addScore.run({ period, board, key, nick, points, now });
        if (board !== 'all') this.q.addScore.run({ period, board: 'all', key, nick, points, now });
      }
    })();
  }

  /** the top `limit` of a board, most points first (a tie: whoever got there first) */
  topScores(period: string, board: string, limit: number): ScoreRow[] {
    return this.q.topScores.all(period, board, limit);
  }

  scoreOf(period: string, board: string, key: string): number {
    return this.q.scoreOf.get(period, board, key)?.points ?? 0;
  }

  /** the rank `points` holds on a board: 1 + how many have more (a tie shares the rank) */
  rankOf(period: string, board: string, points: number): number {
    return this.q.scoresAbove.get(period, board, points)!.n + 1;
  }

  /** how many players are on a board */
  boardSize(period: string, board: string): number {
    return this.q.boardSize.get(period, board)!.n;
  }

  /** whether this player key has ever scored */
  hasScores(key: string): boolean {
    return !!this.q.hasScores.get(key);
  }

  /** forget days before `dayPeriod` and weeks before `weekPeriod` (the all-time totals stay) */
  pruneScores(dayPeriod: string, weekPeriod: string): number {
    return this.q.pruneScores.run({ day: dayPeriod, week: weekPeriod }).changes;
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

/** a stored car, checked field by field (null when it's missing or doesn't make sense any more; the
 *  car football's ball is never anyone's car) */
function savedCar(v: unknown): SavedCar | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Partial<SavedCar>;
  if (typeof c.kind !== 'string' || !(c.kind in SPECS) || c.kind === 'police' || c.kind === 'ball') return null;
  if (typeof c.color !== 'string' || c.color.length > 32) return null;
  if (typeof c.hp !== 'number' || !Number.isFinite(c.hp) || c.hp <= 0 || typeof c.a !== 'number' || !Number.isFinite(c.a)) return null;
  if (!Array.isArray(c.dmg) || c.dmg.length !== 4 || !c.dmg.every((d) => typeof d === 'number' && Number.isFinite(d))) return null;
  const dmg = c.dmg.map((d) => Math.max(0, Math.min(1, d))) as SavedCar['dmg'];
  const mods = cleanMods(c.mods);
  return { kind: c.kind, color: c.color, hp: Math.min(c.hp, SPECS[c.kind].health), dmg, a: c.a, ...(tuned(mods) ? { mods } : {}) };
}
