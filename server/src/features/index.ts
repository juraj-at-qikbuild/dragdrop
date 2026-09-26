// The server features the Room runs. Each feature adds its line here (docs/plans/social-events.md).
import { config } from '../config';
import type { Room } from '../Room';
import { Supa } from '../supa';
import { Activity } from './Activity';
import { RemoteConfig } from './RemoteConfig';
import type { RoomFeature } from './RoomFeature';

export type { RoomFeature };
export { Activity, RemoteConfig, Supa };

export function createFeatures(room: Room, opts: { supa?: Supa } = {}): RoomFeature[] {
  // tests inject a disabled (or fake-fetch) Supa through RoomOptions.supa so they never touch the network
  const supa = opts.supa ?? new Supa(config.supabaseUrl, config.supabaseSecretKey);
  supa.start();
  const remoteConfig = new RemoteConfig(room, supa, { e2e: config.e2e || room.debug });
  const activity = new Activity(supa);
  return [remoteConfig, activity];
  // out.push(new Party(room)) …
}
