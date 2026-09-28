// Every mini-game the rule knows (docs/plans/minigames.md). Each game adds its line here, and nothing
// else outside its own files, so they can be built side by side.
import type { MiniGameDef } from '../MiniGame';
import { TOILET_DEF } from './toilet';
import { FOOTBALL_DEF } from './football';

export const MINI_DEFS: MiniGameDef[] = [
  TOILET_DEF,
  FOOTBALL_DEF,
  // each game adds its line here …
];
