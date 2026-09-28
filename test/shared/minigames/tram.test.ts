// Električkár (games/tram.ts, docs/plans/minigames.md): a tram waits at the stop nearest the player
// (the cab is no crime); the next stop on a "metro interval", served stopped at it with the doors
// open, late or gone past; a car on the track moved by its driver after the bell, by the tow truck
// after twenty seconds, or pushed aside for the damage; the second player's tow truck tows at once;
// six stops, and the pay; and the tram and the cars leave the city when it's over.
import { describe, expect, it } from 'vitest';
import type { Tram } from '../../../src/shared/entities/Tram';
import type { Vehicle } from '../../../src/shared/entities/Vehicle';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { dist } from '../../../src/shared/util/math';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { AT_STOP, DAMAGE, STOPS, TOW_S } from '../../../src/shared/sim/rules/minigames/games/tram';
import { nearestStop, pointAt, sameStop, stopAt, trackAhead } from '../../../src/shared/sim/rules/minigames/games/tramline';
import { Ped } from '../../../src/shared/entities/Ped';
import { addPlayer, lastMini, messages, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';
import { go, tramsOf } from './tramkit';

/** the game's insides, as the tests look at them */
interface Game {
  tram: Tram;
  own: boolean;
  phase: string;
  next: { i: number; due: number; d: number } | null;
  done: number;
  onTime: number;
  tardy: number;
  skipped: number;
  hits: number;
  tally: number;
  cars: { v: Vehicle; state: string }[];
  van: Vehicle | null;
  ahead: { stops: { i: number; d: number }[] } | null;
  junction(t: Tram): { d: number; dir: number } | null;
  blocking(): { v: Vehicle; state: string }[];
  placeCar(t: Tram): void;
}

function shift(at: string, seed = 4) {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, at, 'A', 100);
  startLive(s, p, 'tram');
  return { s, p, g: s.mini.gameOf(p) as unknown as Game };
}

/** `p` at the tram's nose, and into its cab */
function intoCab(s: MiniSetup, p: SimPlayer, g: Game) {
  const t = g.tram;
  standAt(p, t.x + Math.cos(t.angle) * 1.2, t.y + Math.sin(t.angle) * 1.2);
  p.ped.level = t.level;
  expect(tramsOf(s).act(p, 'cab')).toBe(true);
  go(s, 0.3);
}

type Cars = 'bell' | 'wait' | 'push';

/** One step of a careful driver: on to the next stop (steering at a junction where the view says),
 *  braking to stop right at it (or, `stop` false, straight past it); a car on the track: stopped
 *  short of it and the bell rung (`bell`), stopped short and waiting (`wait`), or straight on
 *  into it (`push`). */
function drive(s: MiniSetup, p: SimPlayer, g: Game, o: { stop?: boolean; cars?: Cars } = {}) {
  const t = g.tram, S = s.sim.world.tramStops, n = g.next;
  let d = Infinity, bell = false;
  if (n && o.stop !== false) d = g.ahead?.stops.find((q) => q.i === n.i)?.d ?? (dist(t.x, t.y, S[n.i], S[n.i + 1]) <= AT_STOP ? 0 : Infinity);
  const car = g.blocking()[0];
  if (car && o.cars !== 'push') {
    const dc = dist(t.x, t.y, car.v.x, car.v.y);
    d = Math.min(d, Math.max(0, dc - 12));
    bell = o.cars === 'bell' && car.state === 'parked' && t.speed < 0.5 && dc < 25;
  }
  const brake = (t.speed * t.speed) / 6;
  const throttle = d - 1 <= brake + 0.5 ? -1 : t.speed < 12 ? 1 : 0;
  tramsOf(s).drive(p, throttle, n ? (g.junction(t)?.dir ?? 0) : 0, bell);
}

function driveUntil(s: MiniSetup, p: SimPlayer, g: Game, secs: number, until: () => boolean, o: { stop?: boolean; cars?: Cars } = {}) {
  return go(s, secs, () => {
    drive(s, p, g, o);
    return until();
  });
}

/** serve stops until the next one is far enough ahead for a car before it, and put one there */
function carAhead(s: MiniSetup, p: SimPlayer, g: Game) {
  driveUntil(s, p, g, 300, () => !!g.next && g.next.d > 230 && g.tram.speed < 0.5);
  g.placeCar(g.tram);
  expect(g.cars.length).toBe(1);
  return g.cars[0];
}

describe('Električkár', () => {
  it('puts a tram at the stop nearest the player, its doors open, waiting for its driver: the cab is no crime', () => {
    for (const at of ['kamenne', 'snpsquare', 'oldbridge']) {
      const { s, p, g } = shift(at);
      const w = s.sim.world, t = g.tram;
      expect(s.sim.trams.includes(t)).toBe(true);
      expect(t.speed).toBe(0);
      expect(t.dwell).toBeGreaterThan(1e8);
      const i = stopAt(w, t.x, t.y, 1.5);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(sameStop(w, i, nearestStop(w, p.ped.x, p.ped.y, 700))).toBe(true);
      run(s.sim, 0.3);
      const st = lastMini(s.priv, p.id)!;
      expect(st.goal).toBe('Nastúp do kabíny električky – F pri jej čele.');
      expect(st.marks!.find((m) => m.arrow)?.icon).toBe('🚋');
      intoCab(s, p, g);
      expect(p.wanted).toBe(0);
      expect(g.phase).toBe('run');
      expect(g.next).not.toBeNull();
      expect(lastMini(s.priv, p.id)!.stats![0]).toEqual(['Zastávka', `1/${STOPS}`]);
    }
  });

  it('won\'t start far from the tracks', () => {
    const s = setupMini(1);
    const p = addPlayer(s.sim, 'slavin');
    expect(s.mini.start(p, 'tram')).toBeNull();
    expect(messages(s.priv, p.id).slice(-1)[0]).toContain('električky nechodia');
  });

  it('stopped at the next stop, the doors open for 3 s: on time pays, and on to the one after', () => {
    const { s, p, g } = shift('kamenne');
    intoCab(s, p, g);
    const first = g.next!.i;
    expect(driveUntil(s, p, g, 120, () => g.done === 1)).toBe(true);
    expect(messages(s.priv, p.id)).toContain('Dvere sa otvárajú…');
    expect(messages(s.priv, p.id).some((m) => m.includes('– načas! +€'))).toBe(true);
    expect(g.onTime).toBe(1);
    expect(g.tally).toBeGreaterThanOrEqual(25);
    expect(g.tally).toBeLessThanOrEqual(40);
    expect(g.next && !sameStop(s.sim.world, g.next.i, first)).toBe(true);
  });

  it('late, it pays less; gone past without stopping, it costs', () => {
    const { s, p, g } = shift('oldbridge');
    intoCab(s, p, g);
    // held at the stop until the interval's over
    const due = g.next!.due;
    go(s, due - s.sim.time + 1, () => void tramsOf(s).drive(p, -1, 0, false));
    driveUntil(s, p, g, 150, () => g.done === 1);
    expect(g.tardy).toBe(1);
    expect(g.tally).toBe(10);
    expect(messages(s.priv, p.id).some((m) => m.includes('meškáš'))).toBe(true);
    // straight past the next one
    driveUntil(s, p, g, 150, () => g.done === 2, { stop: false, cars: 'bell' });
    expect(g.skipped).toBe(1);
    expect(g.tally).toBe(10 - 30);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Zastávku') && m.includes('si prešiel'))).toBe(true);
  });

  it('a car on the track: ring the bell near it and its driver comes and drives it off', () => {
    const { s, p, g } = shift('kamenne');
    intoCab(s, p, g);
    const c = carAhead(s, p, g);
    expect(messages(s.priv, p.id)).toContain('Auto na koľajniciach! Zvoň (H), odťahovka (B), alebo ho odtlač – škoda 150 €.');
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.marks!.some((m) => m.e === c.v.id && m.icon === '🚗')).toBe(true);
    driveUntil(s, p, g, 60, () => c.state === 'bell', { cars: 'bell' });
    expect(messages(s.priv, p.id)).toContain('Crnk-crnk! Vodič beží k autu…');
    driveUntil(s, p, g, 12, () => c.state === 'away', { cars: 'bell' });
    expect(messages(s.priv, p.id)).toContain('Vodič odparkoval. Môžeš ísť!');
    driveUntil(s, p, g, 20, () => !s.sim.vehicles.includes(c.v));
    expect(s.sim.vehicles.includes(c.v)).toBe(false);
    expect(g.hits).toBe(0);
  });

  it('...or call the tow truck (B): it takes twenty seconds', () => {
    const { s, p, g } = shift('kamenne');
    intoCab(s, p, g);
    const c = carAhead(s, p, g);
    driveUntil(s, p, g, 60, () => g.tram.speed < 0.1 && dist(g.tram.x, g.tram.y, c.v.x, c.v.y) < 40, { cars: 'wait' });
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.act).toBe(`Zavolať odťahovku (${TOW_S} s)`);
    s.mini.act(p);
    expect(c.state).toBe('tow');
    driveUntil(s, p, g, TOW_S - 1, () => false, { cars: 'wait' });
    expect(s.sim.vehicles.includes(c.v)).toBe(true);
    driveUntil(s, p, g, 2, () => false, { cars: 'wait' });
    expect(s.sim.vehicles.includes(c.v)).toBe(false);
    expect(messages(s.priv, p.id)).toContain('Odťahovka odviezla auto. Koľaj je voľná.');
  });

  it('...or push on through it: the damage is the driver\'s', () => {
    const { s, p, g } = shift('kamenne');
    intoCab(s, p, g);
    const c = carAhead(s, p, g);
    const before = g.tally;
    driveUntil(s, p, g, 60, () => c.state === 'hit', { cars: 'push' });
    expect(g.hits).toBe(1);
    expect(g.tally).toBe(before - DAMAGE);
    expect(messages(s.priv, p.id)).toContain(`Bum! Škoda na aute ${DAMAGE} €.`);
    // it's gone once it's out of sight
    driveUntil(s, p, g, 20, () => !s.sim.vehicles.includes(c.v));
    expect(s.sim.vehicles.includes(c.v)).toBe(false);
  });

  it('with a second player: their tow truck tows a car at once, and the two share the pay', () => {
    const s = setupMini(4, 'server');
    const a = addPlayer(s.sim, 'kamenne', 'Fero', 100);
    const b = addPlayer(s.sim, 'kamenne', 'Jana', 100);
    const r = s.mini.start(a, 'tram')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = s.mini.gameOf(a) as unknown as Game;
    expect(g.van).not.toBeNull();
    expect(messages(s.priv, b.id)).toContain('Si odťahovka! Sadni do dodávky a čisti koľajnice pred električkou.');
    intoCab(s, a, g);
    const c = carAhead(s, a, g);
    // the tow truck pulls up by the car
    const van = g.van!;
    van.x = c.v.x + Math.cos(c.v.angle + Math.PI / 2) * 4;
    van.y = c.v.y + Math.sin(c.v.angle + Math.PI / 2) * 4;
    standAt(b, van.x + 1, van.y);
    expect(s.sim.enterVehicle(b, van, 5)).toBe(true);
    go(s, 0.3);
    expect(lastMini(s.priv, b.id)!.act).toBe('Odtiahnuť auto');
    const tally = g.tally;
    s.mini.act(b);
    expect(s.sim.vehicles.includes(c.v)).toBe(false);
    expect(g.tally).toBe(tally + 15);
    expect(messages(s.priv, a.id).some((m) => m.startsWith('Odtiahnuté!'))).toBe(true);
    driveUntil(s, a, g, 400, () => s.mini.roundOf(a)?.phase !== 'live', { cars: 'bell' });
    const ra = lastMini(s.priv, a.id)!.result!, rb = lastMini(s.priv, b.id)!.result!;
    expect(ra.pay).toBeGreaterThan(0);
    expect(rb.pay).toBe(ra.pay);
    expect(rb.text).toBe(ra.text);
  });

  it('six stops make the shift: paid by the stops on time, with the bonuses; then the tram and the cars go', () => {
    const { s, p, g } = shift('oldbridge');
    intoCab(s, p, g);
    driveUntil(s, p, g, 400, () => s.mini.roundOf(p)?.phase !== 'live', { cars: 'bell' });
    expect(g.done).toBe(STOPS);
    const res = lastMini(s.priv, p.id)!.result!;
    expect(res.text).toContain('Koniec smeny:');
    expect(res.pay).toBeGreaterThanOrEqual(g.onTime * 25);
    expect(res.pay).toBeLessThanOrEqual(STOPS * 40 + 70);
    expect(p.wanted).toBe(0);
    const t = g.tram;
    const cars = g.cars.map((c) => c.v);
    go(s, DONE_S + 0.5);
    expect(s.mini.all.length).toBe(0);
    expect(s.sim.trams.includes(t)).toBe(false);
    expect(p.ped.aboard).toBeNull();
    for (const v of cars) expect(s.sim.vehicles.includes(v)).toBe(false);
  });

  it('people on the track step off it as the tram comes: no one\'s run over', () => {
    const { s, p, g } = shift('kamenne');
    intoCab(s, p, g);
    driveUntil(s, p, g, 30, () => g.tram.speed > 8);
    const t = g.tram;
    const at = pointAt(trackAhead(s.sim.world, t, 60).pts, 30);
    const civ = s.sim.addPed(new Ped('civ', at.x, at.y, 11));
    civ.level = t.level;
    civ.levelInit = true;
    civ.state = 'idle';
    go(s, 6, () => void tramsOf(s).drive(p, 1, 0, false));
    expect(p.wanted).toBe(0);
    expect(s.sim.peds.includes(civ)).toBe(true);
    expect(['idle', 'walk']).toContain(civ.state);
  });

  it('out of the cab mid-run, the tram waits for its driver', () => {
    const { s, p, g } = shift('kamenne');
    intoCab(s, p, g);
    driveUntil(s, p, g, 120, () => g.done === 1);
    expect(tramsOf(s).act(p, 'off')).toBe(true);
    const t = g.tram, x = t.x, y = t.y;
    go(s, 20);
    expect(dist(t.x, t.y, x, y)).toBeLessThan(0.5);
    expect(messages(s.priv, p.id)).toContain('Vráť sa do kabíny (F pri čele električky)!');
    intoCab(s, p, g);
    driveUntil(s, p, g, 120, () => g.done === 2, { cars: 'bell' });
    expect(g.done).toBe(2);
  });
});
