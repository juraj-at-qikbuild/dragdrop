import { clamp, lerp, rand } from '../util/math';

/** RGB triple, 0..255 */
export type RGB = [number, number, number];

/**
 * Ambient light colour through the day. It is used as a `multiply` layer, so
 * white means "no change" and dark blue means night.
 */
const AMBIENT_KEYS: [number, RGB][] = [
  [0, [34, 44, 92]],
  [4.6, [36, 46, 96]],
  [5.6, [120, 104, 150]],
  [6.4, [236, 170, 160]],
  [7.6, [255, 236, 214]],
  [9, [255, 255, 255]],
  [16.6, [255, 255, 255]],
  [18.2, [255, 222, 176]],
  [19.4, [236, 150, 128]],
  [20.3, [120, 92, 140]],
  [21.2, [40, 50, 100]],
  [24, [34, 44, 92]],
];

const SUNRISE = 5.8;
const SUNSET = 20.2;
/** real seconds per in-game hour */
const SECONDS_PER_HOUR = 60;

/**
 * Time of day, sun and weather. One instance lives on `Game.atmos`; every
 * renderer reads from it. All values are updated in `update()` once per frame.
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
    // 0 by day, ~0.1 at golden hour, 1 at night (drives lamps, windows, headlights)
    this.night = clamp((0.9 - (amb[0] + amb[1] + amb[2]) / 765) * 1.5, 0, 1);
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
