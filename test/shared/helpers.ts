import { readFileSync } from 'node:fs';
import path from 'node:path';
import { World } from '../../src/shared/world/World';
import type { MapJSON } from '../../src/shared/types';

let world: World | null = null;
/** the real Bratislava map, loaded once per test file */
export function loadWorld(): World {
  if (!world) world = new World(JSON.parse(readFileSync(path.resolve(__dirname, '../../public/data/bratislava.json'), 'utf8')) as MapJSON);
  return world;
}
