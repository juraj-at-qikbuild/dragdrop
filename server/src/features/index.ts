// The server features the Room runs. Each feature adds its line here (docs/plans/social-events.md).
import type { Room } from '../Room';
import type { RoomFeature } from './RoomFeature';

export type { RoomFeature };

export function createFeatures(_room: Room): RoomFeature[] {
  const out: RoomFeature[] = [];
  // out.push(new Party(room)) …
  return out;
}
