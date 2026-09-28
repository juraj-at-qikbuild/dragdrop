// Horúčava (games/heat.ts, docs/plans/minigames.md): ice cream from Stará tržnica to customers at cafés
// and bistros 300–900 m away before it melts, and the player's own heat: up in the sun (faster on
// Námestie SNP, the asphalt sea, and running), down in the shade, at a drinking fountain, in the
// Primate's Palace and aboard a tram whose air conditioning works (a coin flip per tram); fainting at the
// top; the pay by deliveries and tips; with others, who delivers most; and nothing left behind.
import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/shared/util/math';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { FAR_R, PAY_CONE, TIP, tramAc, type Env } from '../../../src/shared/sim/rules/minigames/games/heat';
import type { MiniState } from '../../../src/shared/sim/rules/minigames/types';
import { Tram } from '../../../src/shared/entities/Tram';
import { Vehicle } from '../../../src/shared/entities/Vehicle';
import type { Ped } from '../../../src/shared/entities/Ped';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';

/** the round's game, as far as the tests look into it */
interface HeatGame {
  seed: number;
  pickup: { x: number; y: number };
  cool: { drink: number[]; mist: number[]; palace: { x: number; y: number; dx: number; dy: number }; snp: { lx: number; ly: number } };
  customers: { x: number; y: number; ped: Ped }[];
  state: Map<number, { heat: number; cones: number[]; delivered: number }>;
  envOf(p: SimPlayer): Env;
}
const game = (s: MiniSetup, p: SimPlayer) => s.mini.gameOf(p) as unknown as HeatGame;
const me = (s: MiniSetup, p: SimPlayer) => game(s, p).state.get(p.id)!;

function state(s: MiniSetup, p: SimPlayer): MiniState {
  run(s.sim, 0.3);
  return lastMini(s.priv, p.id)!;
}

/** a round at Stará tržnica */
function atMarket(seed = 1, mode: 'offline' | 'server' = 'offline') {
  const s = setupMini(seed, mode);
  const p = addPlayer(s.sim, 'market');
  startLive(s, p, 'heat');
  return { s, p, g: game(s, p) };
}

/** somewhere near the market where `p` would be in `env`: on the walking paths, or under a tree */
function spotWith(s: MiniSetup, p: SimPlayer, env: Env): { x: number; y: number } {
  const w = s.sim.world, g = game(s, p);
  const at = { x: p.ped.x, y: p.ped.y };
  const cands: { x: number; y: number }[] = [];
  for (const n of w.ped.nodesAround(g.pickup.x, g.pickup.y, 20, 400)) cands.push({ x: w.ped.nx(n), y: w.ped.ny(n) });
  for (let i = 0; i < w.trees.length; i += 4) if (dist(w.trees[i], w.trees[i + 1], g.pickup.x, g.pickup.y) < 400) cands.push({ x: w.trees[i] + 0.8, y: w.trees[i + 1] });
  for (const c of cands) {
    standAt(p, c.x, c.y);
    if (g.envOf(p) === env) {
      standAt(p, at.x, at.y);
      return c;
    }
  }
  throw new Error(`nowhere ${env}`);
}

/** how much the heat changes over `secs` at (x, y), from `from` (running at `speed` m/s) */
function heatOver(s: MiniSetup, p: SimPlayer, at: { x: number; y: number }, secs: number, from = 0.3, speed = 0) {
  const st = me(s, p);
  standAt(p, at.x, at.y);
  st.heat = from;
  run(s.sim, secs, () => {
    p.ped.vx = speed;
    p.ped.x = at.x;
  });
  return st.heat - from;
}

describe('Horúčava', () => {
  it('starts at Stará tržnica: the counter, customers 300–900 m away, the cooling spots around', () => {
    const { s, p, g } = atMarket(1);
    const st = state(s, p);
    expect(st.phase).toBe('live');
    expect(st.left).toBeGreaterThan(235);
    expect(st.goal).toBe('Vyzdvihni zmrzlinu v Starej tržnici.');
    expect(st.bar!.label).toBe('Prehriatie');
    expect(st.bar!.v).toBeGreaterThan(0.19);
    expect(st.act).toBe('Vziať zmrzlinu');
    const m = st.marks!;
    const counter = m.find((x) => x.icon === '🍦')!;
    expect(counter.arrow).toBe(1);
    const market = s.sim.world.landmark('market');
    expect(dist(counter.x, counter.y, market.x, market.y)).toBeLessThan(40);
    const customers = m.filter((x) => x.icon === '🙋');
    expect(customers.length).toBe(2);
    for (const c of customers) {
      const d = dist(c.x, c.y, g.pickup.x, g.pickup.y);
      expect(d).toBeGreaterThanOrEqual(299);
      expect(d).toBeLessThanOrEqual(901);
      expect(c.e).toBeGreaterThan(0);
    }
    // the drinking fountains around, the palace, and the asphalt sea
    const drinking = m.filter((x) => x.icon === '❄️');
    expect(drinking.length).toBeGreaterThan(0);
    for (const d of drinking) expect(dist(d.x, d.y, p.ped.x, p.ped.y)).toBeLessThanOrEqual(251);
    expect(m.some((x) => x.icon === '🏛️')).toBe(true);
    expect(m.find((x) => x.icon === '🔥')!.poly!.length).toBeGreaterThanOrEqual(8);
    expect(m.length).toBeLessThan(40);
  });

  it('the heat: up in the sun, faster on the asphalt sea and running, down in the shade, at a drinking fountain and in the palace', () => {
    const { s, p, g } = atMarket(2);
    const sun = spotWith(s, p, 'sun');
    const inSun = heatOver(s, p, sun, 10);
    expect(inSun).toBeCloseTo(10 / 150, 2);
    expect(heatOver(s, p, sun, 10, 0.3, 7)).toBeGreaterThan(inSun * 1.5);
    // Námestie SNP: the asphalt sea
    const snp = { x: g.cool.snp.lx, y: g.cool.snp.ly };
    standAt(p, snp.x, snp.y);
    expect(g.envOf(p)).toBe('snp');
    expect(heatOver(s, p, snp, 10)).toBeGreaterThan(inSun * 2);
    expect(messages(s.priv, p.id)).toContain('Námestie SNP: asfaltové more, 60 °C!');
    expect(lastMini(s.priv, p.id)!.stats![2]).toEqual(['Tu', '60 °C']);
    // cooler: the shade, a drinking fountain, the palace's courtyard
    expect(heatOver(s, p, spotWith(s, p, 'shade'), 5, 0.6)).toBeLessThan(-0.1);
    const fountain = { x: g.cool.drink[0], y: g.cool.drink[1] };
    standAt(p, fountain.x, fountain.y);
    expect(g.envOf(p)).toBe('drink');
    expect(heatOver(s, p, fountain, 2, 0.8)).toBeLessThan(-0.45);
    const palace = { x: g.cool.palace.x, y: g.cool.palace.y };
    standAt(p, palace.x, palace.y);
    expect(g.envOf(p)).toBe('palace');
    expect(heatOver(s, p, palace, 3, 0.6)).toBeLessThan(-0.45);
    expect(messages(s.priv, p.id)).toContain('V Primaciálnom paláci je chládok. 🏛️');
    // and its gateway from Primaciálne námestie
    standAt(p, g.cool.palace.dx, g.cool.palace.dy);
    expect(g.envOf(p)).toBe('palace');
    // the city's mist sprayers on the squares (Hlavné, Kamenné, Hviezdoslavovo)
    expect(g.cool.mist.length).toBe(6);
    const kamenne = { x: g.cool.mist[2], y: g.cool.mist[3] };
    standAt(p, kamenne.x, kamenne.y);
    expect(g.envOf(p)).toBe('mist');
    expect(heatOver(s, p, kamenne, 3, 0.6)).toBeLessThan(-0.45);
    expect(messages(s.priv, p.id)).toContain('Rozprašovač! Chladná hmla. 💦');
  });

  it('delivers: two cones at the counter, one to a customer, paid with a tip for a cold one', () => {
    const { s, p, g } = atMarket(3);
    s.mini.act(p);
    expect(me(s, p).cones).toEqual([1, 1]);
    expect(s.priv.some(([id, e]) => id === p.id && e.k === 'style' && e.label === '🍦🍦 a rýchlo!')).toBe(true);
    let st = state(s, p);
    expect(st.goal).toBe('Doruč zmrzlinu zákazníkovi, kým sa neroztopí!');
    // the arrow is on the nearest customer now
    const target = st.marks!.find((m) => m.arrow)!;
    expect(target.icon).toBe('🙋');
    const c = g.customers.find((q) => q.ped.id === target.e)!;
    const before = new Set(g.customers.map((q) => q.ped));
    standAt(p, c.x + 2, c.y);
    st = state(s, p);
    expect(st.act).toBe('Podať zmrzlinu');
    s.mini.act(p);
    // a fresh cone (it's been out a few tenths of a second on the square) gets nearly all the tip
    expect(messages(s.priv, p.id).some((t) => /^Doručené! Tringelt €(19|20)\. 🍦$/.test(t))).toBe(true);
    st = state(s, p);
    expect(st.stats![0]).toEqual(['Doručené', '1']);
    expect(me(s, p).cones.length).toBe(1);
    // someone else wants one now, somewhere else
    expect(g.customers.length).toBe(2);
    expect(g.customers.some((q) => !before.has(q.ped))).toBe(true);
    // topping up at the counter: back to two
    standAt(p, g.pickup.x, g.pickup.y);
    expect(state(s, p).act).toBe('Doplniť zmrzlinu');
    s.mini.act(p);
    expect(me(s, p).cones.length).toBe(2);
    // the round's time runs out (kept cool): paid for the one delivered, and its tip
    const st0 = me(s, p);
    run(s.sim, 240, () => (st0.heat = 0.3));
    const r = lastMini(s.priv, p.id)!;
    expect(r.phase).toBe('done');
    expect(r.result!.text).toMatch(/^Doručil si 1 zmrzlinu, tringelt €(19|20)\.$/);
    expect(r.result!.pay).toBeGreaterThanOrEqual(PAY_CONE + TIP - 1);
    expect(miniPay(s.priv, p.id)).toBe(r.result!.pay);
  });

  it('melts: faster in the sun than in the shade, in a car too; melted is lost', () => {
    const { s, p } = atMarket(4);
    s.mini.act(p);
    const st = me(s, p);
    const melt = (at: { x: number; y: number }) => {
      standAt(p, at.x, at.y);
      st.cones = [1];
      st.heat = 0.3;
      run(s.sim, 10);
      return 1 - st.cones[0];
    };
    const sun = melt(spotWith(s, p, 'sun'));
    const shade = melt(spotWith(s, p, 'shade'));
    expect(sun).toBeCloseTo(10 / 130, 2);
    expect(shade).toBeLessThan(sun * 0.6);
    // no car has air conditioning
    const at = spotWith(s, p, 'sun');
    const car = new Vehicle('hatch', at.x, at.y, 0, '#fff');
    s.sim.addVehicle(car);
    standAt(p, at.x + 1, at.y);
    expect(s.sim.enterVehicle(p, car)).toBe(true);
    expect(game(s, p).envOf(p)).toBe('car');
    expect(melt(at)).toBeGreaterThan(sun * 0.9);
    s.sim.exitVehicle(p, true);
    // nearly gone: it's lost
    standAt(p, at.x, at.y);
    st.cones = [0.02];
    run(s.sim, 3);
    expect(st.cones.length).toBe(0);
    expect(messages(s.priv, p.id)).toContain('Zmrzlina sa roztopila… 🫠');
  });

  it('faints at the top: the ice cream in hand is gone, and they come round dizzy; the wobble grows with the heat', () => {
    const { s, p } = atMarket(5);
    s.mini.act(p);
    const st = me(s, p);
    st.heat = 0.9;
    let v = state(s, p);
    expect(v.x!.wobble).toBeGreaterThan(0.4);
    expect(v.x!.wobble).toBeLessThan(1);
    expect(v.goal).toBe('Prehrievaš sa! Rýchlo do tieňa, k pítku alebo fontáne.');
    st.heat = 0.999;
    run(s.sim, 0.5);
    expect(messages(s.priv, p.id)).toContain('Odpadol si od horúčavy! 🥵 Zmrzlina skončila na dlažbe.');
    expect(st.cones).toEqual([]);
    expect(st.heat).toBeLessThan(0.52);
    v = state(s, p);
    expect(v.x!.wobble).toBe(1);
    expect(v.goal).toBe('Točí sa ti hlava… Chvíľu to potrvá.');
    // it passes
    run(s.sim, 8.5, () => (st.heat = 0.3));
    expect(state(s, p).x!.wobble).toBe(0);
    // still in the round, and on with the job
    expect(lastMini(s.priv, p.id)!.phase).toBe('live');
  });

  it("trams: the air conditioning is a coin flip per tram — 'Klíma ide!' cools, 'Vyhňa…' cooks", () => {
    const { s, p, g } = atMarket(6);
    const w = s.sim.world;
    const trams: Tram[] = [];
    for (let i = 0; i < w.tramStops.length && trams.length < 12; i += 2)
      for (const n of w.tram.nodesAround(w.tramStops[i], w.tramStops[i + 1], 0, 40)) {
        const link = w.tram.out[n]?.[0];
        if (!link) continue;
        const t = new Tram(w.tram, link, s.sim.rng, w.tramStops);
        s.sim.addTram(t);
        trams.push(t);
        break;
      }
    const cool = trams.find((t) => tramAc(t.id, g.seed))!, hot = trams.find((t) => !tramAc(t.id, g.seed))!;
    expect(cool).toBeTruthy();
    expect(hot).toBeTruthy();
    // the same tram, the same answer
    expect(tramAc(cool.id, g.seed)).toBe(true);
    const st = me(s, p);
    p.ped.aboard = cool;
    st.heat = 0.6;
    run(s.sim, 3);
    expect(st.heat).toBeLessThan(0.45);
    expect(messages(s.priv, p.id)).toContain('Klíma ide! ❄️');
    p.ped.aboard = hot;
    st.heat = 0.3;
    run(s.sim, 5);
    expect(st.heat - 0.3).toBeGreaterThan((5 / 150) * 1.5);
    expect(messages(s.priv, p.id)).toContain('Vyhňa… klíma v tejto električke nejde. 🔥');
    expect(lastMini(s.priv, p.id)!.stats![2]).toEqual(['Tu', '45 °C']);
    p.ped.aboard = null;
  });

  it('with others: whoever delivers most wins', () => {
    const s = setupMini(7, 'server');
    const a = addPlayer(s.sim, 'market', 'Fero');
    const b = addPlayer(s.sim, 'market', 'Jana');
    const r = s.mini.start(a, 'heat')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = game(s, a);
    // one customer more than the players
    expect(g.customers.length).toBe(3);
    const deliver = (p: SimPlayer) => {
      standAt(p, g.pickup.x, g.pickup.y);
      s.mini.act(p);
      const c = g.customers[0];
      standAt(p, c.x, c.y);
      s.mini.act(p);
    };
    deliver(a);
    deliver(a);
    deliver(b);
    expect(lastMini(s.priv, a.id)).toBeTruthy();
    run(s.sim, 240, () => {
      for (const p of [a, b]) {
        const st = g.state.get(p.id);
        if (st) st.heat = 0.3;
      }
    });
    const ra = lastMini(s.priv, a.id)!.result!, rb = lastMini(s.priv, b.id)!.result!;
    expect(ra.place).toBe(1);
    expect(rb.place).toBe(2);
    expect(ra.text).toMatch(/^Doručil si 2 zmrzliny/);
    expect(rb.text).toMatch(/^Doručil si 1 zmrzlinu/);
    expect(ra.pay).toBeGreaterThan(rb.pay + PAY_CONE);
    expect(lastMini(s.priv, a.id)!.board!.map(([n, v]) => [n, v])).toEqual([['Fero', 2], ['Jana', 1]]);
  });

  it('does not start far from the market, and leaves nothing behind', () => {
    const s = setupMini(8);
    const far = addPlayer(s.sim, { x: -1500, y: 900 });
    const m = s.sim.world.landmark('market');
    expect(dist(far.ped.x, far.ped.y, m.x, m.y)).toBeGreaterThan(FAR_R);
    expect(s.mini.start(far, 'heat')).toBeNull();
    expect(messages(s.priv, far.id)).toContain('Zmrzlinu rozvážame zo Starej tržnice – príď bližšie do centra.');

    const { s: s2, p, g } = atMarket(9);
    const peds = g.customers.map((c) => c.ped);
    expect(peds.every((q) => s2.sim.peds.includes(q))).toBe(true);
    const st = me(s2, p);
    run(s2.sim, 240 + DONE_S + 1, () => (st.heat = 0.3));
    expect(s2.mini.gameOf(p)).toBeNull();
    expect(peds.some((q) => s2.sim.peds.includes(q))).toBe(false);
    expect(s2.sim.peds.filter((q) => q.kinematic && !q.playerId).length).toBe(0);
  });
});
