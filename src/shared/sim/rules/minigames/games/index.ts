// Every mini-game the rule knows (docs/plans/minigames.md). Each game adds its line here, and nothing
// else outside its own files, so they can be built side by side.
import type { MiniGameDef } from '../MiniGame';
import { TOILET_DEF } from './toilet';

export const MINI_DEFS: MiniGameDef[] = [
  TOILET_DEF,
  // each game adds its line here …
];
