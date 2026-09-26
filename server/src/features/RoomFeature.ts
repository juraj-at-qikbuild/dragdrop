// A server feature plugged into the Room: parties, voice chat, the daily puzzle, accounts, Supabase
// sinks… It handles its own client messages, reacts to sessions coming and going, and ticks with
// the Room, but never touches `ws` (Room stays transport-agnostic). Plan: docs/plans/social-events.md
import type { ClientMsg, HelloMsg, WevMsg } from '../../../src/shared/net/protocol';
import type { Session } from '../Room';

type MsgOf<T extends ClientMsg['t']> = Extract<ClientMsg, { t: T }>;
/** handlers for the JSON messages a feature owns (the Room has already rate-limited them) */
export type FeatureHandlers = { [T in ClientMsg['t']]?: (s: Session, msg: MsgOf<T>) => void };

export interface RoomFeature {
  readonly id: string;
  messages?: FeatureHandlers;
  /** a hello was accepted (isNew: a new session, not a reconnect or a second tab) */
  onHello?(s: Session, isNew: boolean, msg: HelloMsg): void;
  /** the socket closed; the session stays for the grace period */
  onLeave?(s: Session): void;
  /** the session is gone for good (grace expired, left, deleted) */
  onDrop?(s: Session): void;
  /** once per tick, after the simulation and the snapshots */
  tick?(dtMs: number): void;
  /** add to the city-wide `wev` state */
  wev?(out: WevMsg): void;
  /** graceful shutdown: flush what must not be lost */
  shutdown?(): void;
  /** numbers for /stats */
  stats?(): Record<string, number>;
}
