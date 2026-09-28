// Mini-games ("Minihry", docs/plans/minigames.md): the shapes the rule (on the server and offline), the
// wire and the client share. A player starts one from the Aktivity panel whenever they like, alone or
// with whoever joins its lobby, and the rule sends them what to show as a private `mini` event.
// DOM-free (tsconfig.shared.json).

/** every mini-game there is, in the Aktivity panel's order */
export const MINI_KINDS = [
  'parking', 'revizor', 'football', 'butter', 'billboard', 'punch', 'scooters', 'roadworks', 'tram', 'flood', 'heat', 'toilet',
] as const;
export type MiniKind = (typeof MINI_KINDS)[number];
export const isMiniKind = (v: unknown): v is MiniKind => typeof v === 'string' && (MINI_KINDS as readonly string[]).includes(v);

/** lobby: waiting for others to join (alone, a short count-in); live: on; done: the result is shown */
export type MiniPhase = 'lobby' | 'live' | 'done';

/** Something a player of a mini-game sees in the city and on the map: a target, a spot, a zone. */
export interface MiniMark {
  x: number;
  y: number;
  /** an entity it belongs to (a vehicle's or a person's id): the client draws it where that entity
   *  is now, when it has it, and at (x, y) otherwise */
  e?: number;
  /** an emoji over it, in the city and on the map */
  icon?: string;
  /** a word or two under the icon */
  label?: string;
  color?: string;
  /** a ring this wide (m) */
  r?: number;
  /** a rectangle instead of a ring: w × h metres, turned by `a` (a parking bay, a stall) */
  w?: number;
  h?: number;
  a?: number;
  /** a zone, flat [x, y, x, y, …] */
  poly?: number[];
  /** the HUD's arrow points here (the first mark that has it) */
  arrow?: 1;
  /** drawn faded (used up, not for now) */
  dim?: 1;
  /** left off the map and minimap (small things that only matter up close) */
  noMap?: 1;
}

/** What one player of a mini-game is shown, sent as the private `mini` event whenever it changes. */
export interface MiniState {
  /** the round (MiniOpen.id) */
  id: number;
  kind: MiniKind;
  phase: MiniPhase;
  /** seconds left in this phase when it was sent (0: no time limit); the client counts it down */
  left: number;
  /** this player started it: in the lobby they can start it at once */
  owner: boolean;
  /** players in it */
  n: number;
  /** what to do now, one line */
  goal: string;
  /** a few numbers under it: [label, value] */
  stats?: [string, string][];
  /** a meter, 0..1 (the heat, the bladder, the water, the schedule) */
  bar?: { label: string; v: number; color?: string };
  marks?: MiniMark[];
  /** what the action key (B, the pad's R3, the touch button) does right here; none: nothing now */
  act?: string;
  /** with others: the standings, [nick, points], best first */
  board?: [string, number][];
  /** once it's over */
  result?: MiniResultView;
  /** whatever a game's own client drawing needs besides the marks (a ball, the water line), kept small */
  x?: Record<string, number | string | number[]>;
}

export interface MiniResultView {
  text: string;
  pay: number;
  /** with others: this player's place (1 = won) */
  place?: number;
}

/** A round others can still join (the Aktivity panel lists them, the map shows them): sent to everyone
 *  in the `wev` message's optional `mg`. */
export interface MiniOpen {
  id: number;
  kind: MiniKind;
  x: number;
  y: number;
  phase: MiniPhase;
  /** seconds left in the phase when sent */
  left: number;
  /** players in it, and how many it takes */
  n: number;
  max: number;
  /** who started it */
  nick: string;
}

/** What a player asks of the mini-games: start one, join a round, leave, start the lobby now (its
 *  starter), or the action key. Online it's the `mini` message; offline the Game asks directly. */
export type MiniReq =
  | { op: 'start'; kind: MiniKind }
  | { op: 'join'; id: number }
  | { op: 'leave' }
  | { op: 'go' }
  | { op: 'act' };

export function isMiniReq(m: unknown): m is MiniReq {
  if (!m || typeof m !== 'object') return false;
  const r = m as Record<string, unknown>;
  switch (r.op) {
    case 'start':
      return isMiniKind(r.kind);
    case 'join':
      return typeof r.id === 'number' && Number.isInteger(r.id) && r.id > 0;
    case 'leave':
    case 'go':
    case 'act':
      return true;
    default:
      return false;
  }
}
