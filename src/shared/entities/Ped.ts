// Person state (civilians, cops, players) and on-foot movement. Shared by the browser and the game
// server; drawing lives in src/render/drawPed.ts. Appearance is derived from `seed`, so every client
// draws the same NPC the same way.
import type { World } from '../world/World';
import type { Link } from '../world/Graph';
import type { Vehicle } from './Vehicle';
import { Rng } from '../util/Rng';
import { shade } from '../util/color';

export type PedKind = 'player' | 'civ' | 'cop';
export type PedState = 'walk' | 'flee' | 'dead' | 'chase' | 'idle';
export type Archetype = 'player' | 'cop' | 'suit' | 'tourist' | 'jogger' | 'elderly' | 'student' | 'worker' | 'casual' | 'dress';
export type HairStyle = 'short' | 'long' | 'bun' | 'bald' | 'cap' | 'hat' | 'scarf' | 'helmet';

const SHIRTS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#f4511e', '#00897b', '#6d4c41', '#eceff1', '#212121', '#3949ab', '#c2185b'];
const HAIR = ['#2b1d14', '#4a3222', '#8d6e63', '#d7b377', '#1a1a1a', '#9e9e9e', '#b5651d'];
const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3b', '#f5d6ba'];
const GREY_HAIR = ['#c9c9c9', '#dcdcdc', '#a9a29b'];
const PANTS = ['#263238', '#37474f', '#2b3a67', '#4e342e', '#455a64', '#212121', '#5d4037'];
const BRIGHT = ['#00bcd4', '#ff4081', '#ffca28', '#7cb342', '#ff7043', '#ab47bc'];
const DRESS = ['#c2185b', '#8e24aa', '#d81b60', '#00897b', '#f4511e', '#3949ab', '#e53935'];

/** weighted archetype pool for civilians */
const ARCHETYPES: Archetype[] = ['casual', 'casual', 'casual', 'dress', 'dress', 'suit', 'tourist', 'jogger', 'elderly', 'student', 'worker'];
const HAIRSTYLES: HairStyle[] = ['short', 'short', 'long', 'bun', 'bald', 'cap'];

export type WeaponId = 'fist' | 'pistol' | 'uzi' | 'shotgun';

/** stable per-seed pseudo-random in [0, 1) (dead pose, build) */
export function hashRand(seed: number, salt: number) {
  const x = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** player figure shirt colours, indexed by SimPlayer.look (0 = the classic leather jacket) */
export const PLAYER_SHIRTS = ['#4a3220', '#1565c0', '#2e7d32', '#6a1b9a', '#c62828', '#00838f', '#ef6c00', '#37474f', '#ad1457', '#9e9d24'];

export class Ped {
  /** network id, assigned by Sim.addPed (or the server, for mirrors) */
  id = 0;
  /** drives appearance, gait and the dead pose; sent to clients so they draw the same person */
  seed: number;
  x: number;
  y: number;
  angle = 0;
  vx = 0;
  vy = 0;
  r = 0.34;
  health = 100;
  armor = 0;
  kind: PedKind;
  state: PedState = 'walk';
  shirt = '#4a3220';
  pants = '#26262a';
  hair = '#2a1c10';
  skin = '#f1c9a5';
  hairStyle: HairStyle = 'short';
  archetype: Archetype = 'casual';
  /** mutable appearance tag; other systems may set e.g. 'swat' on a cop */
  outfit = 'casual';
  build = 1;
  walkPhase = 0;
  vehicle: Vehicle | null = null;
  /** bridge deck level: 0 ground/underneath, 1 on the deck (see World.updateLevel) */
  level: 0 | 1 = 0;
  /** false until the first level update places it on/under a deck it spawned on (World.spawnLevel) */
  levelInit = false;
  weapon: WeaponId = 'fist';
  cooldown = 0;
  timer = 0;
  fleeFrom = { x: 0, y: 0 };
  deadTime = 0;
  /** true while surrendering / being arrested-at-gunpoint */
  handsUp = false;
  /** seconds remaining of a white hit-flash; decayed by the renderer */
  hitFlash = 0;
  // navigation on the pedestrian graph
  link: Link | null = null;
  pts: number[] = [];
  idx = 0;
  side = 1;
  speed = 1.4;
  money = 20;
  bustTimer = 0;
  shotAt = 0;
  /** the player this figure belongs to (0 = NPC) */
  playerId = 0;
  /** player figures: index into PLAYER_SHIRTS */
  look = 0;
  /** posed from outside the local simulation (a mirror, or a player on the server): never moved by AI */
  kinematic = false;
  /** cops: the player they are after (0 = whoever is nearest and wanted) */
  targetPid = 0;

  constructor(kind: PedKind, x: number, y: number, seed: number) {
    this.kind = kind;
    this.x = x;
    this.y = y;
    this.seed = seed >>> 0;
    applyAppearance(this);
  }

  get dead() {
    return this.state === 'dead';
  }

  /** Move with velocity and resolve collisions against buildings. */
  move(dt: number, world: World, vx: number, vy: number) {
    this.vx = vx;
    this.vy = vy;
    this.x += vx * dt;
    this.y += vy * dt;
    const hit = world.collideCircle(this.x, this.y, this.r);
    if (hit) {
      this.x += hit.nx * hit.depth;
      this.y += hit.ny * hit.depth;
    }
    const sp = Math.hypot(vx, vy);
    if (sp > 0.1) {
      this.walkPhase += sp * dt * 3.2;
      const target = Math.atan2(vy, vx);
      let d = target - this.angle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.angle += d * Math.min(1, dt * 14);
    }
    return !!hit;
  }

  kill(fromX: number, fromY: number, force = 4) {
    if (this.dead) return;
    this.state = 'dead';
    this.health = 0;
    const d = Math.hypot(this.x - fromX, this.y - fromY) || 1;
    this.vx = ((this.x - fromX) / d) * force;
    this.vy = ((this.y - fromY) / d) * force;
    this.deadTime = 0;
  }

  /** Flash white briefly (call from combat code on a successful hit). */
  hit() {
    this.hitFlash = 0.14;
  }
}

/** Derive everything cosmetic (and a few gait/wallet traits) from `p.kind` and `p.seed`. */
export function applyAppearance(p: Ped) {
  const r = new Rng(p.seed);
  const pick = <T>(a: readonly T[]) => r.pick(a);
  p.build = 0.92 + hashRand(p.seed, 9) * 0.22;
  p.walkPhase = r.next() * 10;
  p.side = r.next() < 0.5 ? 1 : -1;
  p.speed = 1.2 + r.next() * 0.5;
  p.money = Math.round(5 + r.next() * 40);
  p.hair = pick(HAIR);
  if (p.kind === 'player') {
    p.archetype = 'player';
    p.outfit = 'player';
    p.shirt = PLAYER_SHIRTS[p.look % PLAYER_SHIRTS.length];
    p.pants = '#26262a';
    p.hair = '#2a1c10';
    p.hairStyle = 'short';
    p.skin = '#f1c9a5';
  } else if (p.kind === 'cop') {
    p.archetype = 'cop';
    p.outfit = p.outfit === 'swat' ? 'swat' : 'police';
    p.shirt = '#1a3f9c';
    p.pants = '#0c1a45';
    p.hair = '#10205a';
    p.hairStyle = 'cap';
    p.skin = pick(SKIN);
    p.weapon = 'pistol';
    p.speed = 4.2;
  } else {
    const a = pick(ARCHETYPES);
    p.archetype = a;
    p.outfit = a;
    p.skin = pick(SKIN);
    p.hairStyle = pick(HAIRSTYLES);
    switch (a) {
      case 'suit':
        p.shirt = pick(['#1f2430', '#263238', '#37474f', '#2b2b2b']);
        p.pants = shade(p.shirt, -0.2);
        p.hairStyle = pick(['short', 'bald', 'short']);
        break;
      case 'tourist':
        p.shirt = pick(BRIGHT);
        p.pants = '#c9b48a';
        p.hairStyle = pick(['hat', 'cap', 'short', 'long']);
        break;
      case 'jogger':
        p.shirt = pick(BRIGHT);
        p.pants = '#212121';
        p.hairStyle = pick(['short', 'bun', 'long']);
        p.speed *= 1.15;
        break;
      case 'elderly':
        p.shirt = pick(['#78716c', '#8d8577', '#6b7a5e', '#5c6b73']);
        p.pants = '#616161';
        p.hair = pick(GREY_HAIR);
        p.hairStyle = pick(['short', 'bald', 'scarf']);
        p.speed *= 0.7;
        break;
      case 'student':
        p.shirt = pick(['#3949ab', '#00897b', '#6d4c41', '#455a64', '#c2185b']);
        p.pants = '#2b3a67';
        p.hairStyle = pick(['long', 'short', 'cap']);
        break;
      case 'worker':
        p.shirt = '#ff6f00';
        p.pants = '#37474f';
        p.hairStyle = 'helmet';
        break;
      case 'dress':
        p.shirt = pick(DRESS);
        p.pants = p.shirt;
        p.hairStyle = pick(['long', 'bun', 'short', 'scarf']);
        break;
      default:
        p.shirt = pick(SHIRTS);
        p.pants = pick(PANTS);
    }
  }
}

/** Turn a figure into a player with the given shirt colour. */
export function setPlayerLook(p: Ped, look: number) {
  p.look = look;
  p.shirt = PLAYER_SHIRTS[look % PLAYER_SHIRTS.length];
}
