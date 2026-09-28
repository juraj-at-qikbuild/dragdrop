// Every mini-game the rule knows (docs/plans/minigames.md), in the catalog's order. Each game adds its
// line here, and nothing else outside its own files, so they can be built side by side.
import type { MiniGameDef } from '../MiniGame';
import { PARKING_DEF } from './parking';
import { REVIZOR_DEF } from './revizor';
import { FOOTBALL_DEF } from './football';
import { BUTTER_DEF } from './butter';
import { BILLBOARD_DEF } from './billboard';
import { PUNCH_DEF } from './punch';
import { SCOOTERS_DEF } from './scooters';
import { ROADWORKS_DEF } from './roadworks';
import { TRAM_DEF } from './tram';
import { FLOOD_DEF } from './flood';
import { HEAT_DEF } from './heat';
import { TOILET_DEF } from './toilet';

export const MINI_DEFS: MiniGameDef[] = [
  PARKING_DEF,
  REVIZOR_DEF,
  FOOTBALL_DEF,
  BUTTER_DEF,
  BILLBOARD_DEF,
  PUNCH_DEF,
  SCOOTERS_DEF,
  ROADWORKS_DEF,
  TRAM_DEF,
  FLOOD_DEF,
  HEAT_DEF,
  TOILET_DEF,
  // a new game adds its line here …
];
