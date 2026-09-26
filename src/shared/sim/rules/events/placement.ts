// Where to put a world event: helpers the event kinds share (Kofolka, the Čumil hunt, the armoured
// van…), so every kind measures "near the players" and "clear of the players" the same way.
// Plan: docs/plans/social-events.md
import type { Sim } from '../../Sim';
import { dist } from '../../../util/math';

/** the observing players' centroid, or null when there are none (nothing to place near) */
export function centroidOf(sim: Sim): { x: number; y: number } | null {
  const obs = sim.observers();
  if (!obs.length) return null;
  let x = 0, y = 0;
  for (const p of obs) {
    const f = p.focus();
    x += f.x;
    y += f.y;
  }
  return { x: x / obs.length, y: y / obs.length };
}

/** true when (x, y) is at least `minD` metres from every player (connected or not) */
export function clearOfPlayers(sim: Sim, x: number, y: number, minD: number): boolean {
  for (const p of sim.players.values()) {
    const f = p.focus();
    if (dist(x, y, f.x, f.y) < minD) return false;
  }
  return true;
}
