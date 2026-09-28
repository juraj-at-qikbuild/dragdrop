// Every mini-game the rule knows (docs/plans/minigames.md). Each game adds its line here, and nothing
// else outside its own files, so they can be built side by side.
import type { MiniGameDef } from '../MiniGame';
import { TOILET_DEF } from './toilet';
import { BUTTER_DEF } from './butter';
import { PUNCH_DEF } from './punch';
import { BILLBOARD_DEF } from './billboard';
import { SCOOTERS_DEF } from './scooters';
import { FLOOD_DEF } from './flood';
import { HEAT_DEF } from './heat';
import { PARKING_DEF } from './parking';
import { ROADWORKS_DEF } from './roadworks';

export const MINI_DEFS: MiniGameDef[] = [
  TOILET_DEF,
  BUTTER_DEF,
  PUNCH_DEF,
  BILLBOARD_DEF,
  SCOOTERS_DEF,
  FLOOD_DEF,
  HEAT_DEF,
  PARKING_DEF,
  ROADWORKS_DEF,
  // each game adds its line here …
];
