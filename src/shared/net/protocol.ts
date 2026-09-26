// Wire protocol between the browser client (src/net/) and the game server (server/).
// Shared by both sides; must stay DOM-free (checked by tsconfig.shared.json).
//
// Transport: one WebSocket per client.
//  - Hot path in binary (see codec.ts): the client's STATE at 20 Hz, the server's SNAPSHOT every tick.
//  - Everything else is JSON text frames: handshake, requests (enter/exit/fire…), events, roster, clock.
import type { WeaponId } from '../entities/Ped';
import type { GlobalEvent, PrivateEvent } from '../sim/events';
import type { PelletReport } from '../sim/Combat';
import type { Level } from '../world/World';
import type { DailyState, EventEntry, EventKind, JobKind } from '../sim/rules/types';

/** Bumped whenever the wire format changes; the server refuses mismatched clients.
 *  v4: levels include -1 (in a tunnel).
 *  v5: levels include 2 (an upper bridge deck), and the city's colliders changed (fountains,
 *  monuments and bollards; lanes fitted to the streets), which client and server must agree on.
 *  v7: world events, parties, accounts, revive, races, jobs, the daily puzzle and voice chat
 *  (docs/plans/social-events.md): new messages, a downed player state, liveries, the golden Čumil. */
export const PROTOCOL_VERSION = 7;

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
  /** a party invite code from a `#join=` link: put me next to whoever invited me */
  join?: string;
  /** a Supabase access token: play as that account instead of the guest `token` */
  auth?: string;
  /** with `auth`: move this device's guest progress (`token`) into the account (once, into an empty one) */
  claim?: boolean;
}

/** WebRTC signalling relayed between two paired players (the server only checks who may talk to whom) */
export interface VoiceSignal {
  sdp?: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string };
  ice?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
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
  // ---- social features (docs/plans/social-events.md)
  /** mint (or re-send) this player's party invite code */
  | { t: 'partyInvite' }
  | { t: 'partyLeave' }
  /** leader only */
  | { t: 'partyKick'; id: number }
  /** challenge the player whose car is next to mine to a race */
  | { t: 'challenge'; target: number }
  | { t: 'challengeAnswer'; from: number; ok: boolean }
  | { t: 'job'; op: 'start' | 'stop'; kind?: JobKind }
  /** downed: skip the wait and go to hospital */
  | { t: 'giveUp' }
  /** voice chat opt-in/out (accounts only) */
  | { t: 'voice'; on: boolean }
  | { t: 'voiceSig'; to: number; data: VoiceSignal }
  | { t: 'report'; target: number; reason: string }
  /** delete this account and its progress (GDPR) */
  | { t: 'accountDelete' }
  /** tests only (server started with E2E=1) */
  | {
      t: 'debug';
      give?: WeaponId;
      money?: number;
      wanted?: number;
      hp?: number;
      /** start a world event now */
      event?: EventKind;
      teleport?: [number, number];
      /** make today's puzzle a spot here (tests) */
      daily?: { x: number; y: number; r: number };
    };

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
  /** playing as a Supabase account (not a guest) */
  account: boolean;
  /** hello.claim was honoured: the guest progress moved into the account */
  claimed?: boolean;
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
  | { k: 'horn'; vid: number; x: number; y: number }
  | { k: 'say'; id: number; l: number };

/** roster row: [id, nick, x, y, wanted, inCar, pedId, partyId (0 = none), flags (ROSTER_*)] */
export type RosterRow = [number, string, number, number, number, 0 | 1, number, number, number];
/** roster flags */
export const ROSTER_DOWNED = 1;
export const ROSTER_VOICE = 2;
export const ROSTER_ACCOUNT = 4;
/** a party's name tag: [partyId, tag, colour] */
export type PartyTag = [number, string, string];

/** The city-wide state: active world events and today's puzzle. Sent whole (1 Hz, on change, on hello). */
export interface WevMsg {
  t: 'wev';
  ev: EventEntry[];
  daily: DailyState | null;
}

export type ErrorCode = 'version' | 'bad-hello' | 'full' | 'auth' | 'auth-unavailable' | 'nick-taken';

export type ServerMsg =
  | WelcomeMsg
  /** g: city-wide news (GlobalEvent), sent to everyone */
  | { t: 'ev'; st: number; e: WorldEvent[]; p: PrivateEvent[]; g?: GlobalEvent[] }
  | { t: 'roster'; ps: RosterRow[]; pt?: PartyTag[] }
  | { t: 'clock'; c: ClockSync }
  | { t: 'profile'; money: number; found: string[]; cumils: number[]; stats?: Record<string, number> }
  | { t: 'pong'; ct: number; st: number }
  /** the server rejected an impossible move: go back to this position */
  | { t: 'correct'; x: number; y: number }
  | { t: 'error'; code: ErrorCode }
  | { t: 'bye'; reason: 'restart' | 'replaced' | 'kicked' | 'deleted' }
  | WevMsg
  // ---- voice chat: who to connect to (polite: yield on offer collisions), ICE servers, relayed signals
  | { t: 'voicePeers'; add: { id: number; polite: boolean }[]; del: number[] }
  | { t: 'voiceIce'; ice: IceServer[] }
  | { t: 'voiceSig'; from: number; data: VoiceSignal };

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
