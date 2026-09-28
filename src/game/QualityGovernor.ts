// The "Auto" graphics setting: watches the frame rate and moves along a ladder of settings, cheapest
// last, so a device that can't keep up loses as little of the picture as possible. The first rungs
// only lower the world's render resolution (on a high-DPR screen a step hardly shows, and every GPU
// cost falls with it: the 2D drawing, the upload, the bloom and the composite); only then does the
// bloom thin out (tier 1), the post-processing go (tier 0), and last the textured facades.
//
// It aims at 60 fps: a 90-144 Hz screen at 60+ is fine as it is. It steps down after 1.5 s of frames
// averaging slower than ~38 fps, and back up after a few seconds at ~60 (backing off each time an
// upgrade doesn't hold). A step down that doesn't make frames faster (the CPU is the bottleneck, or
// the browser is holding the page to 30 fps to save power) is undone and not tried again for a
// minute: it would only have cost the picture. Frames that don't measure the device (the first after
// a tab switch, a resize, a pause or a change of rung) are skipped, and the rest are capped at 150 ms,
// so one stall can't count as seconds of slow frames. Client only; the unit tests drive it with
// synthetic frame times (test/client/qualityGovernor.test.ts).

export interface Rung {
  /** PostFX: 2 = full bloom, 1 = light bloom, 0 = off */
  tier: 0 | 1 | 2;
  /** the world's render resolution, relative to the screen's (up to 2 device px per CSS px) */
  scale: number;
  facades: boolean;
}

/** The Auto ladder for a screen with this many device pixels per CSS pixel (capped at 2): two
 *  resolution steps on a high-DPR screen (effectively 2 -> 1.6 -> 1.33), one small one on a 1x screen,
 *  where it would show more. */
export function autoLadder(uiDpr: number): Rung[] {
  const steps = uiDpr >= 1.5 ? [1, 0.8, 0.67] : [1, 0.85];
  const low = steps[steps.length - 1];
  return [
    ...steps.map((scale) => ({ tier: 2 as const, scale, facades: true })),
    { tier: 1, scale: low, facades: true },
    { tier: 0, scale: low, facades: true },
    { tier: 0, scale: low, facades: false },
  ];
}

/** frame time (ms) averaging above this for SLOW_S steps down (about 38 fps) */
const SLOW_MS = 26;
const SLOW_S = 1.5;
/** ...at or under this (60 fps with a little slack) counts towards stepping back up */
const GOOD_MS = 18.7;
/** seconds of good frames before trying the rung above; doubled (up to PROBE_MAX_S) when that
 *  upgrade had to be taken back within FAILED_UPGRADE_S */
const PROBE_S = 6;
const PROBE_MAX_S = 120;
const FAILED_UPGRADE_S = 5;
/** after a step down, frames are measured this long; less than MIN_GAIN faster, and it's undone */
const CHECK_S = 2.5;
const MIN_GAIN = 0.08;
/** after an undone step, no step down for this long */
const HOLD_S = 60;
/** a single frame counts at most this long */
const MAX_FRAME_MS = 150;

export class QualityGovernor {
  /** index into `ladder` */
  rung = 0;
  /** exponential average frame time, ms */
  avg = 16.7;
  private slowT = 0;
  private goodT = 0;
  private skip = 2;
  /** seconds of measured play so far (the governor's own clock) */
  private t = 0;
  /** probe[i]: seconds of good frames before stepping up to rung i */
  private probe: number[];
  private upgradedAt = -Infinity;
  private upgradedFrom = -1;
  private holdUntil = -Infinity;
  /** measuring a step down: the rung it came from, the average before, and the frames since */
  private check: { from: number; before: number; t: number; sum: number; n: number } | null = null;

  constructor(public ladder: Rung[]) {
    this.probe = ladder.map(() => PROBE_S);
  }

  get current(): Rung {
    return this.ladder[this.rung];
  }

  /** a new ladder (the screen's DPR changed), keeping the position as far as it goes */
  setLadder(ladder: Rung[]) {
    this.ladder = ladder;
    this.probe = ladder.map(() => PROBE_S);
    this.rung = Math.min(this.rung, ladder.length - 1);
    this.check = null;
    this.skipFrames();
  }

  /** the next frames don't measure the device (tab switch, resize, pause, a change of rung) */
  skipFrames(n = 2) {
    this.skip = Math.max(this.skip, n);
  }

  /** One frame took `ms` (rAF to rAF). Returns true when the rung changed. */
  sample(ms: number): boolean {
    if (this.skip > 0) {
      this.skip--;
      return false;
    }
    const ft = Math.min(MAX_FRAME_MS, Math.max(0, ms));
    const dt = ft / 1000;
    this.t += dt;
    this.avg += (ft - this.avg) * 0.08;

    const c = this.check;
    if (c) {
      c.t += dt;
      c.sum += ft;
      c.n++;
      if (c.t < CHECK_S) return false;
      this.check = null;
      if (c.sum / c.n > c.before * (1 - MIN_GAIN)) {
        // it didn't help: the picture back, and leave it be for a while
        this.holdUntil = this.t + HOLD_S;
        return this.go(c.from);
      }
    }

    if (this.avg > SLOW_MS) this.slowT += dt;
    else this.slowT = 0;
    if (this.avg <= GOOD_MS) this.goodT += dt;
    else this.goodT = 0;

    if (this.slowT > SLOW_S && this.rung < this.ladder.length - 1 && this.t >= this.holdUntil) {
      // an upgrade that didn't hold: wait longer before trying that rung again
      if (this.upgradedFrom === this.rung + 1 && this.t - this.upgradedAt < FAILED_UPGRADE_S)
        this.probe[this.rung] = Math.min(PROBE_MAX_S, this.probe[this.rung] * 2);
      this.check = { from: this.rung, before: this.avg, t: 0, sum: 0, n: 0 };
      return this.go(this.rung + 1);
    }
    if (this.rung > 0 && this.goodT > this.probe[this.rung - 1]) {
      this.upgradedAt = this.t;
      this.upgradedFrom = this.rung;
      return this.go(this.rung - 1);
    }
    return false;
  }

  private go(rung: number) {
    this.rung = rung;
    this.slowT = 0;
    this.goodT = 0;
    this.skipFrames();
    return true;
  }
}
