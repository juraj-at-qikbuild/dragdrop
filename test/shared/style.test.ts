// The combo (src/shared/sim/rules/Style.ts; docs/plans/gameplay.md, Phase 3), in the shared simulation
// so it counts online too: near misses (only with moving traffic, only if no crash follows), drifts,
// kills and takedowns through Sim.style, the payout (bank × multiplier) and its caps, the points, a
// death losing the combo, and a clean getaway.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { Tram } from '../../src/shared/entities/Tram';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import type { Caps } from '../../src/shared/sim/density';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { COMBO_BANK_MAX, COMBO_MAX_MULT, COMBO_WINDOW, STYLE, STYLE_PER_POINT, type Style } from '../../src/shared/sim/rules/Style';
import { loadWorld } from './helpers';

const NO_NPCS: Caps = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
// Pečnianska in Petržalka: a straight, open street (see pursuit.test.ts)
const A = { x: -1052.6, y: 1124.9 }, B = { x: -1202.5, y: 1117.5 };
const WEST = Math.atan2(B.y - A.y, B.x - A.x);
const DX = Math.cos(WEST), DY = Math.sin(WEST);

function setup(o: { online?: boolean } = {}) {
  const priv: [number, PrivateEvent][] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(3), caps: NO_NPCS, driveClock: false, rules: 'offline',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]) },
  });
  sim.clock.setTime(12);
  const scored: [number, string][] = [];
  if (o.online) sim.onScore = (_p, n, src) => (scored.push([n, src]), n);
  const style = sim.rule<Style>('style')!;
  const p = sim.addPlayer({ nick: 'A', profile: { money: 0, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] }, kinematic: true, x: A.x, y: A.y });
  const sent = <K extends PrivateEvent['k']>(k: K) => priv.map(([, e]) => e).filter((e): e is Extract<PrivateEvent, { k: K }> => e.k === k);
  return { sim, style, p, priv, sent, scored };
}

/** `p` at the wheel of a car on the street, heading west (the client drives it: kinematic) */
function car(sim: Sim, p: SimPlayer, at = A) {
  const v = sim.addVehicle(new Vehicle('sedan', at.x, at.y, WEST, '#1565c0'));
  p.ped.x = at.x;
  p.ped.y = at.y;
  expect(sim.enterVehicle(p, v, 5)).toBe(true);
  return v;
}

/** a car driving along (nobody's: moved by the test, as the server moves a player's) */
function traffic(sim: Sim, x: number, y: number, speed: number) {
  const v = sim.addVehicle(new Vehicle('van', x, y, WEST, '#eeeeee'));
  v.kinematic = true;
  v.vx = DX * speed;
  v.vy = DY * speed;
  return v;
}

/** step the world `seconds`, moving every kinematic car along its velocity */
function run(sim: Sim, seconds: number, dt = 0.05) {
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    for (const v of sim.vehicles) if (v.kinematic) (v.x += v.vx * dt), (v.y += v.vy * dt);
    for (const pl of sim.players.values()) if (pl.ped.vehicle) (pl.ped.x = pl.ped.vehicle.x), (pl.ped.y = pl.ped.vehicle.y);
    sim.step(dt);
  }
}

describe('near misses', () => {
  it('passing a moving car close at speed counts, once it has stayed clear a moment', () => {
    const { sim, p, sent } = setup();
    const v = car(sim, p);
    v.vx = DX * 20;
    v.vy = DY * 20;
    // a van 2.2 m to the side (hull gap ~0.4 m), going the same way but slower
    const side = 2.2;
    traffic(sim, A.x - DY * side + DX * 12, A.y + DX * side + DY * 12, 8);
    run(sim, 1.2);
    const near = sent('style').filter((e) => e.label === STYLE.near.label);
    expect(near).toHaveLength(1);
    expect(near[0].mult).toBe(2);
    expect(near[0].nitro).toBeGreaterThan(0);
  });

  it("a parked car doesn't count, nor one passed far off", () => {
    const { sim, p, sent } = setup();
    const v = car(sim, p);
    v.vx = DX * 20;
    v.vy = DY * 20;
    traffic(sim, A.x - DY * 2.2 + DX * 12, A.y + DX * 2.2 + DY * 12, 0);
    traffic(sim, A.x - DY * 6 + DX * 30, A.y + DX * 6 + DY * 30, 8);
    run(sim, 2.5);
    // (the street has a speed bump: taken at 20 m/s, that's AIR, which is another story)
    expect(sent('style').filter((e) => e.label === STYLE.near.label)).toHaveLength(0);
  });

  it('a crash right after it voids it', () => {
    const { sim, p, sent } = setup();
    const v = car(sim, p);
    v.vx = DX * 20;
    v.vy = DY * 20;
    traffic(sim, A.x - DY * 2.2 + DX * 12, A.y + DX * 2.2 + DY * 12, 8);
    // run until the near miss is queued, then crash
    for (let i = 0; i < 40 && !(sim.rule<Style>('style') as unknown as { states: Map<number, { pending: unknown[] }> }).states.get(p.id)?.pending.length; i++) run(sim, 0.05);
    v.health -= v.spec.health * 0.3;
    run(sim, 0.6);
    expect(sent('style').filter((e) => e.label === STYLE.near.label)).toHaveLength(0);
  });
});

describe('drifts', () => {
  it('sliding sideways at speed counts, a second at a time', () => {
    const { sim, p, sent } = setup();
    const v = car(sim, p);
    // heading west, moving west-north-west: 18 m/s forward, 6 m/s sideways
    const sx = -DY, sy = DX;
    v.vx = DX * 18 + sx * 6;
    v.vy = DY * 18 + sy * 6;
    run(sim, 2.8);
    const drifts = sent('style').filter((e) => e.label.startsWith('DRIFT'));
    expect(drifts.length).toBeGreaterThanOrEqual(2);
    expect(drifts.length).toBeLessThanOrEqual(3);
    // driving straight: nothing
    const { sim: s2, p: p2, sent: sent2 } = setup();
    const w = car(s2, p2);
    w.vx = DX * 20;
    w.vy = DY * 20;
    run(s2, 2.8);
    expect(sent2('style').filter((e) => e.label.startsWith('DRIFT'))).toHaveLength(0);
  });
});

describe('the combo', () => {
  it('kills go into it, and it pays bank × multiplier when nothing more comes', () => {
    const { sim, style, p, sent } = setup();
    for (let i = 0; i < 3; i++) sim.style(p, 'kill', A.x, A.y);
    expect(style.combo(p)).toMatchObject({ mult: 4, bank: 3 * STYLE.kill.cash });
    expect(sent('style').map((e) => e.mult)).toEqual([2, 3, 4]);
    run(sim, COMBO_WINDOW - 0.2);
    expect(p.profile.money).toBe(0);
    run(sim, 0.4);
    const paid = 3 * STYLE.kill.cash * 4;
    expect(p.profile.money).toBe(paid);
    expect(sent('payout').at(-1)).toMatchObject({ amount: paid, reason: 'style' });
    expect(style.combo(p)).toBeNull();
  });

  it('the multiplier stops at ×5, the bank at its cap', () => {
    const { sim, style, p } = setup();
    for (let i = 0; i < 12; i++) sim.style(p, 'takedown', A.x, A.y);
    expect(style.combo(p)).toMatchObject({ mult: COMBO_MAX_MULT, bank: COMBO_BANK_MAX });
    run(sim, COMBO_WINDOW + 0.2);
    expect(p.profile.money).toBe(COMBO_BANK_MAX * COMBO_MAX_MULT);
  });

  it('a death loses it', () => {
    const { sim, style, p } = setup();
    sim.style(p, 'takedown', A.x, A.y);
    sim.wasted(p);
    run(sim, COMBO_WINDOW + 0.2);
    expect(style.combo(p)).toBeNull();
    expect(p.profile.money).toBe(0);
  });

  it('online it scores on the Štýl board: 1 point per €25 of the payout', () => {
    const { sim, p, scored } = setup({ online: true });
    sim.style(p, 'takedown', A.x, A.y);
    sim.style(p, 'kill', A.x, A.y);
    run(sim, COMBO_WINDOW + 0.2);
    const paid = (STYLE.takedown.cash + STYLE.kill.cash) * 3;
    expect(scored).toContainEqual([Math.round(paid / STYLE_PER_POINT), 'style']);
  });

  it('a kill by a player goes through the combo (Combat)', () => {
    const { sim, style, p, sent } = setup();
    const ped = sim.addPed(new Ped('civ', A.x + 3, A.y, 9));
    p.ammo.pistol = 10;
    for (let i = 0; i < 6 && !ped.dead; i++)
      sim.applyShot(p, { ox: A.x, oy: A.y, a: 0, w: 'pistol', lvl: 0, pellets: [{ a: 0, hx: ped.x, hy: ped.y, kind: 2, hit: ped.id }], rt: 0 } as never);
    expect(ped.dead).toBe(true);
    expect(sent('style').at(-1)).toMatchObject({ label: 'KILL', mult: 2 });
    expect(style.combo(p)?.bank).toBe(STYLE.kill.cash);
  });
});

describe('a clean getaway', () => {
  it('losing a 2★ chase at the wheel of a car without a scratch is a style move', () => {
    const { sim, p, sent } = setup();
    const v = car(sim, p);
    p.chaseSince = sim.time - 60;
    p.chasePeak = 2;
    sim.getaway(p);
    expect(sent('style').at(-1)?.label).toBe(STYLE.getaway.label);
    // a dented car, another time: no
    const { sim: s2, p: p2, sent: sent2 } = setup();
    const w = car(s2, p2);
    w.health = w.spec.health * 0.5;
    p2.chaseSince = s2.time - 60;
    p2.chasePeak = 3;
    s2.getaway(p2);
    expect(sent2('style')).toHaveLength(0);
    void v;
  });
});

describe("the city's moves", () => {
  const w = loadWorld();

  /** `p` at the wheel at (x, y) heading `a`, moving `speed` that way (kinematic: the test moves it) */
  function at(sim: Sim, p: SimPlayer, x: number, y: number, a: number, speed: number, kind: 'sedan' | 'sport' = 'sedan') {
    const v = sim.addVehicle(new Vehicle(kind, x, y, a, '#1565c0'));
    p.ped.x = x;
    p.ped.y = y;
    expect(sim.enterVehicle(p, v, 5)).toBe(true);
    v.vx = Math.cos(a) * speed;
    v.vy = Math.sin(a) * speed;
    return v;
  }
  const labels = (sent: (k: 'style') => { label: string }[]) => sent('style').map((e) => e.label);

  it('AIR: a raised table taken fast enough to fly, not at a sensible speed', () => {
    const d = w.bumps.data;
    let i = 0;
    while (i < w.bumps.n && d[i * 6 + 5] !== 1) i++;
    expect(i).toBeLessThan(w.bumps.n);
    const [bx, by, ux, uy] = [d[i * 6], d[i * 6 + 1], d[i * 6 + 2], d[i * 6 + 3]];
    for (const [speed, flies] of [[20, true], [7, false]] as const) {
      const { sim, p, sent } = setup();
      at(sim, p, bx - ux * 6, by - uy * 6, Math.atan2(uy, ux), speed);
      run(sim, 12 / speed + 0.2);
      expect(labels(sent).includes(STYLE.air.label), `${speed} m/s`).toBe(flies);
    }
  });

  it('RED LIGHT: over a stop line on red at speed; on green, nothing', () => {
    const l = w.lights.lines.find((q) => q.hw > 3)!;
    const red = [...Array(1440).keys()].find((t) => w.lights.state(l, t) === 2 && w.lights.state(l, t + 2) === 2)!;
    const green = [...Array(1440).keys()].find((t) => w.lights.state(l, t) === 0 && w.lights.state(l, t + 2) === 0)!;
    for (const [secs, runs] of [[red, true], [green, false]] as const) {
      const { sim, p, sent } = setup();
      sim.clock.setTime(secs / 60 + 1e-4);
      // in the right-hand lane, 12 m before the line, heading through it
      const rx = -l.uy, ry = l.ux, off = l.hw / 2;
      at(sim, p, l.x + rx * off - l.ux * 12, l.y + ry * off - l.uy * 12, Math.atan2(l.uy, l.ux), 14);
      run(sim, 1.5);
      expect(labels(sent).includes(STYLE.red.label), secs === red ? 'red' : 'green').toBe(runs);
    }
  });

  it('WRONG WAY: against a one-way street, not along it', () => {
    // a straight stretch of a one-way street (not on a bridge), 60 m of it
    const e = w.car.edges.find((q) => {
      if (q.oneway === 0 || q.p.length < 4) return false;
      const [ax, ay, bx, by] = q.p;
      return Math.hypot(bx - ax, by - ay) > 60 && !w.onBridge((ax + bx) / 2, (ay + by) / 2) && !w.onBridge(ax, ay) && !w.onBridge(bx, by);
    })!;
    expect(e).toBeTruthy();
    const [ax, ay, bx, by] = e.p;
    const ux = (bx - ax) / Math.hypot(bx - ax, by - ay), uy = (by - ay) / Math.hypot(bx - ax, by - ay);
    // the way traffic goes, and the other way
    const flow = e.oneway === 1 ? 1 : -1;
    for (const [dir, wrong] of [[flow, false], [-flow, true]] as const) {
      const { sim, p, sent } = setup();
      const sx = dir > 0 ? ax + ux * 5 : bx - ux * 5, sy = dir > 0 ? ay + uy * 5 : by - uy * 5;
      at(sim, p, sx, sy, Math.atan2(uy * dir, ux * dir), 15);
      run(sim, 2.6);
      expect(labels(sent).includes(STYLE.wrongway.label), wrong ? 'against it' : 'along it').toBe(wrong);
    }
  });

  it('THREAD THE NEEDLE: flat out through a passage in a building; slowly, nothing', () => {
    // a street through a building: a car-graph edge with a point in a passage
    let found: { x: number; y: number; ux: number; uy: number } | null = null;
    for (const e of w.car.edges) {
      for (let k = 0; k + 3 < e.p.length && !found; k += 2) {
        const [ax, ay, bx, by] = [e.p[k], e.p[k + 1], e.p[k + 2], e.p[k + 3]];
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 20) continue;
        const ux = (bx - ax) / len, uy = (by - ay) / len;
        for (let t = 4; t < len - 4 && !found; t += 1)
          if (w.inBuildingPassage(ax + ux * t, ay + uy * t) && !w.inBuildingPassage(ax + ux * (t - 4), ay + uy * (t - 4))) found = { x: ax + ux * (t - 4), y: ay + uy * (t - 4), ux, uy };
      }
      if (found) break;
    }
    expect(found).toBeTruthy();
    const f = found!;
    for (const [speed, counts] of [[18, true], [6, false]] as const) {
      const { sim, p, sent } = setup();
      at(sim, p, f.x - f.ux * 3, f.y - f.uy * 3, Math.atan2(f.uy, f.ux), speed);
      run(sim, 40 / speed + 0.8);
      expect(labels(sent).includes(STYLE.passage.label), `${speed} m/s`).toBe(counts);
    }
  });

  it('TRAM DODGE: past a tram close at speed; wide of it, nothing', () => {
    for (const [side, counts] of [[2.4, true], [8, false]] as const) {
      const { sim, p, sent } = setup();
      const tr = new Tram(null, null);
      tr.speed = 0;
      // standing at a stop with its doors open (so the AI leaves it where it is)
      tr.dwell = 1e9;
      // a standing tram along the street, 40 m ahead of A (its sections: front first)
      tr.sections = [0, 1, 2].map((i) => ({ x: A.x + DX * (40 - i * 9.8), y: A.y + DY * (40 - i * 9.8), a: WEST }));
      tr.x = tr.sections[0].x + DX * 4.6;
      tr.y = tr.sections[0].y + DY * 4.6;
      sim.addTram(tr);
      at(sim, p, A.x - DY * side, A.y + DX * side, WEST, 18);
      run(sim, 3.5);
      expect(labels(sent).includes(STYLE.tram.label), `${side} m to the side`).toBe(counts);
    }
  });
});
