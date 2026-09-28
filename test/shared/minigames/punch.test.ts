// Punčová cesta (games/punch.ts, docs/plans/minigames.md): the stalls stand on Hlavné and Hviezdoslavovo
// námestie (not in a building, a fountain or the road); a list of six to drink at in order; each punch
// rocks you more (x.wobble) and it wears off slowly; the pickpockets go for anyone standing about with
// a mug, and running into one gets it back; the mugs go back for their deposit; the finish pays by
// time and mugs; with others the first one through the list wins; the crowd goes with the round.
import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/shared/util/math';
import type { Ped } from '../../../src/shared/entities/Ped';
import { DEPOSIT, SAUSAGE, SAUSAGE_WOB, WOB, WOB_DECAY, marketStalls, type Stall } from '../../../src/shared/sim/rules/minigames/games/punch';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { addPlayer, lastMini, loadWorld, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';

interface Punch {
  stalls: Stall[];
  list: number[];
  pickpockets: { ped: { id: number; x: number; y: number }; mode: string; pid: number }[];
  visitors: { ped: { id: number } }[];
  of(p: SimPlayer): { step: number; mugs: number; returned: number; wob: number; done: boolean };
}

const game = (s: MiniSetup, p: SimPlayer) => s.mini.gameOf(p) as unknown as Punch;

function punch(seed = 3, money = 200) {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, 'main', 'A', money);
  startLive(s, p, 'punch');
  return { s, p, g: game(s, p) };
}

/** stand `p` at stall `st`'s counter */
function atStall(s: MiniSetup, p: SimPlayer, st: Stall) {
  standAt(p, st.x + Math.cos(st.a) * 2, st.y + Math.sin(st.a) * 2);
  run(s.sim, 0.3);
}

/** the next stall on `p`'s list, bought there */
function drinkNext(s: MiniSetup, p: SimPlayer, g: Punch) {
  atStall(s, p, g.stalls[g.list[g.of(p).step]]);
  s.mini.act(p);
  run(s.sim, 0.1);
}

const deposit = (g: Punch) => g.stalls.find((q) => q.kind === 'deposit')!;

describe('Punčová cesta', () => {
  it('sets out 10–16 stalls on the two squares, in the open: not in a building, a fountain or the road', () => {
    const w = loadWorld();
    const stalls = marketStalls(w);
    expect(stalls.length).toBeGreaterThanOrEqual(10);
    expect(stalls.length).toBeLessThanOrEqual(16);
    expect(marketStalls(w)).toBe(stalls);
    const on = new Map<string, number>();
    for (const st of stalls) {
      const sq = w.squareAt(st.x, st.y)!;
      expect(['Hlavné námestie', 'Hviezdoslavovo námestie']).toContain(sq);
      on.set(sq, (on.get(sq) ?? 0) + 1);
      expect(w.insideBuilding(st.x, st.y)).toBe(false);
      expect(w.inWater(st.x, st.y, 0)).toBe(false);
      expect(w.collideCircle(st.x, st.y, 1.5, 0, false)).toBeNull();
      expect(w.onCarriageway(st.x, st.y, 1)).toBe(false);
      for (const o of stalls) if (o !== st) expect(dist(o.x, o.y, st.x, st.y)).toBeGreaterThan(8);
    }
    expect(on.get('Hlavné námestie')).toBeGreaterThanOrEqual(5);
    expect(on.get('Hviezdoslavovo námestie')).toBeGreaterThanOrEqual(5);
    const kinds = stalls.map((q) => q.kind);
    for (const k of ['drink', 'turbo', 'food', 'tree', 'gloves'] as const) expect(kinds).toContain(k);
    expect(kinds.filter((k) => k === 'deposit').length).toBe(1);
    for (const st of stalls) if (st.kind === 'drink') expect([4, 5]).toContain(st.price);
    expect(stalls.find((q) => q.kind === 'turbo')!.price).toBeGreaterThan(5);
    // and the game shows them there
    const { s, p } = punch();
    const marks = lastMini(s.priv, p.id)!.marks!;
    for (const st of stalls) expect(marks.some((m) => m.x === st.x && m.y === st.y)).toBe(true);
  });

  it('six drinks on the list, in order: the arrow on the next one, the rest wait their turn', () => {
    const { s, p, g } = punch();
    expect(g.list.length).toBe(6);
    expect(new Set(g.list).size).toBe(6);
    for (const i of g.list) expect(['drink', 'turbo']).toContain(g.stalls[i].kind);
    // both squares on it
    expect(new Set(g.list.map((i) => g.stalls[i].sq)).size).toBe(2);
    let st = lastMini(s.priv, p.id)!;
    const first = g.stalls[g.list[0]], second = g.stalls[g.list[1]];
    const arrow = st.marks!.find((m) => m.arrow)!;
    expect([arrow.x, arrow.y]).toEqual([first.x, first.y]);
    expect(arrow.label).toContain(`1. ${first.name}`);
    // the second one first: not yet
    atStall(s, p, second);
    expect(lastMini(s.priv, p.id)!.act).toBeUndefined();
    const money = p.profile.money;
    s.mini.act(p);
    expect(messages(s.priv, p.id)).toContain('Tento je na zozname až 2. – ide sa podľa poradia!');
    expect(p.profile.money).toBe(money);
    // the first one: bought, paid, a mug
    atStall(s, p, first);
    expect(lastMini(s.priv, p.id)!.act).toBe(`Kúpiť: ${first.name} (€${first.price})`);
    s.mini.act(p);
    expect(p.profile.money).toBe(money - first.price);
    expect(g.of(p).mugs).toBe(1);
    expect(g.of(p).step).toBe(1);
    run(s.sim, 0.3);
    st = lastMini(s.priv, p.id)!;
    const next = st.marks!.find((m) => m.arrow)!;
    expect([next.x, next.y]).toEqual([second.x, second.y]);
    expect(st.stats).toContainEqual(['Stánky', '1/6']);
    expect(st.stats).toContainEqual(['Hrnčeky', '1']);
    // punch is drunk on foot
    atStall(s, p, second);
    p.ped.vehicle = {} as never;
    s.mini.act(p);
    p.ped.vehicle = null;
    expect(messages(s.priv, p.id)).toContain('Najprv vystúp – punč sa pije pešo.');
    expect(g.of(p).step).toBe(1);
  });

  it('each punch rocks you more, it wears off slowly, and a €9 sausage steadies you', () => {
    const { s, p, g } = punch(5);
    expect(lastMini(s.priv, p.id)!.x?.wobble).toBeUndefined();
    const w1 = g.stalls[g.list[0]].wob, w2 = g.stalls[g.list[1]].wob;
    drinkNext(s, p, g);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.x!.wobble).toBeCloseTo(w1, 1);
    expect(w1 === WOB || w1 === 0.2).toBe(true);
    drinkNext(s, p, g);
    const two = g.of(p).wob;
    expect(two).toBeGreaterThan(w1 + w2 - 0.03);
    run(s.sim, 30);
    expect(g.of(p).wob).toBeCloseTo(two - WOB_DECAY * 30, 2);
    expect(lastMini(s.priv, p.id)!.bar!.label).toBe('Punč v krvi');
    // the sausage
    const food = g.stalls.find((q) => q.kind === 'food')!;
    atStall(s, p, food);
    expect(lastMini(s.priv, p.id)!.act).toBe(`Kúpiť klobásu (€${SAUSAGE})`);
    const money = p.profile.money, wob = g.of(p).wob;
    s.mini.act(p);
    expect(p.profile.money).toBe(money - SAUSAGE);
    expect(g.of(p).wob).toBeCloseTo(wob - SAUSAGE_WOB, 2);
    expect(messages(s.priv, p.id)).toContain('Klobása za €9. Aspoň nie si na lačno.');
  });

  it('a pickpocket takes a mug off someone standing about, and running into him gets it back', () => {
    const { s, p, g } = punch(4);
    drinkNext(s, p, g);
    // standing still with a mug
    for (let i = 0; i < 90 && g.of(p).mugs > 0; i++) run(s.sim, 1);
    expect(g.of(p).mugs).toBe(0);
    expect(messages(s.priv, p.id)).toContain('Vreckár ti vzal hrnček! Chyť ho!');
    run(s.sim, 0.3);
    const thief = g.pickpockets.find((k) => k.mode === 'flee' && k.pid === p.id)!;
    expect(thief).toBeTruthy();
    const mark = lastMini(s.priv, p.id)!.marks!.find((m) => m.icon === '👛')!;
    expect(mark.e).toBe(thief.ped.id);
    // after him, at a run
    for (let i = 0; i < 100 && g.of(p).mugs === 0; i++) {
      const dx = thief.ped.x - p.ped.x, dy = thief.ped.y - p.ped.y, d = Math.hypot(dx, dy) || 1;
      const step = Math.min(d, 7.2 * 0.05);
      standAt(p, p.ped.x + (dx / d) * step, p.ped.y + (dy / d) * step);
      run(s.sim, 0.05);
    }
    expect(g.of(p).mugs).toBe(1);
    expect(messages(s.priv, p.id)).toContain('Máš ho! Hrnček je späť.');
  });

  it('a pickpocket knocked down drops the mug and heads home by himself', () => {
    const { s, p, g } = punch(4);
    drinkNext(s, p, g);
    for (let i = 0; i < 90 && g.of(p).mugs > 0; i++) run(s.sim, 1);
    run(s.sim, 0.3);
    const thief = g.pickpockets.find((k) => k.mode === 'flee' && k.pid === p.id)!;
    const ped = thief.ped as unknown as Ped;
    ped.knockDown(p.ped.x, p.ped.y);
    run(s.sim, 0.3);
    expect(g.of(p).mugs).toBe(1);
    expect(messages(s.priv, p.id)).toContain('Vreckár je na zemi. Hrnček je späť.');
    expect(g.pickpockets).not.toContain(thief);
    expect(ped.kinematic).toBe(false);
  });

  it('keeps moving, keeps the mug', () => {
    const { s, p, g } = punch(4);
    drinkNext(s, p, g);
    const st = g.stalls[g.list[0]];
    // strolling up and down in front of the stall
    let t = 0;
    run(s.sim, 60, () => {
      t += 0.05;
      const k = Math.sin(t * 0.5) * 8;
      standAt(p, st.x + Math.cos(st.a) * 4 - Math.sin(st.a) * k, st.y + Math.sin(st.a) * 4 + Math.cos(st.a) * k);
    });
    expect(g.of(p).mugs).toBe(1);
  });

  it('the mugs go back at the deposit stall, €2 each', () => {
    const { s, p, g } = punch(6);
    drinkNext(s, p, g);
    drinkNext(s, p, g);
    const mugs = g.of(p).mugs;
    expect(mugs).toBe(2);
    atStall(s, p, deposit(g));
    expect(lastMini(s.priv, p.id)!.act).toBe(`Vrátiť hrnčeky (+€${mugs * DEPOSIT})`);
    const money = p.profile.money;
    s.mini.act(p);
    expect(p.profile.money).toBe(money + mugs * DEPOSIT);
    expect(g.of(p).mugs).toBe(0);
    expect(g.of(p).returned).toBe(2);
    expect(messages(s.priv, p.id)).toContain('Záloha späť: €4.');
    // not over: the list isn't done
    expect(s.mini.roundOf(p)!.phase).toBe('live');
  });

  it('the list done and the mugs back: over, paid by the time and the mugs', () => {
    const { s, p, g } = punch(7);
    const money = p.profile.money;
    let spent = 0;
    for (let i = 0; i < 6; i++) {
      spent += g.stalls[g.list[g.of(p).step]].price;
      drinkNext(s, p, g);
      // (walking on to the next one)
      run(s.sim, 15);
    }
    expect(messages(s.priv, p.id)).toContain('Zoznam hotový! Teraz vráť hrnčeky – záloha €2 za kus.');
    run(s.sim, 0.3);
    let st = lastMini(s.priv, p.id)!;
    expect(st.goal).toContain('záloha €2 za kus');
    expect(st.marks!.find((m) => m.arrow)!.icon).toBe('♻️');
    const mugs = g.of(p).mugs;
    atStall(s, p, deposit(g));
    s.mini.act(p);
    run(s.sim, 0.2);
    st = lastMini(s.priv, p.id)!;
    expect(st.phase).toBe('done');
    expect(st.result!.text).toMatch(/^Punčová cesta za \d:\d\d/);
    expect(st.result!.pay).toBeGreaterThanOrEqual(150);
    expect(st.result!.pay).toBeLessThanOrEqual(300);
    expect(miniPay(s.priv, p.id)).toBe(st.result!.pay);
    expect(p.profile.money).toBe(money - spent + mugs * DEPOSIT + st.result!.pay);
  });

  it('out of time: paid for the stalls done', () => {
    const { s, p, g } = punch(8);
    drinkNext(s, p, g);
    drinkNext(s, p, g);
    for (let i = 0; i < 300 && s.mini.roundOf(p)?.phase === 'live'; i++) run(s.sim, 1);
    const r = lastMini(s.priv, p.id)!;
    expect(r.phase).toBe('done');
    expect(r.result!.text).toBe('Stihol si 2/6 stánkov. Punč počká do budúcich Vianoc.');
    expect(r.result!.pay).toBe(24);
  });

  it('with others: the same list, and the first one through it wins', () => {
    const s = setupMini(9, 'server');
    const a = addPlayer(s.sim, 'main', 'Fero', 200);
    const b = addPlayer(s.sim, 'main', 'Jana', 200);
    const r = s.mini.start(a, 'punch')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = game(s, a);
    for (let i = 0; i < 6; i++) {
      drinkNext(s, a, g);
      drinkNext(s, b, g);
    }
    atStall(s, a, deposit(g));
    s.mini.act(a);
    run(s.sim, 2);
    expect(messages(s.priv, b.id)).toContain('Fero dopil zoznam prvý!');
    expect(lastMini(s.priv, b.id)!.board![0][0]).toBe('Fero');
    atStall(s, b, deposit(g));
    s.mini.act(b);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, a.id)!.result!.place).toBe(1);
    expect(lastMini(s.priv, b.id)!.result!.place).toBe(2);
    expect(miniPay(s.priv, a.id)).toBeGreaterThan(miniPay(s.priv, b.id));
  });

  it("won't start far from the Old Town", () => {
    const s = setupMini(1);
    const main = s.sim.world.landmark('main');
    const far = s.sim.world.walkableNear(main.x + 1800, main.y - 1200);
    const p = addPlayer(s.sim, far, 'A');
    expect(s.mini.start(p, 'punch')).toBeNull();
    expect(messages(s.priv, p.id)).toContain('Vianočné trhy sú na Hlavnom a Hviezdoslavovom námestí – príď bližšie k Starému Mestu.');
  });

  it('the crowd and the pickpockets go with the round', () => {
    const { s, p, g } = punch();
    const crowd = s.sim.peds.filter((q) => !q.playerId).length;
    expect(crowd).toBeGreaterThanOrEqual(15);
    expect(crowd).toBeLessThan(30);
    expect(g.visitors.length).toBeGreaterThan(10);
    run(s.sim, 5);
    s.mini.leave(p);
    expect(s.sim.peds.filter((q) => !q.playerId).length).toBe(0);
    // and at the end of a round (everyone the game put there, the pickpockets who came later too;
    // the city's own people, which a few minutes can bring, stay)
    const r2 = punch(2);
    drinkNext(r2.s, r2.p, r2.g);
    const ours = new Set<object>();
    for (let i = 0; i < 300 && r2.s.mini.roundOf(r2.p)?.phase === 'live'; i++) {
      run(r2.s.sim, 1);
      for (const q of r2.s.sim.peds) if (q.kinematic && !q.playerId) ours.add(q);
    }
    expect(ours.size).toBeGreaterThan(20);
    run(r2.s.sim, DONE_S + 0.2);
    expect(r2.s.mini.all.length).toBe(0);
    expect(r2.s.sim.peds.filter((q) => ours.has(q) || (q.kinematic && !q.playerId)).length).toBe(0);
  });
});
