import { World } from '../world/World';
import { Renderer, type View } from '../world/Renderer';
import { Input } from './Input';
import { AI } from './AI';
import { Combat, WEAPONS } from './Combat';
import { Audio } from '../audio/Audio';
import { Ped, type WeaponId } from '../entities/Ped';
import { Vehicle, resolveContact } from '../entities/Vehicle';
import type { Tram } from '../entities/Tram';
import { SpatialHash } from '../util/SpatialHash';
import { MissionManager } from '../missions/Missions';
import { Hud } from '../ui/Hud';
import { MapView } from '../ui/MapView';
import { LANDMARK_INFO, RADIO, BRAND_COLORS } from '../data/brands';
import { clamp, dist, formatMoney, lerp, rand, rng } from '../util/math';
import type { MapJSON } from '../types';
import { Atmosphere } from '../world/Atmosphere';
import { LightLayer } from '../world/Lighting';
import { Weather } from '../world/Weather';
import { PostFX } from '../render/PostFX';

export interface SaveData {
  money: number;
  done: string[];
  found: string[];
  cumils: number[];
  /** time of day in hours */
  clock?: number;
}

const SAVE_KEY = 'blava-city-save-v1';

interface Pickup {
  x: number;
  y: number;
  kind: 'cash' | 'health' | 'pistol' | 'uzi' | 'shotgun' | 'cumil';
  amount: number;
  respawn: number; // seconds, 0 = one-off
  hidden: number;
  id?: number;
}

export interface Msg {
  title: string;
  text: string;
  time: number;
  color: string;
}

export class Game {
  world: World;
  renderer: Renderer;
  input: Input;
  audio: Audio;
  ai!: AI;
  combat: Combat;
  missions!: MissionManager;
  hud: Hud;
  mapView: MapView;
  atmos: Atmosphere;
  light = new LightLayer();
  weather = new Weather();
  /** 1 = full quality, 0 = low (kept for old call sites: true whenever qualityTier > 0) */
  quality = 1;
  /** 2 = high, 1 = medium, 0 = low — drives PostFX detail and quality (see `trackFrameTime`) */
  qualityTier: 0 | 1 | 2 = 2;
  /** user choice from the pause menu: 'auto' adapts qualityTier to frame time, others pin it */
  qualityPref: 'auto' | 'high' | 'medium' | 'low' = 'auto';
  private frameAvg = 16;
  private goodTimer = 0;
  private slowTimer = 0;
  private lastFrameT = 0;
  private baseLightRes: number | null = null;
  private vignette: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D;
  /** GPU post-processing (bloom/grade/vignette/grain/fx); null-safe no-ops when WebGL is unavailable */
  postFx: PostFX | null = null;
  /** transparent overlay canvas the HUD + full map draw into, so post-processing never touches them */
  private hudCanvas: HTMLCanvasElement | null = null;
  private hudCtx: CanvasRenderingContext2D | null = null;
  dpr = 1;
  viewW = 0;
  viewH = 0;
  cam = { x: 0, y: 0, scale: 8 };
  player: Ped;
  vehicles: Vehicle[] = [];
  peds: Ped[] = [];
  trams: Tram[] = [];
  pickups: Pickup[] = [];
  wanted = 0;
  private unseen = 0;
  playerShotCops = false;
  save: SaveData = { money: 0, done: [], found: [], cumils: [] };
  state: 'play' | 'wasted' | 'busted' = 'play';
  stateTimer = 0;
  paused = false;
  showMap = false;
  messages: Msg[] = [];
  radio = 0;
  radioText = { text: '', time: 0 };
  /** base target counts; AI.effectiveDensity() scales these by quality and time of day */
  density = { traffic: 45, parked: 32, peds: 120, trams: 5 };
  shake = 0;
  time = 0;
  lastPlayerCar: Vehicle | null = null;
  ammo: Record<WeaponId, number> = { fist: Infinity, pistol: 0, uzi: 0, shotgun: 0 };
  street = { name: '', timer: 0 };
  district = '';
  private lastMouseMove = -10;
  private lastMouse = { x: 0, y: 0 };
  private sprayCooldown = 0;
  private crimeCooldown = new Map<string, number>();
  private drown = 0;
  /** fixed-step vehicle physics accumulator */
  private vehAccum = 0;
  private vehHash = new SpatialHash<Vehicle>(10);
  private radioLineTimer = 4;
  running = false;
  onPause?: (paused: boolean) => void;

  constructor(public canvas: HTMLCanvasElement, data: MapJSON) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    const hudEl = document.getElementById('hud') as HTMLCanvasElement | null;
    const fxEl = document.getElementById('fx') as HTMLCanvasElement | null;
    if (hudEl) {
      this.hudCanvas = hudEl;
      this.hudCtx = hudEl.getContext('2d')!;
    }
    if (fxEl) this.postFx = new PostFX(fxEl, canvas);
    this.world = new World(data);
    this.renderer = new Renderer(this.world);
    this.input = new Input(canvas);
    this.audio = new Audio();
    this.combat = new Combat(this);
    this.hud = new Hud(this);
    this.mapView = new MapView(this);
    this.load();
    this.atmos = new Atmosphere(this.save.clock);
    this.renderer.atmos = this.atmos;
    if (matchMedia('(pointer: coarse)').matches) this.light.res = 0.35;
    const start = this.world.walkableNear(this.world.landmark('main').x, this.world.landmark('main').y);
    this.player = new Ped('player', start.x + 3, start.y + 3);
    this.peds.push(this.player);
    this.ai = new AI(this);
    this.missions = new MissionManager(this);
    this.cam.x = this.player.x;
    this.cam.y = this.player.y;
    this.placePickups();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  // ------------------------------------------------------------ persistence
  private load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) this.save = { ...this.save, ...JSON.parse(raw) };
    } catch {
      /* storage unavailable: play without saving */
    }
  }
  persist() {
    this.save.clock = this.atmos.time;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.save));
    } catch {
      /* ignore */
    }
  }
  static hasSave() {
    try {
      return !!localStorage.getItem(SAVE_KEY);
    } catch {
      return false;
    }
  }
  static clearSave() {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* ignore */
    }
  }

  resize() {
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.viewW = innerWidth;
    this.viewH = innerHeight;
    const w = Math.round(this.viewW * this.dpr), h = Math.round(this.viewH * this.dpr);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = this.viewW + 'px';
    this.canvas.style.height = this.viewH + 'px';
    if (this.hudCanvas) {
      this.hudCanvas.width = w;
      this.hudCanvas.height = h;
      this.hudCanvas.style.width = this.viewW + 'px';
      this.hudCanvas.style.height = this.viewH + 'px';
    }
    this.postFx?.resize(w, h);
    this.vignette = null; // rebuilt lazily at the new size
  }

  /** CSS-pixel screen position of a world coordinate; multiply by `dpr` before passing to `postFx.shockwave`. */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: this.viewW / 2 + (x - this.cam.x) * this.cam.scale, y: this.viewH / 2 + (y - this.cam.y) * this.cam.scale };
  }

  // ---------------------------------------------------------------- setup
  private placePickups() {
    const w = this.world;
    const at = (id: string, dx = 0, dy = 0) => {
      const l = w.landmark(id);
      return w.walkableNear(l.x + dx, l.y + dy);
    };
    const add = (p: { x: number; y: number }, kind: Pickup['kind'], amount: number, respawn: number) =>
      this.pickups.push({ ...p, kind, amount, respawn, hidden: 0 });
    add(at('main', 20, -15), 'pistol', 36, 45);
    add(at('cathedral', 25, 0), 'uzi', 120, 60);
    add(at('eurovea', 0, -30), 'shotgun', 16, 60);
    add(at('sng', 0, 20), 'pistol', 36, 45);
    add(at('sad', 30, 30), 'uzi', 120, 60);
    add(at('kamenne', -10, 10), 'health', 100, 40);
    for (const h of w.pois('hospital')) add(w.walkableNear(h.x, h.y), 'health', 100, 30);

    // ten hidden Čumil statues spread over the city
    const r = rng(1337);
    const g = w.ped;
    const spots: { x: number; y: number }[] = [];
    for (let tries = 0; tries < 3000 && spots.length < 10; tries++) {
      const n = Math.floor(r() * (g.nodes.length / 2));
      const x = g.nx(n), y = g.ny(n);
      if (!g.out[n].length || x < w.bounds.x0 + 60 || x > w.bounds.x1 - 60 || y < w.bounds.y0 + 60 || y > w.bounds.y1 - 60) continue;
      if (spots.every((s) => dist(s.x, s.y, x, y) > 420)) spots.push({ x, y });
    }
    spots.forEach((s, i) => {
      if (!this.save.cumils.includes(i)) this.pickups.push({ ...s, kind: 'cumil', amount: 250, respawn: 0, hidden: 0, id: i });
    });
  }

  focus() {
    const v = this.player.vehicle;
    return v ? { x: v.x, y: v.y } : { x: this.player.x, y: this.player.y };
  }

  message(title: string, text: string, time = 3, color = '#ffd740') {
    this.messages.push({ title, text, time, color });
  }

  addMoney(v: number) {
    this.save.money = Math.max(0, this.save.money + v);
  }

  // ----------------------------------------------------------------- crime
  crime(kind: 'shoot' | 'killPed' | 'killCop' | 'shootCop' | 'carjack' | 'hitCop' | 'stealCop' | 'destroy') {
    const now = this.time;
    const cd = this.crimeCooldown.get(kind) ?? 0;
    const copNear = (r: number) =>
      this.peds.some((p) => p.kind === 'cop' && !p.dead && dist(p.x, p.y, this.focus().x, this.focus().y) < r);
    switch (kind) {
      case 'shoot':
        if (copNear(45) && now > cd) this.raise(1, kind, 5);
        break;
      case 'killPed':
        this.raise(1, kind, 0.5);
        break;
      case 'killCop':
        this.raise(2, kind, 0.5);
        this.playerShotCops = true;
        break;
      case 'shootCop':
        this.playerShotCops = true;
        if (now > cd) this.raise(1, kind, 6);
        break;
      case 'carjack':
        if (copNear(60)) this.raise(1, kind, 3);
        break;
      case 'hitCop':
        if (now > cd) this.raise(1, kind, 8);
        break;
      case 'stealCop':
        this.raise(2, kind, 1);
        break;
      case 'destroy':
        if (now > cd) this.raise(0.6, kind, 3);
        break;
    }
  }

  private raise(amount: number, kind: string, cooldown: number) {
    const before = Math.ceil(this.wanted);
    this.wanted = clamp(Math.max(this.wanted, 0) + amount, 0, 5);
    if (this.wanted < 1) this.wanted = 1;
    this.unseen = 0;
    this.crimeCooldown.set(kind, this.time + cooldown);
    if (Math.ceil(this.wanted) > before) this.hud.flashStars = 1.5;
  }

  hurtPlayer(dmg: number, fx: number, fy: number) {
    if (this.state !== 'play') return;
    this.player.health -= dmg;
    this.hud.hurt = 0.5;
    this.combat.blood(this.player.x, this.player.y, 0.3);
    if (this.player.health <= 0) this.wasted();
    void fx;
    void fy;
  }

  wasted() {
    if (this.state !== 'play') return;
    this.state = 'wasted';
    this.stateTimer = 4;
    this.player.health = 0;
    this.missions.onPlayerDown();
    this.audio.jingle(false);
  }

  bust() {
    if (this.state !== 'play') return;
    this.state = 'busted';
    this.stateTimer = 4;
    this.missions.onPlayerDown();
    this.audio.jingle(false);
  }

  private respawn() {
    const busted = this.state === 'busted';
    const kind = busted ? 'police' : 'hospital';
    const f = this.focus();
    const list = this.world.pois(kind);
    let best = list[0];
    for (const p of list) if (dist(p.x, p.y, f.x, f.y) < dist(best.x, best.y, f.x, f.y)) best = p;
    const pos = best ? this.world.walkableNear(best.x, best.y) : this.world.walkableNear(0, 0);
    if (this.player.vehicle) this.exitVehicle(true);
    this.player.x = pos.x;
    this.player.y = pos.y;
    this.player.health = 100;
    this.player.state = 'walk';
    const fee = Math.round(this.save.money * 0.1);
    this.addMoney(-fee);
    this.wanted = 0;
    this.playerShotCops = false;
    if (busted) {
      this.ammo = { fist: Infinity, pistol: 0, uzi: 0, shotgun: 0 };
      this.player.weapon = 'fist';
    }
    // clear police from the scene
    this.vehicles = this.vehicles.filter((v) => v.kind !== 'police' || v.isPlayer);
    this.peds = this.peds.filter((p) => p.kind !== 'cop' || p.vehicle);
    this.message(busted ? 'Policajná stanica' : 'Nemocnica', `${best?.n ?? ''}  −${formatMoney(fee)}`, 4, '#ffffff');
    this.state = 'play';
    this.persist();
    this.cam.x = pos.x;
    this.cam.y = pos.y;
    this.ai.prewarm();
  }

  dropCash(x: number, y: number, amount: number) {
    this.pickups.push({ x, y, kind: 'cash', amount, respawn: 0, hidden: 0 });
  }

  // --------------------------------------------------------------- vehicles
  private enterVehicle() {
    const p = this.player;
    let best: Vehicle | null = null, bd = 4.2;
    for (const v of this.vehicles) {
      if (v.wrecked || v.sinking) continue;
      const d = dist(v.x, v.y, p.x, p.y) - v.spec.width / 2;
      if (d < bd) (bd = d), (best = v);
    }
    if (!best) return;
    const v = best;
    if (v.driver && v.driver !== p) {
      // carjacking: throw the driver out
      const d = v.driver;
      d.vehicle = null;
      d.x = v.x - Math.sin(v.angle) * 2;
      d.y = v.y + Math.cos(v.angle) * 2;
      if (d.kind === 'civ') this.combat.scare(d, p.x, p.y);
      else d.state = 'chase';
      this.crime('carjack');
    }
    if (v.kind === 'police') this.crime('stealCop');
    this.ai.drivers.delete(v);
    v.driver = p;
    v.isPlayer = true;
    v.parked = false;
    p.vehicle = v;
    this.lastPlayerCar = v;
    this.audio.setStation(v.kind === 'police' || this.radio >= RADIO.length ? null : RADIO[this.radio]);
    this.showRadio();
  }

  exitVehicle(force = false) {
    const p = this.player;
    const v = p.vehicle;
    if (!v) return;
    const sides = [1, -1];
    for (const s of sides) {
      const x = v.x + Math.sin(v.angle) * (v.spec.width / 2 + 0.7) * s;
      const y = v.y - Math.cos(v.angle) * (v.spec.width / 2 + 0.7) * s;
      if (force || !this.world.collideCircle(x, y, 0.4)) {
        p.x = x;
        p.y = y;
        break;
      }
    }
    v.isPlayer = false;
    v.driver = null;
    v.setControls(0, 0, true);
    p.vehicle = null;
    this.audio.setStation(null);
    this.audio.engine(0, 0, false);
  }

  private showRadio() {
    const v = this.player.vehicle;
    if (!v) return;
    const st = v.kind === 'police' ? null : RADIO[this.radio];
    this.radioText = { text: st ? `📻 ${st.name} ${st.freq}` : v.kind === 'police' ? '📻 Policajná vysielačka' : '📻 Rádio vypnuté', time: 2.5 };
  }

  // ----------------------------------------------------------------- update
  update(dt: number) {
    const inp = this.input;
    if (inp.hit('Escape', 'KeyP')) {
      this.paused = !this.paused;
      this.onPause?.(this.paused);
    }
    if (inp.hit('KeyM', 'Tab')) this.showMap = !this.showMap;
    if (this.paused || this.showMap) {
      this.audio.engine(0, 0, false);
      this.audio.siren(0);
      inp.endFrame();
      return;
    }
    this.time += dt;
    this.atmos.update(dt);
    this.weather.update(dt, this.atmos, this.view(), this.quality, this.audio);

    if (this.state !== 'play') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) this.respawn();
    } else this.updatePlayer(dt);

    this.ai.update(dt);
    this.updateVehicles(dt);
    this.updateLevels();
    this.combat.update(dt);
    this.updatePickups(dt);
    this.updateWanted(dt);
    this.missions.update(dt);
    this.updateCamera(dt);
    this.updateInfo(dt);

    for (const m of this.messages.slice(0, 1)) m.time -= dt;
    this.messages = this.messages.filter((m) => m.time > 0);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2);
    inp.endFrame();
  }

  private updatePlayer(dt: number) {
    const p = this.player;
    const inp = this.input;
    if (inp.mouseX !== this.lastMouse.x || inp.mouseY !== this.lastMouse.y) {
      this.lastMouseMove = this.time;
      this.lastMouse = { x: inp.mouseX, y: inp.mouseY };
    }
    if (inp.hit('KeyF', 'Enter', 'KeyE')) {
      if (p.vehicle) this.exitVehicle();
      else this.enterVehicle();
    }
    // weapon selection
    const owned = (['fist', 'pistol', 'uzi', 'shotgun'] as WeaponId[]).filter((w) => this.ammo[w] > 0);
    if (inp.hit('KeyQ')) p.weapon = owned[(owned.indexOf(p.weapon) + 1) % owned.length];
    (['Digit1', 'Digit2', 'Digit3', 'Digit4'] as const).forEach((k, i) => {
      const w = (['fist', 'pistol', 'uzi', 'shotgun'] as WeaponId[])[i];
      if (inp.hit(k) && this.ammo[w] > 0) p.weapon = w;
    });
    if (this.ammo[p.weapon] <= 0) p.weapon = 'fist';

    const v = p.vehicle;
    if (v) {
      p.x = v.x;
      p.y = v.y;
      const ax = inp.axis();
      let throttle = -ax.y, steer = ax.x;
      if (inp.stick.active) {
        // touch: steer toward stick direction
        const want = Math.atan2(inp.stick.y, inp.stick.x);
        const mag = Math.hypot(inp.stick.x, inp.stick.y);
        const diff = Math.atan2(Math.sin(want - v.angle), Math.cos(want - v.angle));
        throttle = mag > 0.3 ? (Math.abs(diff) > 2.2 ? -1 : 1) : 0;
        steer = clamp(diff * 2, -1, 1) * (throttle < 0 ? -1 : 1);
      }
      v.setControls(throttle, steer, inp.down('Space'), inp.down('ShiftLeft', 'ShiftRight'));
      if (inp.hit('KeyH')) {
        this.audio.horn();
        for (const q of this.peds) if (q.kind === 'civ' && dist(q.x, q.y, v.x, v.y) < 12 && !q.vehicle) this.combat.scare(q, v.x, v.y);
      }
      if (inp.hit('KeyR') && v.kind !== 'police') {
        this.radio = (this.radio + 1) % (RADIO.length + 1);
        this.audio.setStation(this.radio < RADIO.length ? RADIO[this.radio] : null);
        this.showRadio();
      }
      this.audio.engine(v.speed, Math.abs(throttle), true);
      // drive-by: shoot sideways with the mouse
      if ((inp.mouseDown || inp.down('ControlLeft')) && p.weapon !== 'fist' && p.cooldown <= 0 && this.ammo[p.weapon] > 0) {
        const a = this.aimAngle(v.x, v.y);
        p.cooldown = WEAPONS[p.weapon].cd;
        this.ammo[p.weapon]--;
        const saved = { x: p.x, y: p.y };
        p.x = v.x + Math.cos(a) * (v.spec.width / 2 + 0.6);
        p.y = v.y + Math.sin(a) * (v.spec.width / 2 + 0.6);
        this.combat.fire(p, a, p.weapon);
        p.x = saved.x;
        p.y = saved.y;
      }
      if (p.cooldown > 0) p.cooldown -= dt;
      return;
    }

    // on foot
    const ax = inp.axis();
    const len = Math.hypot(ax.x, ax.y);
    const run = inp.down('ShiftLeft', 'ShiftRight') ? 7.2 : 4.6;
    const vx = len ? (ax.x / len) * run * Math.min(1, len) : 0;
    const vy = len ? (ax.y / len) * run * Math.min(1, len) : 0;
    p.move(dt, this.world, vx, vy);
    const aiming = this.time - this.lastMouseMove < 3 || inp.mouseDown;
    if (aiming) p.angle = this.aimAngle(p.x, p.y);
    if (p.cooldown > 0) p.cooldown -= dt;
    const firing = inp.mouseDown || inp.down('Space', 'ControlLeft') || inp.touchButtons.has('fire');
    if (firing && p.cooldown <= 0 && this.ammo[p.weapon] > 0) {
      p.cooldown = WEAPONS[p.weapon].cd;
      if (p.weapon !== 'fist') this.ammo[p.weapon]--;
      this.combat.fire(p, p.angle, p.weapon);
    }
    // drowning
    if (this.world.inWater(p.x, p.y, p.level)) {
      this.drown += dt;
      if (this.drown > 1.5) this.wasted();
    } else this.drown = 0;
  }

  aimAngle(x: number, y: number) {
    const wx = this.cam.x + (this.input.mouseX - this.viewW / 2) / this.cam.scale;
    const wy = this.cam.y + (this.input.mouseY - this.viewH / 2) / this.cam.scale;
    return Math.atan2(wy - y, wx - x);
  }

  private updateVehicles(dt: number) {
    Vehicle.env.wet = this.atmos.wet;
    const STEP = 1 / 120;
    this.vehAccum = Math.min(this.vehAccum + dt, STEP * 8);
    while (this.vehAccum >= STEP) {
      for (const v of this.vehicles) {
        if (v.parked && !v.isPlayer && v.speed < 0.01) continue;
        const impact = v.update(STEP, this.world);
        if (impact > 6 && (v.isPlayer || dist(v.x, v.y, this.player.x, this.player.y) < 40)) this.audio.crash(impact);
        if (impact > 7 && v.isPlayer) this.shake = Math.max(this.shake, impact / 30);
      }
      this.vehicleCollisions();
      this.vehAccum -= STEP;
    }
    // per-frame post-processing (once, not per physics substep)
    for (const v of this.vehicles) {
      if (v.skid && v.speed > 4 && !v.sinking) this.combat.skid(v);
      else this.combat.noSkid(v);
      if (!v.wrecked && v.health < v.spec.health * 0.35 && Math.random() < dt * 8) this.combat.smoke(v.x + Math.cos(v.angle) * v.spec.length * 0.35, v.y + Math.sin(v.angle) * v.spec.length * 0.35);
      if (v.fire > 0 && !v.wrecked) {
        this.combat.flame(v.x + Math.cos(v.angle) * v.spec.length * 0.3, v.y + Math.sin(v.angle) * v.spec.length * 0.3);
        if (v.driver && v.driver !== this.player && !v.driver.dead) {
          // AI bails out of burning cars
          const d = v.driver;
          d.vehicle = null;
          v.driver = null;
          d.x = v.x - Math.sin(v.angle) * 2;
          d.y = v.y + Math.cos(v.angle) * 2;
          this.combat.scare(d, v.x, v.y);
          this.ai.drivers.delete(v);
        }
      }
      if (v.fire > -1 && v.fire <= 0 && !v.wrecked) {
        v.wrecked = true;
        v.fire = -1;
        v.siren = false;
        this.combat.explode(v.x, v.y, v);
        if (v.isPlayer) this.wasted();
        if (this.lastPlayerCar && dist(v.x, v.y, this.player.x, this.player.y) < 60) this.crime('destroy');
      }
      if (v.sinking > 2.5) {
        if (v.isPlayer) this.wasted();
        if (v.driver && v.driver !== this.player) this.peds = this.peds.filter((p) => p !== v.driver);
      }
    }
    this.vehicles = this.vehicles.filter((v) => v.sinking <= 3 || v.isPlayer);
    this.pedCollisions(dt);
  }

  /** bridge-deck level (0 ground/underneath, 1 on top) for every ped, vehicle and tram */
  private updateLevels() {
    for (const p of this.peds) this.world.updateLevel(p);
    for (const v of this.vehicles) this.world.updateLevel(v);
    for (const t of this.trams) this.world.updateLevel(t);
  }

  private vehicleCollisions() {
    const vs = this.vehicles;
    this.vehHash.clear();
    for (const v of vs) this.vehHash.insert(v, v.x, v.y, v.radius);
    for (const a of vs) {
      this.vehHash.query(a.x, a.y, a.radius, (b) => {
        if (b.id <= a.id || a.level !== b.level) return;
        const rr = a.radius + b.radius;
        if (Math.abs(a.x - b.x) > rr || Math.abs(a.y - b.y) > rr) return;
        let best: { nx: number; ny: number; depth: number; cx: number; cy: number } | null = null;
        const ra = a.spec.width / 2, rb = b.spec.width / 2;
        for (let ci = 0; ci < a.circles.length; ci++) {
          const [ax, ay] = a.circleAt(ci);
          for (let cj = 0; cj < b.circles.length; cj++) {
            const [bx, by] = b.circleAt(cj);
            const d = Math.hypot(bx - ax, by - ay);
            const depth = ra + rb - d;
            if (depth > 0 && (!best || depth > best.depth))
              best = { nx: (bx - ax) / (d || 1), ny: (by - ay) / (d || 1), depth, cx: (ax + bx) / 2, cy: (ay + by) / 2 };
          }
        }
        if (!best) return;
        const ma = a.parked && !a.isPlayer ? a.spec.mass * 1.5 : a.spec.mass;
        const mb = b.parked && !b.isPlayer ? b.spec.mass * 1.5 : b.spec.mass;
        const tot = ma + mb;
        a.x -= best.nx * best.depth * (mb / tot);
        a.y -= best.ny * best.depth * (mb / tot);
        b.x += best.nx * best.depth * (ma / tot);
        b.y += best.ny * best.depth * (ma / tot);
        const sev = resolveContact(a, best.cx, best.cy, b, best.cx, best.cy, best.nx, best.ny, 0.25, 0.4);
        if (sev > 0) {
          if (a.parked || b.parked) {
            a.parked = a.parked && !a.isPlayer && a.speed < 0.5 ? a.parked : false;
            b.parked = b.parked && !b.isPlayer && b.speed < 0.5 ? b.parked : false;
          }
          if (sev > 4) this.combat.metalSpark(best.cx, best.cy);
          if (sev > 5) {
            a.damage((sev - 4) * 2 * (mb / tot) * 1.6);
            b.damage((sev - 4) * 2 * (ma / tot) * 1.6);
            if (a.isPlayer || b.isPlayer) {
              this.audio.crash(sev);
              const other = a.isPlayer ? b : a;
              if (other.kind === 'police' && !other.wrecked) this.crime('hitCop');
            }
          }
        }
      });
    }
    // trams: infinite-mass contact through the same impulse solver
    for (const t of this.trams)
      for (const v of vs) {
        if (v.level !== t.level || Math.abs(v.x - t.x) > 40 || Math.abs(v.y - t.y) > 40) continue;
        const s = t.hits(v.x, v.y, v.spec.width / 2);
        if (!s) continue;
        const nx = -Math.sin(s.a), ny = Math.cos(s.a);
        const side = (v.x - s.x) * nx + (v.y - s.y) * ny >= 0 ? 1 : -1;
        const n2x = nx * side, n2y = ny * side;
        v.x += n2x * 0.15;
        v.y += n2y * 0.15;
        const sev = resolveContact(v, v.x, v.y, null, v.x, v.y, n2x, n2y, 0.15, 0.5, {
          vx: Math.cos(s.a) * t.speed, vy: Math.sin(s.a) * t.speed, av: 0,
        });
        if (sev > 2) {
          if (t.speed > 3) v.damage(t.speed * 0.1);
          if (v.isPlayer || dist(v.x, v.y, this.player.x, this.player.y) < 40) this.audio.crash(sev);
        }
      }
  }

  private pedCollisions(dt: number) {
    this.vehHash.clear();
    for (const v of this.vehicles) this.vehHash.insert(v, v.x, v.y, v.radius);
    for (const p of this.peds) {
      if (p.vehicle || p.dead) continue;
      let hit = false;
      this.vehHash.query(p.x, p.y, 3, (v) => {
        if (hit || v.level !== p.level) return;
        if (Math.abs(v.x - p.x) > v.radius + 1 || Math.abs(v.y - p.y) > v.radius + 1) return;
        const r = v.spec.width / 2 + p.r;
        for (let i = 0; i < v.circles.length; i++) {
          const [cx, cy] = v.circleAt(i);
          const d = dist(cx, cy, p.x, p.y);
          if (d >= r) continue;
          const sp = v.speed;
          if (sp > 4.5) {
            if (p === this.player) {
              this.hurtPlayer(sp * 3, v.x, v.y);
              p.x += (v.vx / sp) * 1.5;
              p.y += (v.vy / sp) * 1.5;
            } else {
              p.kill(cx - v.vx, cy - v.vy, sp * 0.8);
              this.combat.blood(p.x, p.y, 0.8);
              this.audio.punch();
              if (v.isPlayer) {
                this.crime(p.kind === 'cop' ? 'killCop' : 'killPed');
                this.dropCash(p.x, p.y, p.money);
              }
              for (const q of this.peds) if (q.kind === 'civ' && !q.dead && dist(q.x, q.y, p.x, p.y) < 20) this.combat.scare(q, p.x, p.y);
            }
          } else {
            const nx = (p.x - cx) / (d || 1), ny = (p.y - cy) / (d || 1);
            p.x += nx * (r - d);
            p.y += ny * (r - d);
          }
          hit = true;
          break;
        }
      });
      for (const t of this.trams) {
        if (t.level !== p.level || Math.abs(t.x - p.x) > 40 || Math.abs(t.y - p.y) > 40) continue;
        const s = t.hits(p.x, p.y, p.r);
        if (!s) continue;
        if (t.speed > 3) {
          if (p === this.player) this.hurtPlayer(t.speed * 5, s.x, s.y);
          else {
            p.kill(s.x, s.y, t.speed);
            this.combat.blood(p.x, p.y, 0.8);
          }
        }
        const nx = -Math.sin(s.a), ny = Math.cos(s.a);
        const side = (p.x - s.x) * nx + (p.y - s.y) * ny >= 0 ? 1 : -1;
        p.x += nx * side * 3 * dt * 10;
        p.y += ny * side * 3 * dt * 10;
      }
    }
  }

  private updatePickups(dt: number) {
    const f = this.focus();
    const onFoot = !this.player.vehicle;
    for (const pk of this.pickups) {
      if (pk.hidden > 0) {
        pk.hidden -= dt;
        continue;
      }
      const r = pk.kind === 'cash' ? 1.2 : onFoot ? 1.3 : 3;
      if (dist(pk.x, pk.y, f.x, f.y) > r || this.state !== 'play') continue;
      switch (pk.kind) {
        case 'cash':
          this.addMoney(pk.amount);
          this.audio.cash();
          break;
        case 'health':
          if (this.player.health >= 100) continue;
          this.player.health = 100;
          this.audio.pickup();
          this.message('', 'Zdravie doplnené', 1.5, '#69f0ae');
          break;
        case 'cumil':
          this.save.cumils.push(pk.id!);
          this.addMoney(pk.amount);
          this.audio.jingle(true);
          this.message('ČUMIL NÁJDENÝ!', `${this.save.cumils.length}/10  +${formatMoney(pk.amount)}`, 3.5, '#ffd740');
          this.persist();
          break;
        default:
          if (!onFoot) continue;
          this.ammo[pk.kind] = Math.min(this.ammo[pk.kind] + pk.amount, 999);
          this.player.weapon = pk.kind;
          this.audio.pickup();
          this.message('', `${WEAPONS[pk.kind].name} +${pk.amount}`, 1.5, '#ffffff');
      }
      if (pk.respawn) pk.hidden = pk.respawn;
      else pk.hidden = -1;
    }
    this.pickups = this.pickups.filter((p) => p.hidden !== -1);
  }

  private updateWanted(dt: number) {
    if (this.wanted <= 0) {
      this.audio.siren(0);
      return;
    }
    const f = this.focus();
    let seen = false, nearest = Infinity;
    for (const v of this.vehicles) {
      if (v.kind !== 'police' || v.wrecked || v.isPlayer || !v.siren) continue;
      const d = dist(v.x, v.y, f.x, f.y);
      nearest = Math.min(nearest, d);
      if (d < 70 && this.world.raycast(v.x, v.y, f.x, f.y) >= 1) seen = true;
    }
    for (const p of this.peds) {
      if (p.kind !== 'cop' || p.dead || p.vehicle) continue;
      const d = dist(p.x, p.y, f.x, f.y);
      nearest = Math.min(nearest, d);
      if (d < 40 && this.world.raycast(p.x, p.y, f.x, f.y) >= 1) seen = true;
    }
    this.audio.siren(clamp(1 - nearest / 120, 0, 1));
    if (seen) this.unseen = 0;
    else {
      this.unseen += dt;
      if (this.unseen > 9 + Math.ceil(this.wanted) * 1.5) {
        this.unseen = 0;
        this.wanted = Math.max(0, Math.ceil(this.wanted) - 1);
        if (this.wanted === 0) {
          this.playerShotCops = false;
          this.message('', 'Polícia ťa stratila z dohľadu.', 2, '#90caf9');
        }
      }
    }
    // Slovnafta spray shop: repaint + repair + lose the cops
    const v = this.player.vehicle;
    if (this.sprayCooldown > 0) this.sprayCooldown -= dt;
    if (v && v.speed < 3 && this.sprayCooldown <= 0)
      for (const fuel of this.world.pois('fuel')) {
        if (dist(fuel.x, fuel.y, v.x, v.y) > 12) continue;
        const cost = 250;
        this.sprayCooldown = 6;
        if (this.save.money < cost) {
          this.message('Striekareň', `Nemáš dosť peňazí (${formatMoney(cost)}).`, 2.5, '#ff8a80');
          break;
        }
        this.addMoney(-cost);
        v.health = v.spec.health;
        v.fire = -1;
        v.color = ['#c62828', '#1565c0', '#2e7d32', '#f9a825', '#eeeeee', '#263238'][(Math.random() * 6) | 0];
        this.wanted = 0;
        this.playerShotCops = false;
        this.message('Striekareň ' + fuel.n, `Nové auto, nová identita.  −${formatMoney(cost)}`, 3, '#90caf9');
        this.audio.cash();
        break;
      }
  }

  private updateCamera(dt: number) {
    const v = this.player.vehicle;
    const f = this.focus();
    const lead = v ? 0.55 : 0;
    const tx = f.x + (v ? v.vx * lead : 0), ty = f.y + (v ? v.vy * lead : 0);
    const k = Math.min(1, dt * 5);
    this.cam.x = lerp(this.cam.x, tx, k);
    this.cam.y = lerp(this.cam.y, ty, k);
    const base = Math.min(this.viewW, this.viewH) / 46;
    const target = v ? (base * 0.78) / (1 + v.speed / 24) : base;
    this.cam.scale = lerp(this.cam.scale, target, Math.min(1, dt * 1.5));
  }

  private updateInfo(dt: number) {
    const f = this.focus();
    const name = this.world.streetName(f.x, f.y);
    if (name && name !== this.street.name) this.street = { name, timer: 3.5 };
    if (this.street.timer > 0) this.street.timer -= dt;
    const d = this.world.district(f.x, f.y);
    if (d !== this.district) {
      if (this.district) this.message('', d, 2.5, '#b3e5fc');
      this.district = d;
    }
    // discover landmarks
    for (const l of this.world.landmarks.values()) {
      if (this.save.found.includes(l.id) || dist(l.x, l.y, f.x, f.y) > 45) continue;
      this.save.found.push(l.id);
      this.addMoney(100);
      this.message(`Objavené: ${l.name}`, `${LANDMARK_INFO[l.id] ?? ''}  +${formatMoney(100)}`, 4, '#80d8ff');
      this.persist();
    }
    if (this.radioText.time > 0) this.radioText.time -= dt;
    // DJ chatter
    if (this.player.vehicle && this.radio < RADIO.length && this.player.vehicle.kind !== 'police') {
      this.radioLineTimer -= dt;
      if (this.radioLineTimer <= 0) {
        this.radioLineTimer = rand(14, 24);
        const st = RADIO[this.radio];
        this.radioText = { text: `📻 ${st.name}: „${st.lines[(Math.random() * st.lines.length) | 0]}“`, time: 6 };
      }
    }
  }

  // ------------------------------------------------------------------- draw
  view(): View {
    const s = this.cam.scale;
    const hw = this.viewW / 2 / s, hh = this.viewH / 2 / s;
    return {
      x0: this.cam.x - hw, y0: this.cam.y - hh, x1: this.cam.x + hw, y1: this.cam.y + hh,
      camX: this.cam.x, camY: this.cam.y, camH: Math.max(hw, hh) * 3, scale: s,
    };
  }

  draw(hud = true) {
    this.trackFrameTime();
    const ctx = this.ctx;
    const v = this.view();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#b3aea3';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const sx = this.shake ? rand(-1, 1) * this.shake * 6 : 0, sy = this.shake ? rand(-1, 1) * this.shake * 6 : 0;
    ctx.setTransform(this.dpr * v.scale, 0, 0, this.dpr * v.scale, this.dpr * (this.viewW / 2 + sx - this.cam.x * v.scale), this.dpr * (this.viewH / 2 + sy - this.cam.y * v.scale));

    // outside the playable area
    ctx.fillStyle = '#2b2d30';
    const b = this.world.bounds;
    ctx.fillRect(v.x0 - 10, v.y0 - 10, v.x1 - v.x0 + 20, b.y0 - v.y0 + 10);
    ctx.fillRect(v.x0 - 10, b.y1, v.x1 - v.x0 + 20, v.y1 - b.y1 + 10);
    ctx.fillRect(v.x0 - 10, v.y0 - 10, b.x0 - v.x0 + 10, v.y1 - v.y0 + 20);
    ctx.fillRect(b.x1, v.y0 - 10, v.x1 - b.x1 + 10, v.y1 - v.y0 + 20);

    const atmos = this.atmos;
    this.renderer.drawGround(ctx, v, v.scale > 3);
    this.renderer.drawShadows(ctx, v);
    this.weather.drawWorld(ctx, atmos);
    this.combat.drawDecals(ctx);
    this.missions.drawWorld(ctx, this.time);
    this.drawPickups(ctx);
    this.combat.drawParticles(ctx, false);

    // entities below any bridge deck, then the deck itself, then entities on top of it
    const inView = (x: number, y: number, r: number) => x > v.x0 - r && x < v.x1 + r && y > v.y0 - r && y < v.y1 + r;
    const drawEntities = (level: 0 | 1) => {
      for (const p of this.peds) if (p.dead && p.level === level && inView(p.x, p.y, 2)) p.draw(ctx, atmos);
      for (const p of this.peds) if (!p.dead && !p.vehicle && p !== this.player && p.level === level && inView(p.x, p.y, 2)) p.draw(ctx, atmos);
      for (const t of this.trams) if (t.level === level && inView(t.x, t.y, 35)) t.draw(ctx, atmos);
      for (const veh of this.vehicles) if (veh.level === level && inView(veh.x, veh.y, 8)) veh.draw(ctx, this.time, atmos);
    };
    drawEntities(0);
    this.renderer.drawBridges(ctx, v);
    drawEntities(1);

    this.combat.drawParticles(ctx, true);
    this.renderer.drawBuildings(ctx, v);
    this.drawLandmarks(ctx, v);

    // lighting: ambient tint + emitted lights, multiplied over the world
    const L = this.light;
    L.begin(v, this.viewW, this.viewH, atmos);
    this.renderer.emitLights(L, v);
    for (const t of this.trams) t.emitLights(L, atmos);
    for (const veh of this.vehicles) if (inView(veh.x, veh.y, 30)) veh.emitLights(L, this.time, atmos);
    this.combat.emitLights(L);
    this.emitAtmosphereLights(L, atmos, inView);
    L.composite(ctx, this.dpr, this.viewW, this.viewH);
    this.renderer.drawNightWindows(ctx, v);

    this.drawSigns(ctx, v);
    if (hud) this.drawPlayerMarker(ctx);

    // screen-space post: rain, wet sheen, vignette — also shown behind the menu (attract mode)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.weather.drawScreen(ctx, this.viewW, this.viewH, atmos, this.time, this.quality);
    if (atmos.wet > 0.05 && atmos.night > 0.3 && L.active) {
      // cheap fake reflections: the light map again, additive, low alpha. Only
      // when it is dark: by day the light map is near-white and would wash out.
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = Math.min(0.22, 0.18 * atmos.wet) * Math.min(1, (atmos.night - 0.3) * 2);
      ctx.drawImage(L.canvas, 0, 0, this.viewW, this.viewH);
      ctx.restore();
    }

    // GPU post-processing (bloom, colour grade, vignette, grain, damage/shockwave/speed fx):
    // re-processes the whole world canvas on the GPU. Falls back to the plain 2D vignette
    // when WebGL is unavailable, the context was lost, or quality is pinned to "low".
    const handled = this.postFx?.render(this.canvas, { night: atmos.night, daylight: atmos.daylight, rain: atmos.rain, wet: atmos.wet, time: atmos.time }, this.time, this.qualityTier) ?? false;
    if (!handled) this.drawVignette(ctx, atmos);

    // HUD + full map draw onto a separate transparent overlay canvas, above PostFX,
    // so post-processing (bloom/grain/aberration/etc.) never touches them.
    if (this.hudCtx && this.hudCanvas) this.hudCtx.clearRect(0, 0, this.hudCanvas.width, this.hudCanvas.height);
    if (!hud) return;
    if (this.hudCtx) {
      this.hudCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.hud.draw(this.hudCtx);
      if (this.showMap) this.mapView.drawFull(this.hudCtx);
    }
  }

  private drawPickups(ctx: CanvasRenderingContext2D) {
    const bob = Math.sin(this.time * 4) * 0.12;
    for (const p of this.pickups) {
      if (p.hidden > 0) continue;
      // soft ground contact shadow, shrinks slightly as the item bobs up
      const shrink = 1 - (bob + 0.12) * 0.18;
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 0.55, 0.55 * shrink, 0.22 * shrink, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(p.x, p.y + bob);
      if (p.kind === 'cash') {
        ctx.fillStyle = '#2e7d32';
        ctx.fillRect(-0.4, -0.25, 0.8, 0.5);
        ctx.fillStyle = '#a5d6a7';
        ctx.font = '700 0.4px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('€', 0, 0.02);
      } else if (p.kind === 'cumil') {
        // a worker's head peeking out of a manhole, with a yellow helmet
        ctx.fillStyle = '#3e3e3e';
        ctx.beginPath();
        ctx.arc(0, 0, 0.75, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#8d6e63';
        ctx.beginPath();
        ctx.arc(0, 0, 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffd600';
        ctx.beginPath();
        ctx.arc(0, -0.08, 0.36, Math.PI, 0);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,214,0,${0.4 + 0.4 * Math.sin(this.time * 5)})`;
        ctx.lineWidth = 0.12;
        ctx.beginPath();
        ctx.arc(0, 0, 1.1, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(-0.5, -0.4, 1.1, 1);
        ctx.fillStyle = p.kind === 'health' ? '#fafafa' : '#37474f';
        ctx.fillRect(-0.55, -0.55, 1.1, 1.1);
        ctx.strokeStyle = p.kind === 'health' ? '#e53935' : '#ffd600';
        ctx.lineWidth = 0.1;
        ctx.strokeRect(-0.55, -0.55, 1.1, 1.1);
        ctx.fillStyle = p.kind === 'health' ? '#e53935' : '#ffd600';
        ctx.font = '900 0.6px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.kind === 'health' ? '+' : p.kind === 'pistol' ? 'P' : p.kind === 'uzi' ? 'U' : 'B', 0, 0.04);
      }
      ctx.restore();
    }
  }

  private drawLandmarks(ctx: CanvasRenderingContext2D, v: View) {
    // UFO on the pylon of Most SNP (85 m above the bridge deck)
    const ufo = this.world.landmarks.get('snp');
    if (ufo && ufo.x > v.x0 - 150 && ufo.x < v.x1 + 150 && ufo.y > v.y0 - 150 && ufo.y < v.y1 + 150) {
      const [ox, oy] = this.renderer.roofOffset(ufo.x, ufo.y, 85, v);
      ctx.strokeStyle = '#9aa0a6';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'butt';
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(ufo.x + s * 9, ufo.y);
        ctx.lineTo(ufo.x + ox + s * 2, ufo.y + oy);
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(ufo.x + ox - 4, ufo.y + oy - 4, 2, ufo.x + ox, ufo.y + oy, 17);
      g.addColorStop(0, '#f5f7f8');
      g.addColorStop(0.6, '#b0b6bb');
      g.addColorStop(1, '#6d7479');
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(ufo.x + 4, ufo.y + 5, 16, 16, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ufo.x + ox, ufo.y + oy, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#37474f';
      ctx.beginPath();
      ctx.arc(ufo.x + ox, ufo.y + oy, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#cfd8dc';
      ctx.beginPath();
      ctx.arc(ufo.x + ox, ufo.y + oy, 8.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(0,229,255,${0.5 + 0.5 * Math.sin(this.time * 3)})`;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + this.time * 0.2;
        ctx.beginPath();
        ctx.arc(ufo.x + ox + Math.cos(a) * 13.5, ufo.y + oy + Math.sin(a) * 13.5, 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // landmark labels when zoomed out a bit
    if (v.scale < 9) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const l of this.world.landmarks.values()) {
        if (l.x < v.x0 || l.x > v.x1 || l.y < v.y0 || l.y > v.y1) continue;
        const fs = 13 / v.scale;
        ctx.font = `700 ${fs}px system-ui, sans-serif`;
        const w = ctx.measureText(l.name).width;
        ctx.fillStyle = 'rgba(10,12,16,0.45)';
        roundRect(ctx, l.x - w / 2 - fs * 0.4, l.y - fs * 0.68, w + fs * 0.8, fs * 1.36, fs * 0.3);
        ctx.fill();
        ctx.fillStyle = this.save.found.includes(l.id) ? '#e1f5fe' : '#fff59d';
        ctx.fillText(l.name, l.x, l.y);
      }
    }
  }

  private drawSigns(ctx: CanvasRenderingContext2D, v: View) {
    const fs = Math.max(1.1, 12 / v.scale);
    const rad = fs * 0.3;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${fs}px system-ui, sans-serif`;
    for (const p of this.world.data.pois) {
      if (p.k !== 'shop' && p.k !== 'fuel') continue;
      if (p.x < v.x0 || p.x > v.x1 || p.y < v.y0 || p.y > v.y1) continue;
      const [bg, fg] = BRAND_COLORS[p.n] ?? ['#37474f', '#fff'];
      const label = p.k === 'fuel' ? `⛽ ${p.n}` : p.n;
      const w = ctx.measureText(label).width + fs * 0.8;
      const bx = p.x - w / 2, by = p.y - fs * 0.75, bh = fs * 1.5;
      roundRect(ctx, bx, by + fs * 0.14, w, bh, rad);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fill();
      roundRect(ctx, bx, by, w, bh, rad);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = fs * 0.06;
      roundRect(ctx, bx, by, w, bh, rad);
      ctx.stroke();
      ctx.fillStyle = fg;
      ctx.fillText(label, p.x, p.y + fs * 0.05);
    }
  }

  private drawPlayerMarker(ctx: CanvasRenderingContext2D) {
    // the player is drawn above roofs as a subtle marker when hidden under buildings
    const p = this.player;
    if (!p.vehicle) p.draw(ctx, this.atmos);
    if (this.state !== 'play') return;
    const f = this.focus();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.arc(f.x, f.y, p.vehicle ? p.vehicle.radius + 0.6 : 0.9, 0, Math.PI * 2);
    ctx.stroke();
  }

  // --------------------------------------------------------- atmosphere fx
  /** must run between `L.begin` and `L.composite`: night light around the player,
   *  a glow on pickups and mission markers so they read well after dark. */
  private emitAtmosphereLights(L: LightLayer, atmos: Atmosphere, inView: (x: number, y: number, r: number) => boolean) {
    // keep the player visible even deep under building shadow
    if (atmos.night > 0.05) {
      const f = this.focus();
      L.point(f.x, f.y, 6, 'rgba(255,246,222,1)', 0.4 * atmos.night);
    }
    if (atmos.night > 0.12) {
      const bob = Math.sin(this.time * 4) * 0.12;
      for (const p of this.pickups) {
        if (p.hidden > 0 || !inView(p.x, p.y, 3)) continue;
        const color = PICKUP_GLOW[p.kind];
        L.glow(p.x, p.y + bob, 1.6, color, 0.5 * atmos.night);
      }
      if (!this.missions.active)
        for (const b of this.missions.available()) {
          if (!inView(b.x, b.y, 4)) continue;
          L.point(b.x, b.y, 4.5, '#ffd600', 0.5 * atmos.night);
          L.glow(b.x, b.y, 2.2, '#ffd600', 0.45 * atmos.night);
        }
      const t = this.missions.target();
      if (t && inView(t.x, t.y, 4)) {
        L.point(t.x, t.y, 5, '#ffea00', 0.55 * atmos.night);
        L.glow(t.x, t.y, 2.6, '#ffea00', 0.5 * atmos.night);
      }
    }
  }

  private drawVignette(ctx: CanvasRenderingContext2D, atmos: Atmosphere) {
    const W = this.viewW, H = this.viewH;
    if (W <= 0 || H <= 0) return;
    if (!this.vignette || this.vignette.width !== Math.round(W * this.dpr) || this.vignette.height !== Math.round(H * this.dpr)) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(W * this.dpr));
      c.height = Math.max(1, Math.round(H * this.dpr));
      const vc = c.getContext('2d')!;
      const r = Math.hypot(c.width, c.height) / 2;
      const g = vc.createRadialGradient(c.width / 2, c.height / 2, r * 0.55, c.width / 2, c.height / 2, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,1)');
      vc.fillStyle = g;
      vc.fillRect(0, 0, c.width, c.height);
      this.vignette = c;
    }
    ctx.save();
    ctx.globalAlpha = 0.22 + atmos.night * 0.16;
    ctx.drawImage(this.vignette, 0, 0, W, H);
    ctx.restore();
  }

  /** rolling frame-time average; adapts `qualityTier` both ways with hysteresis, pinned by `qualityPref`. */
  private trackFrameTime() {
    const now = performance.now();
    if (this.lastFrameT) {
      const ft = now - this.lastFrameT;
      this.frameAvg += (ft - this.frameAvg) * 0.08;
      if (this.qualityPref === 'auto') {
        if (this.frameAvg > 26) this.slowTimer += ft / 1000;
        else this.slowTimer = 0;
        if (this.frameAvg < 14) this.goodTimer += ft / 1000;
        else this.goodTimer = 0;
        if (this.slowTimer > 1.5 && this.qualityTier > 0) {
          this.qualityTier = (this.qualityTier - 1) as 0 | 1 | 2;
          this.slowTimer = 0;
          this.goodTimer = 0;
        } else if (this.goodTimer > 4 && this.qualityTier < 2) {
          this.qualityTier = (this.qualityTier + 1) as 0 | 1 | 2;
          this.goodTimer = 0;
          this.slowTimer = 0;
        }
      } else {
        this.qualityTier = this.qualityPref === 'high' ? 2 : this.qualityPref === 'medium' ? 1 : 0;
      }
      this.quality = this.qualityTier > 0 ? 1 : 0;
      if (this.baseLightRes === null) this.baseLightRes = this.light.res;
      this.light.res = this.qualityTier > 0 ? this.baseLightRes : 0.35;
    }
    this.lastFrameT = now;
  }
}

const PICKUP_GLOW: Record<Pickup['kind'], string> = {
  cash: '#69f0ae',
  health: '#ff5252',
  pistol: '#ffd600',
  uzi: '#ffd600',
  shotgun: '#ffd600',
  cumil: '#ffd600',
};

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
