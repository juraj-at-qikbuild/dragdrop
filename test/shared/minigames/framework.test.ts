// The mini-games' rule (src/shared/sim/rules/minigames/MiniGames.ts, docs/plans/minigames.md): a
// round's lobby (a count-in alone, a wait when others could join), joining and leaving, the action
// key, the end (the pay, the points, the news of a group round), what each player is sent, and how it
// gets along with the jobs. A tiny test game stands in for the real ones.
import { describe, expect, it } from 'vitest';
import { MiniGame, type MiniGameDef, type MiniView } from '../../../src/shared/sim/rules/minigames/MiniGame';
import { LOBBY_S, LOBBY_SOLO_S, DONE_S, JOIN_R, MAX_PAY, MiniGames } from '../../../src/shared/sim/rules/minigames/MiniGames';
import { isMiniReq, MINI_KINDS } from '../../../src/shared/sim/rules/minigames/types';
import { MINI_INFO } from '../../../src/shared/sim/rules/minigames/catalog';
import type { Jobs } from '../../../src/shared/sim/rules/jobs/Jobs';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { addPlayer, lastMini, messages, miniPay, run, setupMini, standAt } from './helpers';

/** a game that ends when every player has pressed the action key: 100 points and €50 each */
class Presses extends MiniGame {
  pressed = new Set<number>();
  started = false;
  left: number[] = [];
  start() {
    this.started = true;
  }
  update() {
    if (this.players.length && this.players.every((p) => this.pressed.has(p.id))) this.finish();
  }
  act(p: SimPlayer) {
    if (this.pressed.has(p.id)) return;
    this.pressed.add(p.id);
    this.addPoints(p, 100 - this.pressed.size);
    this.outcome(p, { pay: 50, text: 'Stlačené!' });
  }
  onLeave(p: SimPlayer) {
    this.left.push(p.id);
  }
  view(p: SimPlayer): MiniView {
    return { goal: this.pressed.has(p.id) ? 'Čakaj' : 'Stlač B', act: this.pressed.has(p.id) ? undefined : 'Stlačiť' };
  }
}

const games: Presses[] = [];
const TEST_DEF: MiniGameDef = {
  kind: 'toilet',
  create(sim, round) {
    const g = new Presses(sim, round);
    games.push(g);
    return g;
  },
};

function withTestGame(mode: 'offline' | 'server' = 'offline') {
  const s = setupMini(1, mode);
  s.mini.register(TEST_DEF);
  return s;
}

describe('mini-games: the catalog and the wire', () => {
  it('describes every kind, with a player limit', () => {
    for (const k of MINI_KINDS) {
      const i = MINI_INFO[k];
      expect(i.title.length).toBeGreaterThan(3);
      expect(i.about.length).toBeGreaterThan(20);
      expect(i.max).toBeGreaterThanOrEqual(1);
    }
  });

  it('checks the shape of a request', () => {
    expect(isMiniReq({ op: 'start', kind: 'toilet' })).toBe(true);
    expect(isMiniReq({ op: 'start', kind: 'nope' })).toBe(false);
    expect(isMiniReq({ op: 'join', id: 3 })).toBe(true);
    expect(isMiniReq({ op: 'join', id: -1 })).toBe(false);
    expect(isMiniReq({ op: 'join', id: 1.5 })).toBe(false);
    expect(isMiniReq({ op: 'act' })).toBe(true);
    expect(isMiniReq({ op: 'hack' })).toBe(false);
    expect(isMiniReq(null)).toBe(false);
  });
});

describe('mini-games: a round alone', () => {
  it('counts in, goes live, takes the action key, pays and scores at the end, then goes', () => {
    const s = withTestGame();
    const p = addPlayer(s.sim, 'main');
    const r = s.mini.start(p, 'toilet')!;
    expect(r).toBeTruthy();
    expect(r.phase).toBe('lobby');
    // alone offline: just the count-in
    expect(r.left).toBe(LOBBY_SOLO_S);
    expect(lastMini(s.priv, p.id)?.phase).toBe('lobby');
    run(s.sim, LOBBY_SOLO_S + 0.2);
    expect(r.phase).toBe('live');
    const g = games[games.length - 1];
    expect(g.started).toBe(true);
    run(s.sim, 0.3);
    expect(lastMini(s.priv, p.id)?.act).toBe('Stlačiť');
    const money = p.profile.money;
    s.mini.act(p);
    run(s.sim, 0.1);
    expect(r.phase).toBe('done');
    expect(p.profile.money).toBe(money + 50);
    expect(miniPay(s.priv, p.id)).toBe(50);
    // €50 is 10 points
    expect(s.scored.get(p.id)).toBe(10);
    expect(lastMini(s.priv, p.id)?.result).toMatchObject({ text: 'Stlačené!', pay: 50 });
    expect(p.profile.stats?.mini_toilet).toBe(1);
    // the result shows for a while, then the round is gone
    run(s.sim, DONE_S + 0.2);
    expect(s.mini.all.length).toBe(0);
    expect(lastMini(s.priv, p.id)).toBeNull();
  });

  it('a new round right after the result replaces it', () => {
    const s = withTestGame();
    const p = addPlayer(s.sim, 'main');
    s.mini.start(p, 'toilet');
    run(s.sim, LOBBY_SOLO_S + 0.2);
    s.mini.act(p);
    run(s.sim, 3.2);
    expect(s.mini.roundOf(p)?.phase).toBe('done');
    expect(s.mini.start(p, 'toilet')).toBeTruthy();
    expect(s.mini.roundOf(p)?.phase).toBe('lobby');
  });

  it('leaving gets you nothing and ends a round nobody plays any more', () => {
    const s = withTestGame();
    const p = addPlayer(s.sim, 'main');
    s.mini.start(p, 'toilet');
    run(s.sim, LOBBY_SOLO_S + 0.2);
    const money = p.profile.money;
    s.mini.leave(p);
    expect(s.mini.all.length).toBe(0);
    expect(lastMini(s.priv, p.id)).toBeNull();
    expect(p.profile.money).toBe(money);
  });

  it('is out of the round when wasted', () => {
    const s = withTestGame();
    const p = addPlayer(s.sim, 'main');
    s.mini.start(p, 'toilet');
    run(s.sim, LOBBY_SOLO_S + 0.2);
    s.sim.wasted(p);
    expect(s.mini.roundOf(p)).toBeUndefined();
    expect(messages(s.priv, p.id)).toContain('Vypadol si z hry.');
  });

  it('one thing at a time: no round during a job, no job during a round, none with the police after you', () => {
    const s = withTestGame();
    const p = addPlayer(s.sim, 'main');
    const jobs = s.sim.rule<Jobs>('jobs')!;
    jobs.start(p, 'courier');
    expect(jobs.active(p)).toBe(true);
    expect(s.mini.start(p, 'toilet')).toBeNull();
    expect(messages(s.priv, p.id)).toContain('Najprv ukonči prácu (J).');
    jobs.stop(p);
    expect(s.mini.start(p, 'toilet')).toBeTruthy();
    jobs.start(p, 'courier');
    expect(jobs.active(p)).toBe(false);
    s.mini.leave(p);
    p.wanted = 2;
    run(s.sim, 3.5);
    expect(s.mini.start(p, 'toilet')).toBeNull();
  });

  it('refuses a kind nobody registered', () => {
    const s = setupMini(1, 'offline');
    const p = addPlayer(s.sim, 'main');
    const empty = new MiniGames(s.sim, 'offline', []);
    expect(empty.start(p, 'parking')).toBeNull();
  });
});

describe('mini-games: a round with others (online)', () => {
  it('waits in the lobby while others could join, lets them in, and its starter can go at once', () => {
    const s = withTestGame('server');
    const a = addPlayer(s.sim, 'main', 'Fero');
    const b = addPlayer(s.sim, 'main', 'Jana');
    const r = s.mini.start(a, 'toilet')!;
    expect(r.left).toBe(LOBBY_S);
    // Rádio Kecy hears of it
    expect(s.globals.some((e) => e.k === 'miniOpen' && e.nick === 'Fero')).toBe(true);
    expect(s.mini.open().map((o) => o.id)).toContain(r.id);
    expect(s.mini.join(b, r.id)).toBe(true);
    expect(r.players).toEqual([a, b]);
    // the lobby's "start now" is the starter's
    expect(lastMini(s.priv, a.id)?.act).toBe('Začať hneď');
    run(s.sim, 0.3);
    expect(lastMini(s.priv, b.id)?.act).toBeUndefined();
    s.mini.act(b);
    expect(r.phase).toBe('lobby');
    s.mini.act(a);
    run(s.sim, LOBBY_SOLO_S + 0.2);
    expect(r.phase).toBe('live');
    expect(r.started).toBe(2);
    // not joinable once it's live (this game takes no latecomers)
    expect(s.mini.open().length).toBe(0);
  });

  it('pays everyone, ranks them, and makes the news', () => {
    const s = withTestGame('server');
    const a = addPlayer(s.sim, 'main', 'Fero');
    const b = addPlayer(s.sim, 'main', 'Jana');
    const r = s.mini.start(a, 'toilet')!;
    s.mini.join(b, r.id);
    s.mini.go(a);
    run(s.sim, LOBBY_SOLO_S + 0.2);
    s.mini.act(b);
    s.mini.act(a);
    run(s.sim, 0.1);
    expect(r.phase).toBe('done');
    expect(lastMini(s.priv, b.id)?.result?.place).toBe(1);
    expect(lastMini(s.priv, a.id)?.result?.place).toBe(2);
    expect(lastMini(s.priv, a.id)?.board?.[0][0]).toBe('Jana');
    const news = s.globals.find((e) => e.k === 'miniResult');
    expect(news).toMatchObject({ k: 'miniResult', kind: 'toilet', winner: 'Jana', n: 2, won: true });
  });

  it('keeps out whoever is too far, and anyone once it is full', () => {
    const s = withTestGame('server');
    const a = addPlayer(s.sim, 'main', 'Fero');
    const far = addPlayer(s.sim, 'castle', 'Ďaleko');
    const r = s.mini.start(a, 'toilet')!;
    const f = far.focus();
    standAt(far, r.x + JOIN_R + 50, r.y);
    expect(s.mini.join(far, r.id)).toBe(false);
    expect(messages(s.priv, far.id)).toContain('Si od hry priďaleko – príď bližšie.');
    standAt(far, f.x, f.y);
    // a party-mate can join from anywhere
    far.partyId = a.partyId = 7;
    expect(s.mini.join(far, r.id)).toBe(true);
    const max = MINI_INFO.toilet.max;
    for (let i = r.players.length; i < max; i++) expect(s.mini.join(addPlayer(s.sim, 'main', `P${i}`), r.id)).toBe(true);
    const late = addPlayer(s.sim, 'main', 'Neskoro');
    expect(s.mini.join(late, r.id)).toBe(false);
    expect(messages(s.priv, late.id)).toContain('Hra je plná.');
  });

  it('the lobby passes on to the next player when its starter leaves', () => {
    const s = withTestGame('server');
    const a = addPlayer(s.sim, 'main', 'Fero');
    const b = addPlayer(s.sim, 'main', 'Jana');
    const r = s.mini.start(a, 'toilet')!;
    s.mini.join(b, r.id);
    s.mini.leave(a);
    expect(r.owner).toBe(b);
    expect(s.mini.open()[0].nick).toBe('Jana');
    // a player removed from the city (dropped for good) leaves too
    s.sim.removePlayer(b);
    expect(s.mini.all.length).toBe(0);
  });

  it('won\'t shield an away player in a round others play', () => {
    const s = withTestGame('server');
    const a = addPlayer(s.sim, 'main', 'Fero');
    const b = addPlayer(s.sim, 'main', 'Jana');
    const r = s.mini.start(a, 'toilet')!;
    expect(s.mini.allowShield(a)).toBe(true);
    s.mini.join(b, r.id);
    s.mini.go(a);
    run(s.sim, LOBBY_SOLO_S + 0.2);
    expect(s.mini.allowShield(a)).toBe(false);
  });

  it('caps the pay of a round', () => {
    const s = setupMini(1, 'offline');
    const p = addPlayer(s.sim, 'main');
    class Greedy extends MiniGame {
      start() {
        this.outcome(p, { pay: 99999, text: 'Všetko!' });
        this.finish();
      }
      update() {}
      view() {
        return { goal: '' };
      }
    }
    s.mini.register({ kind: 'toilet', create: (sim, round) => new Greedy(sim, round) });
    s.mini.start(p, 'toilet');
    run(s.sim, LOBBY_SOLO_S + 0.3);
    expect(miniPay(s.priv, p.id)).toBe(MAX_PAY);
  });
});
