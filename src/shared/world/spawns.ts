// Where a new player starts (a new offline game, a first visit online): one of these places, picked at
// random by Sim.addPlayer when the host asks for it (SimOptions.randomSpawn). Each is open ground at
// street level, clear of buildings, roofs, water and bridge decks, off the carriageway but a short walk
// from it, spread over the map from Podhradie to Eurovea and over the river to Petržalka.
// test/shared/spawns.test.ts checks every one of them on the real map.
import { dist } from '../util/math';

export interface SpawnPlace {
  name: string;
  x: number;
  y: number;
}

export const SPAWNS: readonly SpawnPlace[] = [
  { name: 'Hlavné námestie', x: -346.9, y: -261.9 },
  { name: 'Hviezdoslavovo námestie', x: -309.2, y: -60.2 },
  { name: 'Námestie SNP', x: -156.6, y: -507.7 },
  { name: 'Hodžovo námestie', x: -337, y: -758.8 },
  { name: 'Slovenský rozhlas', x: 109, y: -1520.3 },
  { name: 'Medická záhrada', x: 504.4, y: -921.6 },
  { name: 'Sky Park', x: 908.2, y: -375 },
  { name: 'Eurovea', x: 1076.6, y: 77.9 },
  { name: 'Sad Janka Kráľa', x: -157, y: 899.2 },
  { name: 'Podhradie', x: -709.6, y: -252.5 },
];

/** a new arrival is put this far from a spawn place at most (a step aside when someone stands on it) */
export const SPAWN_SPREAD = 4;

/** the spawn place (x, y) is at, or null: for the welcome that names where a new game starts */
export function spawnAt(x: number, y: number): SpawnPlace | null {
  for (const s of SPAWNS) if (dist(s.x, s.y, x, y) <= SPAWN_SPREAD + 1) return s;
  return null;
}
