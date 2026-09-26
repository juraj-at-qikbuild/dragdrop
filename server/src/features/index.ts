// The server features the Room runs. Each feature adds its line here (docs/plans/social-events.md).
import { config } from '../config';
import type { Room } from '../Room';
import { Supa } from '../supa';
import { Account } from './Account';
import { Activity } from './Activity';
import { RemoteConfig } from './RemoteConfig';
import type { RoomFeature } from './RoomFeature';

export type { RoomFeature };
export { Activity, RemoteConfig, Supa };

export function createFeatures(room: Room, opts: { supa?: Supa } = {}): RoomFeature[] {
  // tests inject a disabled (or fake-fetch) Supa through RoomOptions.supa; under vitest the default is
  // disabled too, so a test that forgets to inject one still never touches the network
  const supa = opts.supa ?? (process.env.VITEST ? new Supa('', '') : new Supa(config.supabaseUrl, config.supabaseSecretKey));
  supa.start();
  const out: RoomFeature[] = [new RemoteConfig(room, supa, { e2e: config.e2e || room.debug }), new Activity(supa)];
  out.push(new Account(room));
  // each feature adds its line here: out.push(new Party(room)) …
  return out;
}
