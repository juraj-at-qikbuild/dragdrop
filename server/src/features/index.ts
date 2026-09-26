// The server features the Room runs. Each feature adds its line here (docs/plans/social-events.md).
import { config } from '../config';
import type { Room } from '../Room';
import { Supa } from '../supa';
import { Account } from './Account';
import { Activity } from './Activity';
import { Daily } from './Daily';
import { Party } from './Party';
import { RemoteConfig } from './RemoteConfig';
import type { RoomFeature } from './RoomFeature';
import { Revive } from './Revive';
import { Voice } from './Voice';
import { Race } from './Race';

export type { RoomFeature };
export { Activity, Daily, RemoteConfig, Supa, Voice };

export function createFeatures(room: Room, opts: { supa?: Supa } = {}): RoomFeature[] {
  // tests inject a disabled (or fake-fetch) Supa through RoomOptions.supa; under vitest the default is
  // disabled too, so a test that forgets to inject one still never touches the network
  const supa = opts.supa ?? (process.env.VITEST ? new Supa('', '') : new Supa(config.supabaseUrl, config.supabaseSecretKey));
  supa.start();
  // built directly (not looked up through room.remoteConfig/room.activity) because every feature here
  // is constructed *before* any of them is added to room.features (Room's constructor loop runs after
  // this whole array comes back), so those accessors would still see an empty registry right now
  const remoteConfig = new RemoteConfig(room, supa, { e2e: config.e2e || room.debug });
  const activity = new Activity(supa);
  const out: RoomFeature[] = [remoteConfig, activity];
  out.push(new Account(room));
  out.push(new Revive(room));
  out.push(new Party(room));
  out.push(new Voice(room, remoteConfig, activity));
  out.push(new Daily(room, supa));
  out.push(new Race(room));
  // each feature adds its line here: out.push(new Jobs(room)) …
  return out;
}
