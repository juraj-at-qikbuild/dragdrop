// The client: camera, input, rendering, audio, HUD and effects around a SimHost, which is either the
// simulation running in the page (offline) or the shared world on the server (online, see src/net/).
import { World, type Level } from '../shared/world/World';
import { Renderer, type View } from '../world/Renderer';
import { Input } from './Input';
import { Juice } from './Juice';
import { Audio } from '../audio/Audio';
import type { WeaponId } from '../shared/entities/Ped';
import type { Vehicle } from '../shared/entities/Vehicle';
import { MissionManager } from '../missions/Missions';
import { Hud } from '../ui/Hud';
import { MapView } from '../ui/MapView';
import { Gps } from './Gps';
import { RADIO, BRAND_COLORS } from '../data/brands';
import { clamp, dist, lerp, rand } from '../shared/util/math';
import { Rng } from '../shared/util/Rng';
import type { MapJSON } from '../shared/types';
import { Atmosphere } from '../world/Atmosphere';
import { LightLayer } from '../world/Lighting';
import { Weather } from '../world/Weather';
import { PostFX } from '../render/PostFX';
import { drawNametags } from '../render/nametags';
import { Bubbles } from '../render/bubbles';
import { drawVehicle, emitVehicleLights } from '../render/drawVehicle';
import { drawPed } from '../render/drawPed';
import { drawTram, emitTramLights } from '../render/drawTram';
import { drawHeli, emitHeliLights } from '../render/drawHeli';
import { drawProps } from '../render/drawProps';
import { roundRect } from '../render/shapes';
import { Clock, SECONDS_PER_HOUR } from '../shared/sim/Clock';
import { WEAPONS, traceMelee, traceShot } from '../shared/sim/Combat';
import type { PickupKind } from '../shared/sim/Pickups';
import type { Observer, Profile } from '../shared/sim/SimPlayer';
import { Fx } from './Fx';
import { FURNITURE, F_HYDRANT } from '../shared/world/Street';
import { EntityFx } from './EntityFx';
import { ClientEvents } from './ClientEvents';
import { LocalSimHost } from './LocalSimHost';
import type { SimHost } from './SimHost';

/** the offline save: the local player's profile plus the time of day */
export type SaveData = Profile;

const SAVE_KEY = 'blava-city-save-v1';
/** camera zoom: metres across the short side of the screen on foot */
const CAM_FOOT_M = 38;
/** in a vehicle, zoomed out by this factor at a standstill... */
const CAM_CAR_ZOOM = 0.84;
/** ...and further with speed: the view doubles at this speed (m/s) */
const CAM_SPEED_ZOOM = 28;

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
  fx: Fx;
  entityFx = new EntityFx();
  events: ClientEvents;
  juice: Juice;
  /** what people nearby just said */
  bubbles = new Bubbles();
  /** read by the HUD combo widget */
  get combo() {
    return this.juice.combo;
  }
  missions: MissionManager;
  hud: Hud;
  mapView: MapView;
  /** waypoint and route (satnav) */
  gps: Gps;
  atmos: Atmosphere;
  light = new LightLayer();
  weather = new Weather();
  /** the world: offline simulation or online server */
  host: SimHost;
  /** 1 = full quality, 0 = low (kept for old call sites: true whenever qualityTier > 0) */
  quality = 1;
  /** 2 = high, 1 = medium, 0 = low — drives PostFX detail and quality (see `trackFrameTime`) */
  qualityTier: 0 | 1 | 2 = 2;
  /** user choice from the pause menu: 'auto' adapts qualityTier to frame time, others pin it */
  qualityPref: 'auto' | 'high' | 'medium' | 'low' = 'auto';
  /** textured building facades; Auto drops them only if frames stay slow with post-processing already off */
  facades = true;
  /** on-foot WASD, user choice from the menus: 'screen' = W is up the screen, 'cursor' = W walks towards the mouse */
  footControls: 'screen' | 'cursor' = 'screen';
  /** the player's zoom (mouse wheel), a factor on the automatic camera zoom */
  zoomPref = 1;
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
  paused = false;
  showMap = false;
  messages: Msg[] = [];
  radio = 0;
  radioText = { text: '', time: 0 };
  shake = 0;
  time = 0;
  street = { name: '', timer: 0 };
  district = '';
  /** the named quarter the player is in (Vnútorné mesto, Podhradie…), '' when none is near */
  quarter = '';
  private infoTimer = 0;
  private lastMouseMove = -10;
  private lastMouse = { x: 0, y: 0 };
  /** the player's car and how many jolts (bumps, kerbs) it had, to react to new ones */
  private joltCar: Vehicle | null = null;
  private joltSeen = 0;
  private geyserAcc = 0;
  private radioLineTimer = 4;
  running = false;
  onPause?: (paused: boolean) => void;
  /** true when this page plays the shared online world: the offline save is neither loaded nor written */
  readonly onlineMode: boolean;

  constructor(public canvas: HTMLCanvasElement, data: MapJSON, opts: { online?: boolean } = {}) {
    this.onlineMode = !!opts.online;
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
    this.fx = new Fx();
    this.juice = new Juice(this);
    this.events = new ClientEvents(this);
    const profile = this.load();
    const clock = new Clock(new Rng(), profile.clock);
    this.atmos = new Atmosphere(undefined, clock);
    this.renderer.atmos = this.atmos;
    if (matchMedia('(pointer: coarse)').matches) this.light.res = 0.35;
    // online, this offline world only backs the menu's attract mode until the connection is up
    this.host = new LocalSimHost(this.world, this.events, profile, clock, () => this.persist());
    this.hud = new Hud(this);
    this.mapView = new MapView(this);
    this.gps = new Gps(this);
    this.missions = new MissionManager(this);
    this.cam.x = this.player.x;
    this.cam.y = this.player.y;
    this.resize();
    addEventListener('resize', () => this.resize());
    // a lift gate's boom snapping: splinters and a crack
    this.world.gates.onSnap = (_i, x, y, speed) => {
      const f = this.focus();
      if (dist(x, y, f.x, f.y) > 80) return;
      for (let k = 0; k < 5; k++) this.fx.debris(x, y);
      this.fx.chunk(x, y, '#e53935');
      this.fx.chunk(x, y, '#f4f4f0');
      this.audio.snap(dist(x, y, f.x, f.y));
      if (this.player.vehicle && dist(x, y, f.x, f.y) < 8) this.juice.addTrauma(Math.min(0.25, speed / 60));
    };
  }

  /** fill the streets around the player right away (start of play) */
  prewarm() {
    if (this.host instanceof LocalSimHost) this.host.sim.prewarm(this.host.me);
  }

  /** switch to another world (online: the server) */
  setHost(h: SimHost) {
    this.host.dispose();
    this.host = h;
    this.missions.cleanupAll();
    this.cam.x = this.player.x;
    this.cam.y = this.player.y;
  }

  // ------------------------------------------------------------ the player
  get player() {
    return this.host.me.ped;
  }
  get vehicles() {
    return this.host.vehicles;
  }
  get peds() {
    return this.host.peds;
  }
  get wanted() {
    return this.host.me.wanted;
  }
  /** missions (offline) raise the wanted level directly */
  set wanted(v: number) {
    if (this.host instanceof LocalSimHost) this.host.sim.setWanted(this.host.me, v);
  }
  get state() {
    return this.host.me.state;
  }
  get save() {
    return this.host.me.profile;
  }
  get searchZone() {
    return this.host.me.searchZone;
  }
  get ammo() {
    return this.host.me.ammo;
  }
  /** online status/roster, or null offline */
  get online() {
    return this.host.net;
  }

  focus() {
    const v = this.player.vehicle;
    return v ? { x: v.x, y: v.y } : { x: this.player.x, y: this.player.y };
  }

  /** the player's level (their vehicle's while driving): -1 in a tunnel, 1 on a bridge deck */
  focusLevel(): Level {
    return this.player.vehicle ? this.player.vehicle.level : this.player.level;
  }

  /** Opacity of something in a tunnel seen from the surface: fades out over the first metres
   *  past the portal, invisible deeper in; 1 anywhere outside the tunnels. */
  tunnelFade = (x: number, y: number) => {
    const d = this.world.tunnelDepth(x, y);
    return d < 0 ? 1 : Math.max(0, 1 - d / 8);
  };

  message(title: string, text: string, time = 3, color = '#ffd740') {
    this.messages.push({ title, text, time, color });
  }

  /** money for combos and missions (offline only: online the server keeps the books) */
  addMoney(v: number) {
    this.host.styleCash(v);
  }

  /** missions (offline) put their own cars into the world */
  addMissionVehicle(v: Vehicle) {
    if (this.host instanceof LocalSimHost) this.host.sim.addVehicle(v);
  }

  // ------------------------------------------------------------ persistence
  private load(): SaveData {
    const save: SaveData = { money: 0, done: [], found: [], cumils: [] };
    if (this.onlineMode) return save;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) Object.assign(save, JSON.parse(raw));
    } catch {
      /* storage unavailable: play without saving */
    }
    return save;
  }
  persist() {
    if (this.onlineMode || this.host.mode !== 'local') return;
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


  /** the nearest car the player could get into */
  private findEnterable(): Vehicle | null {
    const p = this.player;
    let best: Vehicle | null = null, bd = 4.2;
    for (const v of this.host.vehicles) {
      if (v.wrecked || v.sinking || v.level !== p.level) continue;
      const d = dist(v.x, v.y, p.x, p.y) - v.spec.width / 2;
      if (d < bd) (bd = d), (best = v);
    }
    return best;
  }

  showRadio() {
    const v = this.player.vehicle;
    if (!v) return;
    const st = v.kind === 'police' ? null : RADIO[this.radio];
    this.radioText = { text: st ? `📻 ${st.name} ${st.freq}` : v.kind === 'police' ? '📻 Policajná vysielačka' : '📻 Rádio vypnuté', time: 2.5 };
  }

  // ----------------------------------------------------------------- update
  update(dt: number) {
    const inp = this.input;
    const host = this.host;
    inp.pollPad();
    // Esc closes the city map before it pauses the game
    if (this.showMap && inp.hit('Escape')) this.showMap = false;
    else if (inp.hit('Escape', 'KeyP')) {
      this.paused = !this.paused;
      this.onPause?.(this.paused);
    }
    if (inp.hit('KeyM', 'Tab')) {
      this.showMap = !this.showMap;
      if (this.showMap) this.mapView.onOpen();
    }
    if (this.showMap && !this.paused) this.mapView.update(dt);
    // the shared world can't be paused: online, the menus just take the controls away
    const frozen = this.paused || this.showMap;
    if (frozen && host.allowsPause) {
      this.audio.engine(0, 0, false);
      this.audio.siren(0);
      inp.endFrame();
      return;
    }
    const dtReal = dt;
    this.time += dtReal;
    this.atmos.update(dtReal);
    this.weather.update(dtReal, this.atmos, this.view(), this.quality, this.audio);
    if (host instanceof LocalSimHost) host.sim.quality = this.quality;
    // hit-stop / slow-mo: scale the simulation step, leave atmos/weather/UI on real time.
    // Online the world runs on everyone's clock, so no time tricks.
    dt = host.allowsTimeScale ? dtReal * this.juice.timeScale(dtReal) : dtReal;

    if (host.me.state === 'play') {
      if (frozen) this.idlePlayer(dt);
      else this.updatePlayer(dt);
    }
    host.setObserver(this.observer());
    host.update(dt);
    this.entityFx.update(dt, host.vehicles, this.fx, this.world, this.focus());
    this.updateStreet(dt);
    this.fx.update(dt);
    this.missions.enabled = host.missionsEnabled;
    this.missions.update(dt);
    this.gps.update(dtReal);
    this.updateAudio();
    this.updateCamera(dtReal);
    this.updateInfo(dt);
    this.juice.tick(dtReal, dt);
    this.bubbles.update(dt, (id) => host.pedById(id));
    this.shake = this.juice.trauma; // kept for any code that still reads it

    for (const m of this.messages.slice(0, 1)) m.time -= dtReal;
    this.messages = this.messages.filter((m) => m.time > 0);
    inp.endFrame();
  }

  /** what the player sees, for NPC spawning and level of detail */
  private observer(): Observer {
    const f = this.focus();
    const s = this.cam.scale;
    return { fx: f.x, fy: f.y, cx: this.cam.x, cy: this.cam.y, hw: this.viewW / 2 / s, hh: this.viewH / 2 / s };
  }

  private updatePlayer(dt: number) {
    const p = this.player;
    const inp = this.input;
    if (inp.mouseX !== this.lastMouse.x || inp.mouseY !== this.lastMouse.y) {
      this.lastMouseMove = this.time;
      this.lastMouse = { x: inp.mouseX, y: inp.mouseY };
    }
    if (inp.hit('KeyF', 'Enter', 'KeyE')) {
      if (p.vehicle) this.host.requestExit();
      else {
        const v = this.findEnterable();
        if (v) this.host.requestEnter(v);
      }
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
      if (inp.pad.active) {
        // gamepad: analog triggers (right accelerates, left brakes and reverses), or the left
        // stick's up/down when the triggers are left alone
        const trig = inp.pad.rt - inp.pad.lt;
        if (Math.abs(trig) > 0.05) throttle = trig;
      }
      if (inp.stick.active) {
        // touch: steer toward the stick's direction, easing off the throttle through a turn
        // (the tyres only hold so much) and braking into a sharp one at speed
        const want = Math.atan2(inp.stick.y, inp.stick.x);
        const mag = Math.hypot(inp.stick.x, inp.stick.y);
        const diff = Math.atan2(Math.sin(want - v.angle), Math.cos(want - v.angle));
        const turn = Math.abs(diff);
        throttle = mag < 0.3 ? 0 : turn > 2.2 ? -1 : turn > 0.7 && v.fwdSpeed > 12 ? -0.6 : 1 - clamp((turn - 0.25) * 1.2, 0, 0.8);
        steer = clamp(diff * 2, -1, 1) * (throttle < 0 && turn > 2.2 ? -1 : 1);
      }
      v.setControls(throttle, steer, inp.down('Space'), inp.down('ShiftLeft', 'ShiftRight'));
      if (inp.hit('KeyH')) {
        this.audio.horn();
        this.host.horn();
      }
      if (inp.hit('KeyR') && v.kind !== 'police') {
        this.radio = (this.radio + 1) % (RADIO.length + 1);
        this.audio.setStation(this.radio < RADIO.length ? RADIO[this.radio] : null);
        this.showRadio();
      }
      this.audio.engine(v.speed, Math.abs(throttle), true);
      // drive-by: shoot sideways with the mouse, or with the gamepad's right stick pushed hard
      const padAim = this.padAim(0.7);
      if ((inp.mouseDown || inp.down('ControlLeft') || padAim !== null) && p.weapon !== 'fist' && p.cooldown <= 0 && this.ammo[p.weapon] > 0) {
        const a = padAim ?? this.aimAngle(v.x, v.y);
        p.cooldown = WEAPONS[p.weapon].cd;
        this.ammo[p.weapon]--;
        this.fireFrom(v.x + Math.cos(a) * (v.spec.width / 2 + 0.6), v.y + Math.sin(a) * (v.spec.width / 2 + 0.6), a);
      }
      if (p.cooldown > 0) p.cooldown -= dt;
      return;
    }

    // on foot
    const ax = inp.axis();
    // 'cursor' mode: W/S walk towards/away from the mouse, A/D strafe around it (touch stick stays screen-relative)
    const cursorMode = this.footControls === 'cursor' && !inp.stick.active && !inp.pad.active;
    let heading = p.angle;
    if (cursorMode) {
      const c = this.cursorWorld();
      // keep the last heading while the cursor sits on the player, where its angle would jitter
      if (Math.hypot(c.x - p.x, c.y - p.y) > 0.8) heading = Math.atan2(c.y - p.y, c.x - p.x);
      const fx = Math.cos(heading), fy = Math.sin(heading);
      const fwd = -ax.y, side = ax.x;
      ax.x = fx * fwd - fy * side;
      ax.y = fy * fwd + fx * side;
    }
    const len = Math.hypot(ax.x, ax.y);
    const run = inp.down('ShiftLeft', 'ShiftRight') ? 7.2 : 4.6;
    const vx = len ? (ax.x / len) * run * Math.min(1, len) : 0;
    const vy = len ? (ax.y / len) * run * Math.min(1, len) : 0;
    p.move(dt, this.world, vx, vy);
    // facing: the gamepad's right stick (twin-stick), the cursor, or where they walk
    const padAim = this.padAim(0.35);
    if (padAim !== null) p.angle = padAim;
    else if (cursorMode) p.angle = heading;
    else if (!inp.pad.active && (this.time - this.lastMouseMove < 3 || inp.mouseDown)) p.angle = this.aimAngle(p.x, p.y);
    if (p.cooldown > 0) p.cooldown -= dt;
    const firing = inp.mouseDown || inp.down('Space', 'ControlLeft') || inp.touchButtons.has('fire') || (inp.pad.active && inp.pad.rt > 0.5);
    if (firing && p.cooldown <= 0 && this.ammo[p.weapon] > 0) {
      p.cooldown = WEAPONS[p.weapon].cd;
      if (p.weapon === 'fist') this.host.punch(traceMelee(this.host.peds, p, p.angle)?.id ?? 0);
      else {
        this.ammo[p.weapon]--;
        this.fireFrom(p.x, p.y, p.angle);
      }
    }
  }

  /** online with a menu open: the player stands still / brakes, but the world keeps going */
  private idlePlayer(dt: number) {
    const p = this.player;
    const v = p.vehicle;
    if (v) {
      v.setControls(0, 0, true);
      p.x = v.x;
      p.y = v.y;
      this.audio.engine(0, 0, false);
    } else p.move(dt, this.world, 0, 0);
  }

  /** trace a shot from (x, y) against what this client sees, and hand it to the world */
  private fireFrom(x: number, y: number, angle: number) {
    const p = this.player;
    const shot = traceShot(this.world, this.host.peds, this.host.vehicles, { id: p.id, x, y, level: p.level, vehicle: p.vehicle }, angle, p.weapon, Math.random);
    this.host.fire(shot);
  }

  /** world position under the mouse cursor */
  cursorWorld() {
    return {
      x: this.cam.x + (this.input.mouseX - this.viewW / 2) / this.cam.scale,
      y: this.cam.y + (this.input.mouseY - this.viewH / 2) / this.cam.scale,
    };
  }

  aimAngle(x: number, y: number) {
    const c = this.cursorWorld();
    return Math.atan2(c.y - y, c.x - x);
  }

  /** where the gamepad's right stick points (the camera is north-up, so screen = world), when it's
   *  pushed further than `min`; else null */
  private padAim(min: number): number | null {
    const P = this.input.pad;
    return P.active && Math.hypot(P.rx, P.ry) > min ? Math.atan2(P.ry, P.rx) : null;
  }

  /** Street furniture the cars knock over, hydrants gushing, and the player's own car jolting
   *  over speed bumps and kerbs (camera shake, a thud, the pad's rumble). */
  private updateStreet(dt: number) {
    const f = this.focus();
    const street = this.renderer.street;
    street.update(dt, this.host.vehicles, (x, y, kind, speed) => {
      const d = dist(x, y, f.x, f.y);
      if (d > 70) return;
      for (let k = 0; k < 4; k++) this.fx.debris(x, y);
      if (kind === F_HYDRANT) this.fx.splash(x, y);
      this.audio.knock(d, !FURNITURE[kind]?.seat && kind !== 9);
      const car = this.player.vehicle;
      if (car && d < 6) {
        this.juice.addTrauma(Math.min(0.12, speed / 120));
        this.rumble(0.2, 0.35, 90);
      }
    });
    this.geyserAcc += dt;
    if (street.geysers.size && this.geyserAcc > 1 / 30) {
      this.geyserAcc = 0;
      const fu = this.world.furniture;
      for (const i of street.geysers.keys()) if (dist(fu[i], fu[i + 1], f.x, f.y) < 60) this.fx.geyser(fu[i], fu[i + 1]);
    }
    const car = this.player.vehicle;
    if (car !== this.joltCar) (this.joltCar = car), (this.joltSeen = car?.jolts ?? 0);
    else if (car && car.jolts !== this.joltSeen) {
      this.joltSeen = car.jolts;
      const k = car.joltK;
      if (k > 0.12) {
        this.juice.addTrauma(0.05 + k * 0.3);
        this.audio.thud(k);
        this.rumble(0.3 + k * 0.6, 0.2 + k * 0.4, 80 + k * 150);
      }
    }
  }

  /** Gamepad vibration (when a pad is what the player is using). */
  rumble(strong: number, weak: number, ms: number) {
    if (this.input.pad.active) this.input.rumble(strong, weak, ms);
  }

  /** police siren and helicopter rotor loudness from the nearest unit */
  private updateAudio() {
    const f = this.focus();
    const host = this.host;
    if (this.wanted > 0) {
      let nearest = Infinity;
      for (const v of host.vehicles) if (v.kind === 'police' && v.siren && !v.wrecked && !v.isPlayer) nearest = Math.min(nearest, dist(v.x, v.y, f.x, f.y));
      for (const p of host.peds) if (p.kind === 'cop' && !p.dead && !p.vehicle) nearest = Math.min(nearest, dist(p.x, p.y, f.x, f.y));
      this.audio.siren(clamp(1 - nearest / 120, 0, 1));
    } else this.audio.siren(0);
    let heli = Infinity;
    for (const h of host.helis) heli = Math.min(heli, dist(h.x, h.y, f.x, f.y));
    this.audio.rotor(clamp(1 - heli / 90, 0, 1));
  }

  private updateCamera(dt: number) {
    const v = this.player.vehicle;
    const f = this.focus();
    const lead = this.juice.leadOffset(v, dt); // smoothly-eased speed look-ahead
    const k = Math.min(1, dt * 5);
    this.cam.x = lerp(this.cam.x, f.x + lead.x, k);
    this.cam.y = lerp(this.cam.y, f.y + lead.y, k);
    // the mouse wheel zooms in and out around the automatic zoom (unless it's zooming the map)
    const wheel = this.showMap ? 0 : this.input.takeWheel();
    if (wheel) this.zoomPref = clamp(this.zoomPref * 1.12 ** wheel, 0.55, 1.8);
    const base = (Math.min(this.viewW, this.viewH) / CAM_FOOT_M) * this.zoomPref;
    const target = (v ? (base * CAM_CAR_ZOOM) / (1 + v.speed / CAM_SPEED_ZOOM) : base) * this.juice.zoomFactor(v, dt);
    this.cam.scale = lerp(this.cam.scale, target, Math.min(1, dt * 1.5));
    this.postFx?.speed(v ? (v.boosting ? 0.7 : clamp((v.speed - 30) / 40, 0, 0.3)) : 0);
  }

  private updateInfo(dt: number) {
    const f = this.focus();
    this.infoTimer -= dt;
    // the square you're on, else the street (a few times a second is plenty)
    if (this.infoTimer <= 0) {
      this.infoTimer = 0.25;
      const name = this.world.squareAt(f.x, f.y) ?? this.world.streetName(f.x, f.y);
      if (name && name !== this.street.name) this.street = { name, timer: 3.5 };
      // the borough (a message when it changes) and the quarter within it
      const d = this.world.district(f.x, f.y);
      if (d !== this.district) {
        if (this.district) this.message('', d, 2.5, '#b3e5fc');
        this.district = d;
      }
      this.quarter = this.world.quarter(f.x, f.y) ?? '';
    }
    if (this.street.timer > 0) this.street.timer -= dt;
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
    const { dx: sx, dy: sy } = this.juice.shakeOffset();
    ctx.setTransform(this.dpr * v.scale, 0, 0, this.dpr * v.scale, this.dpr * (this.viewW / 2 + sx - this.cam.x * v.scale), this.dpr * (this.viewH / 2 + sy - this.cam.y * v.scale));

    // outside the playable area
    ctx.fillStyle = '#2b2d30';
    const b = this.world.bounds;
    ctx.fillRect(v.x0 - 10, v.y0 - 10, v.x1 - v.x0 + 20, b.y0 - v.y0 + 10);
    ctx.fillRect(v.x0 - 10, b.y1, v.x1 - v.x0 + 20, v.y1 - b.y1 + 10);
    ctx.fillRect(v.x0 - 10, v.y0 - 10, b.x0 - v.x0 + 10, v.y1 - v.y0 + 20);
    ctx.fillRect(b.x1, v.y0 - 10, v.x1 - b.x1 + 10, v.y1 - v.y0 + 20);

    const atmos = this.atmos;
    this.renderer.facades = this.facades;
    this.renderer.drawGround(ctx, v, v.scale > 3);
    this.renderer.drawPortals(ctx, v);
    this.renderer.drawShadows(ctx, v);
    this.renderer.drawBarriers(ctx, v);
    this.renderer.drawPosts(ctx, v);
    this.renderer.street.drawLow(ctx, v, this.time);
    this.weather.drawWorld(ctx, atmos);
    this.fx.drawDecals(ctx, v);
    this.missions.drawWorld(ctx, this.time);
    this.drawPickups(ctx);
    this.fx.drawParticles(ctx, false);

    // entities in the tunnels (only at their portals, fading into the dark, unless the player is
    // underground too: see below), then below any bridge deck, then the deck, then on top of it
    const inView = (x: number, y: number, r: number) => x > v.x0 - r && x < v.x1 + r && y > v.y0 - r && y < v.y1 + r;
    const host = this.host;
    const me = this.player;
    const underground = this.focusLevel() === -1;
    const drawEntities = (level: Level) => {
      for (const p of host.peds) if (p.dead && p.level === level && inView(p.x, p.y, 2)) drawPed(p, ctx, atmos);
      for (const p of host.peds) if (!p.dead && !p.vehicle && p !== me && p.level === level && inView(p.x, p.y, 2)) drawPed(p, ctx, atmos);
      for (const t of host.trams) if (t.level === level && inView(t.x, t.y, 35)) drawTram(t, ctx, atmos, underground ? undefined : this.tunnelFade);
      for (const veh of host.vehicles) if (veh.level === level && inView(veh.x, veh.y, 8)) drawVehicle(veh, ctx, this.time, atmos);
    };
    if (!underground) {
      for (const veh of host.vehicles) {
        if (veh.level !== -1 || !inView(veh.x, veh.y, 8)) continue;
        const a = this.tunnelFade(veh.x, veh.y);
        if (a <= 0) continue;
        ctx.globalAlpha = a;
        drawVehicle(veh, ctx, this.time, atmos);
        ctx.globalAlpha = 1;
      }
      for (const t of host.trams) if (t.level === -1 && inView(t.x, t.y, 35)) drawTram(t, ctx, atmos, this.tunnelFade);
    }
    const lightsTime = atmos.clock.time * SECONDS_PER_HOUR;
    drawEntities(0);
    drawProps(ctx, host.props, 0);
    this.renderer.drawTrafficLights(ctx, v, lightsTime);
    this.renderer.drawBridges(ctx, v, 1);
    drawEntities(1);
    drawProps(ctx, host.props, 1);
    // upper decks (Most SNP's road over its footways, flyovers over their ramps) and what's on them
    this.renderer.drawBridges(ctx, v, 2);
    drawEntities(2);

    this.fx.drawParticles(ctx, true);
    this.renderer.drawBuildings(ctx, v);
    this.drawLandmarks(ctx, v);
    for (const h of host.helis) drawHeli(h, ctx, v, atmos);

    // lighting: ambient tint + emitted lights, multiplied over the world
    const L = this.light;
    L.begin(v, this.viewW, this.viewH, atmos);
    this.renderer.emitLights(L, v);
    this.renderer.emitTrafficLights(L, lightsTime, atmos.night);
    for (const t of host.trams) if (t.level !== -1 || underground) emitTramLights(t, L, atmos);
    for (const veh of host.vehicles) if (inView(veh.x, veh.y, 30)) emitVehicleLights(veh, L, this.time, atmos);
    this.fx.emitLights(L);
    for (const h of host.helis) emitHeliLights(h, L, atmos);
    this.emitAtmosphereLights(L, atmos, inView);
    L.composite(ctx, this.dpr, this.viewW, this.viewH);
    this.renderer.drawNightWindows(ctx, v);

    // in a tunnel: the city above dims away and the tube, with everyone in it, shows through
    if (underground) {
      ctx.save();
      ctx.fillStyle = 'rgba(4,5,9,0.62)';
      ctx.fillRect(v.x0 - 10, v.y0 - 10, v.x1 - v.x0 + 20, v.y1 - v.y0 + 20);
      ctx.restore();
      this.renderer.drawTunnelInterior(ctx, v);
      drawEntities(-1);
    }

    this.drawSigns(ctx, v);
    this.juice.drawTexts(ctx);
    if (hud) this.bubbles.draw(ctx, v);
    if (host.net && hud) drawNametags(ctx, host.net, host.peds, v, host.me.id, underground);
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
    for (const p of this.host.pickups) {
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
        const accent = p.kind === 'health' ? '#e53935' : p.kind === 'armor' ? '#42a5f5' : '#ffd600';
        ctx.fillStyle = p.kind === 'health' ? '#fafafa' : p.kind === 'armor' ? '#0d2440' : '#37474f';
        ctx.fillRect(-0.55, -0.55, 1.1, 1.1);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 0.1;
        ctx.strokeRect(-0.55, -0.55, 1.1, 1.1);
        ctx.fillStyle = accent;
        ctx.font = '900 0.6px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.kind === 'health' ? '+' : p.kind === 'armor' ? 'V' : p.kind === 'pistol' ? 'P' : p.kind === 'uzi' ? 'U' : 'B', 0, 0.04);
      }
      ctx.restore();
    }
  }

  /** Most SNP's pylon and UFO from the map (tower structures, kind 5): the UFO disc (raised,
   *  85-95 m up) and the pylon's two feet beside the deck. Falls back to the landmark point. */
  private snpGeometry() {
    if (this.snp !== undefined) return this.snp;
    const l = this.world.landmarks.get('snp');
    if (!l) return (this.snp = null);
    let ufo = { x: l.x, y: l.y, r: 13, z0: 85, z1: 95 };
    const legs: { x: number; y: number; w: number }[] = [];
    for (const b of this.world.buildings) {
      if (b.kind !== 5 || Math.hypot(b.cx - l.x, b.cy - l.y) > 60) continue;
      const w = b.bbox.x1 - b.bbox.x0, h = b.bbox.y1 - b.bbox.y0;
      if (b.minH > 0) ufo = { x: b.cx, y: b.cy, r: Math.max(w, h) / 2, z0: b.minH, z1: Math.max(b.minH + 4, b.levels * 3.2) };
      else legs.push({ x: b.cx, y: b.cy, w: Math.min(w, h) });
    }
    if (legs.length < 2) legs.splice(0, legs.length, { x: ufo.x - 14, y: ufo.y, w: 5 }, { x: ufo.x + 14, y: ufo.y, w: 5 });
    return (this.snp = { ufo, legs });
  }
  private snp: { ufo: { x: number; y: number; r: number; z0: number; z1: number }; legs: { x: number; y: number; w: number }[] } | null | undefined;

  private drawLandmarks(ctx: CanvasRenderingContext2D, v: View) {
    // Most SNP: the A-frame pylon, whose legs stand beside the deck, carries the UFO restaurant
    // 85 m above the river; cars pass underneath
    const snp = this.snpGeometry();
    if (snp && snp.ufo.x > v.x0 - 150 && snp.ufo.x < v.x1 + 150 && snp.ufo.y > v.y0 - 150 && snp.ufo.y < v.y1 + 150) {
      const { ufo, legs } = snp;
      const s = ufo.r / 16;
      const [ox, oy] = this.renderer.roofOffset(ufo.x, ufo.y, ufo.z0, v);
      // the disc's shadow, cast by the sun from 85 m up
      const sun = this.atmos.sun, day = this.atmos.daylight;
      if (day > 0.05) {
        const h = (ufo.z0 + ufo.z1) / 2;
        ctx.fillStyle = `rgba(20,25,45,${0.22 * day})`;
        ctx.beginPath();
        ctx.arc(ufo.x + sun.dx * h, ufo.y + sun.dy * h, ufo.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // legs: steel box girders leaning in from their feet to meet under the disc
      ctx.fillStyle = '#8f969c';
      ctx.strokeStyle = 'rgba(40,44,48,0.6)';
      ctx.lineWidth = 0.25;
      for (const leg of legs) {
        const tx = ufo.x + ox + (leg.x - ufo.x) * 0.1, ty = ufo.y + oy + (leg.y - ufo.y) * 0.1;
        const dx = tx - leg.x, dy = ty - leg.y, d = Math.hypot(dx, dy) || 1;
        const nx = -dy / d, ny = dx / d, wb = leg.w / 2, wt = 1.3;
        ctx.beginPath();
        ctx.moveTo(leg.x + nx * wb, leg.y + ny * wb);
        ctx.lineTo(tx + nx * wt, ty + ny * wt);
        ctx.lineTo(tx - nx * wt, ty - ny * wt);
        ctx.lineTo(leg.x - nx * wb, leg.y - ny * wb);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const g = ctx.createRadialGradient(ufo.x + ox - 4 * s, ufo.y + oy - 4 * s, 2 * s, ufo.x + ox, ufo.y + oy, 17 * s);
      g.addColorStop(0, '#f5f7f8');
      g.addColorStop(0.6, '#b0b6bb');
      g.addColorStop(1, '#6d7479');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(ufo.x + ox, ufo.y + oy, 16 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#37474f';
      ctx.beginPath();
      ctx.arc(ufo.x + ox, ufo.y + oy, 11 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#cfd8dc';
      ctx.beginPath();
      ctx.arc(ufo.x + ox, ufo.y + oy, 8.5 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(0,229,255,${0.5 + 0.5 * Math.sin(this.time * 3)})`;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + this.time * 0.2;
        ctx.beginPath();
        ctx.arc(ufo.x + ox + Math.cos(a) * 13.5 * s, ufo.y + oy + Math.sin(a) * 13.5 * s, 0.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // landmark labels when zoomed out a bit (one per spot: a label that would overlap one already
    // placed waits until the view moves)
    if (v.scale < 9) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const fs = 13 / v.scale;
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      const taken: number[] = [];
      for (const l of this.world.landmarks.values()) {
        if (l.x < v.x0 || l.x > v.x1 || l.y < v.y0 || l.y > v.y1) continue;
        const w = ctx.measureText(l.name).width;
        const x0 = l.x - w / 2 - fs * 0.4, y0 = l.y - fs * 0.68, x1 = x0 + w + fs * 0.8, y1 = y0 + fs * 1.36;
        let free = true;
        for (let i = 0; i < taken.length && free; i += 4) if (x0 < taken[i + 2] && x1 > taken[i] && y0 < taken[i + 3] && y1 > taken[i + 1]) free = false;
        if (!free) continue;
        taken.push(x0, y0, x1, y1);
        ctx.fillStyle = 'rgba(10,12,16,0.45)';
        roundRect(ctx, x0, y0, x1 - x0, y1 - y0, fs * 0.3);
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
    if (!p.vehicle) drawPed(p, ctx, this.atmos);
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
      for (const p of this.host.pickups) {
        if (!inView(p.x, p.y, 3)) continue;
        const color = PICKUP_GLOW[p.kind];
        L.glow(p.x, p.y + bob, 1.6, color, 0.5 * atmos.night);
      }
      if (!this.missions.active && this.missions.enabled)
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
        } else if (this.slowTimer > 3 && this.facades) {
          // still slow with post-processing off: last resort, drop the textured facades
          this.facades = false;
          this.slowTimer = 0;
        } else if (this.goodTimer > 4 && !this.facades) {
          this.facades = true;
          this.goodTimer = 0;
        } else if (this.goodTimer > 4 && this.qualityTier < 2) {
          this.qualityTier = (this.qualityTier + 1) as 0 | 1 | 2;
          this.goodTimer = 0;
          this.slowTimer = 0;
        }
      } else {
        this.qualityTier = this.qualityPref === 'high' ? 2 : this.qualityPref === 'medium' ? 1 : 0;
        this.facades = this.qualityPref !== 'low';
      }
      this.quality = this.qualityTier > 0 ? 1 : 0;
      if (this.baseLightRes === null) this.baseLightRes = this.light.res;
      this.light.res = this.qualityTier > 0 ? this.baseLightRes : 0.35;
    }
    this.lastFrameT = now;
  }
}

const PICKUP_GLOW: Record<PickupKind, string> = {
  cash: '#69f0ae',
  health: '#ff5252',
  armor: '#42a5f5',
  pistol: '#ffd600',
  uzi: '#ffd600',
  shotgun: '#ffd600',
  cumil: '#ffd600',
};

