// Bilbordová vojna (games/billboard.ts, docs/plans/minigames.md): the campaign's spots are the map's
// billboards and bus shelters around the start; a poster takes a few seconds standing still (moving
// cancels it), a rival's gets a moustache first and can be pasted over then; the AI campaign flips
// spots far from the player; promises lie about; pasting in the campaign silence is a fine and a
// star; two campaigns with others; the spots held decide the election.
import { describe, expect, it } from 'vitest';
import { dist } from '../../../src/shared/util/math';
import { CANDIDATES } from '../../../src/shared/sim/rules/minigames/games/billboard';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt, startLive, type MiniSetup } from './helpers';

interface Spot {
  f: number;
  x: number;
  y: number;
  kind: number;
  owner: number;
  defaced: boolean;
}
/** the game's own state, as the tests read it */
interface Game {
  spots: Spot[];
  promises: { x: number; y: number; kind: 'bridge' | 'tram' | 'amnesty' }[];
  held(): [number, number];
  teamOf(p: SimPlayer): number;
}

function live(seed = 1, at = 'newsnd') {
  const s = setupMini(seed);
  const p = addPlayer(s.sim, at);
  const r = startLive(s, p, 'billboard');
  const g = s.mini.gameOf(p) as unknown as Game;
  return { s, p, r, g, team: g.teamOf(p) };
}

/** the nearest spot to `p` in the state `want`, standing right by it */
function goTo(s: MiniSetup, p: SimPlayer, g: Game, want: (sp: Spot) => boolean): Spot {
  const sp = g.spots.filter(want).sort((a, b) => dist(a.x, a.y, p.ped.x, p.ped.y) - dist(b.x, b.y, p.ped.x, p.ped.y))[0];
  if (!sp) throw new Error('no such spot');
  standAt(p, sp.x + 1, sp.y);
  run(s.sim, 0.3);
  return sp;
}

describe('Bilbordová vojna', () => {
  it('finds the billboards and bus shelters around a couple of landmarks, and shows them', () => {
    for (const at of ['newsnd', 'main']) {
      const { s, p, g } = live(2, at);
      expect(g.spots.length).toBeGreaterThanOrEqual(12);
      expect(g.spots.length).toBeLessThanOrEqual(24);
      for (const sp of g.spots) {
        expect([4, 5, 6]).toContain(sp.kind);
        expect(dist(sp.x, sp.y, p.ped.x, p.ped.y)).toBeLessThan(1100);
      }
      // (Petržalka's avenues have the billboards, the Old Town the bus shelters)
      if (at === 'newsnd') expect(g.spots.some((sp) => sp.kind === 5)).toBe(true);
      run(s.sim, 0.3);
      const st = lastMini(s.priv, p.id)!;
      expect(st.phase).toBe('live');
      expect(st.marks!.filter((m) => m.icon === '🪧' || m.icon === '🥸').length).toBe(g.spots.length);
      expect(st.marks!.filter((m) => m.arrow).length).toBe(1);
      // the promises are out too, and the standings are the two campaigns'
      expect(st.marks!.filter((m) => m.icon === '⭐').length).toBeGreaterThan(0);
      expect(st.board!.map(([n]) => n).sort()).toEqual(CANDIDATES.map((c) => c.short).sort());
    }
  });

  it('a poster takes a few seconds standing still, and moving cancels it', () => {
    const { s, p, g, team } = live(3);
    const sp = goTo(s, p, g, (q) => q.owner < 0);
    expect(lastMini(s.priv, p.id)!.act).toBe('Nalepiť plagát');
    s.mini.act(p);
    run(s.sim, 1);
    expect(sp.owner).toBe(-1);
    const st = lastMini(s.priv, p.id)!;
    expect(st.goal).toContain('nehýb sa');
    expect(st.bar!.v).toBeGreaterThan(0.2);
    expect(st.bar!.v).toBeLessThan(0.6);
    // a step away: it falls down
    p.ped.vx = 3;
    run(s.sim, 0.2);
    p.ped.vx = 0;
    expect(messages(s.priv, p.id)).toContain('Pohol si sa – plagát spadol.');
    run(s.sim, 3);
    expect(sp.owner).toBe(-1);
    // and standing still it sticks
    s.mini.act(p);
    run(s.sim, 3.2);
    expect(sp.owner).toBe(team);
    expect(g.held()[team]).toBeGreaterThanOrEqual(1);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)!.act).toBeUndefined();
  });

  it('draws a moustache on the rival\'s poster, and then pastes over it', () => {
    const { s, p, g, team } = live(4);
    const sp = g.spots.find((q) => q.owner < 0)!;
    sp.owner = 1 - team;
    goTo(s, p, g, (q) => q === sp);
    expect(lastMini(s.priv, p.id)!.act).toBe('Dokresliť fúzy');
    s.mini.act(p);
    run(s.sim, 1.7);
    expect(sp.defaced).toBe(true);
    expect(g.held()[1 - team]).toBe(g.spots.filter((q) => q.owner === 1 - team && !q.defaced).length);
    run(s.sim, 0.3);
    const mark = lastMini(s.priv, p.id)!.marks!.find((m) => dist(m.x, m.y, sp.x, sp.y) < 1)!;
    expect(mark.icon).toBe('🥸');
    expect(lastMini(s.priv, p.id)!.act).toBe('Nalepiť plagát');
    s.mini.act(p);
    run(s.sim, 3.2);
    expect(sp.owner).toBe(team);
    expect(sp.defaced).toBe(false);
  });

  it('the AI campaign flips a spot every quarter of a minute or so, far from the player', () => {
    const { s, p, g, team } = live(5);
    run(s.sim, 90);
    const theirs = g.spots.filter((q) => q.owner === 1 - team);
    expect(theirs.length).toBeGreaterThanOrEqual(5);
    expect(theirs.length).toBeLessThanOrEqual(8);
    const mean = (l: Spot[]) => l.reduce((a, q) => a + dist(q.x, q.y, p.ped.x, p.ped.y), 0) / l.length;
    expect(mean(theirs)).toBeGreaterThan(mean(g.spots));
    // none right by the player
    for (const q of theirs) expect(dist(q.x, q.y, p.ped.x, p.ped.y)).toBeGreaterThan(25);
    // with nothing free left, it draws a moustache on one of the player's posters, and then pastes
    // over it
    for (const q of g.spots) (q.owner = team), (q.defaced = false);
    run(s.sim, 20);
    expect(g.spots.filter((q) => q.owner === team && !q.defaced).length).toBeLessThan(g.spots.length);
    expect(messages(s.priv, p.id).some((m) => m.includes('dokreslil fúzy na tvoj plagát'))).toBe(true);
    run(s.sim, 25);
    expect(g.spots.some((q) => q.owner === 1 - team && !q.defaced)).toBe(true);
  });

  it('promises: a new bridge makes the next poster instant, the tram the next two quick, an amnesty clears the stars', () => {
    const { s, p, g, team } = live(6);
    const take = (kind: 'bridge' | 'tram' | 'amnesty') => {
      const pr = g.promises[0];
      pr.kind = kind;
      standAt(p, pr.x, pr.y);
      run(s.sim, 0.2);
    };
    take('bridge');
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Sľub: Nový most'))).toBe(true);
    run(s.sim, 0.2);
    expect(lastMini(s.priv, p.id)!.stats).toContainEqual(['Sľub', 'Nový most']);
    let sp = goTo(s, p, g, (q) => q.owner < 0);
    s.mini.act(p);
    run(s.sim, 0.1);
    expect(sp.owner).toBe(team);
    // (a promise taken turns up again somewhere else)
    expect(g.promises.length).toBeGreaterThanOrEqual(1);
    take('tram');
    sp = goTo(s, p, g, (q) => q.owner < 0);
    s.mini.act(p);
    run(s.sim, 1);
    expect(sp.owner).toBe(team);
    s.sim.setWanted(p, 2);
    take('amnesty');
    expect(p.wanted).toBe(0);
  });

  it('the campaign silence: pasting in the last 48 s costs a fine and a star (unless an amnesty was kept)', () => {
    const { s, p, g, r, team } = live(7);
    const money = p.profile.money;
    r.left = 44;
    run(s.sim, 0.3);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Moratórium!'))).toBe(true);
    expect(lastMini(s.priv, p.id)!.goal).toContain('Moratórium! Nelep.');
    const sp = goTo(s, p, g, (q) => q.owner < 0 || q.defaced);
    expect(lastMini(s.priv, p.id)!.act).toBe('Lepiť aj tak (pokuta!)');
    s.mini.act(p);
    run(s.sim, 3.2);
    expect(sp.owner).toBe(team);
    expect(p.profile.money).toBe(money - 50);
    expect(p.wanted).toBeGreaterThanOrEqual(1);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Porušil si moratórium!'))).toBe(true);
    // an amnesty picked up with no stars to clear waits for the next fine
    s.sim.setWanted(p, 0);
    const pr = g.promises[0];
    pr.kind = 'amnesty';
    standAt(p, pr.x, pr.y);
    run(s.sim, 0.2);
    const sp2 = goTo(s, p, g, (q) => q.owner < 0 || q.defaced);
    s.mini.act(p);
    run(s.sim, 3.2);
    expect(sp2.owner).toBe(team);
    expect(p.profile.money).toBe(money - 50);
    expect(p.wanted).toBe(0);
  });

  it('the spots held decide the election: a result in percentages, and the pay', () => {
    /** a round where the player has pasted one poster, and then the city looks like `owners` */
    const played = (seed: number, owners: (team: number, i: number) => number) => {
      const l = live(seed);
      goTo(l.s, l.p, l.g, (q) => q.owner < 0);
      l.s.mini.act(l.p);
      run(l.s.sim, 3.2);
      l.g.spots.forEach((q, i) => {
        q.owner = owners(l.team, i);
        q.defaced = false;
      });
      return l;
    };
    // the player's campaign holds all but three, the AI's the rest (one of those with a moustache)
    const { s, p, g, r, team } = played(8, (t, i) => (i < 3 ? 1 - t : t));
    g.spots[0].defaced = true;
    r.left = 0.1;
    run(s.sim, 0.3);
    const st = lastMini(s.priv, p.id)!;
    expect(st.phase).toBe('done');
    const [a, b] = g.held();
    const mine = team === 0 ? a : b;
    expect(mine).toBe(g.spots.length - 3);
    const pct = Math.round((a * 100) / (a + b));
    expect(st.result!.text).toContain(`${pct} %`);
    expect(st.result!.text).toContain(`${100 - pct} %`);
    expect(st.result!.text).toContain('vyhral si!');
    expect(st.result!.pay).toBe(250 + 5 * mine);
    expect(miniPay(s.priv, p.id)).toBe(st.result!.pay);
    expect(messages(s.priv, p.id).some((m) => m.startsWith('Volebný výsledok:'))).toBe(true);
    // losing still pays a little
    const l = played(9, (t) => 1 - t);
    l.r.left = 0.1;
    run(l.s.sim, 0.3);
    expect(lastMini(l.s.priv, l.p.id)!.result!.text).toContain('prehral si.');
    expect(lastMini(l.s.priv, l.p.id)!.result!.pay).toBe(80);
    // and standing about pays nothing but the spots
    const idle = live(10);
    idle.g.spots.forEach((q) => (q.owner = idle.team));
    idle.r.left = 0.1;
    run(idle.s.sim, 0.3);
    expect(lastMini(idle.s.priv, idle.p.id)!.result!.text).toContain('nenalepil ani plagát');
    expect(lastMini(idle.s.priv, idle.p.id)!.result!.pay).toBe(5 * idle.g.held()[idle.team]);
  });

  it('with others: two campaigns by the order they joined, the standings are theirs, and the winners take more', () => {
    const s = setupMini(10, 'server');
    const a = addPlayer(s.sim, 'newsnd', 'Fero');
    const b = addPlayer(s.sim, 'newsnd', 'Jana');
    const r = s.mini.start(a, 'billboard')!;
    expect(s.mini.join(b, r.id)).toBe(true);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = s.mini.gameOf(a) as unknown as Game;
    expect(g.teamOf(a)).toBe(0);
    expect(g.teamOf(b)).toBe(1);
    // no AI with both campaigns played: twenty seconds on (an AI would have moved), nothing has
    run(s.sim, 20);
    expect(g.spots.every((q) => q.owner < 0)).toBe(true);
    // Fero pastes two, Jana one
    for (let k = 0; k < 2; k++) {
      goTo(s, a, g, (q) => q.owner < 0);
      s.mini.act(a);
      run(s.sim, 3.2);
    }
    goTo(s, b, g, (q) => q.owner < 0);
    s.mini.act(b);
    run(s.sim, 3.2);
    expect(g.held()).toEqual([2, 1]);
    const board = lastMini(s.priv, a.id)!.board!;
    expect(board[0][1]).toBe(2);
    expect(board[1][1]).toBe(1);
    r.left = 0.1;
    run(s.sim, 0.3);
    expect(lastMini(s.priv, a.id)!.result!.text).toContain('vyhrali ste!');
    expect(lastMini(s.priv, b.id)!.result!.text).toContain('prehrali ste.');
    expect(lastMini(s.priv, a.id)!.result!.place).toBe(1);
    expect(lastMini(s.priv, b.id)!.result!.place).toBe(2);
    expect(miniPay(s.priv, a.id)).toBe(250 + 2 * 5);
    expect(miniPay(s.priv, b.id)).toBe(80 + 5);
    expect(s.globals.some((e) => e.k === 'miniResult' && e.kind === 'billboard' && e.winner === 'Fero')).toBe(true);
  });

  it('a campaign whose players have all gone is run by the AI from then on', () => {
    const s = setupMini(11, 'server');
    const a = addPlayer(s.sim, 'newsnd', 'Fero');
    const b = addPlayer(s.sim, 'newsnd', 'Jana');
    const r = s.mini.start(a, 'billboard')!;
    s.mini.join(b, r.id);
    s.mini.go(a);
    run(s.sim, 3.2);
    const g = s.mini.gameOf(a) as unknown as Game;
    s.mini.leave(b);
    expect(messages(s.priv, a.id).some((m) => m.includes('prevzala agentúra'))).toBe(true);
    run(s.sim, 40);
    expect(g.held()[1]).toBeGreaterThanOrEqual(2);
  });

  it('says so where there\'s nothing to paste on', () => {
    const s = setupMini(12);
    // up in the woods at the map's north-western corner
    const p = addPlayer(s.sim, { x: -1571, y: -1503 });
    expect(s.mini.start(p, 'billboard')).toBeNull();
    expect(messages(s.priv, p.id).slice(-1)[0]).toContain('Tu nie je kde lepiť');
  });
});
