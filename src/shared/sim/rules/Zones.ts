// Named polygon zones (a world event's arena while it's live, a safe zone…): membership tests, plus
// the parking-lot picker the derby event uses to find a candidate arena. Built on pointInRings.
// Plan: docs/plans/social-events.md
import type { World } from '../../world/World';
import { bboxOf, pointInRings, ringArea, type BBox } from '../../util/math';

export interface Zone {
  name: string;
  kind: string;
  /** flat rings, outer first then any holes (the same shape World's own areas use) */
  rings: ArrayLike<number>[];
}

interface Entry extends Zone {
  bbox: BBox;
}

/** A small registry of named polygons that come and go (an event's arena, typically just one at a
 *  time). `zoneAt` checks the most recently added zone first, in case two ever overlap. */
export class Zones {
  private list: Entry[] = [];

  add(name: string, rings: ArrayLike<number>[], kind: string) {
    this.remove(name);
    this.list.push({ name, kind, rings, bbox: bboxOf(rings[0]) });
  }

  remove(name: string) {
    this.list = this.list.filter((z) => z.name !== name);
  }

  /** the zone (x, y) is inside, or null */
  zoneAt(x: number, y: number): Zone | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const z = this.list[i], b = z.bbox;
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && pointInRings(x, y, z.rings)) return z;
    }
    return null;
  }

  /** is (x, y) inside the named zone (false when there's no such zone right now) */
  inZone(name: string, x: number, y: number): boolean {
    const z = this.list.find((zz) => zz.name === name);
    return !!z && pointInRings(x, y, z.rings);
  }
}

/** The largest parking-lot ring within `maxDist` of a landmark (a candidate derby arena), or null
 *  when the landmark isn't on this map or every lot is too far. `cx, cy` is its bbox centre: lots are
 *  roughly rectangular, so that sits inside them (the same centre AI.ts's own lot picker uses). */
export function bestParkingNear(world: World, landmarkId: string, maxDist: number): { ring: number[]; cx: number; cy: number; area: number } | null {
  const l = world.landmarks.get(landmarkId);
  if (!l) return null;
  let best: { ring: number[]; cx: number; cy: number; area: number } | null = null;
  for (const rings of world.data.areas.parking) {
    const ring = rings[0];
    if (!ring || ring.length < 6) continue;
    const b = bboxOf(ring);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    if (Math.hypot(cx - l.x, cy - l.y) > maxDist) continue;
    const area = ringArea(ring);
    if (!best || area > best.area) best = { ring, cx, cy, area };
  }
  return best;
}
