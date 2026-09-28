export interface PlayDay { day: string; connected_ms: number; active_ms: number; measured_ms: number; }
export interface PlaySnapshot {
  id: string; player: string; nick: string; started_at: string; last_seen: string;
  ended_at: string | null; connected: boolean; active: boolean; revision: number; days: PlayDay[];
}
export type AnalyticsEntry =
  | { kind: 'session'; snapshot: PlaySnapshot }
  | { kind: 'claim'; from: string; to: string }
  | { kind: 'delete'; player: string }
  | { kind: 'player'; player: string; nick: string; first_seen: string; last_seen: string };
export interface OutboxRow { id: number; key: string; payload: string; }
