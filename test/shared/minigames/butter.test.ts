// AKCIA! Maslo (games/butter.ts, docs/plans/minigames.md): the sale is at a real grocery near the start;
// the grannies at its door let you through with a "Prepáčte, prosím!" (or an elbow); ten blocks a visit
// at €1.49, charged at once; the grannies buy too, so the stock runs out; buyers around the city pay
// about €4, and the sales are paid when the round ends; the butter melts, faster in a car; with others
// it's one stock and the best profit wins; everything the round put in the city goes with it.
import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/shared/util/math';
import { Vehicle } from '../../../src/shared/entities/Vehicle';
import { BONUS, DOOR_R, GROCERS, HEAT_S, LIMIT, SQUEEZE_S, eur } from '../../../src/shared/sim/rules/minigames/games/butter';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';

interface Butter {
  shop: { name: string; x: number; y: number; sx: number; sy: number; ux: number; uy: number };
  stock: number;
  stockAtStart: number;
  grannies: { ped: { x: number; y: number; archetype: string; id: number } }[];
  buyers: { ped: { id: number }; x: number; y: number; want: number; price: number; until: number }[];
  of(p: SimPlayer): { carried: number; heat: number; melted: number; sold: number; revenue: number; bought: number; spent: number; visit: number; inside: boolean };
}

const game = (s: MiniSetup, p: SimPlayer) => s.mini.gameOf(p) as unknown as Butter;

/** a round of butter for a player at landmark `at` */
function butter(at = 'main', seed = 3, money = 200) {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, at, 'A', money);
  startLive(s, p, 'butter');
  return { s, p, g: game(s, p) };
}

/** stand `p` just outside the shop's door, among the grannies */
function toDoor(s: MiniSetup, p: SimPlayer, g: Butter, back = 4) {
  standAt(p, g.shop.x - g.shop.ux * back, g.shop.y - g.shop.uy * back);
  run(s.sim, 0.3);
}

/** "Prepáčte, prosím!" until past the grannies (an elbow can send them back a time or two) */
function squeezeIn(s: MiniSetup, p: SimPlayer, g: Butter) {
  for (let i = 0; i < 5 && !g.of(p).inside; i++) {
    s.mini.act(p);
    run(s.sim, SQUEEZE_S + 0.2);
  }
  expect(g.of(p).inside).toBe(true);
}

function buy(s: MiniSetup, p: SimPlayer, n: number) {
  for (let i = 0; i < n; i++) {
    s.mini.act(p);
    run(s.sim, 0.05);
  }
}

/** step until the round is over (the result on screen) */
function runToEnd(s: MiniSetup, p: SimPlayer) {
  for (let i = 0; i < 300 && s.mini.roundOf(p)?.phase === 'live'; i++) run(s.sim, 1);
  expect(lastMini(s.priv, p.id)!.phase).toBe('done');
}

/** the buyer nearest `p` still wanting some */
function nearestBuyer(p: SimPlayer, g: Butter) {
  return [...g.buyers].filter((b) => b.want > 0).sort((a, b) => dist(a.x, a.y, p.ped.x, p.ped.y) - dist(b.x, b.y, p.ped.x, p.ped.y))[0];
}

describe('AKCIA! Maslo', () => {
  it('puts the sale at a real grocery a few hundred metres away, the grannies at its door and buyers around', () => {
    const w = setupMini(1).sim.world;
    for (const at of ['main', 'kamenne', 'eurovea']) {
      const { s, p, g } = butter(at);
      const start = w.walkableNear(w.landmark(at).x, w.landmark(at).y);
      expect(GROCERS).toContain(g.shop.name);
      // the door is a real shop's, on the pavement in front of it
      expect(w.pois('shop').some((q) => q.n === g.shop.name && dist(q.x, q.y, g.shop.x, g.shop.y) < 36)).toBe(true);
      const d = dist(g.shop.x, g.shop.y, start.x, start.y);
      expect(d).toBeGreaterThan(250);
      expect(d).toBeLessThan(950);
      const st = lastMini(s.priv, p.id)!;
      expect(st.phase).toBe('live');
      const shopMark = st.marks!.find((m) => m.icon === '🧈')!;
      expect(shopMark.label).toContain(g.shop.name);
      expect(shopMark.arrow).toBe(1);
      expect(st.goal).toContain('€1,49');
      // the grannies crowd the door
      expect(g.grannies.length).toBe(6);
      for (const gr of g.grannies) {
        expect(gr.ped.archetype).toBe('elderly');
        expect(dist(gr.ped.x, gr.ped.y, g.shop.x, g.shop.y)).toBeLessThan(3.5);
      }
      // buyers around the city, a few hundred metres off
      const buyers = st.marks!.filter((m) => m.icon === '💰');
      expect(buyers.length).toBe(4);
      for (const b of buyers) expect(dist(b.x, b.y, g.shop.x, g.shop.y)).toBeGreaterThan(150);
      expect(st.stats).toContainEqual(['Sklad', '40']);
    }
  });

  it('the grannies are in the way: "Prepáčte, prosím!" gets you to the counter, walking off does not', () => {
    const { s, p, g } = butter();
    toDoor(s, p, g);
    let st = lastMini(s.priv, p.id)!;
    expect(st.act).toBe('Prepáčte, prosím!');
    expect(st.goal).toContain('Babky pri dverách');
    const money = p.profile.money;
    // the key starts the squeeze, it doesn't buy anything
    s.mini.act(p);
    run(s.sim, 0.5);
    expect(p.profile.money).toBe(money);
    expect(g.of(p).inside).toBe(false);
    // walked off halfway: still outside
    standAt(p, g.shop.x - g.shop.ux * (DOOR_R + 5), g.shop.y - g.shop.uy * (DOOR_R + 5));
    run(s.sim, SQUEEZE_S + 0.3);
    expect(g.of(p).inside).toBe(false);
    toDoor(s, p, g);
    squeezeIn(s, p, g);
    run(s.sim, 0.3);
    st = lastMini(s.priv, p.id)!;
    expect(st.act).toBe('Kúpiť maslo (€1,49)');
    expect(messages(s.priv, p.id)).toContain('Si pri pulte! Limit 10 ks na osobu.');
  });

  it('an elbow sends some back out, but not for ever', () => {
    let elbowed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { s, p, g } = butter('main', seed);
      toDoor(s, p, g);
      squeezeIn(s, p, g);
      if (messages(s.priv, p.id).some((m) => m.includes('Loket do rebier'))) elbowed++;
    }
    expect(elbowed).toBeGreaterThan(0);
    expect(elbowed).toBeLessThan(12);
  });

  it('ten blocks a visit at €1,49, charged at once (the till rounds the total), and not one more', () => {
    const { s, p, g } = butter();
    toDoor(s, p, g);
    squeezeIn(s, p, g);
    const money = p.profile.money, stock = g.stock;
    buy(s, p, 1);
    expect(p.profile.money).toBe(money - 1);
    buy(s, p, 1);
    expect(p.profile.money).toBe(money - 3);
    buy(s, p, LIMIT - 2);
    // 10 × €1.49 = €14.90
    expect(p.profile.money).toBe(money - 15);
    expect(g.of(p).carried).toBe(LIMIT);
    expect(g.stock).toBe(stock - LIMIT);
    buy(s, p, 1);
    expect(messages(s.priv, p.id)).toContain('Limit 10 ks na osobu! Vyjdi von a postav sa znova.');
    expect(p.profile.money).toBe(money - 15);
    expect(g.of(p).carried).toBe(LIMIT);
    run(s.sim, 0.3);
    const st = lastMini(s.priv, p.id)!;
    expect(st.act).toBeUndefined();
    expect(st.stats).toContainEqual(['Limit', '10/10']);
    // out and back in again past the grannies: another ten
    standAt(p, g.shop.x - g.shop.ux * 14, g.shop.y - g.shop.uy * 14);
    run(s.sim, 0.5);
    expect(g.of(p).inside).toBe(false);
    toDoor(s, p, g);
    squeezeIn(s, p, g);
    buy(s, p, LIMIT);
    expect(g.of(p).carried).toBe(LIMIT * 2);
    expect(p.profile.money).toBe(money - 30);
  });

  it('no money, no butter', () => {
    const { s, p, g } = butter('main', 3, 0);
    toDoor(s, p, g);
    squeezeIn(s, p, g);
    buy(s, p, 1);
    expect(messages(s.priv, p.id)).toContain('Nemáš ani na maslo v akcii.');
    expect(g.of(p).carried).toBe(0);
  });

  it('the grannies buy too, and the stock runs out', () => {
    const { s, p, g } = butter();
    const stock = g.stock;
    run(s.sim, 60);
    // one goes off with her butter every quarter of a minute or so, and another one comes
    expect(g.stock).toBeLessThan(stock - 2);
    expect(g.grannies.length).toBeGreaterThanOrEqual(6);
    toDoor(s, p, g);
    squeezeIn(s, p, g);
    g.stock = 2;
    buy(s, p, 3);
    expect(g.of(p).carried).toBe(2);
    expect(messages(s.priv, p.id)).toContain('Vypredané! Babky boli rýchlejšie.');
    run(s.sim, 0.3);
    expect(messages(s.priv, p.id)).toContain('Vypredané! Rýchlejšie ako dubajská čokoláda.');
    const st = lastMini(s.priv, p.id)!;
    expect(st.marks!.find((m) => m.icon === '🧈')!.dim).toBe(1);
  });

  it('sells to a buyer at their price, and the sales are paid when the round is over', () => {
    const { s, p, g } = butter();
    toDoor(s, p, g);
    squeezeIn(s, p, g);
    buy(s, p, 6);
    const spent = g.of(p).spent;
    // with butter in the bag, the way is to a buyer
    standAt(p, g.shop.x - g.shop.ux * 15, g.shop.y - g.shop.uy * 15);
    run(s.sim, 0.3);
    let st = lastMini(s.priv, p.id)!;
    const arrow = st.marks!.find((m) => m.arrow)!;
    expect(arrow.icon).toBe('💰');
    const b = nearestBuyer(p, g);
    const want = b.want, price = b.price;
    standAt(p, b.x + 1, b.y);
    run(s.sim, 0.3);
    st = lastMini(s.priv, p.id)!;
    const n = Math.min(want, 6);
    expect(st.act).toBe(`Predať ${n} ks (${eur(price)}/ks)`);
    const money = p.profile.money;
    s.mini.act(p);
    expect(g.of(p).carried).toBe(6 - n);
    expect(g.of(p).revenue).toBe(n * price);
    // not paid yet: at the end
    expect(p.profile.money).toBe(money);
    // the rest to the next buyers, and the shelf empties: nothing more to do, it's over
    for (let i = 0; i < 4 && g.of(p).carried > 0; i++) {
      const c = nearestBuyer(p, g);
      standAt(p, c.x + 1, c.y);
      run(s.sim, 0.3);
      s.mini.act(p);
    }
    expect(g.of(p).carried).toBe(0);
    g.stock = 0;
    run(s.sim, 0.5);
    const r = lastMini(s.priv, p.id)!;
    expect(r.phase).toBe('done');
    const rev = g.of(p).revenue;
    expect(r.result!.pay).toBe(Math.round(rev / 100 + BONUS * 6));
    expect(r.result!.text).toContain('Predal si 6 kociek');
    expect(r.result!.text).toContain(`zisk ${eur(rev - spent * 100)}`);
    expect(miniPay(s.priv, p.id)).toBe(r.result!.pay);
    expect(p.profile.money).toBe(money + r.result!.pay);
  });

  it('melts in the sun on foot, and three times as fast in a car', () => {
    const carry = (inCar: boolean) => {
      const { s, p, g } = butter('main', 5);
      toDoor(s, p, g);
      squeezeIn(s, p, g);
      buy(s, p, LIMIT);
      // out on the pavement, away from the shop's fridges (a few steps from a buyer, not selling)
      const b = nearestBuyer(p, g);
      const at = { x: b.x + 6, y: b.y };
      standAt(p, at.x, at.y);
      if (inCar) {
        const v = s.sim.addVehicle(new Vehicle('sedan', at.x, at.y, 0, '#1565c0'));
        expect(s.sim.enterVehicle(p, v, 5)).toBe(true);
      }
      run(s.sim, 60);
      return { s, p, g, st: lastMini(s.priv, p.id)! };
    };
    const foot = carry(false);
    expect(foot.g.of(foot.p).melted).toBe(0);
    expect(foot.g.of(foot.p).heat).toBeCloseTo(60 / HEAT_S, 1);
    expect(foot.st.bar!.label).toBe('Maslo sa topí');
    expect(foot.st.goal).toContain('kým sa neroztopí');
    const car = carry(true);
    expect(car.g.of(car.p).melted).toBeGreaterThanOrEqual(3);
    expect(car.g.of(car.p).carried).toBe(LIMIT - car.g.of(car.p).melted);
    expect(car.st.goal).toContain('V aute sa maslo topí trikrát rýchlejšie');
    expect(messages(car.s.priv, car.p.id)).toContain('🫠 Kocka masla sa v aute roztopila!');
    // melted is worthless: it's simply gone from the bag
    expect(car.st.stats).toContainEqual(['Maslo', `${car.g.of(car.p).carried} ks`]);
  });

  it('with others: one stock for everyone, and the best profit wins', () => {
    const s = setupMini(7, 'server');
    const a = addPlayer(s.sim, 'main', 'Fero', 200);
    const b = addPlayer(s.sim, 'main', 'Jana', 200);
    const r = s.mini.start(a, 'butter')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = game(s, a);
    expect(game(s, b)).toBe(g);
    // a bigger stock, but one for both
    expect(g.stockAtStart).toBe(52);
    toDoor(s, a, g);
    squeezeIn(s, a, g);
    toDoor(s, b, g, 3);
    squeezeIn(s, b, g);
    const stock = g.stock;
    buy(s, a, 8);
    buy(s, b, 4);
    expect(g.stock).toBe(stock - 12);
    // Fero sells all his, Jana only some
    for (let i = 0; i < 5 && g.of(a).carried > 0; i++) {
      const c = nearestBuyer(a, g);
      standAt(a, c.x + 1, c.y);
      run(s.sim, 0.3);
      s.mini.act(a);
    }
    const c = nearestBuyer(b, g);
    standAt(b, c.x + 1, c.y);
    run(s.sim, 0.3);
    s.mini.act(b);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, a.id)!.board!.map(([n]) => n)).toEqual(['Fero', 'Jana']);
    runToEnd(s, a);
    const ra = lastMini(s.priv, a.id)!, rb = lastMini(s.priv, b.id)!;
    expect(ra.result!.place).toBe(1);
    expect(rb.result!.place).toBe(2);
    expect(miniPay(s.priv, a.id)).toBeGreaterThan(miniPay(s.priv, b.id));
  });

  it('the grannies and the buyers leave with the round', () => {
    const { s, p, g } = butter();
    expect(s.sim.peds.length).toBeGreaterThan(8);
    toDoor(s, p, g);
    squeezeIn(s, p, g);
    s.mini.leave(p);
    expect(s.mini.all.length).toBe(0);
    expect(s.sim.peds.filter((q) => !q.playerId).length).toBe(0);
    // and a round whose time runs out does the same (without the butter, the grannies won)
    const r2 = butter('kamenne', 9);
    const ours = new Set<object>();
    for (let i = 0; i < 300 && r2.s.mini.roundOf(r2.p)?.phase === 'live'; i++) {
      run(r2.s.sim, 1);
      for (const q of r2.s.sim.peds) if (q.kinematic && !q.playerId) ours.add(q);
    }
    // (the grannies come and go, the buyers too)
    expect(ours.size).toBeGreaterThan(15);
    expect(lastMini(r2.s.priv, r2.p.id)!.result!.text).toBe('K maslu si sa ani nedostal. Babky vyhrali.');
    expect(miniPay(r2.s.priv, r2.p.id)).toBe(0);
    run(r2.s.sim, DONE_S + 0.2);
    expect(r2.s.mini.all.length).toBe(0);
    // (the city's own people, which a few minutes can bring, stay)
    expect(r2.s.sim.peds.filter((q) => ours.has(q) || (q.kinematic && !q.playerId)).length).toBe(0);
    expect(lastMini(r2.s.priv, r2.p.id)).toBeNull();
  });
});
