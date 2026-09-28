// Vydrž do 95. minúty (games/football.ts, docs/plans/minigames.md): car football on a parking lot. The
// pitch on a real lot (clear of walls, a goal at each end), the ball (a vehicle kind of its own: it
// rolls, slows, bounces off walls, boards, posts and cars, dents nobody and nobody gets in), a goal
// when all of it is over the line, the scenarios alone (hold 1:0 against England to 95:00, their
// bicycle kick at the end; two goals against Germany), two teams with others, and nothing of it left
// in the city afterwards.
import { describe, expect, it } from 'vitest';
import { BALL_BOUNCE, Vehicle, type Pen } from '../../../src/shared/entities/Vehicle';
import { VehiclePhysics, pedContact } from '../../../src/shared/sim/Physics';
import { Ped } from '../../../src/shared/entities/Ped';
import { World } from '../../../src/shared/world/World';
import type { MapJSON } from '../../../src/shared/types';
import { Ent, Reader, VEHICLE_KINDS, Writer, decodeSnapshot, encodeSnapshotHeader, entityHead, vehicleDynamic, vehicleStatic } from '../../../src/shared/net/codec';
import { findPitch, HL_MIN, PITCH_REACH, PitchFrame } from '../../../src/shared/sim/rules/minigames/games/footballPitch';
import { GROUP_GOALS, MATCH_S, PAY_GOAL, PAY_LOSS, PAY_TEAM_LOSS, PAY_TEAM_WIN, PAY_WIN } from '../../../src/shared/sim/rules/minigames/games/football';
import type { Bot } from '../../../src/shared/sim/rules/minigames/games/footballBots';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, type MiniSetup } from './helpers';

/** the game's insides the tests look at */
interface Game {
  f: PitchFrame;
  ball: Vehicle;
  bots: Bot[];
  cars: Map<number, Vehicle>;
  stage: 'warm' | 'kick' | 'play' | 'goal';
  clock: number;
  score: [number, number];
  noz: { at: number; state: string };
  mode: string;
}
const game = (s: MiniSetup, p: SimPlayer) => s.mini.gameOf(p) as unknown as Game;

/** A round for `p` (and `others`, online), lobby cut short: everyone into the car waiting for them,
 *  and on to the kick-off's end. */
function kickOff(s: MiniSetup, p: SimPlayer, others: SimPlayer[] = []): Game {
  const r = s.mini.start(p, 'football');
  if (!r) throw new Error(`no round: ${messages(s.priv, p.id).slice(-1)[0]}`);
  for (const q of others) expect(s.mini.join(q, r.id)).toBe(true);
  s.mini.go(p);
  run(s.sim, 3.2);
  const g = game(s, p);
  expect(g.stage).toBe('warm');
  for (const q of [p, ...others]) {
    const car = g.cars.get(q.id)!;
    standAt(q, car.x + 2.6 * Math.cos(car.angle + Math.PI / 2), car.y + 2.6 * Math.sin(car.angle + Math.PI / 2));
    expect(s.sim.enterVehicle(q, car)).toBe(true);
  }
  run(s.sim, 0.2);
  expect(g.stage).toBe('kick');
  run(s.sim, 3.2);
  expect(g.stage).toBe('play');
  return g;
}

/** put the ball at (lx, ly) on the pitch, moving (vl, vw) in the pitch's frame */
function place(g: Game, lx: number, ly: number, vl = 0, vw = 0) {
  const f = g.f, b = g.ball;
  b.x = f.wx(lx, ly);
  b.y = f.wy(lx, ly);
  b.vx = vl * f.ca - vw * f.sa;
  b.vy = vl * f.sa + vw * f.ca;
}

/** park a car at (lx, ly) on the pitch, facing along its length turned by `a`, standing */
function park(g: Game, v: Vehicle, lx: number, ly: number, a = 0) {
  const f = g.f;
  v.x = f.wx(lx, ly);
  v.y = f.wy(lx, ly);
  v.angle = f.p.a + a;
  v.vx = v.vy = v.av = 0;
}

/** the NPC cars out of the way beside the pitch, every step (a test's own scenario) */
function benchBots(g: Game) {
  g.bots.forEach((b, i) => {
    park(g, b.v, -10 + i * 7, g.f.p.hw + 8);
    b.v.setControls(0, 0, true);
  });
}

/** step the city along until `done` (at most `secs`) */
function runUntil(s: MiniSetup, secs: number, done: () => boolean, each?: () => void) {
  for (let t = 0; t < secs && !done(); t += 0.05) {
    s.sim.step(0.05);
    each?.();
  }
}

/** an open flat test track (no walls but the edge of the world), as test/shared/vehicle.test.ts */
function track() {
  const w = new World({
    bounds: [-5000, -5000, 5000, 5000], origin: [0, 0], names: [], roads: [], trams: [], buildings: [],
    areas: { water: [], green: [], wood: [], plaza: [], parking: [], pitch: [], sand: [], rail: [] },
    rivers: [], pois: [], landmarks: [], graph: { car: { nodes: [], edges: [] }, ped: { nodes: [], edges: [] }, tram: { nodes: [], edges: [] } },
  } as MapJSON);
  w.surfaceAt = () => 'asphalt';
  return w;
}

describe('Vydrž do 95. minúty: the pitch', () => {
  it('is marked out on a parking lot near Aupark and near Eurovea: clear of walls, on the lot, a goal at each end', () => {
    const s = setupMini(1);
    const w = s.sim.world;
    for (const at of ['aupark', 'eurovea']) {
      const l = w.landmark(at);
      const found = findPitch(w, l.x, l.y)!;
      expect(found).toBeTruthy();
      expect(found.d).toBeLessThan(PITCH_REACH);
      const q = found.pitch;
      expect(q.hl).toBeGreaterThanOrEqual(HL_MIN);
      expect(q.gw).toBeGreaterThanOrEqual(6);
      const f = new PitchFrame(q);
      // every metre or two of it, goals included: on the lot, no wall, trunk or post
      for (let lx = -q.hl - q.gd; lx <= q.hl + q.gd; lx += 2)
        for (let ly = -q.hw; ly <= q.hw; ly += 2) {
          const x = f.wx(lx, ly), y = f.wy(lx, ly);
          expect(w.inParking(x, y)).toBe(true);
          expect(w.collideCircle(x, y, 0.5, 0, false)).toBeNull();
        }
    }
  });

  it('a round moves to its pitch and shows it: the two goals, the arrow at the ball', () => {
    const s = setupMini(2);
    const p = addPlayer(s.sim, 'aupark');
    const g = kickOff(s, p);
    const r = s.mini.roundOf(p)!;
    expect(r.x).toBeCloseTo(g.f.p.x, 0);
    run(s.sim, 0.3);
    const st = lastMini(s.priv, p.id)!;
    const goals = st.marks!.filter((m) => m.w && m.h);
    expect(goals.length).toBe(2);
    for (const m of goals) {
      expect(m.w).toBe(g.f.p.gd);
      expect(m.h).toBe(g.f.p.gw);
      expect(Math.abs(Math.abs(g.f.lx(m.x, m.y)) - (g.f.p.hl + g.f.p.gd / 2))).toBeLessThan(0.2);
    }
    expect(goals.map((m) => m.label).sort()).toEqual(['súperova bránka', 'tvoja bránka']);
    expect(st.marks!.find((m) => m.arrow)?.e).toBe(g.ball.id);
    expect(st.x?.b).toBe(g.ball.id);
    expect(st.x?.p).toEqual([g.f.p.x, g.f.p.y, g.f.p.a, g.f.p.hl, g.f.p.hw, g.f.p.gw, g.f.p.gd]);
  });

  it('refuses where no lot is near enough (Slavín)', () => {
    const s = setupMini(1);
    const p = addPlayer(s.sim, 'slavin');
    expect(s.mini.start(p, 'football')).toBeNull();
    expect(messages(s.priv, p.id).slice(-1)[0]).toContain('parkovisko');
  });
});

describe('Vydrž do 95. minúty: the ball', () => {
  const dt = 1 / 120;

  it('rolls on, slowing down, and stops', () => {
    const w = track();
    const b = new Vehicle('ball', 0, 0, 0, '#fff');
    expect(b.circles).toEqual([0]);
    expect(b.radius).toBeCloseTo(0.8);
    b.vx = 10;
    for (let t = 0; t < 1; t += dt) b.update(dt, w);
    expect(b.speed).toBeLessThan(9);
    expect(b.speed).toBeGreaterThan(7);
    for (let t = 0; t < 20; t += dt) b.update(dt, w);
    expect(b.speed).toBe(0);
    // (a knock at 10 m/s rolls it some 25-35 m)
    expect(b.x).toBeGreaterThan(25);
    expect(b.x).toBeLessThan(40);
    expect(b.y).toBe(0);
  });

  it('bounces off a wall, keeping about half its pace', () => {
    const w = track();
    // (the edge of the world is a wall like any other: World.collideCircle)
    const b = new Vehicle('ball', -4996, 0, 0, '#fff');
    b.vx = -10;
    let back = 0;
    for (let t = 0; t < 1; t += dt) {
      b.update(dt, w);
      back = Math.max(back, b.vx);
    }
    expect(b.x).toBeGreaterThan(-4999.3);
    expect(back).toBeGreaterThan(9 * BALL_BOUNCE * 0.8);
    expect(back).toBeLessThan(10 * BALL_BOUNCE * 1.05);
  });

  it('stays on its pitch: off the boards and the posts, and a goal\'s net takes the pace off it', () => {
    const w = track();
    const pen: Pen = { x: 0, y: 0, a: 0, hl: 20, hw: 12, gw: 8, gd: 2.5 };
    const b = new Vehicle('ball', 0, 0, 0, '#fff');
    b.pen = pen;
    // at the side boards
    b.vy = 12;
    for (let t = 0; t < 1.5; t += dt) b.update(dt, w);
    expect(b.y).toBeLessThanOrEqual(12 - 0.8 + 1e-6);
    expect(b.vy).toBeLessThan(0);
    // at the end boards beside the goal
    Object.assign(b, { x: 15, y: 8, vx: 12, vy: 0 });
    for (let t = 0; t < 1; t += dt) b.update(dt, w);
    expect(b.x).toBeLessThanOrEqual(20 - 0.8 + 1e-6);
    expect(b.vx).toBeLessThan(0);
    // into the goal: all the way to the back of the net, which takes the pace off it
    Object.assign(b, { x: 12, y: 0, vx: 15, vy: 0 });
    for (let t = 0; t < 2; t += dt) b.update(dt, w);
    expect(b.x).toBeGreaterThan(20 + 0.8);
    expect(b.x).toBeLessThanOrEqual(20 + 2.5 - 0.8 + 1e-6);
    expect(Math.abs(b.vx)).toBeLessThan(1);
    // off a post
    Object.assign(b, { x: 14, y: 4, vx: 12, vy: 0 });
    for (let t = 0; t < 1; t += dt) b.update(dt, w);
    expect(b.x).toBeLessThan(20);
  });

  it('a car knocks it away, faster than the car, and neither is dented', () => {
    const w = track();
    const phys = new VehiclePhysics();
    const b = new Vehicle('ball', 10, 0, 0, '#fff');
    b.id = 1;
    const car = new Vehicle('hatch', 0, 0, 0, '#c62828');
    car.id = 2;
    car.vx = 12;
    car.setControls(0, 0);
    for (let t = 0; t < 1.2; t += dt) phys.step(dt, [b, car], [], w, {});
    expect(b.vx).toBeGreaterThan(14);
    expect(b.x).toBeGreaterThan(car.x + 3);
    expect(car.health).toBe(car.spec.health);
    expect(car.dmg).toEqual({ front: 0, rear: 0, left: 0, right: 0 });
    expect(b.health).toBe(b.spec.health);
    // and a nudge just pushes it along (it can be dribbled)
    const b2 = new Vehicle('ball', 5, 0, 0, '#fff');
    b2.id = 3;
    const car2 = new Vehicle('hatch', 0, 0, 0, '#c62828');
    car2.id = 4;
    car2.vx = 3;
    for (let t = 0; t < 2; t += dt) phys.step(dt, [b2, car2], [], w, {}), car2.setControls(0.25, 0);
    expect(b2.x).toBeGreaterThan(car2.x + 2.4);
    expect(b2.speed).toBeLessThan(8);
  });

  it('online: a player\'s car (posed by their client) pushes the server\'s ball; a client\'s mirror of the ball stops no car', () => {
    const w = track();
    const phys = new VehiclePhysics();
    const b = new Vehicle('ball', 6, 0, 0, '#fff');
    b.id = 1;
    const car = new Vehicle('sedan', 0, 0, 0, '#fff');
    car.id = 2;
    car.kinematic = true;
    for (let t = 0; t < 1; t += dt) {
      car.vx = 10;
      car.x += 10 * dt;
      phys.step(dt, [b, car], [], w, {});
    }
    expect(b.vx).toBeGreaterThan(12);
    // the other way round: a client's car drives through the mirrored ball as if it weren't there
    const mirror = new Vehicle('ball', 6, 0, 0, '#fff');
    mirror.id = 3;
    mirror.kinematic = true;
    const mine = new Vehicle('sedan', 0, 0, 0, '#fff');
    mine.id = 4;
    mine.vx = 8;
    for (let t = 0; t < 0.5; t += dt) phys.step(dt, [mirror, mine], [], w, {});
    expect(mine.vx).toBeGreaterThan(7);
    expect(mirror.x).toBe(6);
  });

  it('nobody gets in, it never burns or breaks, and it knocks nobody down', () => {
    const s = setupMini(1);
    const p = addPlayer(s.sim, 'main');
    const b = s.sim.addVehicle(new Vehicle('ball', p.ped.x + 2, p.ped.y, 0, '#fff'));
    expect(s.sim.enterableFor(p)).toBeNull();
    expect(s.sim.enterVehicle(p, b)).toBe(false);
    b.damage(1000);
    s.sim.damageVehicle(b, 500, p.id);
    expect(b.health).toBe(b.spec.health);
    expect(b.fire).toBe(-1);
    expect(b.burstTyres()).toBe(false);
    // flying at someone: they're nudged aside, not knocked down
    const ped = new Ped('civ', 0, 0, 1);
    const ball = new Vehicle('ball', 0.5, 0, 0, '#fff');
    ball.vx = 15;
    const phys = new VehiclePhysics();
    phys.rehash([ball]);
    let knocked = 0;
    pedContact(ped, phys.hash, [], 0.05, { runOver: () => knocked++, tramHit: () => {} });
    expect(knocked).toBe(0);
    expect(Math.hypot(ped.x - ball.x, ped.y - ball.y)).toBeGreaterThanOrEqual(0.8 + ped.r - 1e-6);
  });

  it('goes over the wire as a kind of its own, the last one, which a client from before reads as a sedan', () => {
    expect(VEHICLE_KINDS[VEHICLE_KINDS.length - 1]).toBe('ball');
    // (the kinds before it keep their numbers)
    expect(VEHICLE_KINDS.indexOf('policeboat')).toBe(12);
    const w = new Writer(64);
    encodeSnapshotHeader(w, 1, 0, 0, { health: 100, armor: 0, wanted: 0, state: 'play', stateTimer: 0, searching: false, shotCops: false, money: 0, ammo: [0, 0, 0], epoch: 0, zone: null });
    w.u16(1);
    const b = new Vehicle('ball', 12.5, -3.25, 0, '#fafafa');
    b.id = 77;
    b.mission = true;
    b.vx = 9;
    entityHead(w, b.id, Ent.Vehicle, true, 0);
    vehicleStatic(w, b, false);
    vehicleDynamic(w, b);
    w.u16(0);
    const bytes = w.finish();
    const snap = decodeSnapshot(new Reader(bytes));
    const e = snap.ents[0];
    expect(e.type === Ent.Vehicle && e.v.kind).toBe('ball');
    expect(e.type === Ent.Vehicle && e.v.vx).toBeCloseTo(9, 1);
    // an older client's list stops at the police boat: the ball's index isn't in it
    const old = VEHICLE_KINDS.slice(0, 13);
    expect(old[VEHICLE_KINDS.indexOf('ball')] ?? 'sedan').toBe('sedan');
  });
});

describe('Vydrž do 95. minúty: the match', () => {
  it('gives the player a car on the pitch and kicks off once they\'re in it; the ball waits on the centre spot', () => {
    const s = setupMini(3);
    const p = addPlayer(s.sim, 'aupark');
    const r = s.mini.start(p, 'football')!;
    s.mini.go(p);
    run(s.sim, 3.2);
    expect(r.phase).toBe('live');
    const g = game(s, p);
    expect(g.stage).toBe('warm');
    // alone: England, 1:0 up, a keeper and two strikers
    expect(g.mode).toBe('eng');
    expect(g.score).toEqual([1, 0]);
    expect(g.bots.map((b) => b.role)).toEqual(['gk', 'att', 'att']);
    const car = g.cars.get(p.id)!;
    expect(s.sim.vehicles).toContain(car);
    expect(car.reservedFor).toBe(p.id);
    expect(g.f.on(car.x, car.y)).toBe(true);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.marks!.find((m) => m.arrow)?.e).toBe(car.id);
    expect(lastMini(s.priv, p.id)!.goal).toContain('príď tam');
    standAt(p, car.x + 3, car.y);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.goal).toBe('Nasadni do auta na ihrisku (F).');
    s.sim.enterVehicle(p, car);
    run(s.sim, 0.2);
    expect(g.stage).toBe('kick');
    expect(g.ball.kinematic).toBe(true);
    expect(Math.hypot(g.f.lx(g.ball.x, g.ball.y), g.f.ly(g.ball.x, g.ball.y))).toBeLessThan(0.01);
    run(s.sim, 3.2);
    expect(g.stage).toBe('play');
    expect(g.ball.kinematic).toBe(false);
    expect(messages(s.priv, p.id)).toContain('90. minúta, vedieš 1:0 s Anglickom. Vydrž do 95.!');
  });

  it('no show: a player who never gets to the pitch gets nothing', () => {
    const s = setupMini(3);
    const p = addPlayer(s.sim, 'aupark');
    const r = s.mini.start(p, 'football')!;
    s.mini.go(p);
    runUntil(s, 3.2 + 260, () => r.phase === 'done');
    expect(lastMini(s.priv, p.id)!.result).toMatchObject({ text: 'Na zápas si neprišiel – rozhodca zapísal kontumáciu.', pay: 0 });
    expect(miniPay(s.priv, p.id)).toBe(0);
  });

  it('a goal once all of the ball is over the line between the posts: it counts, the scorer is credited, and play restarts from the centre', () => {
    const s = setupMini(4);
    const p = addPlayer(s.sim, 'aupark');
    const g = kickOff(s, p);
    const q = g.f.p, car = p.ped.vehicle!;
    // the ball just short of England's goal line is no goal yet
    place(g, q.hl + 0.5, 0);
    run(s.sim, 0.1);
    expect(g.score).toEqual([1, 0]);
    // the player's car drives it in from 6 m out
    place(g, q.hl - 6, 0);
    park(g, car, q.hl - 10, 0);
    run(s.sim, 2.5, () => {
      benchBots(g);
      car.setControls(0.6, 0);
    });
    expect(g.score).toEqual([2, 0]);
    expect(messages(s.priv, p.id).join(' ')).toContain('GÓÓÓL! Dal si ho! SVK 2:0 ENG');
    expect(g.stage === 'goal' || g.stage === 'kick').toBe(true);
    // (the player's car back in its own half, out of the NPC cars' way)
    run(s.sim, 3.5, () => {
      park(g, car, -q.hl * 0.5, 0);
      car.setControls(0, 0, true);
    });
    expect(g.stage).toBe('kick');
    expect(Math.hypot(g.f.lx(g.ball.x, g.ball.y), g.f.ly(g.ball.x, g.ball.y))).toBeLessThan(0.01);
    // the NPC cars are back on their spots
    for (const b of g.bots) expect(Math.hypot(g.f.lx(b.v.x, b.v.y) - b.hx, g.f.ly(b.v.x, b.v.y) - b.hy)).toBeLessThan(0.5);
  });

  it('alone against England: keeping the ball away from your goal until 95:00 wins (and your goal pays extra)', () => {
    const s = setupMini(5);
    const p = addPlayer(s.sim, 'eurovea');
    const g = kickOff(s, p);
    const q = g.f.p;
    // a goal of the player's own first (2:0: an England car's touch on the way in doesn't take it
    // away), then the ball held deep in England's half
    place(g, q.hl + 2, 0);
    g.ball.vx = g.ball.vy = 0;
    (s.mini.gameOf(p) as unknown as { touched: unknown }).touched = [{ pid: p.id, t: s.sim.time - 0.5 }, { pid: 0, t: s.sim.time }];
    run(s.sim, 0.1);
    expect(g.score).toEqual([2, 0]);
    expect(messages(s.priv, p.id).join(' ')).toContain('GÓÓÓL! Dal si ho! SVK 2:0 ENG');
    run(s.sim, MATCH_S + 10, () => {
      if (g.stage === 'play') place(g, q.hl * 0.6, q.hw * 0.7);
    });
    const res = lastMini(s.priv, p.id)!.result!;
    expect(res.text).toContain('Slovensko je vo štvrťfinále!');
    expect(res.pay).toBe(PAY_WIN + PAY_GOAL);
    expect(miniPay(s.priv, p.id)).toBe(PAY_WIN + PAY_GOAL);
  });

  it('alone against England: an equaliser is Bellingham in the 95th minute', () => {
    const s = setupMini(6);
    const p = addPlayer(s.sim, 'aupark');
    const g = kickOff(s, p);
    place(g, -g.f.p.hl + 4, 0, -12, 0);
    run(s.sim, 1.5);
    expect(g.score).toEqual([1, 1]);
    const res = lastMini(s.priv, p.id)!.result!;
    expect(res.text).toContain('Bellingham v 95. minúte');
    expect(res.pay).toBe(PAY_LOSS);
  });

  it('the bicycle kick, late on, flies at the goal from range: into an empty one, or off a car in its way', () => {
    for (const blocked of [false, true]) {
      const s = setupMini(7);
      const p = addPlayer(s.sim, 'aupark');
      const g = kickOff(s, p);
      const q = g.f.p, car = p.ped.vehicle!;
      // held away until it's on
      const r = s.mini.roundOf(p)!;
      runUntil(s, MATCH_S, () => r.phase === 'done', () => {
        if (g.clock < g.noz.at) place(g, q.hl * 0.5, 0);
        else if (g.noz.state === 'wait' || g.noz.state === 'wind') place(g, -q.hl + 18, 1);
        benchBots(g);
        if (blocked) park(g, car, -q.hl + 2, 0, Math.PI / 2);
        else park(g, car, q.hl * 0.5, -q.hw * 0.8);
      });
      expect(messages(s.priv, p.id)).toContain('Bellingham sa rozbieha na nožničky! Postav sa do cesty!');
      const res = lastMini(s.priv, p.id)!.result!;
      if (blocked) {
        expect(messages(s.priv, p.id)).toContain('Zablokované! Celé Slovensko dýcha.');
        expect(res.text).toContain('Slovensko je vo štvrťfinále!');
        expect(miniPay(s.priv, p.id)).toBe(PAY_WIN);
      } else {
        expect(g.score).toEqual([1, 1]);
        expect(res.text).toContain('Bellingham');
        expect(miniPay(s.priv, p.id)).toBe(PAY_LOSS);
      }
    }
  });

  it('England\'s strikers go for an empty goal, and don\'t get stuck on the way', () => {
    const s = setupMini(8);
    const p = addPlayer(s.sim, 'eurovea');
    const g = kickOff(s, p);
    const car = p.ped.vehicle!;
    run(s.sim, 60, () => {
      park(g, car, 0, g.f.p.hw + 14);
    });
    expect(g.score[1]).toBe(1);
    expect(messages(s.priv, p.id).join(' ')).toContain('Gól… SVK 1:1 ENG');
  });

  it('alone against Germany (every other round): they defend, and two goals (more than theirs) win it', () => {
    const s = setupMini(9);
    const p = addPlayer(s.sim, 'aupark');
    p.profile.stats = { mini_football: 1 };
    const g = kickOff(s, p);
    expect(g.mode).toBe('ger');
    expect(g.score).toEqual([0, 0]);
    expect(g.bots.every((b) => b.role !== 'att')).toBe(true);
    const q = g.f.p;
    place(g, q.hl + 2, 0);
    run(s.sim, 0.1);
    expect(g.score).toEqual([1, 0]);
    run(s.sim, 6.5);
    expect(g.stage).toBe('play');
    // Germany levels (a clearance that rolls all the way): two goals still win it, as long as they're more
    place(g, -q.hl - 2, 0);
    run(s.sim, 0.1);
    expect(g.score).toEqual([1, 1]);
    run(s.sim, 6.5);
    expect(g.stage).toBe('play');
    expect(lastMini(s.priv, p.id)!.goal).toBe('Ešte jeden gól – a je to doma!');
    place(g, q.hl + 2, 1);
    run(s.sim, 0.1);
    const res = lastMini(s.priv, p.id)!.result!;
    expect(res.text).toContain('2:1 s Nemeckom!');
    expect(res.pay).toBe(PAY_WIN);
  });

  it('with others: two teams by joining order, NPC cars to even them up; two goals win, the winners are paid more', () => {
    const s = setupMini(10, 'server');
    const a = addPlayer(s.sim, 'eurovea', 'Fero');
    const b = addPlayer(s.sim, 'eurovea', 'Jana');
    const c = addPlayer(s.sim, 'eurovea', 'Miro');
    const g = kickOff(s, a, [b, c]);
    expect(g.mode).toBe('group');
    // Fero and Miro play for SVK, Jana for ENG with an NPC striker
    expect(g.bots.map((x) => [x.team, x.role])).toEqual([[1, 'att']]);
    expect(g.cars.get(a.id)!.color).toBe(g.cars.get(c.id)!.color);
    expect(g.cars.get(b.id)!.color).not.toBe(g.cars.get(a.id)!.color);
    expect(g.score).toEqual([0, 0]);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, a.id)!.board).toEqual([['SVK', 0], ['ENG', 0]]);
    for (let i = 0; i < GROUP_GOALS; i++) {
      run(s.sim, 7, () => g.stage === 'play' || benchBots(g));
      expect(g.stage).toBe('play');
      place(g, -g.f.p.hl - 2, 0);
      run(s.sim, 0.1);
    }
    expect(g.score).toEqual([0, 2]);
    expect(lastMini(s.priv, b.id)!.result).toMatchObject({ text: 'Vyhrali ste 2:0!', pay: PAY_TEAM_WIN, place: 1 });
    expect(lastMini(s.priv, a.id)!.result).toMatchObject({ text: 'Prehrali ste 0:2.', pay: PAY_TEAM_LOSS });
    expect(s.globals.find((e) => e.k === 'miniResult')).toMatchObject({ kind: 'football', winner: 'Jana', n: 3 });
  });

  it('with others: a team that walks off loses by forfeit', () => {
    const s = setupMini(11, 'server');
    const a = addPlayer(s.sim, 'eurovea', 'Fero');
    const b = addPlayer(s.sim, 'eurovea', 'Jana');
    kickOff(s, a, [b]);
    s.mini.leave(b);
    run(s.sim, 0.2);
    expect(lastMini(s.priv, a.id)!.result).toMatchObject({ text: 'Súper ušiel z ihriska – kontumačne 3:0.', pay: PAY_TEAM_WIN });
  });

  it('leaves nothing behind: no ball, no NPC cars, no car nobody took; the car a player sits in is theirs, an ordinary car again', () => {
    const s = setupMini(12);
    const p = addPlayer(s.sim, 'aupark');
    const g = kickOff(s, p);
    const car = p.ped.vehicle!, ball = g.ball, bots = g.bots.map((b) => b.v);
    place(g, -g.f.p.hl - 2, 0);
    run(s.sim, 0.2);
    expect(s.mini.roundOf(p)?.phase).toBe('done');
    run(s.sim, DONE_S + 0.5);
    expect(s.mini.all.length).toBe(0);
    expect(s.sim.vehicles).not.toContain(ball);
    for (const v of bots) expect(s.sim.vehicles).not.toContain(v);
    expect(s.sim.vehicles.some((v) => v.spec.ball)).toBe(false);
    expect(p.ped.vehicle).toBe(car);
    expect(s.sim.vehicles).toContain(car);
    expect(car.mission).toBe(false);
    expect(car.livery).toBe(0);
    expect(car.reservedFor).toBe(0);
  });

  it('a spare car goes too, and so does the pitch\'s stray parked car', () => {
    const s = setupMini(13);
    const p = addPlayer(s.sim, 'aupark');
    const r = s.mini.start(p, 'football')!;
    s.mini.go(p);
    run(s.sim, 3.2);
    const g = game(s, p);
    const spare = g.cars.get(p.id)!;
    // a car parked on the pitch (the city parks on a lot all the time) goes once nobody sees it
    const stray = new Vehicle('sedan', g.f.wx(5, 5), g.f.wy(5, 5), 0, '#263238');
    stray.parked = true;
    s.sim.addVehicle(stray);
    run(s.sim, 1.2);
    expect(s.sim.vehicles).not.toContain(stray);
    s.mini.leave(p);
    expect(r.players.length).toBe(0);
    expect(s.sim.vehicles).not.toContain(spare);
    expect(s.sim.vehicles.some((v) => v.spec.ball)).toBe(false);
  });
});
