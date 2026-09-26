// A client-side feature plugged into the Game: world-event markers, the party panel, the revive
// prompt, the race HUD, jobs, the daily puzzle card, radio news, voice chat… It reads the host's
// LiveState (the same offline and online), draws in its layer and reacts to events.
// Plan: docs/plans/social-events.md
import type { View } from '../../world/Renderer';
import type { GlobalEvent, PrivateEvent } from '../../shared/sim/events';
import type { ServerMsg } from '../../shared/net/protocol';

export type ToScreen = (x: number, y: number) => [number, number];

export interface ClientFeature {
  readonly id: string;
  /** every frame, after the host updated (dt: simulation seconds) */
  update?(dt: number): void;
  /** world space (the world transform is set), after entities and name tags */
  drawWorld?(ctx: CanvasRenderingContext2D, v: View): void;
  /** screen space, on the HUD canvas after the built-in HUD */
  drawHud?(ctx: CanvasRenderingContext2D): void;
  /** the minimap and the full map: `size` is the blip size there */
  drawMap?(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number): void;
  /** city-wide news (world events, results, the daily puzzle) */
  onGlobal?(e: GlobalEvent): void;
  /** this player's private events (after the host and the built-in effects saw them) */
  onPrivate?(e: PrivateEvent): void;
  /** online: server messages meant for a feature (voice signalling) */
  onMessage?(m: ServerMsg): void;
  /** the host changed (offline → online) or the game is leaving */
  reset?(): void;
}
