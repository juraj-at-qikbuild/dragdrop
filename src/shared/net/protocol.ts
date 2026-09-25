// Wire protocol between the browser client (src/net/) and the game server (server/).
// Shared by both sides; must stay DOM-free (checked by tsconfig.shared.json).
//
// Transport: one WebSocket per client. Control messages and events are JSON text frames.

/** Bumped whenever the wire format changes; the server refuses mismatched clients. */
export const PROTOCOL_VERSION = 1;

/** server simulation / snapshot rate */
export const TICK_HZ = 20;
/** client-side interpolation delay: remote entities are rendered this far in the past */
export const INTERP_DELAY_MS = 100;
/** client state upload rate */
export const STATE_HZ = 20;

export type WeaponId = 'fist' | 'pistol' | 'uzi' | 'shotgun';

/** A vehicle as its driver reports it (the driver's client simulates it). */
export interface VehState {
  /** VehicleKind */
  k: string;
  /** body colour */
  c: string;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  av: number;
  /** wheel steer -1..1 */
  st: number;
  /** throttle -1..1 (brake lights) */
  th: number;
  /** bit flags: see VEH_FLAG */
  f: number;
  /** health, 0..spec.health */
  hp: number;
  /** located damage [front, rear, left, right], 0..1 */
  dmg: [number, number, number, number];
  /** skid intensity 0..1 */
  sk: number;
  /** seconds sinking (0 = afloat) */
  sink: number;
  /** seconds until a burning car explodes, -1 when not burning */
  fire: number;
}

export const VEH_FLAG = {
  siren: 1,
  handbrake: 2,
  boosting: 4,
  wrecked: 8,
  tyres: 16,
  horn: 32,
} as const;

/** Client → server: the local player's own state, sent at STATE_HZ. */
export interface StateMsg {
  t: 'state';
  seq: number;
  /** teleport counter: bumped by the client on respawn so the server accepts the jump */
  ep: number;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  lvl: 0 | 1;
  w: WeaponId;
  hp: number;
  /** wanted level, 0..5 (client-side in protocol v1) */
  wanted: number;
  dead: 0 | 1;
  /** camera half-extents in metres, for interest management */
  hw: number;
  hh: number;
  veh: VehState | null;
}

export interface HelloMsg {
  t: 'hello';
  v: number;
  token: string;
  nick: string;
}

/** Cosmetic shot report (v1): relayed to nearby players so they see the muzzle flash and tracers. */
export interface ShotMsg {
  t: 'shot';
  w: WeaponId;
  x: number;
  y: number;
  a: number;
  lvl: 0 | 1;
  /** tracer end points, flat [x, y, ...] */
  ends: number[];
}

export type ClientMsg =
  | HelloMsg
  | StateMsg
  | ShotMsg
  | { t: 'nick'; nick: string }
  | { t: 'ping'; ct: number }
  | { t: 'leave' };

/** One other player as seen by a client. */
export interface PlayerSnap {
  id: number;
  nick: string;
  /** look index: shirt colour of the player figure */
  look: number;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  lvl: 0 | 1;
  w: WeaponId;
  wanted: number;
  dead: 0 | 1;
  veh: VehState | null;
}

export interface WelcomeMsg {
  t: 'welcome';
  v: number;
  id: number;
  nick: string;
  look: number;
  tickHz: number;
  /** server clock, ms */
  st: number;
}

export interface SnapMsg {
  t: 'snap';
  /** server clock, ms */
  st: number;
  ps: PlayerSnap[];
  /** ids of players that left this client's interest area (or the game) */
  gone: number[];
}

export interface ShotEvent {
  k: 'shot';
  pid: number;
  w: WeaponId;
  x: number;
  y: number;
  a: number;
  lvl: 0 | 1;
  ends: number[];
}

export type WorldEvent = ShotEvent;

/** roster row: [id, nick, x, y, wanted, inCar] */
export type RosterRow = [number, string, number, number, number, 0 | 1];

export type ServerMsg =
  | WelcomeMsg
  | SnapMsg
  | { t: 'ev'; st: number; e: WorldEvent[] }
  | { t: 'roster'; ps: RosterRow[] }
  | { t: 'pong'; ct: number; st: number }
  | { t: 'correct'; x: number; y: number }
  | { t: 'error'; code: 'version' | 'bad-hello' | 'full' }
  | { t: 'bye'; reason: 'restart' | 'replaced' | 'kicked' };

// ------------------------------------------------------------------ helpers

export const NICK_MIN = 2;
export const NICK_MAX = 16;

/** Trim and validate a nickname; returns null when unusable. */
export function cleanNick(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < NICK_MIN || s.length > NICK_MAX) return null;
  if (!/^[\p{L}\p{N} ._\-]+$/u.test(s)) return null;
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isToken = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

/** Shirt colours for player figures, indexed by `look`. */
export const PLAYER_SHIRTS = ['#4a3220', '#1565c0', '#2e7d32', '#6a1b9a', '#c62828', '#00838f', '#ef6c00', '#37474f', '#ad1457', '#9e9d24'];
