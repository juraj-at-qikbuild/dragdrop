// Time of day and weather: the simulated part of the atmosphere. The server's Clock is authoritative
// online (clients sync to it); offline the browser drives its own. Visuals derived from it (sun, ambient
// colour, night) live in the client's Atmosphere.
import { clamp } from '../util/math';
import type { Rng } from '../util/Rng';

/** real seconds per in-game hour (a day lasts 24 minutes) */
export const SECONDS_PER_HOUR = 60;

/** RGB triple, 0..255 */
export type RGB = [number, number, number];

/**
 * Ambient light colour through the day. The renderer uses it as a `multiply` layer, so white means
 * "no change" and dark blue means night. Kept gentle on purpose: night stays bright enough to
 * navigate by (roads/buildings dimly visible), golden hour and dusk are soft tints rather than a
 * saturated wash. Here, not in the client's Atmosphere, because how dark it is also decides how far
 * the police see (sight.ts).
 */
export const AMBIENT_KEYS: [number, RGB][] = [
  [0, [70, 82, 130]], // readable night blue
  [4.4, [72, 84, 132]],
  [5.2, [104, 98, 142]], // pre-dawn violet
  [6.0, [214, 175, 178]], // dawn, pinkish
  [7.0, [255, 226, 206]], // warm sunrise
  [9, [255, 255, 255]], // day: neutral, so the lighting pass is skipped entirely
  [16.6, [255, 255, 255]],
  [18.1, [255, 224, 194]], // golden hour, gentle warm tint
  [19.3, [227, 178, 168]], // soft warm dusk (was a strong orange-red before)
  [20.3, [150, 128, 168]], // dusk, soft purple-blue
  [21.4, [96, 96, 146]], // blue hour, fading to night
  [24, [70, 82, 130]],
];

/** brightest / darkest total (r+g+b) among the keyframes, for `darknessOf` */
const AMBIENT_DAY_SUM = Math.max(...AMBIENT_KEYS.map(([, c]) => c[0] + c[1] + c[2]));
const AMBIENT_NIGHT_SUM = Math.min(...AMBIENT_KEYS.map(([, c]) => c[0] + c[1] + c[2]));

/** the ambient colour at `hour` (0..24), eased between the keyframes */
export function ambientAt(hour: number): RGB {
  const t = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < AMBIENT_KEYS.length - 2 && AMBIENT_KEYS[i + 1][0] <= t) i++;
  const [t0, c0] = AMBIENT_KEYS[i], [t1, c1] = AMBIENT_KEYS[i + 1];
  const k = clamp((t - t0) / (t1 - t0), 0, 1);
  const s = k * k * (3 - 2 * k);
  return [c0[0] + (c1[0] - c0[0]) * s, c0[1] + (c1[1] - c0[1]) * s, c0[2] + (c1[2] - c0[2]) * s];
}

/** how dark an ambient colour is: 0 by day, ~0.1 at golden hour, 1 at night */
export function darknessOf(c: RGB): number {
  return clamp((AMBIENT_DAY_SUM - (c[0] + c[1] + c[2])) / (AMBIENT_DAY_SUM - AMBIENT_NIGHT_SUM), 0, 1);
}

/** how dark it is at `hour`, weather aside: 0 by day, 1 at night */
export function darkness(hour: number): number {
  return darknessOf(ambientAt(hour));
}

export class Clock {
  /** hours, 0..24 */
  time = 9;
  /** 0..1 current rain intensity (smoothed) */
  rain = 0;
  /** 0..1 how wet the ground is (lags behind rain) */
  wet = 0;
  rainTarget = 0;
  weatherTimer: number;
  /** freezes the clock and weather (debug / screenshots) */
  frozen = false;

  constructor(private rng: Rng, time?: number) {
    if (typeof time === 'number' && isFinite(time)) this.time = ((time % 24) + 24) % 24;
    this.weatherTimer = rng.range(90, 240);
  }

  setTime(h: number) {
    if (!isFinite(h)) return;
    this.time = ((h % 24) + 24) % 24;
  }

  setRain(v: number) {
    this.rainTarget = this.rain = this.wet = clamp(isFinite(v) ? v : 1, 0, 1);
    this.weatherTimer = this.rng.range(180, 360);
  }

  update(dt: number) {
    if (this.frozen) return;
    this.time = (this.time + dt / SECONDS_PER_HOUR) % 24;
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      // roughly one shower in four weather periods
      this.rainTarget = this.rainTarget > 0 ? 0 : this.rng.chance(0.28) ? this.rng.range(0.45, 1) : 0;
      this.weatherTimer = this.rainTarget > 0 ? this.rng.range(90, 200) : this.rng.range(150, 360);
    }
    this.rain += clamp(this.rainTarget - this.rain, -dt * 0.08, dt * 0.08);
    this.wet += clamp(this.rain - this.wet, -dt * 0.015, dt * 0.05);
  }

  /** adopt the server's clock (online): snap if far off, otherwise nudge to avoid visible jumps */
  sync(s: { time: number; rain: number; wet: number; target: number }) {
    let d = s.time - this.time;
    if (d > 12) d -= 24;
    if (d < -12) d += 24;
    this.time = Math.abs(d) > 0.25 ? s.time : (this.time + d * 0.5 + 24) % 24;
    this.rain = s.rain;
    this.wet = s.wet;
    this.rainTarget = s.target;
  }
}
