// A mini-game's own drawing, beyond the marks every game shows (docs/plans/minigames.md): a ball, the
// water line, heat haze… MiniGamesUi calls the one for the round the player is in. Each game adds its
// line here, and nothing else outside its own files.
import type { Game } from '../../../Game';
import type { View } from '../../../../world/Renderer';
import type { ToScreen } from '../../ClientFeature';
import type { MiniKind, MiniState } from '../../../../shared/sim/rules/minigames/types';
import { BILLBOARD_DRAW } from './billboard';
import { SCOOTERS_DRAW } from './scooters';

export interface MiniDrawer {
  /** in the city (the world transform is set), under the marks */
  world?(ctx: CanvasRenderingContext2D, s: MiniState, v: View, g: Game): void;
  /** on the HUD, after the objective */
  hud?(ctx: CanvasRenderingContext2D, s: MiniState, g: Game): void;
  /** on the map and the minimap */
  map?(ctx: CanvasRenderingContext2D, s: MiniState, toScreen: ToScreen, full: boolean, size: number, g: Game): void;
}

export const MINI_DRAW: Partial<Record<MiniKind, MiniDrawer>> = {
  billboard: BILLBOARD_DRAW,
  scooters: SCOOTERS_DRAW,
  // each game adds its line here …
};
