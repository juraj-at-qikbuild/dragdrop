// Wire protocol between the browser client (src/net/) and the game server (server/).
// Shared by both sides; must stay DOM-free (checked by tsconfig.shared.json).
//
// Transport: one WebSocket per client.
//  - Hot path in binary (see codec.ts): the client's STATE at 20 Hz, the server's SNAPSHOT every tick.
//  - Everything else is JSON text frames: handshake, requests (enter/exit/fire…), events, roster, clock.
import type { WeaponId } from '../entities/Ped';
import type { VehicleKind } from '../entities/Vehicle';
import type { GlobalEvent, PrivateEvent } from '../sim/events';
import type { Mess, PelletReport } from '../sim/Combat';
import type { Level } from '../world/World';
import type { DailyState, EventEntry, EventKind, EventSchedule, JobKind } from '../sim/rules/types';
import type { BoardId, ScorePeriod } from '../sim/rules/points';
import type { Gear, Prices } from '../sim/shops/catalog';
import type { MiniKind, MiniOpen, MiniReq } from '../sim/rules/minigames/types';

/** Bumped whenever the wire format changes; the server refuses mismatched clients.
 *  v4: levels include -1 (in a tunnel).
 *  v5: levels include 2 (an upper bridge deck), and the city's colliders changed (fountains,
 *  monuments and bollards; lanes fitted to the streets), which client and server must agree on.
 *  v7: world events, parties, accounts, revive, races, jobs, the daily puzzle and voice chat
 *  (docs/plans/social-events.md): new messages, a downed player state, liveries, the golden Čumil.
 *  Pausing and coming back (docs/plans/pause-resume.md) added only optional fields and messages that
 *  either side can do without, so it stayed v7: `hello.presence` says a client sends `away` and
 *  understands `bye: 'idle'`, and `welcome.resumed` says the server takes `away`. The leaderboard
 *  (docs/plans/leaderboard.md) is optional the same way: a server that keeps one sends `score` right
 *  after every welcome, and a client only asks for a `board` once it has seen one. So is the police's
 *  side of a chase (docs/plans/gameplay.md, Phase 1): the `police` and `bribe` private events are new
 *  kinds older clients ignore, and a client only sends `bribe` in answer to a `bribe` offer. And so
 *  are the shops (Phase 2): a server that has them sends a `catalog` after every welcome, a client only
 *  sends `shop` once it has seen one, and the rest (gear, a car's tuning, a hat) rides in fields and
 *  spare snapshot bits an older client never reads. */
export const PROTOCOL_VERSION = 7;

/** server simulation / snapshot rate */
export const TICK_HZ = 20;
/** client-side interpolation delay: remote entities are rendered this far in the past */
export const INTERP_DELAY_MS = 100;
/** client state upload rate */
export const STATE_HZ = 20;
/** a player who comes back within this long starts where they left (their spot, health, weapons,
 *  car); later, on the square. Also what the main menu's "Pokračovať online" promises. */
export const RESUME_MS = 24 * 60 * 60 * 1000;

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
  /** this client reports `away` and understands `bye: 'idle'` (older clients don't send it, and are
   *  never timed out for being idle) */
  presence?: boolean;
  /** Input telemetry supported; duration is always measured by the server. */
  analytics?: boolean;
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
  /** `fall`: thrown off a scooter or a bike by a knock that hard (m/s), which hurts (Vehicle.fallHurt;
   *  docs/plans/gameplay.md, Phase 3). The rider's client decides it: it simulates the ride. */
  | { t: 'exit'; x: number; y: number; veh: VehFull; fall?: number }
  | { t: 'horn' }
  /** trams (docs/plans/gameplay.md, Phase 3; rules/Trams.ts): get on one at a stop, take its cab, get
   *  off; and the cab's controls (throttle, steering for the next junction, the bell). Sent only to a
   *  server whose welcome lists 'tram' in its `caps`. */
  | { t: 'tram'; op: 'board' | 'cab' | 'off' }
  | { t: 'tram'; op: 'drive'; th: number; st: number; bell?: 1 }
  /** "a car/tram just hit me": the victim's client reports it (it sees exactly what hit it) */
  | { t: 'hit'; src: number; speed: number; tram: 0 | 1; rt: number }
  | { t: 'nick'; nick: string }
  | { t: 'ping'; ct: number }
  | { t: 'leave' }
  /** the pause menu opened or closed (or the page went hidden): the city keeps going either way, but
   *  an away player shows as ⏸ and, when it's safe, can't be hurt (docs/plans/pause-resume.md). Sent
   *  only to a server whose welcome carried `resumed`. */
  | { t: 'away'; on: boolean }
  | { t: 'activity' }
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
  /** Úplatok: pay off the arrest the server offered (private event `bribe`) */
  | { t: 'bribe' }
  /** the shop the player is in (docs/plans/gameplay.md, Phase 2; rules/Shops.ts): buy `item`, park the
   *  car in the garage, or take the car in garage place `slot` out. Only to a server that sent a `catalog`. */
  | { t: 'shop'; op: 'buy' | 'store' | 'take'; item?: string; slot?: number }
  /** voice chat opt-in/out (accounts only) */
  | { t: 'voice'; on: boolean }
  | { t: 'voiceSig'; to: number; data: VoiceSignal }
  | { t: 'report'; target: number; reason: string }
  /** delete this account and its progress (GDPR) */
  | { t: 'accountDelete' }
  /** a page of the leaderboard (docs/plans/leaderboard.md): the server answers with `board` */
  | { t: 'board'; period: ScorePeriod; board: BoardId }
  /** mini-games (docs/plans/minigames.md; rules/minigames): start one, join a round, leave, start the
   *  lobby now, the action key. Sent only to a server whose welcome lists 'mini' in its `caps`. */
  | ({ t: 'mini' } & MiniReq)
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
      /** override the presence tunables (server/src/features/Presence.ts PresenceTuning), e.g. a short
       *  idle timeout for the e2e */
      presence?: Record<string, number | boolean>;
      /** score this many leaderboard points for this source (server/src/features/Leaderboard.ts) */
      score?: [number, string];
      /** put trams on the tracks by the tram stop nearest the player, to pull in there (the trams'
       *  e2e, scripts/e2e-trams.mjs) */
      tram?: boolean;
      /** park a car of this kind beside the player (the garage's e2e, scripts/e2e-shops.mjs) */
      car?: VehicleKind;
      /** start a mini-game round of this kind for the player, its lobby cut short (the mini-games' e2e) */
      mini?: MiniKind;
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
  /** how this player came back: 'live' (their figure was still in the city: a reconnect, another
   *  tab), 'saved' (restored from their last session), 'fresh' (a new start on the square). Servers
   *  from before docs/plans/pause-resume.md leave it out, and don't take `away`. */
  resumed?: 'live' | 'saved' | 'fresh';
  /** what this server takes beyond protocol 7's baseline: 'tram' (the `tram` message; docs/plans/
   *  gameplay.md, Phase 3), 'mini' (the `mini` message; docs/plans/minigames.md). Servers from before
   *  leave it out, and get none. */
  caps?: string[];
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
  | { k: 'pedHit'; id: number; x: number; y: number; s: number; m?: Mess }
  | { k: 'spark'; x: number; y: number; kind: 0 | 1 | 2 }
  | { k: 'explode'; x: number; y: number; vid: number; c: string | null }
  | { k: 'crash'; vid: number; x: number; y: number; sev: number; nx: number; ny: number; kick: number }
  | { k: 'killed'; id: number; x: number; y: number; by: number; cause: 'shot' | 'melee' | 'road' | 'tram' | 'blast' }
  | { k: 'scream'; x: number; y: number }
  | { k: 'bell'; x: number; y: number }
  | { k: 'horn'; vid: number; x: number; y: number }
  | { k: 'say'; id: number; l: number }
  // (optional kinds, still protocol 7: an older client ignores them; docs/plans/non-violent.md)
  | { k: 'splash'; id: number; x: number; y: number; a: number; s: number }
  | { k: 'five'; id: number; x: number; y: number };

/** roster row: [id, nick, x, y, wanted, inCar, pedId, partyId (0 = none), flags (ROSTER_*)] */
export type RosterRow = [number, string, number, number, number, 0 | 1, number, number, number];
/** roster flags */
export const ROSTER_DOWNED = 1;
export const ROSTER_VOICE = 2;
export const ROSTER_ACCOUNT = 4;
/** paused, the page hidden, or disconnected and still in the city (⏸) */
export const ROSTER_AWAY = 8;
/** away and safe: nobody can hurt, arrest or carjack them (🛡) */
export const ROSTER_SHIELD = 16;
/** a party's name tag: [partyId, tag, colour] */
export type PartyTag = [number, string, string];

/** a leaderboard row: [rank (ties share one), nick, points, flags (BOARD_*)] */
export type BoardRow = [number, string, number, number];
/** leaderboard row flags */
export const BOARD_ACCOUNT = 1;
/** in the city right now */
export const BOARD_ONLINE = 2;
/** the player who asked */
export const BOARD_ME = 4;

/** One page of the leaderboard, the answer to a `board` request. */
export interface BoardMsg {
  t: 'board';
  period: ScorePeriod;
  board: BoardId;
  /** the top of the board */
  rows: BoardRow[];
  /** the asking player's own [rank, points] (rank 0: not on this board yet) */
  me: [number, number];
  /** how many players are on this board */
  n: number;
  /** the previous day's or week's winner, [nick, points] (none for all-time, or nobody scored) */
  prev?: [string, number];
  /** seconds until this day or week is over (none for all-time) */
  ends?: number;
}

/** This player's own points, pushed after every welcome, whenever they change, and when a new day
 *  starts: today, this week, all time, and today's rank (0: nothing today) out of `n` players. */
export interface ScoreMsg {
  t: 'score';
  d: number;
  w: number;
  a: number;
  r: number;
  n: number;
}

/** The city-wide state: active world events and today's puzzle. Sent whole (1 Hz, on change, on hello). */
export interface WevMsg {
  t: 'wev';
  ev: EventEntry[];
  daily: DailyState | null;
  /** what's coming next (the Aktivity panel). Optional both ways, so protocol 7 either way: a server
   *  from before it leaves it out, and a client from before ignores it */
  up?: EventSchedule;
  /** the mini-game rounds others can still join (docs/plans/minigames.md). Optional both ways too */
  mg?: MiniOpen[];
}

export type ErrorCode = 'version' | 'bad-hello' | 'full' | 'auth' | 'auth-unavailable' | 'nick-taken';

export type ServerMsg =
  | WelcomeMsg
  /** g: city-wide news (GlobalEvent), sent to everyone */
  | { t: 'ev'; st: number; e: WorldEvent[]; p: PrivateEvent[]; g?: GlobalEvent[] }
  | { t: 'roster'; ps: RosterRow[]; pt?: PartyTag[] }
  | { t: 'clock'; c: ClockSync }
  /** gear: what money bought (docs/plans/gameplay.md, Phase 2), from a server with shops */
  | { t: 'profile'; money: number; found: string[]; cumils: number[]; stats?: Record<string, number>; gear?: Gear }
  /** the shops' price list (a server with shops sends it after every welcome, and again whenever
   *  game_config changes a price) */
  | { t: 'catalog'; prices: Prices }
  | { t: 'pong'; ct: number; st: number }
  /** the server rejected an impossible move: go back to this position */
  | { t: 'correct'; x: number; y: number }
  | { t: 'error'; code: ErrorCode }
  /** idle: away too long, moved out of the city and saved (only to a client whose hello had `presence`) */
  | { t: 'bye'; reason: 'restart' | 'replaced' | 'kicked' | 'deleted' | 'idle' }
  | WevMsg
  // ---- voice chat: who to connect to (polite: yield on offer collisions), ICE servers, relayed signals
  | { t: 'voicePeers'; add: { id: number; polite: boolean }[]; del: number[] }
  | { t: 'voiceIce'; ice: IceServer[] }
  | { t: 'voiceSig'; from: number; data: VoiceSignal }
  // ---- the leaderboard (docs/plans/leaderboard.md)
  | BoardMsg
  | ScoreMsg;

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
