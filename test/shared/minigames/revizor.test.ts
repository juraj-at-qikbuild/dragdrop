// Revízor (games/revizor.ts, docs/plans/minigames.md): a target stop 1–2 km along the tracks and
// inspectors at stops on the way; the round's own trams come to where the player waits and run to
// the target; an inspector boards at their stop and checks the player a few seconds later (€79),
// goes after one who got off, and gives up on one who ran; walking doesn't count; the výluka moves
// the target; with others, dodgers against player inspectors (aboard together, or on foot); and
// everything the round put in the city goes when it ends.
import { describe, expect, it } from 'vitest';
import { Tram } from '../../../src/shared/entities/Tram';
import { Vehicle } from '../../../src/shared/entities/Vehicle';
import type { Ped } from '../../../src/shared/entities/Ped';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { dist } from '../../../src/shared/util/math';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { FINE } from '../../../src/shared/sim/rules/minigames/games/revizor';
import {
  Ways, leftHand, linksAt, nearestStop, platform, pointAt, sameStop, stopAt, stopsOn, trackAhead,
} from '../../../src/shared/sim/rules/minigames/games/tramline';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';
import { board, go, tramsOf } from './tramkit';

/** the game's insides, as the tests look at them */
interface Game {
  start0: number;
  target0: number;
  closed: number;
  vyluka: boolean;
  npcs: { ped: Ped; home: number; state: string; check: number }[];
  runs: { t: Tram; own: boolean; to: number }[];
  riders: Map<number, { role: string; target: number; ridden: number; board: { i: number } | null; catches: number; caught: number }>;
  rest(run: unknown): unknown[];
  despawn(o: unknown): void;
  pointsOf(p: SimPlayer): number;
}

function solo(at: string, seed = 3, money = 200) {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, at, 'A', money);
  startLive(s, p, 'revizor');
  const g = s.mini.gameOf(p) as unknown as Game;
  g.vyluka = false;
  return { s, p, g, w: s.sim.world };
}

/** the city's inspectors go home (a ride with nobody checking) */
function noInspectors(g: Game) {
  for (const n of g.npcs) g.despawn(n.ped);
  g.npcs.length = 0;
}

/** `p` waits on the platform of stop `at` (the round's start by default) until one of the round's
 *  trams stands at the platform they're to board at, and gets on it */
function waitAndBoard(s: MiniSetup, p: SimPlayer, g: Game, at = g.start0): Tram {
  const pl = platform(s.sim.world, at);
  standAt(p, pl.x, pl.y);
  const r = g.riders.get(p.id)!;
  let t: Tram | null = null;
  go(s, 150, () => {
    const run = r.board && g.runs.find((q) => q.t.dwell > 0.3 && stopAt(s.sim.world, q.t.x, q.t.y) === r.board!.i);
    if (run && board(s, p, run.t)) t = run.t;
    return !!t;
  });
  if (!t) throw new Error('no tram of the round came');
  return t;
}

/** ride on until the tram stands at the rider's target, and get off there (whether they did) */
function rideToTarget(s: MiniSetup, p: SimPlayer, g: Game, secs = 420) {
  const w = s.sim.world, r = g.riders.get(p.id)!;
  const off = go(s, secs, () => {
    const t = p.ped.aboard;
    return !!t && t.dwell > 0.3 && sameStop(w, stopAt(w, t.x, t.y), r.target) && tramsOf(s).act(p, 'off');
  });
  go(s, 0.3);
  return off;
}

describe('Revízor alone', () => {
  it('takes a target 1–2 km along the tracks from the stop nearest, with inspectors at stops on the way', () => {
    for (const at of ['kamenne', 'snpsquare', 'oldbridge']) {
      const { s, p, g, w } = solo(at);
      const S = w.tramStops;
      expect(sameStop(w, g.start0, nearestStop(w, p.ped.x, p.ped.y, 600))).toBe(true);
      const lens = linksAt(w, g.start0)
        .filter(({ l }) => !leftHand(w, l))
        .map(({ l, s: from }) => new Ways(w, l, from, 2500).at.get(g.target0)?.len ?? Infinity);
      expect(lens.some((len) => len >= 1000 && len <= 2000)).toBe(true);
      expect(g.npcs.length).toBeGreaterThan(0);
      for (const n of g.npcs) {
        expect(sameStop(w, n.home, g.start0) || sameStop(w, n.home, g.target0)).toBe(false);
        expect(dist(n.ped.x, n.ped.y, S[n.home], S[n.home + 1])).toBeLessThan(9);
      }
      run(s.sim, 0.3);
      const marks = lastMini(s.priv, p.id)!.marks!;
      expect(marks.find((m) => m.icon === '🏁')?.label).toContain('cieľ');
      expect(marks.filter((m) => m.arrow).length).toBe(1);
      expect(marks.filter((m) => m.icon === '🎫').length).toBe(g.npcs.length);
    }
  });

  it('won\'t start far from the tracks', () => {
    const s = setupMini(1);
    const p = addPlayer(s.sim, 'aupark');
    expect(s.mini.start(p, 'revizor')).toBeNull();
    expect(messages(s.priv, p.id).slice(-1)[0]).toContain('električky nechodia');
  });

  it('a tram of the round comes to the stop, runs to the target, and getting off there pays by the stops ridden', () => {
    const { s, p, g, w } = solo('kamenne');
    noInspectors(g);
    const t = waitAndBoard(s, p, g);
    expect(g.runs.find((q) => q.t === t)?.own).toBe(true);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.goal).toContain('Vez sa do zastávky');
    // it runs to the target, whatever it would have picked at the junctions itself
    expect(trackAhead(w, t, 3000, 0, g.rest(g.runs[0]) as never).stops.some((q) => sameStop(w, q.i, g.target0))).toBe(true);
    expect(rideToTarget(s, p, g)).toBe(true);
    const res = lastMini(s.priv, p.id)!.result!;
    expect(res.text).toContain('Si v cieli');
    expect(g.riders.get(p.id)!.ridden).toBeGreaterThanOrEqual(3);
    expect(res.pay).toBeGreaterThanOrEqual(150);
    expect(res.pay).toBeLessThanOrEqual(250);
    expect(miniPay(s.priv, p.id)).toBe(res.pay);
  });

  it('an inspector boards at their stop, and a few seconds later it\'s a €79 fine', () => {
    const { s, p, g } = solo('oldbridge');
    waitAndBoard(s, p, g);
    go(s, 300, () => s.mini.roundOf(p)?.phase !== 'live');
    expect(messages(s.priv, p.id)).toContain('Revízor nastupuje! Vystúp, kým ťa skontroluje!');
    const res = lastMini(s.priv, p.id)!.result!;
    expect(res.text).toBe(`Pokuta ${FINE} €. Revízor s kamerou si ťa natočil.`);
    expect(res.pay).toBe(0);
    expect(p.profile.money).toBe(200 - FINE);
  });

  /** ride until an inspector comes aboard where the tram stands, and get off */
  function offAsTheInspectorBoards(s: MiniSetup, p: SimPlayer, g: Game) {
    waitAndBoard(s, p, g);
    const got = go(s, 300, () => {
      const t = p.ped.aboard;
      return !!t && t.speed < 0.5 && g.npcs.some((n) => n.state === 'board' || n.state === 'aboard') && tramsOf(s).act(p, 'off');
    });
    expect(got).toBe(true);
    expect(p.ped.aboard).toBeNull();
  }

  it('one who gets off before the check is followed on foot, and caught standing there', () => {
    const { s, p, g } = solo('oldbridge');
    offAsTheInspectorBoards(s, p, g);
    go(s, 20, () => s.mini.roundOf(p)?.phase !== 'live');
    expect(messages(s.priv, p.id)).toContain('Revízor ťa videl vystúpiť – bež!');
    expect(lastMini(s.priv, p.id)!.result!.text).toContain(`Pokuta ${FINE} €`);
  });

  it('...but gives up on one who runs, and goes back to their stop', () => {
    const { s, p, g, w } = solo('oldbridge');
    offAsTheInspectorBoards(s, p, g);
    const n = g.npcs.find((q) => q.state === 'chase' || q.state === 'aboard' || q.state === 'board')!;
    // off at a sprint, far out of reach
    const away = w.walkableNear(p.ped.x + (p.ped.x - n.ped.x) * 20, p.ped.y + (p.ped.y - n.ped.y) * 20);
    go(s, 0.5);
    standAt(p, away.x, away.y);
    go(s, 16);
    expect(s.mini.roundOf(p)?.phase).toBe('live');
    expect(messages(s.priv, p.id)).toContain('Revízor to vzdal. Na kamere si len rozmazaný fľak.');
    expect(['back', 'wait']).toContain(n.state);
    expect(p.profile.money).toBe(200);
  });

  it('an inspector knocked off their feet is up again after a few seconds, back at their stop', () => {
    const { s, g } = solo('oldbridge');
    const n = g.npcs[0];
    const spot = { x: n.ped.x, y: n.ped.y };
    // (whatever knocked them over: they're not walking or standing)
    n.ped.state = 'sit';
    go(s, 3);
    expect(n.ped.state).toBe('sit');
    go(s, 6);
    expect(['idle', 'walk']).toContain(n.ped.state);
    go(s, 5);
    expect(n.state).toBe('wait');
    expect(dist(n.ped.x, n.ped.y, spot.x, spot.y)).toBeLessThan(1);
  });

  it('walking there doesn\'t count: a stop or two ridden isn\'t enough', () => {
    const { s, p, g, w } = solo('kamenne');
    noInspectors(g);
    // the stop just before the target on the way there
    let before = -1;
    for (const { l, s: from } of linksAt(w, g.start0)) {
      const ways = new Ways(w, l, from, 2500);
      const way = ways.to(g.target0);
      if (!way || leftHand(w, l)) continue;
      for (const link of [l, ...way]) for (const o of stopsOn(w, link)) if (!sameStop(w, o.i, g.target0) && !sameStop(w, o.i, g.start0)) before = o.i;
    }
    expect(before).toBeGreaterThanOrEqual(0);
    waitAndBoard(s, p, g, before);
    rideToTarget(s, p, g);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Pešo sa to neráta'))).toBe(true);
    expect(s.mini.roundOf(p)?.phase).toBe('live');
  });

  it('the výluka moves the target on, and there it still counts', () => {
    const { s, p, g } = solo('kamenne');
    noInspectors(g);
    g.vyluka = true;
    const old = g.target0;
    waitAndBoard(s, p, g);
    go(s, 300, () => g.closed >= 0);
    expect(g.closed).toBe(old);
    expect(messages(s.priv, p.id)).toContain('Výluka! Náhradná doprava nejazdí.');
    run(s.sim, 0.3);
    const marks = lastMini(s.priv, p.id)!.marks!;
    expect(marks.find((m) => m.icon === '🚧')).toBeTruthy();
    expect(sameStop(s.sim.world, g.riders.get(p.id)!.target, old)).toBe(false);
    expect(rideToTarget(s, p, g)).toBe(true);
    expect(lastMini(s.priv, p.id)!.result!.text).toContain('Si v cieli');
  });

  it('takes a tram of the city\'s coming the other way off the track ahead, and turns one the player boards onto the way', () => {
    const { s, p, g, w } = solo('kamenne');
    noInspectors(g);
    const t = waitAndBoard(s, p, g);
    // a tram of the city's nose to nose on the rail 150 m ahead, where nobody sees it
    const ahead = trackAhead(w, t, 400, 0, g.rest(g.runs[0]) as never);
    let acc = 0, link = ahead.links[0];
    for (const l of ahead.links) {
      link = l;
      acc += l.edge.len;
      if (acc > 200) break;
    }
    const back = w.tram.out[link.to].find((l) => l.edge === link.edge)!;
    const other = s.sim.addTram(new Tram(w.tram, back, s.sim.rng, w.tramStops));
    go(s, 1.5);
    expect(s.sim.trams.includes(other)).toBe(false);
    // the player gets off where the tram stands next, and onto one of the city's there
    go(s, 200, () => !!p.ped.aboard && p.ped.aboard.dwell > 0.3 && tramsOf(s).act(p, 'off'));
    const at = stopAt(w, t.x, t.y);
    const links = linksAt(w, at);
    const city = s.sim.addTram(new Tram(w.tram, links[0].l, s.sim.rng, w.tramStops));
    city.dwell = 20;
    expect(board(s, p, city)).toBe(true);
    go(s, 1);
    expect(g.runs.find((q) => q.t === city)?.own).toBe(false);
  });

  it('a car of the city\'s parked on the track in front of the round\'s tram is towed', () => {
    const { s, p, g, w } = solo('kamenne');
    noInspectors(g);
    const t = waitAndBoard(s, p, g);
    // wait till it's under way, then a car stands on the rail 40 m in front of it
    go(s, 60, () => t.speed > 8);
    const ahead = pointAt(trackAhead(w, t, 80, 0, g.rest(g.runs[0]) as never).pts, 40);
    const car = s.sim.addVehicle(new Vehicle('sedan', ahead.x, ahead.y, ahead.a, '#888'));
    car.parked = true;
    car.level = t.level;
    go(s, 15, () => !s.sim.vehicles.includes(car));
    expect(s.sim.vehicles.includes(car)).toBe(false);
    expect(messages(s.priv, p.id)).toContain('Odťahovka odtiahla auto z koľají. Konečne.');
  });

  it('when it\'s over, its trams and inspectors are gone from the city', () => {
    const { s, p, g } = solo('oldbridge');
    waitAndBoard(s, p, g);
    go(s, 300, () => s.mini.roundOf(p)?.phase !== 'live');
    const trams = g.runs.filter((q) => q.own).map((q) => q.t);
    const peds = g.npcs.map((n) => n.ped);
    expect(peds.length).toBeGreaterThan(0);
    go(s, DONE_S + 0.5);
    expect(s.mini.all.length).toBe(0);
    for (const t of trams) expect(s.sim.trams.includes(t) && !p.ped.aboard).toBe(false);
    for (const n of peds) expect(s.sim.peds.includes(n)).toBe(false);
  });
});

describe('Revízor with others', () => {
  function group(n: number, seed = 5) {
    const s = setupMini(seed, 'server');
    const ps = ['Fero', 'Jana', 'Mišo', 'Zuza'].slice(0, n).map((nick) => addPlayer(s.sim, 'kamenne', nick, 200));
    const r = s.mini.start(ps[0], 'revizor')!;
    for (const q of ps.slice(1)) expect(s.mini.join(q, r.id)).toBe(true);
    s.mini.go(ps[0]);
    run(s.sim, 3.2);
    return { s, ps, g: s.mini.gameOf(ps[0]) as unknown as Game };
  }

  it('splits the players: one inspector for every two or three, never the starter', () => {
    const three = group(3);
    expect(three.ps.map((p) => three.g.riders.get(p.id)!.role)).toEqual(['dodger', 'inspector', 'dodger']);
    expect(messages(three.s.priv, three.ps[1].id)).toContain('Si revízor! Chyť čiernych pasažierov – pokuta ide tebe.');
    const four = group(4);
    expect(four.ps.map((p) => four.g.riders.get(p.id)!.role)).toEqual(['dodger', 'inspector', 'dodger', 'inspector']);
    // no inspectors of the city's: it's the players
    expect(four.g.npcs.length).toBe(0);
  });

  it('an inspector aboard the same tram for a few seconds catches the dodger: the fine is theirs', () => {
    const { s, ps, g } = group(2);
    const [a, b] = ps;
    const t = waitAndBoard(s, a, g);
    expect(board(s, b, t)).toBe(true);
    go(s, 5.5);
    expect(messages(s.priv, b.id)).toContain('Chytil si Fero! Pokuta 79 € je tvoja.');
    expect(a.profile.money).toBe(200 - FINE);
    expect(g.pointsOf(b)).toBe(80);
    // once caught, not again straight away
    go(s, 6);
    expect(g.riders.get(a.id)!.caught).toBe(1);
    // the round's time runs out: the inspector keeps the fine
    go(s, 250, () => s.mini.roundOf(a)?.phase !== 'live');
    expect(lastMini(s.priv, b.id)!.result!.pay).toBe(80);
    expect(lastMini(s.priv, b.id)!.result!.text).toContain('Chytil si 1×');
  });

  it('...or on foot, right after the dodger got off', () => {
    const { s, ps, g } = group(2, 6);
    const [a, b] = ps;
    const t = waitAndBoard(s, a, g);
    expect(board(s, b, t)).toBe(true);
    go(s, 1);
    // both off before the check (the tram's still at the stop), side by side
    expect(tramsOf(s).act(b, 'off')).toBe(true);
    expect(tramsOf(s).act(a, 'off')).toBe(true);
    standAt(b, a.ped.x + 1, a.ped.y);
    go(s, 0.3);
    expect(g.riders.get(b.id)!.catches).toBe(1);
    expect(messages(s.priv, a.id)).toContain(`Revízor Jana ťa chytil! Pokuta ${FINE} €, a je to na kamere.`);
  });

  it('a dodger scores the stops ridden and the target reached, then gets a new one', () => {
    const { s, ps, g } = group(2, 7);
    const [a, b] = ps;
    // the inspector's somewhere else
    standAt(b, b.ped.x + 400, b.ped.y);
    const r = g.riders.get(a.id)!;
    const first = r.target;
    waitAndBoard(s, a, g);
    rideToTarget(s, a, g);
    expect(r.ridden).toBeGreaterThanOrEqual(3);
    expect(g.pointsOf(a)).toBe(10 * r.ridden + 60);
    expect(sameStop(s.sim.world, r.target, first)).toBe(false);
    expect(messages(s.priv, a.id).some((m) => m.startsWith('V cieli! +60 bodov.'))).toBe(true);
  });
});
