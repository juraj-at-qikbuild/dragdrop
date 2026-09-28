// Trams (docs/plans/gameplay.md, Phase 3): getting on at a stop, riding along out of reach, getting
// off only once it's stopped; the cab (a crime), its throttle and brake, no stops, a branch picked by
// the steering, the people it hits on the driver's account, and handing it back; and the police
// taking longer to pick out a rider.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { SERVER_CAPS } from '../../src/shared/sim/density';
import { Tram } from '../../src/shared/entities/Tram';
import { Ped } from '../../src/shared/entities/Ped';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { linkPoints } from '../../src/shared/world/Graph';
import { nullEvents, type PrivateEvent } from '../../src/shared/sim/events';
import { tramUse, type Trams } from '../../src/shared/sim/rules/Trams';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { dist } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

const EMPTY = { ...SERVER_CAPS, traffic: 0, parked: 0, peds: 0, trams: 0, police: 0 };
const profile = () => ({ money: 0, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] });

/** the player's camera on the tram (so the AI keeps it), their figure beside it unless aboard */
function follow(p: SimPlayer, t: Tram) {
  Object.assign(p.observer, { fx: t.x, fy: t.y, cx: t.x, cy: t.y, hw: 30, hh: 18 });
}

/** A city with one tram, run until it stands at a stop with its doors open. */
function tramAtStop(seed = 1) {
  const w = loadWorld();
  const sent: PrivateEvent[] = [];
  const sim = new Sim(w, { rng: new Rng(seed), caps: EMPTY, rules: 'offline', events: { ...nullEvents, toPlayer: (_id: number, e: PrivateEvent) => sent.push(e) } });
  const S = w.tramStops;
  const p = sim.addPlayer({ nick: 'A', profile: profile(), kinematic: false, x: S[0] + 30, y: S[1] + 30 });
  for (let i = 0; i < S.length; i += 2) {
    for (const n of w.tram.nodesAround(S[i], S[i + 1], 30, 90)) {
      for (const link of w.tram.out[n]) {
        const t = new Tram(w.tram, link, sim.rng, S);
        sim.addTram(t);
        for (let k = 0; k < 900 && t.dwell <= 0.3; k++) {
          follow(p, t);
          sim.step(1 / 15);
        }
        if (t.dwell > 0.3 && sim.trams.includes(t)) return { sim, w, p, t, sent, trams: sim.rule<Trams>('trams')! };
        sim.trams = sim.trams.filter((q) => q !== t);
      }
    }
  }
  throw new Error('no tram reached a stop');
}

/** the player on foot by the nearest of a tram's doors */
function atDoor(p: SimPlayer, t: Tram) {
  const s = t.doorSpots();
  let bi = 0;
  for (let i = 0; i < s.length; i += 2) if (dist(s[i], s[i + 1], p.ped.x, p.ped.y) < dist(s[bi], s[bi + 1], p.ped.x, p.ped.y)) bi = i;
  p.ped.x = s[bi];
  p.ped.y = s[bi + 1];
  p.ped.level = t.level;
}

describe('riding a tram', () => {
  it('gets on at an open door of a tram at a stop, rides along out of reach, and off only once it stops', () => {
    const { sim, p, t, sent, trams } = tramAtStop(1);
    atDoor(p, t);
    expect(tramUse(sim.trams, p.ped.x, p.ped.y, p.ped.level)?.op).toBe('board');
    expect(trams.act(p, 'board')).toBe(true);
    expect(p.ped.aboard).toBe(t);
    expect(sent.some((e) => e.k === 'tram' && e.id === t.id && !e.cab)).toBe(true);
    expect(p.wanted).toBe(0);
    // it pulls away: the rider goes with it, and can't get off on the move
    let tried = false;
    for (let k = 0; k < 600 && !(t.speed > 3); k++) {
      follow(p, t);
      sim.step(1 / 15);
    }
    expect(t.speed).toBeGreaterThan(3);
    const mid = t.sections[1];
    expect(dist(p.ped.x, p.ped.y, mid.x, mid.y)).toBeLessThan(0.5);
    tried = trams.act(p, 'off');
    expect(tried).toBe(false);
    expect(p.ped.aboard).toBe(t);
    // nothing outside touches them: a shot at where they are goes through
    const shooter = sim.addPlayer({ nick: 'B', profile: profile(), kinematic: false, x: p.ped.x - 6, y: p.ped.y });
    shooter.ammo.pistol = 5;
    const hp = p.ped.health;
    sim.applyShot(shooter, { w: 'pistol', ox: p.ped.x - 5, oy: p.ped.y, a: 0, lvl: p.ped.level, pellets: [{ a: 0, kind: 1, hit: p.ped.id, hx: p.ped.x, hy: p.ped.y }] });
    expect(p.ped.health).toBe(hp);
    sim.removePlayer(shooter);
    // the next stop: off at a door, beside the tram
    for (let k = 0; k < 3000 && !(t.dwell > 0.3); k++) {
      follow(p, t);
      sim.step(1 / 15);
    }
    expect(t.dwell).toBeGreaterThan(0.3);
    expect(trams.act(p, 'off')).toBe(true);
    expect(p.ped.aboard).toBeNull();
    expect(t.hits(p.ped.x, p.ped.y, 0)).toBeNull();
    expect(Math.min(...t.sections.map((s) => dist(s.x, s.y, p.ped.x, p.ped.y)))).toBeLessThan(6);
    expect(sent.some((e) => e.k === 'tram' && e.id === 0)).toBe(true);
  });

  it('can\'t get on a tram that isn\'t at a stop, nor from a car', () => {
    const { sim, p, t, trams } = tramAtStop(2);
    t.dwell = 0;
    atDoor(p, t);
    expect(trams.act(p, 'board')).toBe(false);
    t.dwell = 5;
    const car = sim.addVehicle(new Vehicle('sedan', p.ped.x + 2, p.ped.y, 0, '#fff'));
    car.parked = true;
    expect(sim.enterVehicle(p, car, 5)).toBe(true);
    expect(trams.act(p, 'board')).toBe(false);
  });

  it('a police unit takes twice as long to pick out a rider, even one who matches', () => {
    const recognised = (ride: boolean) => {
      const { sim, p, t, trams } = tramAtStop(3);
      atDoor(p, t);
      if (ride) expect(trams.act(p, 'board')).toBe(true);
      // wanted, and a police car with its siren on 15 m off, looking this way
      p.wanted = 2;
      sim.pursuit.know(p);
      const f = p.focus();
      let at: { x: number; y: number; a: number } | null = null;
      for (let k = 0; k < 16 && !at; k++) {
        const a = (k / 16) * Math.PI * 2, x = f.x + Math.cos(a) * 15, y = f.y + Math.sin(a) * 15;
        if (!sim.world.collideCircle(x, y, 1, 0) && sim.world.raycast(x, y, f.x, f.y) >= 1) at = { x, y, a: a + Math.PI };
      }
      expect(at).not.toBeNull();
      const car = sim.addVehicle(new Vehicle('police', at!.x, at!.y, at!.a, '#f5f5f5'));
      car.siren = true;
      car.driver = new Ped('cop', car.x, car.y, 1);
      // (not lying low yet either, which would take longer still)
      p.spot = 0;
      p.still = 0;
      p.low = 0;
      p.searchZone = null;
      t.update = () => {};
      let seenAfter = -1;
      for (let s = 0; s < 2.5 && seenAfter < 0; s += 0.1) {
        sim.pursuit.update(p, 0.1);
        if (p.spot >= 1) seenAfter = s;
      }
      return { seenAfter, spot: p.spot };
    };
    // on foot, matching the description: at once; riding: not yet, though the unit is looking them over
    const onFoot = recognised(false), riding = recognised(true);
    expect(onFoot.seenAfter).toBeGreaterThanOrEqual(0);
    expect(onFoot.seenAfter).toBeLessThan(0.2);
    expect(riding.seenAfter).toBe(-1);
    expect(riding.spot).toBeGreaterThan(0.4);
  });
});

describe('driving a tram', () => {
  it('takes the cab of a stopped tram (a crime), drives through the stops, brakes, and goes back to the AI', () => {
    const { sim, p, t, sent, trams } = tramAtStop(4);
    p.ped.x = t.x + Math.cos(t.angle) * 1.2;
    p.ped.y = t.y + Math.sin(t.angle) * 1.2;
    expect(tramUse(sim.trams, p.ped.x, p.ped.y, p.ped.level)?.op).toBe('cab');
    expect(trams.act(p, 'cab')).toBe(true);
    expect(t.driver).toBe(p.id);
    // a star, and heat toward the second (Sim.STAR_HEAT)
    expect(p.stars).toBe(1);
    expect(p.heat).toBeGreaterThan(0);
    expect(sent.some((e) => e.k === 'tram' && e.id === t.id && e.cab)).toBe(true);
    // full throttle: it pulls away from the stop at once and keeps going (no dwelling)
    let dwelt = 0, top = 0;
    for (let k = 0; k < 20 * 15; k++) {
      trams.drive(p, 1, 0, k === 0);
      follow(p, t);
      sim.step(1 / 15);
      if (t.dwell > 0) dwelt++;
      top = Math.max(top, t.speed);
    }
    expect(dwelt).toBe(0);
    expect(top).toBeGreaterThan(11);
    expect(dist(p.ped.x, p.ped.y, t.x, t.y)).toBeLessThan(2);
    // can't climb out at speed; the brake stops it
    expect(trams.act(p, 'off')).toBe(false);
    for (let k = 0; k < 10 * 15 && t.speed > 0; k++) {
      trams.drive(p, -1, 0, false);
      follow(p, t);
      sim.step(1 / 15);
    }
    expect(t.speed).toBe(0);
    expect(trams.act(p, 'off')).toBe(true);
    expect(t.driver).toBe(0);
    expect(p.ped.aboard).toBeNull();
    // the AI has it again: it pulls away by itself
    for (let k = 0; k < 5 * 15; k++) {
      follow(p, t);
      sim.step(1 / 15);
    }
    expect(t.speed).toBeGreaterThan(0.5);
  });

  it('the steering picks the branch at a junction', () => {
    const w = loadWorld(), g = w.tram;
    // a junction with a left and a right branch ahead of some track
    let found: { link: (typeof g.out)[number][number]; left: number; right: number } | null = null;
    for (let n = 0; n < g.out.length && !found; n++)
      for (const link of g.out[n]) {
        const run = (steer: number) => {
          const t = new Tram(g, link, new Rng(1), new Float32Array(0));
          t.takeCab(1);
          t.ctl.throttle = 1;
          t.ctl.steer = steer;
          const start = t.link.edge.id;
          for (let k = 0; k < 4000 && t.link.edge.id === start; k++) t.drive(1 / 30);
          // (pre-rolled onto the next link already: follow it to the one after)
          return t.link.edge.id;
        };
        const left = run(-1), right = run(1);
        if (left !== right) found = { link, left, right };
      }
    expect(found).not.toBeNull();
    expect(linkPoints(found!.link).length).toBeGreaterThan(2);
  });

  it('can\'t be driven through the tram ahead', () => {
    const { sim, p, t, trams, w } = tramAtStop(6);
    p.ped.x = t.x + Math.cos(t.angle) * 1.2;
    p.ped.y = t.y + Math.sin(t.angle) * 1.2;
    expect(trams.act(p, 'cab')).toBe(true);
    // another tram standing on the track 40 m ahead
    const ahead = new Tram(w.tram, t.link, sim.rng, w.tramStops);
    ahead.dwell = 1e9;
    for (let k = 0; k < 400; k++) {
      const d = Math.hypot(ahead.x - t.x, ahead.y - t.y);
      if (d > 40) break;
      ahead.advance(0.5);
      ahead.updateSections();
    }
    sim.addTram(ahead);
    for (let k = 0; k < 30 * 15; k++) {
      trams.drive(p, 1, 0, false);
      follow(p, t);
      sim.step(1 / 15);
      for (const s of t.sections) expect(ahead.hits(s.x, s.y, -0.5)).toBeNull();
    }
    expect(t.speed).toBeLessThan(1);
  });

  it('whoever it hits is the driver\'s doing', () => {
    const { sim, p, t, trams } = tramAtStop(5);
    p.ped.x = t.x + Math.cos(t.angle) * 1.2;
    p.ped.y = t.y + Math.sin(t.angle) * 1.2;
    expect(trams.act(p, 'cab')).toBe(true);
    // (who knocked them down: with no police in sight it costs no heat, but it's still the driver's)
    const by: number[] = [];
    sim.events = { ...sim.events, pedDazed: (_id, _x, _y, pid) => by.push(pid) };
    // someone standing on the track some way ahead
    let civ: Ped | null = null;
    for (let k = 0; k < 30 * 15 && !(civ && civ.dazed); k++) {
      trams.drive(p, 1, 0, false);
      if (!civ && t.speed > 6) {
        const x = t.x + Math.cos(t.angle) * 8, y = t.y + Math.sin(t.angle) * 8;
        civ = sim.addPed(new Ped('civ', x, y, 7));
        civ.level = t.level;
        civ.levelInit = true;
        civ.state = 'idle';
      }
      follow(p, t);
      sim.step(1 / 15);
    }
    expect(civ?.dazed).toBe(true);
    expect(by).toEqual([p.id]);
  });
});
