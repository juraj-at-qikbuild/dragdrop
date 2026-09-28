// Súrna potreba (games/toilet.ts, docs/plans/minigames.md): the toilets are the map's own; locked, paid
// or free, found out at the door; coins from a bakery, a café's toilet for its customers; the bladder
// fills (faster running) and a full one is the end; one at a time in each; the first one relieved wins.
import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/shared/util/math';
import type { MiniState } from '../../../src/shared/sim/rules/minigames/types';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';

/** the game's spots as it shows them: the toilets, cafés and bakeries */
function spots(s: MiniSetup, p: SimPlayer) {
  return lastMini(s.priv, p.id)?.marks ?? [];
}

/** step until the bladder has been shown (a state was sent) */
function state(s: MiniSetup, p: SimPlayer): MiniState {
  run(s.sim, 0.3);
  return lastMini(s.priv, p.id)!;
}

/** find a seed whose toilets near Hlavné námestie include one of `status` (the game's own hidden
 *  status is read off the round's game) */
function withToilet(status: 'free' | 'paid' | 'locked') {
  for (let seed = 1; seed < 60; seed++) {
    const s = setupMini(seed);
    const p = addPlayer(s.sim, 'main', 'A', 200);
    startLive(s, p, 'toilet');
    const g = s.mini.gameOf(p) as unknown as { spots: { x: number; y: number; kind: string; status: string }[] };
    const sp = g.spots.find((q) => q.kind === 'wc' && q.status === status);
    if (sp) return { s, p, sp, g };
  }
  throw new Error(`no ${status} toilet`);
}

describe('Súrna potreba', () => {
  it('shows the toilets near the Old Town, a bladder filling up, and points the way', () => {
    const s = setupMini(3);
    const p = addPlayer(s.sim, 'main');
    startLive(s, p, 'toilet');
    const st = state(s, p);
    expect(st.phase).toBe('live');
    const wcs = spots(s, p).filter((m) => m.icon === '🚻');
    expect(wcs.length).toBeGreaterThanOrEqual(2);
    for (const m of wcs) expect(dist(m.x, m.y, p.ped.x, p.ped.y)).toBeLessThanOrEqual(1100);
    expect(spots(s, p).filter((m) => m.arrow).length).toBe(1);
    const b0 = st.bar!.v;
    run(s.sim, 10);
    expect(lastMini(s.priv, p.id)!.bar!.v).toBeGreaterThan(b0);
  });

  it('a free toilet: the door opens, a few seconds, relief and pay', () => {
    const { s, p, sp } = withToilet('free');
    standAt(p, sp.x, sp.y);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.act).toBe('Skúsiť dvere');
    s.mini.act(p);
    run(s.sim, 5);
    const r = lastMini(s.priv, p.id)!;
    expect(r.phase).toBe('done');
    expect(r.result!.pay).toBeGreaterThanOrEqual(60);
    expect(miniPay(s.priv, p.id)).toBe(r.result!.pay);
  });

  it('a locked one says so, and walking off mid-way means you still have to go', () => {
    const { s, p, sp } = withToilet('locked');
    standAt(p, sp.x, sp.y);
    run(s.sim, 0.3);
    s.mini.act(p);
    expect(messages(s.priv, p.id)).toContain('Zamknuté. Otváracie hodiny sú len na papieri.');
    run(s.sim, 0.3);
    const lock = spots(s, p).find((m) => dist(m.x, m.y, sp.x, sp.y) < 1);
    expect(lock?.icon).toBe('🔒');
  });

  it('a paid one wants coins: change from a bakery first', () => {
    const { s, p, sp, g } = withToilet('paid');
    standAt(p, sp.x, sp.y);
    run(s.sim, 0.3);
    s.mini.act(p);
    expect(messages(s.priv, p.id)).toContain('Nemáš drobné! Rozmeň si v pekárni alebo kaviarni.');
    const bakery = g.spots.find((q) => q.kind === 'bakery');
    if (!bakery) return;
    const money = p.profile.money;
    standAt(p, bakery.x, bakery.y);
    run(s.sim, 0.3);
    s.mini.act(p);
    expect(p.profile.money).toBe(money - 1);
    standAt(p, sp.x, sp.y);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.act).toBe('Zaplatiť 50 centov a ísť');
    s.mini.act(p);
    run(s.sim, 5);
    expect(lastMini(s.priv, p.id)!.phase).toBe('done');
  });

  it('a café lets its customers in', () => {
    for (let seed = 1; seed < 20; seed++) {
      const s = setupMini(seed);
      const p = addPlayer(s.sim, 'main', 'A', 50);
      startLive(s, p, 'toilet');
      const g = s.mini.gameOf(p) as unknown as { spots: { x: number; y: number; kind: string }[] };
      const cafe = g.spots.find((q) => q.kind === 'cafe');
      if (!cafe) continue;
      standAt(p, cafe.x, cafe.y);
      run(s.sim, 0.3);
      s.mini.act(p);
      expect(p.profile.money).toBe(47);
      run(s.sim, 5);
      expect(lastMini(s.priv, p.id)!.result!.text).toContain('v kaviarni');
      return;
    }
    throw new Error('no café near Hlavné námestie');
  });

  it('holding on too long is the end, and running makes it come sooner', () => {
    const s = setupMini(5);
    const p = addPlayer(s.sim, 'main');
    startLive(s, p, 'toilet');
    const walk = lastMini(s.priv, p.id)!;
    run(s.sim, 30, () => {
      p.ped.vx = 4;
    });
    const ran = lastMini(s.priv, p.id)!.bar!.v - walk.bar!.v;
    const s2 = setupMini(5);
    const q = addPlayer(s2.sim, 'main');
    startLive(s2, q, 'toilet');
    const w2 = lastMini(s2.priv, q.id)!;
    run(s2.sim, 30);
    const walked = lastMini(s2.priv, q.id)!.bar!.v - w2.bar!.v;
    expect(ran).toBeGreaterThan(walked * 1.4);
    run(s.sim, 200, () => {
      p.ped.vx = 4;
    });
    expect(messages(s.priv, p.id)).toContain('Nestihol si to… 💦');
    expect(miniPay(s.priv, p.id)).toBe(0);
  });

  it('with others: one at a time in a toilet, and the first one relieved wins', () => {
    for (let seed = 1; seed < 60; seed++) {
      const s = setupMini(seed, 'server');
      const a = addPlayer(s.sim, 'main', 'Fero', 200);
      const b = addPlayer(s.sim, 'main', 'Jana', 200);
      const r = s.mini.start(a, 'toilet')!;
      s.mini.join(b, r.id);
      s.mini.go(a);
      run(s.sim, 3.2);
      const g = s.mini.gameOf(a) as unknown as { spots: { x: number; y: number; kind: string; status: string }[] };
      const sp = g.spots.find((q) => q.kind === 'wc' && q.status === 'free');
      if (!sp) continue;
      standAt(a, sp.x, sp.y);
      standAt(b, sp.x + 1, sp.y);
      run(s.sim, 0.2);
      s.mini.act(a);
      s.mini.act(b);
      expect(messages(s.priv, b.id)).toContain('Obsadené! Niekto ťa predbehol.');
      run(s.sim, 4.5);
      expect(messages(s.priv, b.id)).toContain('Fero to stihol prvý!');
      s.mini.act(b);
      run(s.sim, 5);
      expect(lastMini(s.priv, a.id)!.result!.place).toBe(1);
      expect(lastMini(s.priv, b.id)!.result!.place).toBe(2);
      expect(miniPay(s.priv, a.id)).toBeGreaterThan(miniPay(s.priv, b.id));
      return;
    }
    throw new Error('no free toilet');
  });
});
