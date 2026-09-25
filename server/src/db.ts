// SQLite persistence on the Fly volume: online profiles (money, landmarks, Čumils, nickname), each
// player's last session (position, health, weapons, wanted level: so a deploy doesn't lose them), and
// world state (clock/weather). Tokens are bearer secrets, so only their SHA-256 is stored.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Profile, SimPlayer } from '../../src/shared/sim/SimPlayer';
import type { WeaponId } from '../../src/shared/entities/Ped';
import type { ClockSync } from '../../src/shared/net/protocol';

export interface SessionRow {
  x: number;
  y: number;
  level: 0 | 1;
  health: number;
  armor: number;
  weapon: WeaponId;
  ammo: { pistol: number; uzi: number; shotgun: number };
  wanted: number;
  savedAt: number;
}

const MIGRATIONS = [
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
];

/** sessions older than this aren't resumed (you start fresh at the square) */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

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
      getPlayer: db.prepare<[string], { nickname: string; money: number; found: string; cumils: string }>('SELECT nickname, money, found, cumils FROM players WHERE token_hash = ?'),
      upsertPlayer: db.prepare(
        `INSERT INTO players (token_hash, nickname, money, found, cumils, created_at, updated_at) VALUES (@h, @nick, @money, @found, @cumils, @now, @now)
         ON CONFLICT(token_hash) DO UPDATE SET nickname = @nick, money = @money, found = @found, cumils = @cumils, updated_at = @now`,
      ),
      getSession: db.prepare<[string], { x: number; y: number; level: number; health: number; armor: number; weapon: string; ammo: string; wanted: number; saved_at: number }>(
        'SELECT x, y, level, health, armor, weapon, ammo, wanted, saved_at FROM sessions WHERE token_hash = ?',
      ),
      upsertSession: db.prepare(
        `INSERT INTO sessions (token_hash, x, y, level, health, armor, weapon, ammo, wanted, saved_at) VALUES (@h, @x, @y, @level, @health, @armor, @weapon, @ammo, @wanted, @now)
         ON CONFLICT(token_hash) DO UPDATE SET x = @x, y = @y, level = @level, health = @health, armor = @armor, weapon = @weapon, ammo = @ammo, wanted = @wanted, saved_at = @now`,
      ),
      getWorld: db.prepare<[string], { value: string }>('SELECT value FROM world WHERE key = ?'),
      setWorld: db.prepare('INSERT INTO world (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      count: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM players'),
    };
  }

  loadProfile(token: string): { nick: string; profile: Profile } | null {
    const r = this.q.getPlayer.get(hashToken(token));
    if (!r) return null;
    return { nick: r.nickname, profile: { money: r.money, done: [], found: safeJson(r.found, []), cumils: safeJson(r.cumils, []) } };
  }

  loadSession(token: string, now = Date.now()): SessionRow | null {
    const r = this.q.getSession.get(hashToken(token));
    if (!r || now - r.saved_at > SESSION_TTL_MS) return null;
    return {
      x: r.x, y: r.y, level: r.level === 1 ? 1 : 0, health: r.health, armor: r.armor, weapon: (r.weapon as WeaponId) ?? 'fist',
      ammo: { pistol: 0, uzi: 0, shotgun: 0, ...safeJson(r.ammo, {}) }, wanted: r.wanted, savedAt: r.saved_at,
    };
  }

  /** save a batch of players (profile + session) in one transaction */
  savePlayers(list: { token: string; nick: string; player: SimPlayer }[], now = Date.now()) {
    this.db.transaction(() => {
      for (const { token, nick, player: p } of list) {
        const h = hashToken(token);
        this.q.upsertPlayer.run({ h, nick, money: Math.round(p.profile.money), found: JSON.stringify(p.profile.found), cumils: JSON.stringify(p.profile.cumils), now });
        const f = p.focus();
        this.q.upsertSession.run({
          h, x: f.x, y: f.y, level: p.ped.level, health: p.state === 'play' ? Math.max(1, p.ped.health) : 100, armor: p.ped.armor, weapon: p.ped.weapon,
          ammo: JSON.stringify({ pistol: p.ammo.pistol, uzi: p.ammo.uzi, shotgun: p.ammo.shotgun }), wanted: p.state === 'play' ? p.wanted : 0, now,
        });
      }
    })();
  }

  loadClock(): ClockSync | null {
    const r = this.q.getWorld.get('clock');
    return r ? safeJson<ClockSync | null>(r.value, null) : null;
  }

  saveClock(c: ClockSync) {
    this.q.setWorld.run('clock', JSON.stringify(c));
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
