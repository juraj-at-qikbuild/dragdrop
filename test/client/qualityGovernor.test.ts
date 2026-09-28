// The Auto graphics setting (src/game/QualityGovernor.ts) against synthetic frame times: it keeps full
// quality on a device that holds 60 fps (a tab switch or a stall included), steps down the render
// resolution before anything else, comes back up when frames are fast again (backing off when an
// upgrade doesn't hold), and undoes a step down that didn't make frames any faster.
import { describe, expect, it } from 'vitest';
import { QualityGovernor, autoLadder } from '../../src/game/QualityGovernor';

/** feed `secs` of frames of `ms` each (or of `ms(rung)`, the frame time the current rung gives) */
function run(g: QualityGovernor, secs: number, ms: number | ((rung: number) => number)) {
  const changes: number[] = [];
  for (let t = 0; t < secs * 1000; ) {
    const f = typeof ms === 'number' ? ms : ms(g.rung);
    if (g.sample(f)) changes.push(g.rung);
    t += f;
  }
  return changes;
}

describe('the Auto ladder', () => {
  it('lowers the resolution before touching the effects', () => {
    const hi = autoLadder(2);
    expect(hi.map((r) => [r.tier, r.scale, r.facades])).toEqual([
      [2, 1, true], [2, 0.8, true], [2, 0.67, true], [1, 0.67, true], [0, 0.67, true], [0, 0.67, false],
    ]);
    // a 1x screen gets one small resolution step
    expect(autoLadder(1).slice(0, 2).map((r) => [r.tier, r.scale])).toEqual([[2, 1], [2, 0.85]]);
  });
});

describe('QualityGovernor', () => {
  it('keeps full quality at a steady 60 fps, and at 120', () => {
    const g = new QualityGovernor(autoLadder(2));
    expect(run(g, 60, 16.7)).toEqual([]);
    expect(run(g, 30, 8.3)).toEqual([]);
    expect(g.rung).toBe(0);
  });

  it("doesn't count a tab switch or a one-off stall as slow frames", () => {
    const g = new QualityGovernor(autoLadder(2));
    run(g, 5, 16.7);
    g.sample(10_000); // the first frame back from a hidden tab
    run(g, 1, 16.7);
    g.sample(1600); // a stall
    run(g, 10, 16.7);
    expect(g.rung).toBe(0);
  });

  it('steps down on sustained slow frames, resolution first, until it keeps up', () => {
    const g = new QualityGovernor(autoLadder(2));
    // 30 ms at full resolution, 22 ms at 0.8: one step is enough
    const changes = run(g, 20, (r) => (r === 0 ? 30 : 22));
    expect(changes).toEqual([1]);
    expect(g.current).toMatchObject({ tier: 2, scale: 0.8 });
  });

  it('goes further down a device that stays slow', () => {
    const g = new QualityGovernor(autoLadder(2));
    const cost = [40, 34, 30, 27, 20, 18];
    run(g, 60, (r) => cost[r]);
    expect(g.current).toMatchObject({ tier: 0, facades: true });
  });

  it('undoes a step that makes no difference (a 30 fps cap, or the CPU the bottleneck) and holds', () => {
    const g = new QualityGovernor(autoLadder(2));
    const changes = run(g, 30, 33.3);
    // stepped down once, measured no gain, came back, and stayed
    expect(changes).toEqual([1, 0]);
    expect(g.rung).toBe(0);
  });

  it('comes back up when frames are fast again, and backs off when the upgrade fails', () => {
    const g = new QualityGovernor(autoLadder(2));
    run(g, 10, (r) => (r === 0 ? 30 : 16.7));
    expect(g.rung).toBe(1);
    // the load goes away: back to full quality after a few seconds
    run(g, 10, 16.7);
    expect(g.rung).toBe(0);
    // a device that only just can't hold rung 0: each failed upgrade waits twice as long before the next
    // try, so it spends ever less time flipping between the two
    const first = run(g, 60, (r) => (r === 0 ? 30 : 16.7));
    const second = run(g, 60, (r) => (r === 0 ? 30 : 16.7));
    const third = run(g, 120, (r) => (r === 0 ? 30 : 16.7));
    expect(first.length).toBeGreaterThan(second.length);
    expect(second.length).toBeLessThanOrEqual(3);
    expect(third.length).toBeLessThanOrEqual(2);
  });

  it('ignores the frames it is told to skip', () => {
    const g = new QualityGovernor(autoLadder(1));
    run(g, 2, 16.7);
    g.skipFrames(3);
    expect(g.sample(5000)).toBe(false);
    expect(g.sample(5000)).toBe(false);
    expect(g.sample(5000)).toBe(false);
    expect(g.avg).toBeLessThan(20);
  });
});
