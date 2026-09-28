// The police's side of a chase (src/shared/sim/Pursuit.ts; docs/plans/gameplay.md, Phase 1), against
// the real map: sight cones by day and night, crimes that need police eyes, witness reports at the
// crime scene, the description and recognising a player in another car, searching instead of homing
// in (cops on foot, reinforcements, roadblocks, the helicopter), lying low, and bribes.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Vehicle, type VehicleKind } from '../../src/shared/entities/Vehicle';
import { Ped } from '../../src/shared/entities/Ped';
import { nullEvents, type PrivateEvent, type ShotFx } from '../../src/shared/sim/events';
import { BRIBE_PER_STAR } from '../../src/shared/sim/Pursuit';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import type { Caps } from '../../src/shared/sim/density';
import { dist } from '../../src/shared/util/math';
import { loadWorld } from './helpers';

const NO_NPCS: Caps = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };
/** every landmark pre-found, so no discovery reward lands on a money assertion */
const allFound = () => [...loadWorld().landmarks.keys()];
const profile = (money = 1000) => ({ money, done: [], found: allFound(), cumils: [] as number[] });

// Pečnianska in Petržalka: a straight street, clear from A (east) to B (west), 150 m
const A = { x: -1052.6, y: 1124.9 }, B = { x: -1202.5, y: 1117.5 };
const LEN = dist(A.x, A.y, B.x, B.y);
const WEST = Math.atan2(B.y - A.y, B.x - A.x);
/** a point `d` m from A toward B (negative: behind A) */
const along = (d: number) => ({ x: A.x + ((B.x - A.x) / LEN) * d, y: A.y + ((B.y - A.y) / LEN) * d });
/** a car park beside it, and a spot under the Michalská brána gateway (under a roof) */
const PARKING = { x: -1345.0, y: 1276.9 };
const GATEWAY = { x: -430.1, y: -459.6 };

function setup(seed: number, o: { hour?: number; caps?: Caps } = {}) {
  const priv: [number, PrivateEvent][] = [];
  const shots: ShotFx[] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), caps: { ...NO_NPCS, ...o.caps }, driveClock: false,
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), shot: (e) => shots.push(e) },
  });
  sim.clock.setTime(o.hour ?? 12);
  sim.clock.setRain(0);
  return { sim, priv, shots };
}

/** a player (their client moves them, as online) standing at `at`, with their camera on them */
function player(sim: Sim, at: { x: number; y: number }, money = 1000): SimPlayer {
  const p = sim.addPlayer({ nick: 'A', profile: profile(money), kinematic: true, x: at.x, y: at.y });
  Object.assign(p.observer, { fx: at.x, fy: at.y, cx: at.x, cy: at.y, hw: 30, hh: 18 });
  return p;
}

/** a police car with a cop at the wheel, parked facing `angle` (nobody drives it: it stays put) */
function policeCar(sim: Sim, at: { x: number; y: number }, angle: number, siren = true) {
  const v = new Vehicle('police', at.x, at.y, angle, '#f5f5f5');
  const cop = new Ped('cop', at.x, at.y, 7);
  cop.vehicle = v;
  v.driver = cop;
  v.siren = siren;
  sim.addVehicle(v);
  sim.addPed(cop);
  return v;
}

/** put `p` in a new car at `at` */
function drive(sim: Sim, p: SimPlayer, at: { x: number; y: number }, kind: VehicleKind = 'sedan', color = '#263238') {
  const v = sim.addVehicle(new Vehicle(kind, at.x, at.y, WEST, color));
  p.ped.x = at.x;
  p.ped.y = at.y + 1.5;
  expect(sim.enterVehicle(p, v)).toBe(true);
  return v;
}

const run = (sim: Sim, seconds: number, dt = 0.1) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) sim.step(dt);
};

describe('what the police see', () => {
  it('a police car sees ahead within its cone, not behind it, and always up close', () => {
    const { sim } = setup(1);
    const p = player(sim, along(40));
    policeCar(sim, A, WEST);
    sim.setWanted(p, 2);
    run(sim, 0.3);
    expect(p.searching).toBe(false);
    expect(p.searchZone).toBeNull();

    Object.assign(p.ped, along(-40)); // behind it
    run(sim, 0.3);
    expect(p.searching).toBe(true);
    expect(p.searchZone).not.toBeNull();

    Object.assign(p.ped, along(-10)); // behind it, but right there
    run(sim, 0.3);
    expect(p.searching).toBe(false);
  });

  it('sees a player 55 m ahead at noon, not at midnight', () => {
    for (const [hour, seen] of [[12, true], [0, false]] as const) {
      const { sim } = setup(2, { hour });
      const p = player(sim, along(55));
      policeCar(sim, A, WEST);
      sim.setWanted(p, 2);
      run(sim, 0.3);
      expect(p.searching).toBe(!seen);
    }
  });

  it('a crime behind a patrol car\'s back goes unseen; in front of it, it is seen', () => {
    const { sim } = setup(3);
    const p = player(sim, along(-30));
    policeCar(sim, A, WEST, false); // on patrol: no siren
    sim.crime(p, 'carjack');
    expect(p.wanted).toBe(0);
    Object.assign(p.ped, along(30));
    sim.crime(p, 'carjack');
    expect(p.wanted).toBe(1);
  });

  it('gunfire close behind a police car is heard; further off, it is not', () => {
    for (const [d, heard] of [[-15, true], [-30, false]] as const) {
      const { sim } = setup(3);
      const p = player(sim, along(d));
      policeCar(sim, A, WEST, false);
      sim.crime(p, 'shoot');
      expect(p.wanted > 0).toBe(heard);
    }
  });
});

describe('heat: stars come one at a time (Sim.STAR_HEAT)', () => {
  it('the first crime is a star; each star after it takes more', () => {
    const { sim } = setup(9);
    const p = player(sim, along(30));
    sim.crime(p, 'hitCop'); // ramming a police car: 0.4 heat, once in 8 s
    expect(p.stars).toBe(1);
    const ramsTo = (stars: number) => {
      let n = 0;
      for (; p.stars < stars && n < 50; n++) {
        sim.time += 8.1;
        sim.crime(p, 'hitCop');
      }
      return n;
    };
    // 1.5 heat to the second star, 2 more to the third
    expect(ramsTo(2)).toBe(4);
    expect(ramsTo(3)).toBe(5);
    // (within the cooldown a ram adds nothing)
    const heat = p.heat;
    sim.crime(p, 'hitCop');
    expect(p.heat).toBe(heat);
  });

  it('a big crime from nothing: a star, and the rest as heat toward the next', () => {
    const { sim } = setup(9);
    const p = player(sim, along(30));
    sim.crime(p, 'stealCop');
    expect(p.stars).toBe(1);
    expect(p.heat).toBeCloseTo(0.5, 6);
    sim.setWanted(p, 3);
    expect(p.heat).toBe(0);
  });
});

describe('the description', () => {
  it('a witness\'s report sends the police to the crime scene, looking for the car used there', () => {
    const { sim } = setup(4);
    const p = player(sim, along(0));
    const used = drive(sim, p, along(0), 'hatch', '#c62828');
    // a passer-by 16 m off, with a clear view
    const w = new Ped('civ', along(16).x, along(16).y, 11);
    sim.addPed(w);
    run(sim, 0.2);
    sim.crime(p, 'shoot');
    expect(p.wanted).toBe(0);
    // meanwhile the player swaps cars 100 m down the street
    sim.exitVehicle(p, true);
    const other = drive(sim, p, along(100));
    Object.assign(p.observer, { fx: p.ped.x, fy: p.ped.y, cx: p.ped.x, cy: p.ped.y });
    for (let t = 0; t < 20 && p.wanted === 0; t += 0.1) sim.step(0.1);
    expect(p.wanted).toBe(1);
    expect(dist(p.lastSeenPos.x, p.lastSeenPos.y, along(0).x, along(0).y)).toBeLessThan(3);
    expect(p.desc.car).toBe(used.id);
    expect(p.desc.color).toBe('#c62828');
    expect(sim.pursuit.matches(p)).toBe(false);
    expect(p.ped.vehicle).toBe(other);
  });

  it('a unit recognises a player in another car only after a good look, at once up close', () => {
    const { sim, priv } = setup(5);
    const p = player(sim, along(40));
    const car = drive(sim, p, along(40));
    policeCar(sim, A, WEST);
    p.wanted = 2;
    // they're looking for a red Felícia the player left somewhere else
    sim.pursuit.know(p, along(40), { car: 9999, kind: 'hatch', color: '#c62828' });
    run(sim, 2);
    expect(p.searching).toBe(true); // 1 s + 1 s per 20 m: 3 s at 40 m
    expect(p.spot).toBeGreaterThan(0.5);
    expect(p.unseen).toBe(0); // the stars hold while they look the player over
    const watched = priv.filter(([, e]) => e.k === 'police').map(([, e]) => e as Extract<PrivateEvent, { k: 'police' }>);
    expect(watched.some((e) => e.w === 1 && e.m === 0 && e.spot > 0)).toBe(true);
    run(sim, 1.2);
    expect(p.searching).toBe(false);
    expect(p.desc.car).toBe(car.id);
    expect(sim.pursuit.matches(p)).toBe(true);

    // another car again, but pulled up right beside the police car
    const { sim: sim2 } = setup(6);
    const q = player(sim2, along(10));
    drive(sim2, q, along(10));
    policeCar(sim2, A, WEST);
    q.wanted = 2;
    sim2.pursuit.know(q, along(10), { car: 9999, kind: 'hatch', color: '#c62828' });
    run(sim2, 0.2);
    expect(q.searching).toBe(false);
  });
});

describe('searching, not homing in', () => {
  it('a cop on foot who has lost the player searches the circle rather than walking to them', () => {
    const { sim } = setup(7);
    const p = player(sim, along(0));
    p.ped.vx = 2; // on the move: not lying low
    p.wanted = 2;
    sim.pursuit.know(p, along(100), undefined, false); // last seen 100 m west
    const cop = new Ped('cop', along(20).x, along(20).y, 13);
    cop.state = 'chase';
    cop.targetPid = p.id;
    cop.angle = WEST; // the player is behind them
    sim.addPed(cop);
    const toZone0 = dist(cop.x, cop.y, along(100).x, along(100).y);
    run(sim, 5);
    expect(p.searching).toBe(true);
    expect(dist(cop.x, cop.y, along(100).x, along(100).y)).toBeLessThan(toZone0 - 5);
    expect(dist(cop.x, cop.y, p.ped.x, p.ped.y)).toBeGreaterThan(20);
  });

  it('reinforcements come in round the search circle, not round the player', () => {
    const { sim } = setup(8);
    const p = player(sim, along(0));
    p.ped.vx = 2;
    p.wanted = 3;
    sim.pursuit.know(p, along(150), undefined, false);
    run(sim, 0.2); // the circle opens before any police may come
    sim.caps = { ...sim.caps, police: 20 };
    run(sim, 3);
    const zone = p.searchZone!;
    const cops = sim.vehicles.filter((v) => v.kind === 'police' || sim.police.swat.has(v));
    expect(cops.length).toBeGreaterThan(0);
    for (const v of cops) expect(dist(v.x, v.y, zone.x, zone.y)).toBeLessThan(zone.r + 60 + 40);
  });

  it('no roadblocks go up while nobody has seen the player for a while', () => {
    for (const fresh of [true, false]) {
      const { sim } = setup(9, { caps: { ...NO_NPCS, roadblocks: 6 } });
      const l = sim.world.landmark('eurovea');
      const at = sim.world.walkableNear(l.x, l.y - 40);
      const p = player(sim, at);
      const car = drive(sim, p, at);
      car.vx = -14; // heading west along the riverside at speed
      car.angle = Math.PI;
      p.wanted = 3;
      for (let t = 0; t < 30; t += 0.25) {
        if (fresh) p.lastSeenAt = sim.time; // as if a police car kept them in sight
        sim.step(0.25);
      }
      expect(sim.props.some((pr) => pr.kind === 'barrier')).toBe(fresh);
    }
  });
});

describe('lying low', () => {
  /** seconds for 1★ to wear off, the police having last seen the player at `seenAt` */
  function fade(o: { seenAt?: { x: number; y: number }; at?: { x: number; y: number }; moving?: boolean; car?: boolean; mismatch?: boolean }) {
    const { sim } = setup(10);
    const at = o.at ?? along(0);
    const p = player(sim, at);
    if (o.car) drive(sim, p, at);
    if (o.moving) p.ped.vx = 2;
    p.wanted = 1;
    sim.pursuit.know(p, o.seenAt ?? at, o.mismatch ? { car: 9999, kind: 'hatch', color: '#c62828' } : undefined, false);
    let t = 0;
    for (; t < 40 && p.wanted > 0; t += 0.1) sim.step(0.1);
    return t;
  }

  it('fades faster in another car, still faster lying low, fastest in a hideout; not at all on the move inside the circle', () => {
    const far = along(150);
    const running = fade({ seenAt: far, moving: true });
    const otherCar = fade({ seenAt: far, moving: true, mismatch: true });
    const low = fade({});
    const hideout = fade({ at: PARKING, car: true });
    expect(running).toBeGreaterThan(10);
    expect(running).toBeLessThan(11.5);
    expect(otherCar).toBeLessThan(running - 2);
    expect(low).toBeLessThan(running - 1.5); // and inside the circle, where the search is
    expect(hideout).toBeLessThan(low - 0.5);
    expect(fade({ moving: true })).toBeGreaterThanOrEqual(40);
  });

  it('says when the player lies low, and when in a hideout', () => {
    const { sim, priv } = setup(11);
    const p = player(sim, PARKING);
    drive(sim, p, PARKING);
    p.wanted = 2;
    sim.pursuit.know(p, undefined, undefined, false);
    run(sim, 4);
    expect(p.low).toBe(2);
    const last = priv.filter(([, e]) => e.k === 'police').pop()![1] as Extract<PrivateEvent, { k: 'police' }>;
    expect(last.low).toBe(2);
    expect(last.m).toBe(1);
  });
});

describe('the helicopter', () => {
  it('finds a player in the open by day, but not one under a roof, and never fires at a search point', () => {
    const open = setup(12, { caps: { ...NO_NPCS, helis: 4 } });
    const main = open.sim.world.landmark('main');
    const pOpen = player(open.sim, open.sim.world.walkableNear(main.x, main.y));
    pOpen.ped.vx = 2;
    open.sim.setWanted(pOpen, 5);
    let seen = false;
    for (let t = 0; t < 30 && !seen; t += 0.1) {
      open.sim.step(0.1);
      seen = !pOpen.searching;
    }
    expect(seen).toBe(true);

    const hid = setup(13, { caps: { ...NO_NPCS, helis: 4 } });
    const pHid = player(hid.sim, GATEWAY);
    expect(hid.sim.world.covered(GATEWAY.x, GATEWAY.y, 0)).toBe(true);
    pHid.ped.vx = 2; // not lying low: only the roof hides them
    hid.sim.setWanted(pHid, 5);
    pHid.unseen = -Infinity; // and the stars wait: this is about what the helicopter sees
    run(hid.sim, 30);
    expect(hid.sim.police.helis().length).toBe(1);
    expect(pHid.searching).toBe(true);
    expect(hid.shots.filter((s) => s.by === 0).length).toBe(0);
  });
});

describe('Úplatok', () => {
  function busted(stars: number, money = 1000) {
    const { sim, priv } = setup(20);
    const p = player(sim, along(0), money);
    p.ammo.pistol = 20;
    sim.setWanted(p, stars);
    sim.bust(p);
    return { sim, priv, p };
  }

  it('buys off an arrest at 1–2★: no fee, the guns kept, the stars gone, no points', () => {
    const { sim, priv, p } = busted(2);
    const scored: string[] = [];
    sim.onScore = (_p, n, src) => (scored.push(src), n);
    expect(p.state).toBe('busted');
    expect(p.bribeOffer).toBe(2 * BRIBE_PER_STAR);
    expect(priv.some(([, e]) => e.k === 'bribe' && e.price === 300 && e.t === 5)).toBe(true);
    expect(sim.bribe(p)).toBe(true);
    expect(p.state).toBe('play');
    expect(p.wanted).toBe(0);
    expect(p.profile.money).toBe(700);
    expect(p.ammo.pistol).toBe(20);
    run(sim, 6);
    expect(p.state).toBe('play');
    expect(scored).toEqual([]);
    expect(priv.some(([, e]) => e.k === 'bribe' && e.price === 0)).toBe(true);
  });

  it('is not offered at 3★, after shooting at the police, or to someone cuffed while downed', () => {
    const three = busted(3);
    expect(three.p.bribeOffer).toBe(0);
    expect(three.sim.bribe(three.p)).toBe(false);
    run(three.sim, 4.5);
    expect(three.p.state).toBe('play');
    expect(three.p.ammo.pistol).toBe(0); // arrested after all

    const { sim } = setup(21);
    const p = player(sim, along(0));
    sim.setWanted(p, 2);
    p.shotCops = true;
    sim.bust(p);
    expect(p.bribeOffer).toBe(0);

    const d = setup(22);
    const q = player(d.sim, along(0));
    d.sim.setWanted(q, 1);
    q.state = 'downed';
    d.sim.bust(q);
    expect(q.bribeOffer).toBe(0);
  });

  it('fails without the money, and a second one within 10 minutes is not offered', () => {
    const poor = busted(2, 100);
    expect(poor.sim.bribe(poor.p)).toBe(false);
    expect(poor.p.state).toBe('busted');
    run(poor.sim, 5.5);
    expect(poor.p.state).toBe('play');
    expect(poor.p.ammo.pistol).toBe(0);

    const { sim, p } = busted(1);
    expect(sim.bribe(p)).toBe(true);
    run(sim, 60);
    sim.setWanted(p, 1);
    sim.bust(p);
    expect(p.bribeOffer).toBe(0);
    expect(sim.bribe(p)).toBe(false);
  });
});
