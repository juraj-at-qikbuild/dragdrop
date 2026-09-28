// The Hračkárstvo's second shelf (src/shared/sim/Combat.ts, Toys.ts; docs/plans/gameplay.md, Phase 4),
// against the real map: each squirted or swung toy's gag, each thrown toy's landing, the shop selling
// them, and the wire carrying them.
import { describe, expect, it } from 'vitest';
import { Sim } from '../../src/shared/sim/Sim';
import { Rng } from '../../src/shared/util/Rng';
import { Ped, STICKY_PACE, WEAPON_IDS, type WeaponId } from '../../src/shared/entities/Ped';
import { Vehicle } from '../../src/shared/entities/Vehicle';
import { nullEvents, type PrivateEvent, type ToyFx } from '../../src/shared/sim/events';
import type { Caps } from '../../src/shared/sim/density';
import type { SimPlayer } from '../../src/shared/sim/SimPlayer';
import { STICKY_S, WEAPONS, traceShot } from '../../src/shared/sim/Combat';
import { CLAMP_S, SLICK_R } from '../../src/shared/sim/Toys';
import type { Shops } from '../../src/shared/sim/rules/Shops';
import { AMMO_BOX, PRICES } from '../../src/shared/sim/shops/catalog';
import { shopById, teleports } from '../../src/shared/sim/shops/places';
import { AMMO_LIST, Ent, Reader, Writer, decodeSnapshot, encodeSnapshotHeader, entityHead, pedDynamic, pedStatic } from '../../src/shared/net/codec';
import { dist } from '../../src/shared/util/math';
import { SPAWNS } from '../../src/shared/world/spawns';
import { loadWorld } from './helpers';

const NO_NPCS: Caps = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

function setup() {
  const priv: [number, PrivateEvent][] = [];
  const toys: ToyFx[] = [];
  const sim = new Sim(loadWorld(), {
    rng: new Rng(5), caps: NO_NPCS, driveClock: false, rules: 'offline',
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), toy: (e) => toys.push(e) },
  });
  sim.clock.setTime(12);
  const sent = <K extends PrivateEvent['k']>(k: K) => priv.map(([, e]) => e).filter((e): e is Extract<PrivateEvent, { k: K }> => e.k === k);
  return { sim, sent, toys };
}

/** a street corner a car can stand on (a teleport's bay), and a spot on an open square (Hlavné
 *  námestie: nothing in the way for a dozen metres either side) */
const road = () => teleports(loadWorld())[0];
const pavement = () => {
  const w = loadWorld(), s = SPAWNS[0];
  for (let dy = 0; dy < 40; dy += 1)
    for (const sy of [1, -1]) {
      const y = s.y + dy * sy;
      if (w.raycast(s.x - 13, y, s.x + 13, y, 0) >= 1 && w.raycast(s.x, y, s.x, y + 4, 0) >= 1) return { x: s.x, y };
    }
  throw new Error('no open spot');
};

function player(sim: Sim, at: { x: number; y: number }): SimPlayer {
  const p = sim.addPlayer({ nick: 'A', profile: { money: 10_000, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] }, kinematic: true, x: at.x, y: at.y });
  p.ped.x = at.x;
  p.ped.y = at.y;
  for (const w of AMMO_LIST) p.ammo[w] = 50;
  return p;
}

/** a passer-by standing `dx` m east of `at` */
function civ(sim: Sim, at: { x: number; y: number }, dx: number, dy = 0): Ped {
  const q = sim.addPed(new Ped('civ', at.x + dx, at.y + dy, 1234 + dx * 10 + dy));
  q.state = 'idle';
  q.timer = 100;
  return q;
}

/** `p` fires `w` straight at (x, y), no spread */
function fireAt(sim: Sim, p: SimPlayer, w: WeaponId, x: number, y: number) {
  const a = Math.atan2(y - p.ped.y, x - p.ped.x);
  p.ped.weapon = w;
  sim.applyShot(p, traceShot(sim.world, sim.peds, sim.vehicles, p.ped, a, w, () => 0.5));
}

const run = (sim: Sim, s: number) => {
  for (let t = 0; t < s; t += 0.05) sim.step(0.05);
};

describe('the second shelf: squirted and swung', () => {
  it('Kofola makes whoever it hits sticky, and sticky walks slowly', () => {
    const { sim } = setup();
    const at = pavement();
    const p = player(sim, at);
    const q = civ(sim, at, 4);
    fireAt(sim, p, 'kofola', q.x, q.y);
    expect(q.sticky).toBe(STICKY_S);
    const x0 = q.x;
    q.move(0.1, sim.world, 1, 0);
    expect(q.vx).toBeCloseTo(STICKY_PACE);
    expect(q.x - x0).toBeCloseTo(0.1 * STICKY_PACE, 2);
  });

  it('...and tells a player it hits, so their own client slows them', () => {
    const { sim, sent } = setup();
    const at = pavement();
    const p = player(sim, at);
    const other = sim.addPlayer({ nick: 'B', profile: { money: 0, done: [], found: [], cumils: [] }, kinematic: true, x: at.x + 4, y: at.y });
    other.ped.x = at.x + 4;
    other.ped.y = at.y;
    fireAt(sim, p, 'kofola', other.ped.x, other.ped.y);
    expect(sent('sticky').at(-1)).toEqual({ k: 'sticky', t: STICKY_S });
  });

  it('the squeaky hammer sits someone down in one bonk', () => {
    const { sim } = setup();
    const at = pavement();
    const p = player(sim, at);
    const q = civ(sim, at, 1.2);
    fireAt(sim, p, 'hammer', q.x, q.y);
    expect(q.dazed).toBe(true);
    expect(q.downMess).toBe('bonk');
  });

  it('the blower pushes someone over and blows them a good way off', () => {
    const { sim } = setup();
    const at = pavement();
    const p = player(sim, at);
    const q = civ(sim, at, 4);
    for (let i = 0; i < 6 && !q.dazed; i++) fireAt(sim, p, 'blower', q.x, q.y);
    expect(q.dazed).toBe(true);
    expect(q.vx).toBeGreaterThan(5);
  });

  it('the peashooter is quiet: nobody around runs', () => {
    const { sim } = setup();
    const at = pavement();
    const p = player(sim, at);
    const target = civ(sim, at, 6);
    const bystander = civ(sim, at, -6);
    fireAt(sim, p, 'pea', target.x, target.y);
    expect(target.health).toBe(100 - WEAPONS.pea.dmg);
    expect(bystander.state).toBe('idle');
    // the water pistol isn't
    fireAt(sim, p, 'pistol', target.x, target.y);
    expect(bystander.state).toBe('flee');
  });

  it('the foam puts out a burning car', () => {
    const { sim, toys } = setup();
    const r = road();
    const car = sim.addVehicle(new Vehicle('sedan', r.x, r.y, r.a, '#c62828'));
    car.health = 0;
    car.fire = 2.5;
    const p = player(sim, { x: r.x + Math.cos(r.a + Math.PI / 2) * 6, y: r.y + Math.sin(r.a + Math.PI / 2) * 6 });
    fireAt(sim, p, 'foam', car.x, car.y);
    expect(car.fire).toBe(-1);
    expect(car.health).toBeGreaterThan(0);
    expect(toys.some((e) => e.op === 'foam' && e.vid === car.id)).toBe(true);
    // (and it doesn't dent it)
    fireAt(sim, p, 'foam', car.x, car.y);
    expect(car.health).toBeCloseTo(car.spec.health * 0.12);
  });
});

describe('the second shelf: thrown', () => {
  it('an egg on a windscreen, for a few seconds', () => {
    const { sim, toys } = setup();
    const r = road();
    const car = sim.addVehicle(new Vehicle('sedan', r.x, r.y, r.a, '#1565c0'));
    const p = player(sim, { x: r.x + 10, y: r.y });
    expect(sim.throwToy(p, 'egg', car.x, car.y)).toBe(true);
    expect(toys[0]).toMatchObject({ op: 'throw', w: 'egg' });
    run(sim, 1);
    expect(car.egg).toBeGreaterThan(2);
    expect(toys.some((e) => e.op === 'stick' && e.what === 'egg' && e.vid === car.id)).toBe(true);
    run(sim, 4);
    expect(car.egg).toBe(0);
  });

  it('the wheel clamp holds a car where it stands', () => {
    const { sim } = setup();
    const r = road();
    const car = sim.addVehicle(new Vehicle('sedan', r.x, r.y, r.a, '#1565c0'));
    const p = player(sim, { x: r.x + 6, y: r.y });
    sim.throwToy(p, 'clamp', car.x, car.y);
    run(sim, 0.8);
    expect(car.clamp).toBeGreaterThan(CLAMP_S - 1);
    car.vx = Math.cos(car.angle) * 12;
    car.vy = Math.sin(car.angle) * 12;
    car.setControls(1, 0, false);
    run(sim, 1);
    expect(car.speed).toBeLessThan(0.5);
  });

  it('a soap bomb leaves a slippery patch that cars on it slide on', () => {
    const { sim, toys } = setup();
    const r = road();
    const p = player(sim, { x: r.x + 8, y: r.y });
    sim.throwToy(p, 'soap', r.x, r.y);
    run(sim, 1);
    expect(sim.toys.slicks).toHaveLength(1);
    expect(toys.some((e) => e.op === 'slick' && e.r === SLICK_R)).toBe(true);
    const car = sim.addVehicle(new Vehicle('sedan', r.x, r.y, r.a, '#1565c0'));
    car.setControls(1, 0, false);
    run(sim, 0.1);
    expect(car.slick).toBe(true);
    run(sim, 20);
    expect(sim.toys.slicks).toHaveLength(0);
  });

  it('the Easter bucket soaks everyone round where it lands, but the thrower', () => {
    const { sim } = setup();
    const at = pavement();
    const p = player(sim, at);
    const a = civ(sim, at, 6), b = civ(sim, at, 7.5, 1);
    sim.throwToy(p, 'bucket', at.x + 6.5, at.y);
    run(sim, 1.2);
    expect(a.dazed && b.dazed).toBe(true);
    expect(p.ped.health).toBe(100);
  });

  it('the pigeon flies at whoever is nearest the spot', () => {
    const { sim } = setup();
    const at = pavement();
    const p = player(sim, at);
    const q = civ(sim, at, 10, 3);
    sim.throwToy(p, 'pigeon', at.x + 12, at.y);
    run(sim, 1.5);
    expect(q.health).toBe(100 - WEAPONS.pigeon.dmg);
  });

  it('goes no further than it can be thrown, and only a thrown toy can be', () => {
    const { sim, toys } = setup();
    const at = pavement();
    const p = player(sim, at);
    expect(sim.throwToy(p, 'egg', at.x + 500, at.y)).toBe(true);
    const e = toys[0] as Extract<ToyFx, { op: 'throw' }>;
    expect(dist(e.x, e.y, e.tx, e.ty)).toBeCloseTo(WEAPONS.egg.range, 1);
    expect(sim.throwToy(p, 'pistol', at.x + 5, at.y)).toBe(false);
  });
});

describe('the Hračkárstvo sells them', () => {
  it('every toy, with its refill', () => {
    const { sim } = setup();
    const shops = sim.rule<Shops>('shops')!;
    const p = player(sim, shopById(loadWorld(), 'guns-michael')!);
    for (const w of AMMO_LIST) p.ammo[w] = 0;
    let money = p.profile.money;
    for (const w of AMMO_LIST) {
      expect(shops.act(p, { op: 'buy', item: w }).ok, w).toBe(true);
      expect(p.ammo[w]).toBe(AMMO_BOX[w]);
      money -= PRICES[w];
      expect(p.profile.money).toBe(money);
    }
  });
});

describe('on the wire', () => {
  it("a player's toy, whichever it is, and every toy's refills", () => {
    for (const weapon of WEAPON_IDS) {
      const w = new Writer(64);
      const ammo = AMMO_LIST.map((_, i) => i * 7);
      encodeSnapshotHeader(w, 1, 1, 1, { health: 100, armor: 0, wanted: 0, state: 'play', stateTimer: 0, searching: false, shotCops: false, money: 5, ammo, epoch: 0, zone: null });
      w.u16(1);
      const p = new Ped('player', 3, 4, 99);
      p.id = 5;
      p.playerId = 2;
      p.weapon = weapon;
      entityHead(w, p.id, Ent.Ped, true, 0);
      pedStatic(w, p);
      pedDynamic(w, p, 0);
      w.u16(0);
      const snap = decodeSnapshot(new Reader(w.finish()));
      expect((snap.ents[0].v as { weapon: string }).weapon).toBe(weapon);
      expect(snap.me.ammo).toEqual(ammo);
    }
  });
});
