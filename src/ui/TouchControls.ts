// The touch screen's controls, landscape-first: a floating stick for the left thumb (it appears where
// the thumb lands), a cluster of buttons for the right thumb that changes with what the player is
// doing (on foot, driving with either scheme, bleeding out, on the city map), and small buttons by
// the minimap (pause, radio). Built once as DOM in #touch; a context switch only toggles visibility.
// It writes into Input the same way the keyboard does: `touch` (stick, aim drag, fire), held codes in
// `touchButtons`, one-shot key presses with `press`. Layout numbers come from src/ui/layout.ts.
import type { Game } from '../game/Game';
import type { WeaponId } from '../shared/entities/Ped';
import { WEAPONS } from '../shared/sim/Combat';
import { KEYS } from '../game/Input';
import { isModalOpen } from './kit/dom';
import { drawWeaponIcon } from './Hud';
import type { HudLayout } from './layout';
import { TouchTips } from './TouchTips';

type Ctx = 'off' | 'foot' | 'car-d' | 'car-c' | 'downed' | 'map';

/** How a control behaves: `press` a key once, `hold` a code while down (`key` also pressed once on
 *  the way down), `act` call a function, or one of the special ones handled below. */
interface Control {
  id: string;
  el: HTMLElement;
  kind: 'press' | 'hold' | 'act' | 'fire' | 'pedal';
  code?: string;
  key?: string;
  act?: () => void;
  /** contexts it shows in */
  in: Ctx[];
}

/** the stick: base radius (px at scale 1), dead zone, and how far past the rim the base follows */
const STICK_R = 56;
const DEAD = 0.12;
const FOLLOW = 1.3;
/** a drag this far from the fire button (px at scale 1) aims by hand */
const AIM_DRAG = 18;

export class TouchControls {
  readonly root: HTMLElement;
  private controls: Control[] = [];
  private byId = new Map<string, Control>();
  private ctx: Ctx | null = null;
  private layout: HudLayout | null = null;
  /** live pointers: which control (or the stick) each is driving */
  private pointers = new Map<number, Control | 'stick'>();
  /** pointers that were live across a context switch: ignored until they lift */
  private dead = new Set<number>();
  private moveZone: HTMLElement;
  private stickBase: HTMLElement;
  private knob: HTMLElement;
  private idleRing: HTMLElement;
  private stick = { x: 0, y: 0, id: -1 };
  private fireStart = { x: 0, y: 0 };
  /** what's shown, so the DOM is only touched on a change */
  private shown = '';
  private weaponShown = '';
  private nitroShown = -1;
  private icons = new Map<WeaponId, HTMLCanvasElement>();
  private weaponIcon: HTMLElement;
  private weaponAmmo: HTMLElement;
  readonly tips: TouchTips;

  constructor(private g: Game) {
    const root = document.getElementById('touch')!;
    this.root = root;
    root.textContent = '';
    root.classList.remove('hidden');
    document.documentElement.classList.add('touch');
    // no long-press menus, no text selection, no image dragging on the controls
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS ignores user-scalable=no: stop two-finger pinches zooming the page
    for (const t of ['gesturestart', 'gesturechange'] as const) document.addEventListener(t, (e) => e.preventDefault());

    this.moveZone = el('div', 't-zone');
    this.idleRing = el('div', 't-idle');
    this.stickBase = el('div', 't-stick');
    this.knob = el('div', 't-knob');
    this.stickBase.appendChild(this.knob);
    root.append(this.moveZone, this.idleRing, this.stickBase);
    this.bindStick();

    const foot: Ctx[] = ['foot'], car: Ctx[] = ['car-d', 'car-c'], play: Ctx[] = ['foot', 'car-d', 'car-c', 'downed'];
    this.add('pause', 'press', '', { code: 'Escape', in: play, label: 'Pauza', cls: 't-util t-pause' });
    this.add('radio', 'press', '📻', { code: 'KeyR', in: car, label: 'Rádio', cls: 't-util' });
    this.add('map', 'press', '', { code: 'KeyM', in: play, label: 'Mapa mesta', cls: 't-hit' });
    this.add('daily', 'press', '', { code: KEYS.daily, in: play, label: 'Kde to je?', cls: 't-hit' });
    this.add('fire', 'fire', '', { in: [...foot, ...car], label: 'Streľba', cls: 't-fire' });
    this.add('weapon', 'press', '', { code: 'KeyQ', in: [...foot, ...car], label: 'Zbraň', cls: 't-weapon' });
    this.add('use', 'press', '', { code: 'KeyF', in: [...foot, ...car], label: '', cls: 't-use' });
    this.add('brake', 'hold', 'BRZDA', { code: 'brake', in: ['car-d'], label: 'Brzda', cls: 't-brake' });
    this.add('pedal', 'pedal', '', { in: ['car-c'], label: 'Plyn a brzda', cls: 't-pedal' });
    this.add('handbrake', 'hold', 'RUČNÁ', { code: 'handbrake', in: car, label: 'Ručná brzda', cls: 't-hand' });
    this.add('nitro', 'hold', 'N₂O', { code: 'nitro', in: car, label: 'Nitro', cls: 't-nitro' });
    // the horn is held as well as pressed: holding it next to another player's car challenges them
    this.add('horn', 'hold', '📣', { code: KEYS.horn, key: KEYS.horn, in: car, label: 'Klaksón', cls: 't-small' });
    this.add('talk', 'hold', '🎙', { code: KEYS.talk, in: play, label: 'Hovoriť', cls: 't-small' });
    this.add('giveup', 'press', 'Vzdať sa', { code: KEYS.giveUp, in: ['downed'], label: 'Vzdať sa', cls: 't-use' });
    this.add('mapClose', 'press', '✕', { code: 'KeyM', in: ['map'], label: 'Zavrieť mapu', cls: 't-mapbtn' });
    this.add('zoomIn', 'act', '+', { act: () => g.mapView.zoomBy(1.4), in: ['map'], label: 'Priblížiť', cls: 't-mapbtn' });
    this.add('zoomOut', 'act', '−', { act: () => g.mapView.zoomBy(1 / 1.4), in: ['map'], label: 'Oddialiť', cls: 't-mapbtn' });
    this.add('center', 'act', '⌖', { act: () => g.mapView.centerOnPlayer(), in: ['map'], label: 'Kde som', cls: 't-mapbtn' });

    // the pedal: one element, BRAKE on the left half, GAS on the right, so a thumb can slide across
    const pedal = this.byId.get('pedal')!.el;
    pedal.append(el('span', 't-pedal-brake', 'BRZDA'), el('span', 't-pedal-gas', 'PLYN'));
    // the weapon button: its icon and the ammo left
    const weapon = this.byId.get('weapon')!.el;
    this.weaponIcon = el('span', 't-weapon-icon');
    this.weaponAmmo = el('span', 't-weapon-ammo');
    weapon.append(this.weaponIcon, this.weaponAmmo);
    this.byId.get('fire')!.el.append(el('span', 't-fire-icon', '🎯'));

    this.tips = new TouchTips(g, this);
  }

  private add(id: string, kind: Control['kind'], text: string, o: { code?: string; key?: string; act?: () => void; in: Ctx[]; label: string; cls: string }) {
    const b = el('div', `t-btn ${o.cls}`, text);
    b.dataset.id = id;
    b.setAttribute('role', 'button');
    if (o.label) b.setAttribute('aria-label', o.label);
    this.root.appendChild(b);
    const c: Control = { id, el: b, kind, code: o.code, key: o.key, act: o.act, in: o.in };
    this.controls.push(c);
    this.byId.set(id, c);
    this.bind(c);
  }

  /** a control's element, for the tips to point at */
  element(id: string): HTMLElement | null {
    return this.byId.get(id)?.el ?? null;
  }

  // ------------------------------------------------------------------------------------ input
  private live(e: PointerEvent) {
    if (this.dead.has(e.pointerId)) {
      if (e.type === 'pointerup' || e.type === 'pointercancel') this.dead.delete(e.pointerId);
      return false;
    }
    return true;
  }

  private bind(c: Control) {
    const inp = this.g.input;
    const b = c.el;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.live(e) || this.pointers.has(e.pointerId)) return;
      capture(b, e.pointerId);
      this.pointers.set(e.pointerId, c);
      this.g.audio.init();
      b.classList.add('down');
      this.tips.did(c.id);
      switch (c.kind) {
        case 'press':
          inp.press(c.code!);
          break;
        case 'act':
          c.act!();
          break;
        case 'hold':
          if (c.key) inp.press(c.key);
          inp.touchButtons.add(c.code!);
          break;
        case 'fire':
          this.fireStart = { x: e.clientX, y: e.clientY };
          inp.touch.fire = true;
          break;
        case 'pedal':
          this.pedal(e);
          break;
      }
    });
    b.addEventListener('pointermove', (e) => {
      if (this.pointers.get(e.pointerId) !== c) return;
      if (c.kind === 'pedal') this.pedal(e);
      else if (c.kind === 'fire') {
        const dx = e.clientX - this.fireStart.x, dy = e.clientY - this.fireStart.y;
        const d = Math.hypot(dx, dy);
        const t = inp.touch;
        if (d > AIM_DRAG * (this.layout?.ts ?? 1)) (t.aim.on = true), (t.aim.x = dx / d), (t.aim.y = dy / d);
      }
    });
    const up = (e: PointerEvent) => {
      if (!this.live(e) || this.pointers.get(e.pointerId) !== c) return;
      this.pointers.delete(e.pointerId);
      this.release(c);
    };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
  }

  /** a control let go of: stop whatever it held */
  private release(c: Control) {
    const inp = this.g.input;
    c.el.classList.remove('down');
    if (c.kind === 'hold') inp.touchButtons.delete(c.code!);
    else if (c.kind === 'fire') {
      inp.touch.fire = false;
      inp.touch.aim.on = false;
    } else if (c.kind === 'pedal') {
      inp.touchButtons.delete('gas');
      inp.touchButtons.delete('brake');
      c.el.classList.remove('gas', 'brake');
    }
  }

  /** the classic pedal: the half under the thumb */
  private pedal(e: PointerEvent) {
    const c = this.byId.get('pedal')!;
    const r = c.el.getBoundingClientRect();
    const gas = e.clientX >= r.left + r.width / 2;
    const tb = this.g.input.touchButtons;
    tb.delete(gas ? 'brake' : 'gas');
    tb.add(gas ? 'gas' : 'brake');
    c.el.classList.toggle('gas', gas);
    c.el.classList.toggle('brake', !gas);
  }

  private bindStick() {
    const z = this.moveZone;
    z.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.live(e) || this.stick.id >= 0) return;
      capture(z, e.pointerId);
      this.pointers.set(e.pointerId, 'stick');
      this.g.audio.init();
      const R = STICK_R * (this.layout?.ts ?? 1);
      // keep the whole base on the screen
      const x = Math.max(R, Math.min(innerWidth - R, e.clientX)), y = Math.max(R, Math.min(innerHeight - R, e.clientY));
      this.stick = { x, y, id: e.pointerId };
      this.stickBase.style.transform = `translate(${x - R}px, ${y - R}px)`;
      this.root.classList.add('sticking');
      this.moveStick(e.clientX, e.clientY);
    });
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stick.id) this.moveStick(e.clientX, e.clientY);
    });
    const up = (e: PointerEvent) => {
      if (!this.live(e) || e.pointerId !== this.stick.id) return;
      this.pointers.delete(e.pointerId);
      this.releaseStick();
    };
    z.addEventListener('pointerup', up);
    z.addEventListener('pointercancel', up);
    z.addEventListener('lostpointercapture', up);
  }

  private moveStick(px: number, py: number) {
    const R = STICK_R * (this.layout?.ts ?? 1);
    let dx = px - this.stick.x, dy = py - this.stick.y;
    let d = Math.hypot(dx, dy);
    // dragged well past the rim: the base follows the thumb
    if (d > R * FOLLOW) {
      const k = (d - R * FOLLOW) / d;
      this.stick.x += dx * k;
      this.stick.y += dy * k;
      this.stickBase.style.transform = `translate(${this.stick.x - R}px, ${this.stick.y - R}px)`;
      dx = px - this.stick.x;
      dy = py - this.stick.y;
      d = Math.hypot(dx, dy);
    }
    const k = d > R ? R / d : 1;
    let x = (dx * k) / R, y = (dy * k) / R;
    if (this.ctx === 'car-c') y = 0; // classic: the stick only steers
    this.knob.style.transform = `translate(${x * R}px, ${y * R}px)`;
    const m = Math.hypot(x, y);
    // the dead zone, rescaled so the push still reaches 1
    if (m < DEAD) x = y = 0;
    else (x *= (m - DEAD) / (1 - DEAD) / m), (y *= (m - DEAD) / (1 - DEAD) / m);
    const t = this.g.input.touch.move;
    t.x = x;
    t.y = y;
    t.on = true;
    // on foot a full push runs: the knob lights up
    this.knob.classList.toggle('run', this.ctx === 'foot' && Math.hypot(x, y) > 0.85);
    if (m > 0.5) this.tips.did('stick');
  }

  private releaseStick() {
    this.stick.id = -1;
    const t = this.g.input.touch.move;
    t.x = t.y = 0;
    t.on = false;
    this.knob.style.transform = '';
    this.knob.classList.remove('run');
    this.root.classList.remove('sticking');
  }

  /** let go of everything (a context switch): pointers still down are ignored until they lift */
  private releaseAll() {
    for (const [id, c] of this.pointers) {
      this.dead.add(id);
      if (c !== 'stick') {
        try {
          c.el.releasePointerCapture(id);
        } catch {
          /* not captured */
        }
      }
    }
    this.pointers.clear();
    for (const c of this.controls) c.el.classList.remove('down', 'gas', 'brake');
    this.releaseStick();
    this.g.input.resetTouch();
  }

  // ------------------------------------------------------------------------------------ per frame
  private context(): Ctx {
    const g = this.g;
    if (!g.running || g.paused || isModalOpen() || g.input.pad.active) return 'off';
    if (g.showMap) return 'map';
    if (g.state === 'downed') return 'downed';
    if (g.state !== 'play') return 'off';
    if (g.player.vehicle) return g.driveControls === 'classic' ? 'car-c' : 'car-d';
    return 'foot';
  }

  /** once a frame (main.ts): context, what's shown, positions */
  update() {
    const g = this.g;
    const ctx = this.context();
    if (g.layout !== this.layout) {
      this.layout = g.layout;
      this.place(g.layout);
    }
    if (ctx !== this.ctx) {
      this.releaseAll();
      this.ctx = ctx;
      this.root.dataset.ctx = ctx;
      this.placeCluster();
    }
    // what's shown besides the context
    const v = g.player.vehicle;
    const pr = ctx === 'foot' || ctx === 'car-d' || ctx === 'car-c' ? g.prompt() : null;
    const useText = pr?.use ? pr.text : v ? 'Vystúpiť' : '';
    const hasGun = g.ammo.pistol > 0 || g.ammo.uzi > 0 || g.ammo.shotgun > 0;
    const daily = (g.features.find((f) => f.id === 'daily') as { cardRect?: { x: number; y: number; w: number; h: number } | null } | undefined)?.cardRect ?? null;
    const voice = g.features.find((f) => f.id === 'voice') as { pushToTalk?: boolean } | undefined;
    const show: Record<string, boolean> = {
      use: !!useText,
      // a drive-by needs a gun (Game picks one when the fists are out)
      fire: !v || hasGun,
      radio: !!v && v.kind !== 'police',
      talk: !!voice?.pushToTalk,
      daily: !!daily,
    };
    const key = `${ctx}|${useText}|${Object.entries(show).map(([k, b]) => (b ? k : '')).join(',')}|${daily ? `${daily.x},${daily.y},${daily.w},${daily.h}` : ''}`;
    if (key !== this.shown) {
      this.shown = key;
      for (const c of this.controls) {
        const on = c.in.includes(ctx) && (show[c.id] ?? true);
        c.el.classList.toggle('off', !on);
        // hidden while held: let it go (display:none keeps the pointer captured)
        if (!on) for (const [id, pc] of this.pointers) if (pc === c) (this.pointers.delete(id), this.dead.add(id), this.release(c));
      }
      const use = this.byId.get('use')!.el;
      use.textContent = useText;
      if (daily) setRect(this.byId.get('daily')!.el, daily);
    }
    // the weapon button: the icon and ammo
    const w = g.player.weapon;
    const wKey = `${w}|${w === 'fist' ? '' : g.ammo[w]}`;
    if (wKey !== this.weaponShown && (ctx === 'foot' || ctx === 'car-d' || ctx === 'car-c')) {
      this.weaponShown = wKey;
      this.weaponIcon.textContent = '';
      this.weaponIcon.appendChild(this.icon(w));
      this.weaponAmmo.textContent = w === 'fist' ? WEAPONS.fist.name : String(g.ammo[w]);
    }
    // the nitro charge ring, in 5% steps
    if (v) {
      const n = Math.round(Math.max(0, Math.min(1, v.nitro)) * 20);
      if (n !== this.nitroShown) {
        this.nitroShown = n;
        this.byId.get('nitro')!.el.style.setProperty('--charge', String(n / 20));
      }
    }
    this.tips.update();
  }

  private icon(w: WeaponId): HTMLCanvasElement {
    let c = this.icons.get(w);
    if (!c) {
      const dpr = Math.min(2, devicePixelRatio || 1), s = 30;
      c = document.createElement('canvas');
      c.width = c.height = s * dpr;
      c.style.width = c.style.height = s + 'px';
      const cx = c.getContext('2d')!;
      cx.scale(dpr, dpr);
      drawWeaponIcon(cx, w, s / 2, s / 2, s * 0.4);
      this.icons.set(w, c);
    }
    return c;
  }

  /** put everything where the layout says (on a resize or rotation) */
  private place(L: HudLayout) {
    const ts = L.ts;
    this.root.style.setProperty('--ts', String(ts));
    // the stick's zone: the left of the screen under the minimap corner (portrait: the lower half)
    const top = L.portrait ? L.H * 0.45 : Math.min(L.thumbs!.left.y, L.place.y + 4);
    setRect(this.moveZone, { x: 0, y: top, w: L.portrait ? L.W * 0.5 : L.W * 0.45, h: L.H - top });
    const R = STICK_R * ts;
    const idle = { x: L.thumbs!.left.x + L.thumbs!.left.w / 2, y: L.thumbs!.left.y + L.thumbs!.left.h / 2 };
    setRect(this.idleRing, { x: idle.x - R, y: idle.y - R, w: 2 * R, h: 2 * R });
    this.stickBase.style.width = this.stickBase.style.height = 2 * R + 'px';
    // by the minimap: pause and radio in a column, a tap target over the minimap
    const u = L.util;
    setRect(this.byId.get('pause')!.el, { x: u.x, y: u.y, w: u.size, h: u.size });
    setRect(this.byId.get('radio')!.el, { x: u.x, y: u.y + u.size + u.gap, w: u.size, h: u.size });
    const m = L.mini;
    setRect(this.byId.get('map')!.el, { x: m.cx - m.r, y: m.cy - m.r, w: 2 * m.r, h: 2 * m.r });
    // the right thumb's cluster, from the bottom-right corner (centres, px at scale 1)
    const ax = L.W - L.padR - 10 * ts, ay = L.H - L.padB - 10 * ts;
    const at = (id: string, dx: number, dy: number, size: number) => {
      const s = size * ts;
      setRect(this.byId.get(id)!.el, { x: ax + dx * ts - s / 2, y: ay + dy * ts - s / 2, w: s, h: s });
    };
    // positions per context; a control in two contexts takes its first spot and is moved on a switch
    this.spots = {
      foot: () => {
        at('fire', -50, -50, 88);
        at('weapon', -150, -34, 58);
        at('talk', -150, -112, 46);
        this.pill('use', ax - 10 * ts, ay - 118 * ts);
      },
      car: (classic: boolean) => {
        if (classic) {
          const pw = 156 * ts, ph = 96 * ts;
          setRect(this.byId.get('pedal')!.el, { x: ax - pw, y: ay - ph, w: pw, h: ph });
          at('handbrake', -198, -42, 58);
          at('nitro', -40, -138, 58);
          at('fire', -116, -146, 56);
          at('weapon', -198, -116, 44);
          at('horn', -196, -170, 44);
        } else {
          at('brake', -46, -46, 80);
          at('handbrake', -140, -36, 60);
          at('nitro', -40, -136, 60);
          at('fire', -128, -120, 58);
          at('weapon', -206, -124, 44);
          at('horn', -210, -64, 44);
        }
        at('talk', -252, -150, 40);
        this.pill('use', ax - 10 * ts, ay - 196 * ts);
      },
      downed: () => this.pill('giveup', ax - 10 * ts, ay - 40 * ts),
    };
    // the map's buttons: close top-right, zoom and "where am I" down the right edge
    const mb = 46 * ts, mx = L.W - L.padR - mb - 4;
    setRect(this.byId.get('mapClose')!.el, { x: mx, y: L.padT + 40, w: mb, h: mb });
    ['zoomIn', 'zoomOut', 'center'].forEach((id, i) => setRect(this.byId.get(id)!.el, { x: mx, y: L.H / 2 - mb * 1.6 + i * (mb + 10), w: mb, h: mb }));
    this.placeCluster();
  }

  private spots: { foot: () => void; car: (classic: boolean) => void; downed: () => void } | null = null;

  /** the cluster's spots for the current context (the same button sits elsewhere on foot and driving) */
  private placeCluster() {
    const s = this.spots;
    if (!s) return;
    const c = this.ctx;
    if (c === 'car-d' || c === 'car-c') s.car(c === 'car-c');
    else if (c === 'downed') s.downed();
    else s.foot();
  }

  /** a pill-shaped button right-aligned at (right, centre y) */
  private pill(id: string, right: number, cy: number) {
    const e = this.byId.get(id)!.el;
    const h = 50 * (this.layout?.ts ?? 1);
    e.style.left = '';
    e.style.right = `${innerWidth - right}px`;
    e.style.top = `${cy - h / 2}px`;
    e.style.width = '';
    e.style.height = `${h}px`;
  }
}

function el(tag: string, cls: string, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function setRect(e: HTMLElement, r: { x: number; y: number; w: number; h: number }) {
  e.style.left = `${r.x}px`;
  e.style.top = `${r.y}px`;
  e.style.right = '';
  e.style.width = `${r.w}px`;
  e.style.height = `${r.h}px`;
}

/** capture a pointer to the element it went down on (throws for synthetic events: harmless) */
function capture(e: HTMLElement, id: number) {
  try {
    e.setPointerCapture(id);
  } catch {
    /* a script-made event */
  }
}
