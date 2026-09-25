// Wire protocol between the browser client (src/net/) and the game server (server/).
// Shared by both sides; must stay DOM-free (checked by tsconfig.shared.json).
//
// Transport: one WebSocket per client.
//  - Hot path in binary (see codec.ts): the client's STATE at 20 Hz, the server's SNAPSHOT every tick.
//  - Everything else is JSON text frames: handshake, requests (enter/exit/fire…), events, roster, clock.
import type { WeaponId } from '../entities/Ped';
import type { PrivateEvent } from '../sim/events';
import type { PelletReport } from '../sim/Combat';
import type { Level } from '../world/World';

/** Bumped whenever the wire format changes; the server refuses mismatched clients.
 *  v4: levels include -1 (in a tunnel). */
export const PROTOCOL_VERSION = 4;

/** server simulation / snapshot rate */
export const TICK_HZ = 20;
/** client-side interpolation delay: remote entities are rendered this far in the past */
export const INTERP_DELAY_MS = 100;
/** client state upload rate */
export const STATE_HZ = 20;

export type { WeaponId };

/** Full state of the car a player drives, sent when they leave it (the server takes over simulating it). */
export interface VehFull {
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  av: number;
  hp: number;
  /** [front, rear, left, right], 0..1 */
  dmg: [number, number, number, number];
  fire: number;
  tyres: 0 | 1;
  nitro: number;
  lvl: Level;
}

// ------------------------------------------------------------ client → server (JSON)
export interface HelloMsg {
  t: 'hello';
  v: number;
  token: string;
  nick: string;
  /** reconnecting: where this client is, and the car it's driving (0 = on foot) */
  resume?: { x: number; y: number; lvl: Level; car: number };
}

/** a shot as traced by the shooter's client */
export interface FireMsg {
  t: 'fire';
  w: WeaponId;
  ox: number;
  oy: number;
  a: number;
  lvl: Level;
  /** the shooter's render time (server clock, ms) when it fired: hit claims are checked against then */
  rt: number;
  pellets: PelletReport[];
}

export type ClientMsg =
  | HelloMsg
  | FireMsg
  | { t: 'punch'; target: number; rt: number }
  | { t: 'enter'; vid: number }
  | { t: 'exit'; x: number; y: number; veh: VehFull }
  | { t: 'horn' }
  /** "a car/tram just hit me": the victim's client reports it (it sees exactly what hit it) */
  | { t: 'hit'; src: number; speed: number; tram: 0 | 1; rt: number }
  | { t: 'nick'; nick: string }
  | { t: 'ping'; ct: number }
  | { t: 'leave' }
  /** tests only (server started with E2E=1) */
  | { t: 'debug'; give?: WeaponId; money?: number; wanted?: number; hp?: number };

// ------------------------------------------------------------ server → client (JSON)
export interface WelcomeMsg {
  t: 'welcome';
  v: number;
  /** player id */
  id: number;
  /** this player's figure (its id; the server never sends it back as an entity) */
  ped: number;
  nick: string;
  look: number;
  x: number;
  y: number;
  lvl: Level;
  /** car still owned from before a reconnect, if any */
  car: number;
  epoch: number;
  tickHz: number;
  /** server clock, ms */
  st: number;
  clock: ClockSync;
}

export interface ClockSync {
  time: number;
  rain: number;
  wet: number;
  target: number;
}

/** A world event (see SimEvents), JSON-encoded; `st` of the enclosing message dates it. */
export type WorldEvent =
  | { k: 'shot'; by: number; pid: number; x: number; y: number; a: number; w: WeaponId; lvl: Level; ends: number[]; sparks: number }
  | { k: 'melee'; x: number; y: number; hit: 0 | 1 }
  | { k: 'pedHit'; id: number; x: number; y: number; s: number }
  | { k: 'spark'; x: number; y: number; kind: 0 | 1 | 2 }
  | { k: 'explode'; x: number; y: number; vid: number; c: string | null }
  | { k: 'crash'; vid: number; x: number; y: number; sev: number; nx: number; ny: number; kick: number }
  | { k: 'killed'; id: number; x: number; y: number; by: number; cause: 'shot' | 'melee' | 'road' | 'tram' | 'blast' }
  | { k: 'scream'; x: number; y: number }
  | { k: 'bell'; x: number; y: number }
  | { k: 'horn'; vid: number; x: number; y: number };

/** roster row: [id, nick, x, y, wanted, inCar, pedId] */
export type RosterRow = [number, string, number, number, number, 0 | 1, number];

export type ServerMsg =
  | WelcomeMsg
  | { t: 'ev'; st: number; e: WorldEvent[]; p: PrivateEvent[] }
  | { t: 'roster'; ps: RosterRow[] }
  | { t: 'clock'; c: ClockSync }
  | { t: 'profile'; money: number; found: string[]; cumils: number[] }
  | { t: 'pong'; ct: number; st: number }
  /** the server rejected an impossible move: go back to this position */
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

export { PLAYER_SHIRTS } from '../entities/Ped';
