// Helpers for the mini-games' tests (docs/plans/minigames.md): a Sim on the real map with no NPCs (a
// game adds its own), what a player was sent, and stepping the city along.
import { Sim } from '../../../src/shared/sim/Sim';
import { Rng } from '../../../src/shared/util/Rng';
import { nullEvents, type GlobalEvent, type PrivateEvent } from '../../../src/shared/sim/events';
import type { MiniGames } from '../../../src/shared/sim/rules/minigames/MiniGames';
import type { MiniState } from '../../../src/shared/sim/rules/minigames/types';
import type { SimPlayer } from '../../../src/shared/sim/SimPlayer';
import { loadWorld } from '../helpers';

export { loadWorld };

export const profile = (money = 100) => ({ money, done: [], found: [...loadWorld().landmarks.keys()], cumils: [] });
/** no NPC ever spawns, so a scenario stays exactly what the test sets up */
export const NO_NPCS = { traffic: 0, parked: 0, peds: 0, trams: 0, police: 0, helis: 0, roadblocks: 0 };

export interface MiniSetup {
  sim: Sim;
  mini: MiniGames;
  priv: [number, PrivateEvent][];
  globals: GlobalEvent[];
  /** points scored per player id (Sim.onScore), as the server's leaderboard would count them */
  scored: Map<number, number>;
}

/** A Sim with the rules of `mode` ('server': the online rules, several players), recording events. */
export function setupMini(seed = 1, mode: 'offline' | 'server' = 'offline', caps: Record<string, number> = NO_NPCS): MiniSetup {
  const priv: [number, PrivateEvent][] = [];
  const globals: GlobalEvent[] = [];
  const scored = new Map<number, number>();
  const sim = new Sim(loadWorld(), {
    rng: new Rng(seed), caps: { ...NO_NPCS, ...caps } as never, rules: mode,
    events: { ...nullEvents, toPlayer: (pid, e) => priv.push([pid, e]), global: (e) => globals.push(e) },
  });
  sim.onScore = (p, n) => {
    scored.set(p.id, (scored.get(p.id) ?? 0) + n);
    return n;
  };
  return { sim, mini: sim.rule<MiniGames>('minigames')!, priv, globals, scored };
}

/** a player standing at a landmark (by id: 'main', 'castle', 'eurovea'…), or at (x, y) */
export function addPlayer(sim: Sim, at: string | { x: number; y: number }, nick = 'A', money = 100): SimPlayer {
  const w = sim.world;
  const pos = typeof at === 'string' ? w.walkableNear(w.landmark(at)!.x, w.landmark(at)!.y) : at;
  const p = sim.addPlayer({ nick, profile: profile(money), kinematic: false, x: pos.x, y: pos.y });
  Object.assign(p.observer, { fx: pos.x, fy: pos.y, cx: pos.x, cy: pos.y });
  return p;
}

/** step the city along for `secs` seconds (at 20 Hz, like the server) */
export function run(sim: Sim, secs: number, each?: () => void) {
  const dt = 0.05;
  for (let t = 0; t < secs; t += dt) {
    sim.step(dt);
    each?.();
  }
}

/** the latest `mini` state this player was sent (undefined: never; null: none any more) */
export function lastMini(priv: [number, PrivateEvent][], pid: number): MiniState | null | undefined {
  let s: MiniState | null | undefined;
  for (const [id, e] of priv) if (id === pid && e.k === 'mini') s = e.s;
  return s;
}

/** the lines this player was shown */
export function messages(priv: [number, PrivateEvent][], pid: number): string[] {
  return priv.filter((e): e is [number, Extract<PrivateEvent, { k: 'msg' }>] => e[0] === pid && e[1].k === 'msg').map(([, e]) => e.text);
}

/** what this player was paid for mini-games */
export function miniPay(priv: [number, PrivateEvent][], pid: number): number {
  let n = 0;
  for (const [id, e] of priv) if (id === pid && e.k === 'payout' && e.reason === 'minigame') n += e.amount;
  return n;
}

/** put a player's figure exactly here, stopped (out of any car) */
export function standAt(p: SimPlayer, x: number, y: number) {
  p.ped.x = x;
  p.ped.y = y;
  p.ped.vx = p.ped.vy = 0;
  Object.assign(p.observer, { fx: x, fy: y, cx: x, cy: y });
}

/** start a round of `kind` for `p` and cut the lobby short; returns the live state */
export function startLive(s: MiniSetup, p: SimPlayer, kind: MiniState['kind']) {
  const r = s.mini.start(p, kind);
  if (!r) throw new Error(`could not start ${kind}: ${messages(s.priv, p.id).slice(-1)[0] ?? '?'}`);
  s.mini.go(p);
  run(s.sim, 3.2);
  return r;
}
