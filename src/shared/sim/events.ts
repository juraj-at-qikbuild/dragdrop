// Everything the simulation wants the outside world to *see or hear* goes through a SimEvents sink
// instead of calling audio/particles/HUD directly. The browser maps events to effects (ClientEvents);
// the server batches them into network messages for clients in range (NetEvents).
import type { Level } from '../world/World';
import type { WeaponId } from '../entities/Ped';

/** Messages meant for one player only (HUD, sounds, their own car). */
export type PrivateEvent =
  | { k: 'msg'; title: string; text: string; time: number; color: string }
  /** took damage from (fx, fy) */
  | { k: 'hurt'; dmg: number; fx: number; fy: number }
  /** wanted level went up a star */
  | { k: 'stars' }
  | { k: 'jingle'; good: boolean }
  /** style/kill bonus shown as floating text (e.g. KILL, ROADKILL, TAKEDOWN!) */
  | { k: 'style'; label: string; cash: number; x: number; y: number }
  | { k: 'cash'; amount: number; x: number; y: number }
  | { k: 'pickup'; kind: string; amount: number }
  /** discovered a landmark (+ reward); the client formats the text */
  | { k: 'found'; id: string; reward: number }
  | { k: 'cumil'; id: number; count: number; reward: number }
  | { k: 'down'; state: 'wasted' | 'busted' }
  | { k: 'respawn'; x: number; y: number; busted: boolean; poi: string; fee: number; epoch: number }
  /** answer to an enter-vehicle request */
  | { k: 'enter'; vehicle: number; ok: boolean }
  /** thrown out of your car (carjacked) */
  | { k: 'eject'; vehicle: number; x: number; y: number }
  /** the server damaged the car you drive (explosion, gunfire): apply it to your simulation */
  | { k: 'vehDamage'; vehicle: number; amount: number; dvx: number; dvy: number; dav: number }
  /** spray shop: repaint + repair the car you drive */
  | { k: 'spray'; vehicle: number; color: string }
  /** spikes burst your tyres */
  | { k: 'tyres'; vehicle: number }
  /** a car/tram knocked you over: shove your figure */
  | { k: 'knock'; dx: number; dy: number };

export type KillCause = 'shot' | 'melee' | 'road' | 'tram' | 'blast';

export interface ShotFx {
  /** ped id of the shooter (0 = helicopter) */
  by: number;
  /** player id of the shooter, 0 for NPCs */
  pid: number;
  x: number;
  y: number;
  a: number;
  w: WeaponId;
  lvl: Level;
  /** tracer end points, flat [x, y, ...] */
  ends: number[];
  /** bit i set: pellet i ended on a wall or car (spark there) */
  sparks: number;
}

export interface SimEvents {
  shot(e: ShotFx): void;
  /** a punch: landed or whiffed */
  melee(x: number, y: number, hit: boolean): void;
  /** a ped took a hit: blood (size ~0.3..1) and a hit flash */
  pedHit(pedId: number, x: number, y: number, size: number): void;
  /** kind: 0 bullet spark, 1 metal (car contact), 2 glass */
  spark(x: number, y: number, kind: 0 | 1 | 2): void;
  explode(x: number, y: number, vehicleId: number, color: string | null): void;
  /** a hard vehicle impact: `sev` drives the crunch sound; `kick` > 0 also shakes the camera of whoever
   *  is in (or near) the car, pushed along n (pointing away from what it hit) */
  crash(vehicleId: number, x: number, y: number, sev: number, nx: number, ny: number, kick: number): void;
  pedKilled(pedId: number, x: number, y: number, byPid: number, cause: KillCause): void;
  scream(x: number, y: number): void;
  bell(x: number, y: number): void;
  horn(vehicleId: number, x: number, y: number): void;
  /** someone says something (a speech bubble): `line` from phrases.ts `pickLine` */
  say(pedId: number, x: number, y: number, line: number): void;
  toPlayer(pid: number, e: PrivateEvent): void;
}

/** Discards everything (tests, headless benchmarks). */
export const nullEvents: SimEvents = {
  shot() {},
  melee() {},
  pedHit() {},
  spark() {},
  explode() {},
  crash() {},
  pedKilled() {},
  scream() {},
  bell() {},
  horn() {},
  say() {},
  toPlayer() {},
};
