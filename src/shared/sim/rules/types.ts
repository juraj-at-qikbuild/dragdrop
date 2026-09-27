// Shapes shared by the social and world-event features: what the server tells clients (the `wev`
// message and private events) and what the offline host exposes the same way, so HUD and map code
// never needs to know which host it runs on. DOM-free (see tsconfig.shared.json).
// Plan: docs/plans/social-events.md

/** timed world events the director runs (the most wanted one is triggered, not scheduled) */
export type EventKind = 'kofolka' | 'wanted' | 'cumil' | 'armored' | 'derby';
export type EventPhase = 'announce' | 'live' | 'ending';

/** One active world event, as shown on the map and the HUD. Positions in metres. */
export interface EventEntry {
  id: number;
  kind: EventKind;
  phase: EventPhase;
  /** seconds left in this phase at the time it was sent (the client counts down between updates) */
  left: number;
  /** where it is: the van, the hint circle's centre, the arena, the most wanted player */
  x?: number;
  y?: number;
  /** hint circle radius (Čumil hunt), arena radius (derby) */
  r?: number;
  /** player involved: whoever drives the van, the most wanted */
  holder?: number;
  holderNick?: string;
  /** cash still in the van, bounty, prize pool */
  pot?: number;
  /** derby: cars still in */
  alive?: number;
  /** derby arena outline, flat [x, y, ...] */
  zone?: number[];
  /** the event's vehicle (follow its mirror when it's in range) */
  vid?: number;
  /** where, for the HUD ("pri Eurovei") */
  place?: string;
}

/** The director's plan, for what's coming next (the Aktivity panel and its HUD chip). Like
 *  EventEntry.left, the seconds count down from when it was sent; clients work out the rest
 *  (src/game/features/activities/forecast.ts). */
export interface EventSchedule {
  /** the schedule runs (false: switched off in game_config) */
  on: boolean;
  /** seconds until the director next tries to start a scheduled event (while none can start, it
   *  tries again every 30 s) */
  next: number;
  /** players who count right now: connected, not idle, not away (offline: the one player) */
  players: number;
  /** the single-player schedule, where player counts don't matter */
  offline: boolean;
  kinds: EventPlan[];
}

/** Where one kind of world event stands in the plan. */
export interface EventPlan {
  kind: EventKind;
  /** players it needs online */
  min: number;
  /** seconds until it may run again (0: now) */
  cd: number;
  /** picked by the schedule; false: it starts by itself (the most wanted, when someone reaches 5★) */
  sched: boolean;
  /** never runs here (the online-only kinds, offline) */
  never?: boolean;
}

/** Today's "Kde to je?" puzzle as clients see it (the spot itself stays on the server). */
export interface DailyState {
  /** YYYY-MM-DD, Bratislava time */
  day: string;
  /** public image URL */
  img: string;
  /** hints revealed so far */
  hints: string[];
  solvedBy: string | null;
}

export interface PartyMember {
  id: number;
  nick: string;
  leader: boolean;
  online: boolean;
}

export interface PartyState {
  id: number;
  /** shown on nametags, e.g. "FERO" */
  tag: string;
  color: string;
  members: PartyMember[];
  /** the invite code (only sent to members) */
  invite?: string;
}

export type JobKind = 'courier' | 'taxi';

export interface JobState {
  kind: JobKind;
  /** offer: waiting for the next order/fare; pickup: go get it; deliver: take it there */
  stage: 'offer' | 'pickup' | 'deliver';
  /** where to go now */
  x: number;
  y: number;
  /** place label for the HUD */
  label: string;
  /** seconds left (0 = no limit) */
  left: number;
  /** 0..100: the order's condition, or the passenger's mood */
  condition: number;
  /** expected pay so far, and the tips in it */
  pay: number;
  tips: number;
}

export interface RaceState {
  id: number;
  opponent: number;
  opponentNick: string;
  /** destination name and point */
  dest: string;
  x: number;
  y: number;
  stake: number;
  /** seconds to the start (countdown), then 0 */
  startsIn: number;
  /** seconds left once running */
  left: number;
}

/** someone challenged this player to a race */
export interface ChallengeState {
  from: number;
  nick: string;
  stake: number;
  dest: string;
  left: number;
}

export interface ReviveState {
  /** this player is down: seconds until they bleed out */
  bleed?: number;
  /** a revive in progress (this player reviving or being revived), 0..1 */
  progress?: number;
  /** the other player */
  other?: number;
}
