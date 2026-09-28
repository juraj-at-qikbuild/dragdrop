// Povodeň (games/flood.ts, docs/plans/minigames.md): the mobile wall on the real embankment (its gaps on
// dry land with the Danube right past them, between Most SNP and Eurovea), the way there from further
// off, carrying panels from the van's stack and setting them, the waves (an open gap at a peak floods
// the street behind it, three breaches and the round is lost, all closed and the wave is held), the flood
// tourists who keep a gap open until they're asked to go, the shared pay, and nothing left behind.
import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/shared/util/math';
import { DONE_S } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { FAR_R, MAX_BREACH, findWall, levelAt, type Gap } from '../../../src/shared/sim/rules/minigames/games/flood';
import type { MiniState } from '../../../src/shared/sim/rules/minigames/types';
import type { Ped } from '../../../src/shared/entities/Ped';
import type { Vehicle } from '../../../src/shared/entities/Vehicle';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';

/** the round's game, as far as the tests look into it */
interface FloodGame {
  gaps: Gap[];
  van: Vehicle | null;
  tourists: { ped: Ped; gap: number; mode: string }[];
  depotAt(): { x: number; y: number };
  spawnTourist(): void;
  /** seconds since the waves started */
  t: number;
}
const game = (s: MiniSetup, p: SimPlayer) => s.mini.gameOf(p) as unknown as FloodGame;

/** step on until a state has been sent */
function state(s: MiniSetup, p: SimPlayer): MiniState {
  run(s.sim, 0.3);
  return lastMini(s.priv, p.id)!;
}

/** a player (or two) at the stack of panels on the promenade by Hviezdoslavovo námestie, and the round
 *  started there: the waves are on at once */
function onEmbankment(seed = 1) {
  const s = setupMini(seed);
  const hv = s.sim.world.landmark('hviezdoslav');
  const site = findWall(s.sim.world, hv.x, hv.y)!;
  const p = addPlayer(s.sim, { x: site.depot.x, y: site.depot.y });
  startLive(s, p, 'flood');
  return { s, p, g: game(s, p) };
}

/** take a panel at the stack */
function takePanel(s: MiniSetup, p: SimPlayer) {
  const d = game(s, p).depotAt();
  standAt(p, d.x, d.y);
  s.mini.act(p);
}

/** carry a panel to gap i and set it */
function fill(s: MiniSetup, p: SimPlayer, i: number) {
  const g = game(s, p).gaps[i];
  takePanel(s, p);
  standAt(p, g.x + g.nx, g.y + g.ny);
  s.mini.act(p);
}

/** close every open gap (`who` take turns) */
function closeAll(s: MiniSetup, who: SimPlayer[]) {
  const g = game(s, who[0]);
  let k = 0;
  g.gaps.forEach((gap, i) => {
    if (!gap.closed) fill(s, who[k++ % who.length], i);
  });
}

/** run until `t` seconds into the waves */
function until(s: MiniSetup, p: SimPlayer, t: number) {
  run(s.sim, Math.max(0, t - game(s, p).t));
}

describe('Povodeň', () => {
  it('builds the wall on the real embankment: gaps on dry land, the Danube right past them, between Most SNP and Eurovea', () => {
    const s = setupMini(1);
    const w = s.sim.world;
    const snp = w.landmark('snp'), ev = w.landmark('eurovea');
    for (const at of ['hviezdoslav', 'sng', 'reduta', 'snp', 'eurovea', 'oldbridge', 'main']) {
      const l = w.landmark(at);
      const site = findWall(w, l.x, l.y)!;
      expect(site, at).toBeTruthy();
      expect(site.gaps.length).toBeGreaterThanOrEqual(8);
      expect(site.gaps.length).toBeLessThanOrEqual(12);
      site.gaps.forEach((g, i) => {
        // on the Old Town's bank, east of Most SNP's deck and not past Eurovea
        expect(g.x).toBeGreaterThan(snp.x);
        expect(g.x).toBeLessThan(ev.x + 130);
        for (const [x, y] of [[g.x, g.y], [g.ax, g.ay], [g.bx, g.by]]) {
          expect(w.inWater(x, y, 0), `${at} gap ${i} dry`).toBe(false);
          expect(w.insideBuilding(x, y)).toBe(false);
          expect(w.onBridge(x, y)).toBe(false);
        }
        expect(w.spawnLevel(g.x, g.y, 0.5)).toBe(0);
        // the river is right in front of it, and inland is behind it
        expect(w.inWater(g.x - g.nx * 17, g.y - g.ny * 17, 0), `${at} gap ${i} by the river`).toBe(true);
        expect(w.inWater(g.x + g.nx * 5, g.y + g.ny * 5, 0)).toBe(false);
        // 16 m apart along the bank (a little less or more where it bends)
        if (i) expect(Math.abs(dist(g.x, g.y, site.gaps[i - 1].x, site.gaps[i - 1].y) - 16)).toBeLessThan(2.5);
      });
      // the stack of panels is on land behind the wall, the van behind it
      const d = site.depot, m = site.gaps[site.gaps.length >> 1];
      expect(w.inWater(d.x, d.y, 0)).toBe(false);
      expect((d.x - m.x) * m.nx + (d.y - m.y) * m.ny).toBeGreaterThan(3);
      expect(dist(d.x, d.y, d.vx, d.vy)).toBeGreaterThan(4.2);
    }
    // started by Hviezdoslavovo námestie, the wall is on the bank right in front of it
    const hv = w.landmark('hviezdoslav');
    expect(findWall(w, hv.x, hv.y)!.gaps.every((g) => Math.abs(g.x - hv.x) < 120)).toBe(true);
  });

  it('shows the wall, the stack, the river and the countdown to the first peak', () => {
    const { s, p, g } = onEmbankment(1);
    const st = state(s, p);
    expect(st.phase).toBe('live');
    expect(st.goal).toBe('Vezmi panel z auta a zatvor medzery pred kulmináciou!');
    expect(st.bar!.label).toBe('Hladina Dunaja 7,5 m');
    expect(st.left).toBeGreaterThan(70);
    expect(st.left).toBeLessThanOrEqual(75);
    expect(st.stats).toEqual([['Vlna', '1/4'], ['Medzery', '5'], ['Prielomy', '0/3']]);
    const stack = st.marks!.find((m) => m.icon === '🧱')!;
    expect(stack.arrow).toBe(1);
    const gaps = st.marks!.filter((m) => m.w && m.h);
    expect(gaps.length).toBe(5);
    for (const m of gaps) expect(m.label).toBe('medzera');
    // the drawer's wall: each gap's ends and states, and the van for scenery
    expect((st.x!.w as number[]).length).toBe(g.gaps.length * 4);
    expect(st.x!.s).toBe(g.gaps.map((q) => (q.closed ? '1' : '0')).join(''));
    expect(s.sim.vehicles.includes(g.van!)).toBe(true);
    expect(g.van!.locked).toBe(true);
    // the river climbs toward the first peak
    run(s.sim, 40);
    expect(lastMini(s.priv, p.id)!.bar!.v).toBeGreaterThan(st.bar!.v);
    expect(levelAt(0)).toBe(7.5);
    expect(levelAt(75)).toBeCloseTo(8.4);
    expect(levelAt(80)).toBeLessThan(8.4);
    expect(levelAt(240)).toBeCloseTo(9.7);
  });

  it('carrying panels: one from the stack at a time, set in a gap within reach, on foot', () => {
    const { s, p, g } = onEmbankment(2);
    const open = g.gaps.findIndex((q) => !q.closed);
    const d = g.depotAt();
    standAt(p, d.x, d.y);
    expect(state(s, p).act).toBe('Vziať panel');
    s.mini.act(p);
    let st = state(s, p);
    expect(st.x!.c).toBe(1);
    expect(st.act).toBeUndefined();
    expect(st.goal).toBe('Nes panel do otvorenej medzery a osaď ho.');
    // the arrow is on the nearest open gap now
    expect(st.marks!.find((m) => m.arrow)?.w).toBe(6);
    // not within reach of a gap: nothing to set
    const gap = g.gaps[open];
    standAt(p, gap.x + gap.nx * 8, gap.y + gap.ny * 8);
    expect(state(s, p).act).toBeUndefined();
    standAt(p, gap.bx + gap.nx * 2, gap.by + gap.ny * 2);
    expect(state(s, p).act).toBe('Osadiť panel');
    s.mini.act(p);
    expect(gap.closed).toBe(true);
    // (a floating word over it, not a line on the screen: those queue up)
    expect(s.priv.some(([id, e]) => id === p.id && e.k === 'style' && e.label === 'panel sedí!')).toBe(true);
    st = state(s, p);
    expect(st.x!.c).toBe(0);
    expect((st.x!.s as string)[open]).toBe('1');
    expect(st.stats![1]).toEqual(['Medzery', '4']);
  });

  it('a wave peaks: all closed and it holds; an open gap floods the street behind it; three breaches and it is lost', () => {
    const { s, p, g } = onEmbankment(3);
    closeAll(s, [p]);
    expect(messages(s.priv, p.id)).toContain('Všetky medzery sú zatvorené! 💪');
    until(s, p, 76);
    expect(messages(s.priv, p.id)).toContain('Kulminácia 8,4 m – stena vydržala! 💪');
    let st = lastMini(s.priv, p.id)!;
    expect(st.stats![0]).toEqual(['Vlna', '2/4']);
    expect(st.marks!.some((m) => m.icon === '🌊')).toBe(false);
    // the wave knocks two panels out after it
    until(s, p, 84);
    expect(messages(s.priv, p.id)).toContain('Vlna vyrazila 2 panely! Zase sú medzery.');
    const open = g.gaps.filter((q) => !q.closed);
    expect(open.length).toBe(2);
    // leave them open: at the next peak the river comes through both
    until(s, p, 131);
    expect(messages(s.priv, p.id)).toContain('Prielom! Dunaj sa valí na nábrežie (2×).');
    st = lastMini(s.priv, p.id)!;
    expect(st.stats![2]).toEqual(['Prielomy', `2/${MAX_BREACH}`]);
    const floods = st.marks!.filter((m) => m.icon === '🌊');
    expect(floods.length).toBe(2);
    for (const f of floods) {
      expect(f.poly!.length).toBe(8);
      // behind the wall, over the street
      const gap = open.find((q) => dist(q.x, q.y, f.x, f.y) < 20)!;
      expect((f.x - gap.x) * gap.nx + (f.y - gap.y) * gap.ny).toBeGreaterThan(5);
    }
    expect((st.x!.s as string).split('').filter((c) => c === '3').length).toBe(2);
    // a panel back in one: the street behind it stays flooded
    const back = g.gaps.indexOf(open[0]);
    fill(s, p, back);
    st = state(s, p);
    expect((st.x!.s as string)[back]).toBe('4');
    expect(st.marks!.filter((m) => m.icon === '🌊').length).toBe(2);
    // one more breach at the third peak is the end: the consolation (6 panels were set: €15 + €2 each)
    until(s, p, 186);
    const r = lastMini(s.priv, p.id)!;
    expect(r.phase).toBe('done');
    expect(r.result!.text).toBe('Dunaj prerazil stenu – nábrežie je pod vodou. 🌊');
    expect(r.result!.pay).toBe(15 + 2 * 6);
    expect(miniPay(s.priv, p.id)).toBe(27);
  });

  it('holding all four waves pays €40 each, €60 for a dry Old Town and a little for the panels', () => {
    const { s, p } = onEmbankment(4);
    for (const peak of [75, 130, 185, 240]) {
      closeAll(s, [p]);
      until(s, p, peak + 9);
    }
    run(s.sim, 1);
    const r = lastMini(s.priv, p.id)!;
    expect(r.phase).toBe('done');
    expect(r.result!.text).toBe('Stena vydržala všetky vlny – Staré Mesto je suché! 🎉');
    // 5 panels at first, 2 after each of three waves: 11 panels, capped at €30
    expect(r.result!.pay).toBe(4 * 40 + 60 + 30);
  });

  it('flood tourists: one takes selfies in a gap, and the panel waits until they are asked to go', () => {
    const { s, p, g } = onEmbankment(5);
    g.spawnTourist();
    const t = g.tourists[0];
    expect(t.mode).toBe('walk');
    expect(t.ped.archetype).toBe('tourist');
    run(s.sim, 30);
    expect(t.mode).toBe('selfie');
    expect(messages(s.priv, p.id)).toContain('📱 Turista si v medzere robí selfie s Dunajom!');
    // in the gap, a step back from its line, facing the river
    const gap = g.gaps[t.gap];
    expect(dist(t.ped.x, t.ped.y, gap.x, gap.y)).toBeLessThan(1.2);
    let st = state(s, p);
    expect(st.marks!.some((m) => m.icon === '📱' && m.e === t.ped.id)).toBe(true);
    expect(st.marks!.find((m) => m.w && Math.abs(m.x - gap.x) < 0.2)?.label).toBe('turista!');
    expect((st.x!.s as string)[t.gap]).toBe('2');
    // with a panel at that gap: first they have to go
    takePanel(s, p);
    standAt(p, gap.ax + gap.nx, gap.ay + gap.ny);
    expect(state(s, p).act).toBe('Choďte preč, prosím!');
    s.mini.act(p);
    expect(t.mode).toBe('asked');
    expect(messages(s.priv, p.id)).toContain('„Choďte preč, prosím!" – „Ešte jedno selfie… Dobre, dobre."');
    st = state(s, p);
    expect(st.act).toBeUndefined();
    s.mini.act(p);
    expect(gap.closed).toBe(false);
    run(s.sim, 2);
    expect(t.mode).toBe('leave');
    expect(state(s, p).act).toBe('Osadiť panel');
    s.mini.act(p);
    expect(gap.closed).toBe(true);
    // and off they go, out of the city
    run(s.sim, 26);
    expect(s.sim.peds.includes(t.ped)).toBe(false);
  });

  it('a tourist left in a gap at the peak: the river comes through (they got their selfie)', () => {
    const { s, p, g } = onEmbankment(6);
    g.spawnTourist();
    const t = g.tourists[0];
    run(s.sim, 30);
    expect(t.mode).toBe('selfie');
    // every other gap closed, theirs left to them
    const i = t.gap;
    g.gaps.forEach((q, k) => {
      if (!q.closed && k !== i) fill(s, p, k);
    });
    expect(g.gaps[i].closed).toBe(false);
    until(s, p, 76);
    expect(messages(s.priv, p.id)).toContain('Turistovi zmokli tenisky – ale selfie má!');
    expect(messages(s.priv, p.id)).toContain('Prielom! Dunaj sa valí na nábrežie (1×).');
    expect(t.mode).toBe('leave');
  });

  it('started away from the river: first the way there, and the waves wait for the players (a while)', () => {
    const s = setupMini(7);
    const p = addPlayer(s.sim, 'main');
    const r = startLive(s, p, 'flood');
    const g = game(s, p);
    // the round is at the embankment now (joining is from there)
    expect(dist(r.x, r.y, g.gaps[4].x, g.gaps[4].y)).toBeLessThan(20);
    let st = state(s, p);
    expect(st.goal).toMatch(/^Utekaj na .*! Dunaj stúpa\.$/);
    expect(st.stats![0][0]).toBe('Nábrežie');
    expect(st.left).toBeGreaterThan(170);
    expect(st.marks!.find((m) => m.arrow)?.icon).toBe('🧱');
    run(s.sim, 20);
    expect(lastMini(s.priv, p.id)!.bar!.label).toBe('Hladina Dunaja 7,5 m');
    // there: the waves start
    const d = g.depotAt();
    standAt(p, d.x + 20, d.y);
    st = state(s, p);
    expect(st.stats![0]).toEqual(['Vlna', '1/4']);
    expect(st.left).toBeGreaterThan(73);
    expect(messages(s.priv, p.id)).toContain('Si na nábreží! Nos panely z auta do medzier v stene.');

    // nobody comes: the river doesn't wait for ever
    const s2 = setupMini(7);
    const q = addPlayer(s2.sim, 'main');
    startLive(s2, q, 'flood');
    run(s2.sim, 181);
    expect(messages(s2.priv, q.id)).toContain('Dunaj nečaká – prvá vlna je na ceste!');
    expect(lastMini(s2.priv, q.id)!.stats![0]).toEqual(['Vlna', '1/4']);
    // …and when nobody set a panel, nobody's paid
    run(s2.sim, 76);
    expect(lastMini(s2.priv, q.id)!.phase).toBe('done');
    expect(lastMini(s2.priv, q.id)!.result!.text).toBe('Na nábrežie nikto neprišiel… Dunaj si poradil sám.');
    expect(miniPay(s2.priv, q.id)).toBe(0);

    // too far from the river, it doesn't start at all
    const s3 = setupMini(7);
    const far = addPlayer(s3.sim, { x: -1500, y: -1450 });
    const hv = s3.sim.world.landmark('hviezdoslav');
    expect(dist(far.ped.x, far.ped.y, hv.x, 150)).toBeGreaterThan(FAR_R);
    expect(s3.mini.start(far, 'flood')).toBeNull();
    expect(messages(s3.priv, far.id)).toContain('Povodeň je na nábreží v Starom Meste – príď bližšie k Dunaju.');
  });

  it('with others: one wall, one score, the same pay for all and a little more for more panels', () => {
    const s = setupMini(8, 'server');
    const hv = s.sim.world.landmark('hviezdoslav');
    const site = findWall(s.sim.world, hv.x, hv.y)!;
    const a = addPlayer(s.sim, { x: site.depot.x, y: site.depot.y }, 'Fero');
    const b = addPlayer(s.sim, { x: site.depot.x + 1, y: site.depot.y }, 'Jana');
    const r = s.mini.start(a, 'flood')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = game(s, a);
    // a bigger crew, a bigger job
    expect(g.gaps.filter((q) => !q.closed).length).toBe(6);
    for (const peak of [75, 130, 185, 240]) {
      // Fero does most of it
      g.gaps.forEach((q, i) => {
        if (q.closed) return;
        const open = g.gaps.filter((x) => !x.closed).length;
        fill(s, open === 1 ? b : a, i);
      });
      until(s, a, peak + 9);
    }
    run(s.sim, 1);
    const ra = lastMini(s.priv, a.id)!.result!, rb = lastMini(s.priv, b.id)!.result!;
    expect(ra.text).toBe('Stena vydržala všetky vlny – Staré Mesto je suché! 🎉');
    expect(rb.text).toBe(ra.text);
    // together: no places, the board counts panels
    expect(ra.place).toBeUndefined();
    const board = lastMini(s.priv, a.id)!.board!;
    expect(board[0][0]).toBe('Fero');
    expect(board[1]).toEqual(['Jana', 4]);
    // the same shared score, and €3 a panel (up to €30) on top
    expect(rb.pay).toBe(4 * 40 + 60 + 4 * 3);
    expect(ra.pay).toBe(4 * 40 + 60 + 30);
    expect(miniPay(s.priv, a.id)).toBe(ra.pay);
    expect(miniPay(s.priv, b.id)).toBe(rb.pay);
  });

  it('leaves nothing behind: the van and the tourists go with the round', () => {
    const { s, p, g } = onEmbankment(9);
    g.spawnTourist();
    run(s.sim, 5);
    const van = g.van!, tourist = g.tourists[0].ped;
    expect(s.sim.vehicles.includes(van)).toBe(true);
    expect(s.sim.peds.includes(tourist)).toBe(true);
    s.mini.leave(p);
    expect(s.mini.all.length).toBe(0);
    expect(s.sim.vehicles.includes(van)).toBe(false);
    expect(s.sim.peds.includes(tourist)).toBe(false);
    // and after a round that ran its course, too
    const { s: s2, p: q, g: g2 } = onEmbankment(10);
    const van2 = g2.van!;
    until(s2, q, 131);
    run(s2.sim, DONE_S + 0.5);
    expect(s2.mini.gameOf(q)).toBeNull();
    expect(s2.sim.vehicles.includes(van2)).toBe(false);
    expect(s2.sim.peds.filter((x) => x.kinematic && !x.playerId).length).toBe(0);
  });
});
