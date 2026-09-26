// ?photo: a headless rendering mode for scripts/spots-gen.mjs (docs/plans/social-events.md). Boots
// just enough of the client — World + Renderer + a fixed Atmosphere — to replicate Game.draw's world
// pass on an offscreen canvas, with no Sim, no menu, no NPCs/players, no HUD and no post-FX. Exposes
// window.__photo so a headless Chromium page (playwright-core) can list candidate spots and render
// each one to a data URL. Offline play never touches this file unless `?photo` is on the URL.
import { World } from '../../shared/world/World';
import type { MapJSON } from '../../shared/types';
import { Renderer, type View } from '../../world/Renderer';
import { Atmosphere } from '../../world/Atmosphere';
import { Clock, SECONDS_PER_HOUR } from '../../shared/sim/Clock';
import { Rng } from '../../shared/util/Rng';
import { candidateSpots, type Spot } from '../../shared/world/spots';

/** fixed midday, dry: a puzzle photo should look like an ordinary day, not any particular one, and
 *  never leak which day it was shot on */
const PHOTO_HOUR = 13;
/** how wide the shot is, in metres (about a courtyard or a street crossing, not a whole block) */
const VIEW_METRES = 45;
const DEFAULT_W = 960;
const DEFAULT_H = 640;

export interface PhotoApi {
  ready: boolean;
  candidates(n: number, seed: number): Spot[];
  render(spot: Spot, w?: number, h?: number): Promise<string>;
}

declare global {
  interface Window {
    __photo?: PhotoApi;
  }
}

/** The `?photo` boot path (src/main.ts): builds the world and renderer once, then exposes
 *  window.__photo for scripts/spots-gen.mjs to drive. `ready` flips true only once both are built,
 *  so a page script can safely `waitForFunction(() => window.__photo?.ready)` right after navigating. */
export function bootPhotoMode(data: MapJSON) {
  const photo: PhotoApi = { ready: false, candidates: () => [], render: async () => '' };
  window.__photo = photo;

  const world = new World(data);
  const renderer = new Renderer(world);
  const clock = new Clock(new Rng(1));
  const atmos = new Atmosphere(PHOTO_HOUR, clock);
  // set explicitly (not just passed to the constructor above), so a stray ?t=/?rain= on the URL —
  // Atmosphere reads those too, for ordinary screenshots — can never un-fix the puzzle's weather
  atmos.setTime(PHOTO_HOUR);
  atmos.setRain(0);
  atmos.frozen = true;
  renderer.atmos = atmos;
  // never draw text that would name the place: real shopfront/museum/theatre/library signs and
  // tram-stop-name plates (street-name signs and map labels are simply never called below)
  renderer.labels = false;
  renderer.street.labels = false;

  photo.candidates = (n, seed) => candidateSpots(world, n, seed);
  photo.render = (spot, w = DEFAULT_W, h = DEFAULT_H) => renderSpot(renderer, atmos, spot, w, h);
  photo.ready = true;
}

/** Replicates Game.draw's world pass for a north-up camera centred on `spot`, on a fresh offscreen
 *  canvas, then marks the spot with a small red X. Deliberately leaves out anything that would name
 *  the place for someone looking at the photo — street-name signs, landmark labels, map labels — by
 *  simply never calling the Game/MapView code that draws them; every call below is the plain city
 *  geometry (ground, portals, shadows, barriers, posts, low street detail, traffic lights, bridges,
 *  buildings — which draws trees too, see Renderer.drawBuildings). No weather, particles, entities,
 *  lighting or post-FX: none of that runs without a Game/Sim to drive it, and photo mode has neither. */
async function renderSpot(renderer: Renderer, atmos: Atmosphere, spot: Spot, w: number, h: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const scale = w / VIEW_METRES;
  const hw = w / 2 / scale, hh = h / 2 / scale;
  const view: View = {
    x0: spot.x - hw, y0: spot.y - hh, x1: spot.x + hw, y1: spot.y + hh,
    camX: spot.x, camY: spot.y, camH: Math.max(hw, hh) * 3, scale,
  };
  ctx.fillStyle = '#b3aea3';
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, -view.x0 * scale, -view.y0 * scale);

  renderer.drawGround(ctx, view, view.scale > 3);
  renderer.drawPortals(ctx, view);
  renderer.drawShadows(ctx, view);
  renderer.drawBarriers(ctx, view);
  renderer.drawPosts(ctx, view);
  renderer.street.drawLow(ctx, view, 0);
  renderer.drawTrafficLights(ctx, view, atmos.clock.time * SECONDS_PER_HOUR);
  renderer.drawBridges(ctx, view, 1);
  renderer.drawBridges(ctx, view, 2);
  renderer.drawBuildings(ctx, view);

  drawMarker(ctx, spot.x, spot.y);
  return canvas.toDataURL('image/webp', 0.85);
}

/** a small red X with a white outline, in world space (so it scales with the shot, not the pixels) */
function drawMarker(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const arm = 1.1;
  const stroke = (color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - arm, y - arm);
    ctx.lineTo(x + arm, y + arm);
    ctx.moveTo(x + arm, y - arm);
    ctx.lineTo(x - arm, y + arm);
    ctx.stroke();
  };
  stroke('#ffffff', 0.55);
  stroke('#e53935', 0.3);
}
