import { clamp, lerp, rand } from '../util/math';

/** RGB triple, 0..255 */
export type RGB = [number, number, number];

/**
 * Ambient light colour through the day. It is used as a `multiply` layer, so
 * white means "no change" and dark blue means night. Kept gentle on purpose:
 * night stays bright enough to navigate by (roads/buildings dimly visible),
 * golden hour and dusk are soft tints rather than a saturated wash.
 */
const AMBIENT_KEYS: [number, RGB][] = [
  [0, [70, 82, 130]], // readable night blue
  [4.4, [72, 84, 132]],
  [5.2, [104, 98, 142]], // pre-dawn violet
  [6.0, [214, 175, 178]], // dawn, pinkish
  [7.0, [255, 226, 206]], // warm sunrise
  [9, [255, 248, 238]], // day, a hair warm — cheap, no perf cost
  [16.6, [255, 248, 238]],
  [18.1, [255, 224, 194]], // golden hour, gentle warm tint
  [19.3, [227, 178, 168]], // soft warm dusk (was a strong orange-red before)
  [20.3, [150, 128, 168]], // dusk, soft purple-blue
  [21.4, [96, 96, 146]], // blue hour, fading to night
  [24, [70, 82, 130]],
];

/** brightest / darkest total (r+g+b) among the keyframes, for the `night` gauge below */
const AMBIENT_DAY_SUM = Math.max(...AMBIENT_KEYS.map(([, c]) => c[0] + c[1] + c[2]));
const AMBIENT_NIGHT_SUM = Math.min(...AMBIENT_KEYS.map(([, c]) => c[0] + c[1] + c[2]));

const SUNRISE = 5.8;
const SUNSET = 20.2;
/** real seconds per in-game hour */
const SECONDS_PER_HOUR = 60;

/**
 * Time of day, sun and weather. One instance lives on `Game.atmos`; every
 * renderer reads from it. All values are updated in `update()` once per frame.
 *
 * Debug / screenshot knobs, either as URL params (read once in the
 * constructor) or live from the console via `window.game.atmos`:
 *   ?t=19.3           → game.atmos.setTime(19.3)   jump to a time of day (0..24h)
 *   ?rain=1           → game.atmos.setRain(1)      force rain intensity (0..1)
 *   ?freeze           → game.atmos.frozen = true   stop the clock & weather cycling
 * e.g. http://localhost:5173/?t=22&rain=0.8&freeze for a frozen rainy night shot.
 */
export class Atmosphere {
  /** hours, 0..24 */
  time = 9;
  /** 0 at night, 1 in full daylight */
  daylight = 1;
  /** 1 - daylight, convenience */
  night = 0;
  /** ground shadow offset per metre of height (world units), pointing away from the sun */
  sun = { dx: 0, dy: 0, elev: 1 };
  /** direction the sun shines *from*, unit vector (for wall shading) */
  sunDir = { x: 0, y: 1 };
  /** multiply colour for the light layer */
  ambient: RGB = [255, 255, 255];
  /** true when the ambient differs enough from white to need the lighting pass */
  tinted = false;
  /** 0..1 current rain intensity (smoothed) */
  rain = 0;
  /** 0..1 how wet the ground is (lags behind rain) */
  wet = 0;
  private rainTarget = 0;
  private weatherTimer = rand(90, 240);
  /** freezes the clock and weather (debug / screenshots) */
  frozen = false;

  constructor(time?: number) {
    if (typeof time === 'number' && isFinite(time)) this.time = ((time % 24) + 24) % 24;
    try {
      const q = new URLSearchParams(location.search);
      if (q.has('t')) this.setTime(parseFloat(q.get('t')!));
      if (q.has('rain')) this.setRain(parseFloat(q.get('rain') || '1'));
      if (q.has('freeze')) this.frozen = true;
    } catch {
      /* no location (tests) */
    }
    this.recompute();
  }

  setTime(h: number) {
    if (!isFinite(h)) return;
    this.time = ((h % 24) + 24) % 24;
    this.recompute();
  }

  setRain(v: number) {
    this.rainTarget = this.rain = this.wet = clamp(isFinite(v) ? v : 1, 0, 1);
    this.weatherTimer = rand(180, 360);
  }

  update(dt: number) {
    if (!this.frozen) {
      this.time = (this.time + dt / SECONDS_PER_HOUR) % 24;
      this.weatherTimer -= dt;
      if (this.weatherTimer <= 0) {
        // roughly one shower in four weather periods
        this.rainTarget = this.rainTarget > 0 ? 0 : Math.random() < 0.28 ? rand(0.45, 1) : 0;
        this.weatherTimer = this.rainTarget > 0 ? rand(90, 200) : rand(150, 360);
      }
      this.rain += clamp(this.rainTarget - this.rain, -dt * 0.08, dt * 0.08);
      this.wet += clamp(this.rain - this.wet, -dt * 0.015, dt * 0.05);
    }
    this.recompute();
  }

  private recompute() {
    const t = this.time;
    // ambient colour
    let i = 0;
    while (i < AMBIENT_KEYS.length - 2 && AMBIENT_KEYS[i + 1][0] <= t) i++;
    const [t0, c0] = AMBIENT_KEYS[i], [t1, c1] = AMBIENT_KEYS[i + 1];
    const k = clamp((t - t0) / (t1 - t0), 0, 1);
    const s = k * k * (3 - 2 * k);
    const dim = 1 - this.rain * 0.22; // overcast
    const amb: RGB = [0, 0, 0];
    for (let j = 0; j < 3; j++) amb[j] = lerp(c0[j], c1[j], s) * (j === 2 ? 1 - this.rain * 0.12 : dim);
    this.ambient = amb;
    this.tinted = amb[0] < 250 || amb[1] < 250 || amb[2] < 250;

    // sun
    const dayFrac = (t - SUNRISE) / (SUNSET - SUNRISE);
    const elev = Math.sin(clamp(dayFrac, 0, 1) * Math.PI);
    this.daylight = clamp(elev * 3, 0, 1) * (1 - this.rain * 0.35);
    // 0 by day, ~0.1 at golden hour, 1 at night (drives lamps, windows, headlights).
    // Scaled off how dark the ambient tint actually is, not the raw clock time.
    const sum = amb[0] + amb[1] + amb[2];
    this.night = clamp((AMBIENT_DAY_SUM - sum) / (AMBIENT_DAY_SUM - AMBIENT_NIGHT_SUM), 0, 1);
    // azimuth: east in the morning, south at noon, west in the evening (y grows southwards)
    const az = clamp(dayFrac, 0, 1) * Math.PI;
    this.sunDir = { x: Math.cos(az), y: Math.sin(az) };
    const len = Math.min(2.6, 1 / Math.tan(Math.max(0.3, elev * 1.25)));
    this.sun = { dx: -this.sunDir.x * len, dy: -this.sunDir.y * len * 0.8 - 0.25, elev };
  }

  /** CSS colour string of the ambient multiply colour */
  ambientCss() {
    const a = this.ambient;
    return `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
  }

  clock() {
    const h = Math.floor(this.time), m = Math.floor((this.time - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
