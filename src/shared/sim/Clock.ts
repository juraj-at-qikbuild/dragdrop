// Time of day and weather: the simulated part of the atmosphere. The server's Clock is authoritative
// online (clients sync to it); offline the browser drives its own. Visuals derived from it (sun, ambient
// colour, night) live in the client's Atmosphere.
import { clamp } from '../util/math';
import type { Rng } from '../util/Rng';

/** real seconds per in-game hour (a day lasts 24 minutes) */
export const SECONDS_PER_HOUR = 60;

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
