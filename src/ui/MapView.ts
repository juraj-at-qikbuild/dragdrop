import type { Game } from '../game/Game';
import { outlined } from './Hud';
import type { View } from '../world/Renderer';

const PX = 0.6; // pixels per metre in the cached map image
const GOLD_FRAME = '#ffd600';
/** the full map's zoom range (screen px per metre): from the whole city to a few streets */
const MAX_ZOOM = 6;
/** above this zoom the map is drawn from the city's own geometry instead of the cached image */
const DETAIL_ZOOM = PX * 1.4;
const BODY = `'Inter', system-ui, sans-serif`;

/** POI groups on the city map, each switched on and off in the legend */
type Group = 'landmarks' | 'missions' | 'services' | 'food' | 'culture' | 'shops' | 'transit';
const GROUPS: { id: Group; label: string; icon: string; minZoom: number }[] = [
  { id: 'missions', label: 'Misie', icon: 'phone', minZoom: 0 },
  { id: 'landmarks', label: 'Pamiatky', icon: 'star', minZoom: 0 },
  { id: 'services', label: 'Polícia, nemocnica, striekareň', icon: 'police', minZoom: 0 },
  { id: 'culture', label: 'Múzeá, divadlá, kostoly', icon: 'museum', minZoom: 0.9 },
  { id: 'food', label: 'Reštaurácie, kaviarne, bary', icon: 'food', minZoom: 1.6 },
  { id: 'shops', label: 'Potraviny, lekárne, banky, pošta', icon: 'grocery', minZoom: 1.6 },
  { id: 'transit', label: 'Električky, taxi', icon: 'tram', minZoom: 0.9 },
];
const PLACE_GROUP: Record<string, Group> = {
  food: 'food', cafe: 'food', bar: 'food', museum: 'culture', theatre: 'culture', church: 'culture', library: 'culture', view: 'culture',
  grocery: 'shops', bakery: 'shops', pharmacy: 'shops', bank: 'shops', post: 'shops', hotel: 'shops', taxi: 'transit', wc: 'shops',
};
/** badge colour per icon */
const ICON_BG: Record<string, string> = {
  food: '#e65100', cafe: '#6d4c41', bar: '#7b1fa2', pharmacy: '#00897b', museum: '#546e7a', theatre: '#4a148c', church: '#5e35b1',
  library: '#795548', view: '#2e7d32', grocery: '#2e7d32', bakery: '#f9a825', bank: '#1565c0', post: '#ef6c00', hotel: '#283593',
  wc: '#607d8b', taxi: '#f9a825', tram: '#d71920', police: '#1565c0', hospital: '#d32f2f', fuel: '#0288d1', star: '#78909c', phone: '#ffd600',
};

interface Label {
  x: number;
  y: number;
  text: string;
  a: number;
  font: string;
  color: string;
  prio: number;
  w?: number;
}

/** Pre-rendered city map used by the minimap, and the full-screen city map (M): zoom with the wheel
 *  (or the triggers / +−), pan by dragging (or the stick / WASD), click to set a waypoint the GPS
 *  leads to, right-click to clear it. Street names, places and landmarks, decluttered. */
export class MapView {
  private img: HTMLCanvasElement | null = null;
  /** the full map's view: screen px per metre and the world point at the map's centre */
  private zoom = 0;
  private cx = 0;
  private cy = 0;
  private detail: { canvas: HTMLCanvasElement; key: string } | null = null;
  private groups: Record<Group, boolean> = { missions: true, landmarks: true, services: true, culture: true, food: false, shops: false, transit: false };
  /** street name candidates: one per named road, at its longest stretch */
  private streets: { x: number; y: number; a: number; len: number; name: string; cls: number }[] | null = null;
  /** pointers down on the map (for drag and pinch) */
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number }>();
  private dragged = false;
  private pinch = 0;
  /** legend rows' hit boxes, from the last draw */
  private legendHits: { x: number; y: number; w: number; h: number; id: Group }[] = [];
  private hover: { x: number; y: number } | null = null;

  constructor(private g: Game) {
    const c = g.canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    addEventListener('pointermove', (e) => this.onMove(e));
    addEventListener('pointerup', (e) => this.onUp(e));
    addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
  }

  private image() {
    if (this.img) return this.img;
    const b = this.g.world.bounds;
    const c = document.createElement('canvas');
    c.width = Math.ceil((b.x1 - b.x0) * PX);
    c.height = Math.ceil((b.y1 - b.y0) * PX);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#9e998f';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(PX, 0, 0, PX, -b.x0 * PX, -b.y0 * PX);
    const v = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, camX: 0, camY: 0, camH: 1000, scale: PX };
    this.g.renderer.drawGround(ctx, v, false);
    ctx.globalAlpha = 0.85;
    this.g.renderer.drawBuildingsFlat(ctx);
    ctx.globalAlpha = 1;
    this.img = c;
    return c;
  }

  // ------------------------------------------------------------------ full map: state and input
  /** the map's frame on screen (CSS px) */
  private frame() {
    const W = this.g.viewW, H = this.g.viewH;
    const top = 44, bottom = 30;
    return { x: 8, y: top, w: W - 16, h: H - top - bottom };
  }

  private fitZoom() {
    const b = this.g.world.bounds, f = this.frame();
    return Math.min(f.w / (b.x1 - b.x0), f.h / (b.y1 - b.y0));
  }

  /** the map was opened: centred on the player, zoomed to a few blocks around them */
  onOpen() {
    const f = this.g.focus();
    this.cx = f.x;
    this.cy = f.y;
    this.zoom = Math.max(this.fitZoom(), Math.min(1.2, MAX_ZOOM));
    this.pointers.clear();
    this.clampView();
  }

  private clampView() {
    const b = this.g.world.bounds, f = this.frame();
    this.zoom = Math.max(this.fitZoom(), Math.min(MAX_ZOOM, this.zoom));
    const hw = f.w / 2 / this.zoom, hh = f.h / 2 / this.zoom;
    this.cx = b.x1 - b.x0 <= hw * 2 ? (b.x0 + b.x1) / 2 : Math.max(b.x0 + hw, Math.min(b.x1 - hw, this.cx));
    this.cy = b.y1 - b.y0 <= hh * 2 ? (b.y0 + b.y1) / 2 : Math.max(b.y0 + hh, Math.min(b.y1 - hh, this.cy));
  }

  /** screen (CSS px) <-> world */
  private toScreen = (x: number, y: number): [number, number] => {
    const f = this.frame();
    return [f.x + f.w / 2 + (x - this.cx) * this.zoom, f.y + f.h / 2 + (y - this.cy) * this.zoom];
  };
  private toWorld(sx: number, sy: number) {
    const f = this.frame();
    return { x: this.cx + (sx - f.x - f.w / 2) / this.zoom, y: this.cy + (sy - f.y - f.h / 2) / this.zoom };
  }

  /** zoom by `k` keeping the world point under (sx, sy) where it is */
  private zoomAt(k: number, sx: number, sy: number) {
    const before = this.toWorld(sx, sy);
    this.zoom *= k;
    this.clampView();
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
    this.clampView();
  }

  private onDown(e: PointerEvent) {
    if (!this.g.showMap) return;
    if (e.button === 2) {
      this.g.gps.clearWaypoint();
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
    this.dragged = false;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }

  private onMove(e: PointerEvent) {
    if (!this.g.showMap) return;
    this.hover = { x: e.clientX, y: e.clientY };
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 6) this.dragged = true;
    if (this.pointers.size === 2) {
      // pinch to zoom about the midpoint
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch > 0 && d > 0) this.zoomAt(d / this.pinch, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.pinch = d;
      return;
    }
    if (this.dragged) {
      this.cx -= dx / this.zoom;
      this.cy -= dy / this.zoom;
      this.clampView();
    }
  }

  private onUp(e: PointerEvent) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!p || !this.g.showMap || this.dragged || this.pointers.size) return;
    this.click(e.clientX, e.clientY);
  }

  /** a click (or tap) on the map: a legend row toggles its places, anywhere else sets the waypoint */
  private click(sx: number, sy: number) {
    for (const h of this.legendHits)
      if (sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h) {
        this.groups[h.id] = !this.groups[h.id];
        return;
      }
    const f = this.frame();
    if (sx < f.x || sx > f.x + f.w || sy < f.y || sy > f.y + f.h) return;
    const w = this.toWorld(sx, sy);
    const gps = this.g.gps;
    // clicking the waypoint again removes it
    const wp = gps.waypoint;
    if (wp) {
      const [px, py] = this.toScreen(wp.x, wp.y);
      if (Math.hypot(px - sx, py - sy) < 14) {
        gps.clearWaypoint();
        return;
      }
    }
    gps.setWaypoint(w.x, w.y);
    this.g.audio.pickup();
  }

  /** Keys, pad and wheel while the map is open (called every frame by Game). */
  update(dt: number) {
    const inp = this.g.input;
    if (!this.zoom) this.onOpen();
    const wheel = inp.takeWheel();
    const f = this.frame();
    if (wheel) this.zoomAt(1.25 ** wheel, this.hover?.x ?? f.x + f.w / 2, this.hover?.y ?? f.y + f.h / 2);
    // pan: WASD / arrows / the pad's left stick; zoom: + - / the pad's triggers
    const ax = inp.axis();
    const pan = (600 / this.zoom) * dt;
    if (ax.x || ax.y) {
      this.cx += ax.x * pan;
      this.cy += ax.y * pan;
    }
    let z = 0;
    if (inp.down('Equal', 'NumpadAdd', 'PageUp')) z += 1;
    if (inp.down('Minus', 'NumpadSubtract', 'PageDown')) z -= 1;
    if (inp.pad.active) z += inp.pad.rt - inp.pad.lt;
    if (z) this.zoomAt(Math.exp(z * 2 * dt), f.x + f.w / 2, f.y + f.h / 2);
    // a waypoint at the centre cross (keyboard and pad); clear it
    if (inp.hit('Enter', 'Space', 'KeyF')) {
      this.g.gps.setWaypoint(this.cx, this.cy);
      this.g.audio.pickup();
    }
    if (inp.hit('Backspace', 'Delete', 'KeyH')) this.g.gps.clearWaypoint();
    // layers on the number keys
    GROUPS.forEach((gr, i) => {
      if (inp.hit(`Digit${i + 1}`)) this.groups[gr.id] = !this.groups[gr.id];
    });
    this.clampView();
  }

  // ------------------------------------------------------------------ drawing helpers
  /** police "last seen" area: stay out of it for the stars to drop */
  private searchZone(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
    const blue = Math.floor(this.g.time * 3) % 2 === 0;
    ctx.save();
    ctx.fillStyle = blue ? 'rgba(66,133,244,0.22)' : 'rgba(229,57,53,0.22)';
    ctx.strokeStyle = blue ? 'rgba(66,133,244,0.85)' : 'rgba(229,57,53,0.85)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** the GPS route as a bold line (purple to a waypoint, gold to a mission) */
  private drawRoute(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], width: number) {
    const gps = this.g.gps;
    const r = gps.route;
    if (!gps.target || r.length < 4) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < r.length; i += 2) {
      const [x, y] = toScreen(r[i], r[i + 1]);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = width + 3;
    ctx.stroke();
    ctx.strokeStyle = gps.target.kind === 'mission' ? '#ffd600' : '#b388ff';
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.restore();
  }

  /** the waypoint flag */
  private drawWaypoint(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, 0, s * 0.6, s * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = Math.max(1.5, s * 0.14);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -s * 2);
    ctx.stroke();
    ctx.fillStyle = '#b388ff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, -s * 2);
    ctx.lineTo(s * 1.3, -s * 1.6);
    ctx.lineTo(0, -s * 1.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private blips(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], size: number, full: boolean) {
    const g = this.g;
    // mission booths and targets
    if (!g.missions.active && (!full || this.groups.missions))
      for (const b of g.missions.available()) {
        const [x, y] = toScreen(b.x, b.y);
        badge(ctx, x, y, size * 1.1, 'phone');
      }
    const t = g.missions.target();
    if (t) {
      const [x, y] = toScreen(t.x, t.y);
      ctx.fillStyle = '#ffea00';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, size * 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    const wp = g.gps.waypoint;
    if (wp && !t) {
      const [x, y] = toScreen(wp.x, wp.y);
      this.drawWaypoint(ctx, x, y, size * 1.1);
    }
    if (!full || this.groups.services) {
      for (const f of g.world.pois('fuel')) {
        const [x, y] = toScreen(f.x, f.y);
        if (full) badge(ctx, x, y, size * 0.95, 'fuel');
        else {
          ctx.fillStyle = '#29b6f6';
          ctx.fillRect(x - size * 0.6, y - size * 0.6, size * 1.2, size * 1.2);
        }
      }
      if (full) {
        for (const p of g.world.pois('police')) badge(ctx, ...toScreen(p.x, p.y), size * 0.95, 'police');
        for (const p of g.world.pois('hospital')) badge(ctx, ...toScreen(p.x, p.y), size * 0.95, 'hospital');
      }
    }
    for (const v of g.vehicles) {
      if (v.kind !== 'police' || !v.siren) continue;
      const [x, y] = toScreen(v.x, v.y);
      ctx.fillStyle = Math.floor(g.time * 6) % 2 ? '#ff1744' : '#2979ff';
      ctx.beginPath();
      ctx.arc(x, y, size * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    // other players online (from the 1 Hz roster), wanted ones in red
    const net = g.online;
    if (net)
      for (const [id, nick, x0, y0, wanted] of net.roster) {
        if (id === g.host.me.id) continue;
        const [x, y] = toScreen(x0, y0);
        ctx.fillStyle = wanted > 0 ? '#ff5252' : '#b388ff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, size * 0.85, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (full) {
          ctx.font = `700 11px ${BODY}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          outlined(ctx, nick, x, y - size - 2, '#e1bee7', 3);
        }
      }
    // player arrow
    const f = g.focus();
    const a = g.player.vehicle ? g.player.vehicle.angle : g.player.angle;
    const [px, py] = toScreen(f.x, f.y);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(size * 1.5, 0);
    ctx.lineTo(-size, -size);
    ctx.lineTo(-size * 0.4, 0);
    ctx.lineTo(-size, size);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  drawMini(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
    const g = this.g;
    const img = this.image();
    const b = g.world.bounds;
    const f = g.focus();
    const range = g.player.vehicle ? 260 : 170; // metres from centre to edge
    const k = r / range;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#2b2d30';
    ctx.fill();
    ctx.clip();
    const sx = (f.x - range - b.x0) * PX, sy = (f.y - range - b.y0) * PX;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, sx, sy, range * 2 * PX, range * 2 * PX, cx - r, cy - r, r * 2, r * 2);
    const flat = (x: number, y: number): [number, number] => [cx + (x - f.x) * k, cy + (y - f.y) * k];
    this.drawRoute(ctx, flat, Math.max(2.5, r / 26));
    const toScreen = (x: number, y: number): [number, number] => {
      let dx = (x - f.x) * k, dy = (y - f.y) * k;
      const d = Math.hypot(dx, dy);
      if (d > r - 6) (dx *= (r - 6) / d), (dy *= (r - 6) / d);
      return [cx + dx, cy + dy];
    };
    const z = g.searchZone;
    if (z) this.searchZone(ctx, cx + (z.x - f.x) * k, cy + (z.y - f.y) * k, z.r * k);
    this.blips(ctx, toScreen, Math.max(3, r / 22), false);
    // night dimming: a translucent navy wash over the tile, before the frame
    const night = g.atmos.night;
    if (night > 0.02) {
      ctx.fillStyle = `rgba(12,18,42,${(night * 0.4).toFixed(3)})`;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.restore();
    // outer ring: dark bevel, gold hairline, soft outer glow, gloss highlight along the top
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    const bevel = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    bevel.addColorStop(0, 'rgba(255,255,255,0.5)');
    bevel.addColorStop(0.5, 'rgba(255,214,0,0.4)');
    bevel.addColorStop(1, 'rgba(120,90,0,0.4)');
    ctx.strokeStyle = bevel;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    // north marker: small gold pointer + "S" (Sever) tab riding the ring
    ctx.save();
    ctx.translate(cx, cy - r);
    ctx.fillStyle = GOLD_FRAME;
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 2);
    ctx.lineTo(-6, 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.font = '900 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    outlined(ctx, 'S', cx, cy - r + 12, '#fff', 3);
    // distance left along the GPS route
    const gps = g.gps;
    if (gps.target && gps.length > 0) {
      const d = gps.length;
      const text = d >= 1000 ? `${(d / 1000).toFixed(1).replace('.', ',')} km` : `${Math.round(d / 10) * 10} m`;
      ctx.font = `700 12px ${BODY}`;
      outlined(ctx, text, cx, cy + r + 12, gps.target.kind === 'mission' ? '#ffd600' : '#d1c4e9', 3);
    }
  }

  // ------------------------------------------------------------------ the full map
  /** the city drawn from its own geometry for the current view (sharp when zoomed in), cached
   *  until the view changes */
  private detailCanvas(W: number, H: number, f: { x: number; y: number; w: number; h: number }) {
    const g = this.g, dpr = g.dpr;
    const key = `${this.zoom.toFixed(4)}|${this.cx.toFixed(2)}|${this.cy.toFixed(2)}|${W}x${H}|${dpr}`;
    if (this.detail?.key === key) return this.detail.canvas;
    const canvas = this.detail?.canvas ?? document.createElement('canvas');
    canvas.width = Math.round(f.w * dpr);
    canvas.height = Math.round(f.h * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#9e998f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const z = this.zoom;
    const x0 = this.cx - f.w / 2 / z, y0 = this.cy - f.h / 2 / z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -x0 * z * dpr, -y0 * z * dpr);
    const v: View = { x0, y0, x1: x0 + f.w / z, y1: y0 + f.h / z, camX: this.cx, camY: this.cy, camH: 1000, scale: z };
    g.renderer.drawGround(ctx, v, false);
    ctx.globalAlpha = 0.85;
    g.renderer.drawBuildingsFlat(ctx, v);
    ctx.globalAlpha = 1;
    this.detail = { canvas, key };
    return canvas;
  }

  drawFull(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    if (!this.zoom) this.onOpen();
    const W = g.viewW, H = g.viewH;
    const f = this.frame();
    ctx.fillStyle = 'rgba(10,12,16,0.94)';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(f.x, f.y, f.w, f.h);
    ctx.clip();
    const b = g.world.bounds;
    if (this.zoom <= DETAIL_ZOOM) {
      const img = this.image();
      const [sx, sy] = this.toScreen(b.x0, b.y0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, sx, sy, (b.x1 - b.x0) * this.zoom, (b.y1 - b.y0) * this.zoom);
    } else {
      ctx.drawImage(this.detailCanvas(W, H, f), f.x, f.y, f.w, f.h);
    }
    const z = g.searchZone;
    if (z) {
      const [zx, zy] = this.toScreen(z.x, z.y);
      this.searchZone(ctx, zx, zy, z.r * this.zoom);
    }
    this.drawRoute(ctx, this.toScreen, Math.max(3, Math.min(7, this.zoom * 3)));
    this.drawLabels(ctx, f);
    this.blips(ctx, this.toScreen, 5 + Math.min(3, this.zoom), true);
    ctx.restore();
    // frame
    ctx.save();
    ctx.shadowColor = 'rgba(255,214,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = '#ffd600';
    ctx.lineWidth = 2;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
    ctx.restore();
    // the centre cross (where Enter / the pad's Y puts the waypoint)
    if (g.input.pad.active || !this.hover) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      const mx = f.x + f.w / 2, my = f.y + f.h / 2;
      ctx.beginPath();
      ctx.moveTo(mx - 9, my);
      ctx.lineTo(mx + 9, my);
      ctx.moveTo(mx, my - 9);
      ctx.lineTo(mx, my + 9);
      ctx.stroke();
    }
    this.drawLegend(ctx, f);
    this.drawHoverInfo(ctx, f);
    // title and help
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '26px "Arial Black", Impact, sans-serif';
    outlined(ctx, 'BRATISLAVA – mapa', W / 2, 8, '#ffd600');
    ctx.font = `600 12px ${BODY}`;
    ctx.textBaseline = 'bottom';
    const pad = g.input.pad.active;
    const help = pad
      ? 'Páčka: posun · RT/LT: priblíženie · Y: cieľ · X: zrušiť cieľ · Back: zavrieť'
      : 'Koliesko: priblíženie · Ťahanie: posun · Klik: cieľ GPS · Pravý klik: zrušiť · 1–7: vrstvy · M: zavrieť';
    outlined(ctx, `${help}   ·   Čumil ${g.save.cumils.length}/10 · pamiatky ${g.save.found.length}/${g.world.landmarks.size}   ·   © OpenStreetMap`, W / 2, H - 7, '#cfd8dc', 3);
  }

  /** Street and square names, quarters, boroughs, landmarks and places, decluttered: the more
   *  important label wins a spot, the rest skip this frame. */
  private drawLabels(ctx: CanvasRenderingContext2D, f: { x: number; y: number; w: number; h: number }) {
    const g = this.g, w = g.world, z = this.zoom;
    const onScreen = (x: number, y: number, m: number) => x > f.x - m && x < f.x + f.w + m && y > f.y - m && y < f.y + f.h + m;
    const labels: Label[] = [];
    const icons: { x: number; y: number; kind: string; name?: string; prio: number }[] = [];
    // boroughs when zoomed right out, quarters in between
    if (z < 0.45)
      for (const d of w.data.districts ?? []) {
        const r = d.r[0];
        let x = 0, y = 0;
        for (let i = 0; i < r.length; i += 2) (x += r[i]), (y += r[i + 1]);
        const [sx, sy] = this.toScreen(x / (r.length / 2), y / (r.length / 2));
        if (onScreen(sx, sy, 0)) labels.push({ x: sx, y: sy, text: w.names[d.n].toUpperCase(), a: 0, font: `800 20px ${BODY}`, color: 'rgba(255,255,255,0.55)', prio: 1 });
      }
    if (z >= 0.3 && z < 2.2)
      for (const q of w.data.quarters ?? []) {
        const [sx, sy] = this.toScreen(q.x, q.y);
        if (onScreen(sx, sy, 0)) labels.push({ x: sx, y: sy, text: w.names[q.n], a: 0, font: `italic 600 ${z < 0.8 ? 11 : 13}px ${BODY}`, color: 'rgba(230,236,240,0.75)', prio: 2 });
      }
    // street names along the streets, the big roads first
    if (z >= 0.9) {
      const streets = this.streetLabels();
      for (const s of streets) {
        const need = s.cls <= 3 ? 0.9 : s.cls <= 6 ? 1.4 : 2.2;
        if (z < need) continue;
        const [sx, sy] = this.toScreen(s.x, s.y);
        if (!onScreen(sx, sy, 60)) continue;
        const fs = s.cls <= 3 ? 12 : 11;
        labels.push({ x: sx, y: sy, text: s.name, a: s.a, font: `600 ${fs}px ${BODY}`, color: s.cls >= 8 ? '#fff3c4' : '#ffffff', prio: 1.5 + s.cls * 0.1 - Math.min(1, (s.len * z) / 800), w: s.len * z });
      }
      if (z >= 1.2)
        for (const q of w.data.squares ?? []) {
          const r = q.r[0];
          let x = 0, y = 0;
          for (let i = 0; i < r.length; i += 2) (x += r[i]), (y += r[i + 1]);
          const [sx, sy] = this.toScreen(x / (r.length / 2), y / (r.length / 2));
          if (onScreen(sx, sy, 0)) labels.push({ x: sx, y: sy, text: w.names[q.n], a: 0, font: `italic 700 12px ${BODY}`, color: '#ffe082', prio: 2.5 });
        }
    }
    // landmarks: a star each, named
    if (this.groups.landmarks)
      for (const l of w.landmarks.values()) {
        const [sx, sy] = this.toScreen(l.x, l.y);
        if (!onScreen(sx, sy, 20)) continue;
        const found = g.save.found.includes(l.id);
        icons.push({ x: sx, y: sy, kind: found ? 'starFound' : 'star', prio: 0.5 });
        labels.push({ x: sx, y: sy - 17, text: l.name, a: 0, font: `700 ${z > 1.5 ? 12 : 11}px ${BODY}`, color: found ? '#e1f5fe' : '#cfd8dc', prio: 0.8 });
      }
    // mission booths' titles
    if (!g.missions.active && this.groups.missions)
      for (const bth of g.missions.available()) {
        const [sx, sy] = this.toScreen(bth.x, bth.y);
        if (onScreen(sx, sy, 20)) labels.push({ x: sx, y: sy - 18, text: bth.def.title, a: 0, font: `700 12px ${BODY}`, color: '#ffd600', prio: 0.2 });
      }
    // places, by group and zoom
    for (const p of w.data.places ?? []) {
      const grp = PLACE_GROUP[p.k];
      const gr = GROUPS.find((q) => q.id === grp);
      if (!gr || !this.groups[grp] || z < gr.minZoom) continue;
      const [sx, sy] = this.toScreen(p.x, p.y);
      if (!onScreen(sx, sy, 10)) continue;
      icons.push({ x: sx, y: sy, kind: p.k, name: p.n !== undefined ? w.names[p.n] : undefined, prio: 4 });
      if (p.n !== undefined && z >= 2.4) labels.push({ x: sx, y: sy + 13, text: w.names[p.n], a: 0, font: `600 10px ${BODY}`, color: '#eceff1', prio: 5 });
    }
    if (this.groups.transit && z >= 0.9) {
      const ts = w.tramStops;
      for (let i = 0; i < ts.length; i += 2) {
        const [sx, sy] = this.toScreen(ts[i], ts[i + 1]);
        if (!onScreen(sx, sy, 10)) continue;
        icons.push({ x: sx, y: sy, kind: 'tram', prio: 3.5 });
        const name = w.tramStopNames[i / 2];
        if (name && z >= 1.6) labels.push({ x: sx, y: sy + 13, text: name, a: 0, font: `600 10px ${BODY}`, color: '#ffcdd2', prio: 4.5 });
      }
    }
    // declutter, most important first (a landmark's star before a street name before a café):
    // whatever would overlap something already placed is left out this frame
    const taken: [number, number, number, number][] = [];
    const free = (x0: number, y0: number, x1: number, y1: number) => {
      for (const t of taken) if (x0 < t[2] && x1 > t[0] && y0 < t[3] && y1 > t[1]) return false;
      return true;
    };
    type Item = { prio: number; icon?: (typeof icons)[number]; label?: Label };
    const items: Item[] = [...icons.map((icon) => ({ prio: icon.prio, icon })), ...labels.map((label) => ({ prio: label.prio, label }))];
    items.sort((a, b) => a.prio - b.prio);
    const r = 7;
    for (const it of items) {
      const ic = it.icon;
      if (ic) {
        if (!free(ic.x - r, ic.y - r, ic.x + r, ic.y + r)) continue;
        taken.push([ic.x - r, ic.y - r, ic.x + r, ic.y + r]);
        badge(ctx, ic.x, ic.y, r, ic.kind);
        continue;
      }
      const l = it.label!;
      ctx.font = l.font;
      const tw = ctx.measureText(l.text).width;
      // a street name longer than its street on screen is left out
      if (l.w !== undefined && tw > l.w * 0.95) continue;
      const c = Math.abs(Math.cos(l.a)), sn = Math.abs(Math.sin(l.a)), h = 14;
      const hw = (tw * c + h * sn) / 2 + 2, hh = (tw * sn + h * c) / 2 + 2;
      if (!free(l.x - hw, l.y - hh, l.x + hw, l.y + hh)) continue;
      taken.push([l.x - hw, l.y - hh, l.x + hw, l.y + hh]);
      ctx.save();
      ctx.translate(l.x, l.y);
      if (l.a) ctx.rotate(l.a);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      outlined(ctx, l.text, 0, 0, l.color, 3);
      ctx.restore();
    }
  }

  /** one label spot per named street: the middle of its longest stretch, turned to read upright */
  private streetLabels() {
    if (this.streets) return this.streets;
    const w = this.g.world;
    const out: NonNullable<MapView['streets']> = [];
    const best = new Map<string, { x: number; y: number; a: number; len: number; cls: number }[]>();
    for (const r of w.data.roads) {
      if (r.n === undefined || r.b) continue;
      const name = w.names[r.n];
      // the whole way when it runs fairly straight, else its longest stretch
      const n = r.p.length;
      let path = 0;
      for (let i = 0; i < n - 2; i += 2) path += Math.hypot(r.p[i + 2] - r.p[i], r.p[i + 3] - r.p[i + 1]);
      const cdx = r.p[n - 2] - r.p[0], cdy = r.p[n - 1] - r.p[1], chord = Math.hypot(cdx, cdy);
      let bl = 0, bx = 0, by = 0, ba = 0;
      if (chord > 0.9 * path) (bl = chord), (bx = r.p[0] + cdx / 2), (by = r.p[1] + cdy / 2), (ba = Math.atan2(cdy, cdx));
      else
        for (let i = 0; i < n - 2; i += 2) {
          const dx = r.p[i + 2] - r.p[i], dy = r.p[i + 3] - r.p[i + 1], L = Math.hypot(dx, dy);
          if (L > bl) (bl = L), (bx = r.p[i] + dx / 2), (by = r.p[i + 1] + dy / 2), (ba = Math.atan2(dy, dx));
        }
      if (bl < 18) continue;
      if (ba > Math.PI / 2) ba -= Math.PI;
      if (ba < -Math.PI / 2) ba += Math.PI;
      const list = best.get(name) ?? [];
      // one label per 250 m of a street's name
      if (list.some((o) => Math.hypot(o.x - bx, o.y - by) < 250)) continue;
      list.push({ x: bx, y: by, a: ba, len: bl, cls: r.c });
      best.set(name, list);
    }
    for (const [name, list] of best) for (const s of list) out.push({ ...s, name });
    return (this.streets = out);
  }

  /** the legend: the place layers, click (or 1-7) to switch each on or off */
  private drawLegend(ctx: CanvasRenderingContext2D, f: { x: number; y: number; w: number; h: number }) {
    const small = this.g.viewW < 700;
    if (small) return;
    const rowH = 20, w = 250, h = GROUPS.length * rowH + 30;
    const x = f.x + 10, y = f.y + f.h - h - 10;
    ctx.fillStyle = 'rgba(12,14,18,0.78)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,214,0,0.35)';
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 12px ${BODY}`;
    ctx.fillStyle = '#ffd600';
    ctx.fillText('Vrstvy', x + 10, y + 13);
    this.legendHits = [];
    GROUPS.forEach((gr, i) => {
      const ry = y + 26 + i * rowH;
      const on = this.groups[gr.id];
      ctx.globalAlpha = on ? 1 : 0.4;
      badge(ctx, x + 18, ry + rowH / 2 - 2, 7, gr.icon);
      ctx.fillStyle = on ? '#eceff1' : '#90a4ae';
      ctx.font = `600 12px ${BODY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}  ${gr.label}`, x + 32, ry + rowH / 2 - 2);
      ctx.globalAlpha = 1;
      this.legendHits.push({ x, y: ry, w, h: rowH, id: gr.id });
    });
  }

  /** what's under the cursor: the street (or square) there */
  private drawHoverInfo(ctx: CanvasRenderingContext2D, f: { x: number; y: number; w: number; h: number }) {
    const h = this.hover;
    if (!h || this.g.input.pad.active || h.x < f.x || h.x > f.x + f.w || h.y < f.y || h.y > f.y + f.h) return;
    const p = this.toWorld(h.x, h.y);
    const w = this.g.world;
    const name = w.squareAt(p.x, p.y) ?? w.streetName(p.x, p.y);
    const q = w.quarter(p.x, p.y);
    const text = [name, q ? `${q} · ${w.district(p.x, p.y)}` : w.district(p.x, p.y)].filter(Boolean).join('  —  ');
    ctx.font = `600 12px ${BODY}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    outlined(ctx, text, f.x + f.w - 10, f.y + 8, '#ffffff', 3);
  }
}

/** A round map badge with a little glyph for a kind of place. */
function badge(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, kind: string) {
  const star = kind === 'star' || kind === 'starFound';
  ctx.fillStyle = kind === 'starFound' ? '#29b6f6' : ICON_BG[kind] ?? '#546e7a';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  if (star) {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.5 : r * 1.15;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return;
  }
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  const s = r * 0.55;
  ctx.fillStyle = ctx.strokeStyle = kind === 'phone' || kind === 'taxi' || kind === 'bakery' ? '#1a1a1a' : '#ffffff';
  ctx.lineWidth = Math.max(1, r * 0.18);
  ctx.lineCap = 'round';
  ctx.beginPath();
  switch (kind) {
    case 'food': // fork and knife
      ctx.moveTo(x - s * 0.45, y - s);
      ctx.lineTo(x - s * 0.45, y + s);
      ctx.moveTo(x + s * 0.45, y - s);
      ctx.lineTo(x + s * 0.45, y + s);
      ctx.moveTo(x - s * 0.8, y - s);
      ctx.lineTo(x - s * 0.8, y - s * 0.2);
      ctx.lineTo(x - s * 0.1, y - s * 0.2);
      ctx.lineTo(x - s * 0.1, y - s);
      ctx.stroke();
      return;
    case 'cafe': // a cup with a handle
      ctx.rect(x - s * 0.8, y - s * 0.4, s * 1.2, s * 1.1);
      ctx.moveTo(x + s * 0.4, y - s * 0.1);
      ctx.arc(x + s * 0.55, y + s * 0.15, s * 0.3, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      return;
    case 'bar': // a cocktail glass
      ctx.moveTo(x - s, y - s * 0.7);
      ctx.lineTo(x + s, y - s * 0.7);
      ctx.lineTo(x, y + s * 0.1);
      ctx.closePath();
      ctx.moveTo(x, y + s * 0.1);
      ctx.lineTo(x, y + s * 0.8);
      ctx.moveTo(x - s * 0.5, y + s * 0.8);
      ctx.lineTo(x + s * 0.5, y + s * 0.8);
      ctx.stroke();
      return;
    case 'pharmacy':
    case 'hospital': // a cross
      ctx.fillRect(x - s * 0.3, y - s, s * 0.6, s * 2);
      ctx.fillRect(x - s, y - s * 0.3, s * 2, s * 0.6);
      return;
    case 'church': // a slim cross
      ctx.moveTo(x, y - s);
      ctx.lineTo(x, y + s);
      ctx.moveTo(x - s * 0.6, y - s * 0.35);
      ctx.lineTo(x + s * 0.6, y - s * 0.35);
      ctx.stroke();
      return;
    case 'museum': // columns under a pediment
      ctx.moveTo(x - s, y - s * 0.4);
      ctx.lineTo(x, y - s);
      ctx.lineTo(x + s, y - s * 0.4);
      ctx.closePath();
      for (const o of [-0.6, 0, 0.6]) {
        ctx.moveTo(x + s * o, y - s * 0.2);
        ctx.lineTo(x + s * o, y + s * 0.8);
      }
      ctx.stroke();
      return;
    case 'theatre': // a star-like mask spark
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
      }
      ctx.stroke();
      return;
    case 'view': // an eye
      ctx.ellipse(x, y, s, s * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'phone': // a handset
      ctx.arc(x, y + s * 0.2, s * 0.8, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
      ctx.fillRect(x - s * 0.95, y - s * 0.25, s * 0.5, s * 0.5);
      ctx.fillRect(x + s * 0.45, y - s * 0.25, s * 0.5, s * 0.5);
      return;
    case 'fuel': // a drop
      ctx.moveTo(x, y - s);
      ctx.quadraticCurveTo(x + s * 0.9, y + s * 0.1, x, y + s * 0.8);
      ctx.quadraticCurveTo(x - s * 0.9, y + s * 0.1, x, y - s);
      ctx.fill();
      return;
    case 'grocery': // a basket
      ctx.moveTo(x - s, y - s * 0.2);
      ctx.lineTo(x + s, y - s * 0.2);
      ctx.lineTo(x + s * 0.7, y + s * 0.8);
      ctx.lineTo(x - s * 0.7, y + s * 0.8);
      ctx.closePath();
      ctx.moveTo(x - s * 0.5, y - s * 0.2);
      ctx.lineTo(x, y - s);
      ctx.lineTo(x + s * 0.5, y - s * 0.2);
      ctx.stroke();
      return;
    case 'library': // an open book
      ctx.moveTo(x, y - s * 0.6);
      ctx.lineTo(x - s, y - s * 0.8);
      ctx.lineTo(x - s, y + s * 0.6);
      ctx.lineTo(x, y + s * 0.8);
      ctx.lineTo(x + s, y + s * 0.6);
      ctx.lineTo(x + s, y - s * 0.8);
      ctx.closePath();
      ctx.moveTo(x, y - s * 0.6);
      ctx.lineTo(x, y + s * 0.8);
      ctx.stroke();
      return;
  }
  // everything else: a letter
  const letter: Record<string, string> = { hotel: 'H', bank: '€', post: '✉', bakery: 'P', wc: 'WC', taxi: 'T', tram: 'Z', police: 'P' };
  ctx.font = `800 ${Math.round(r * (kind === 'wc' ? 0.9 : 1.25))}px ${BODY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter[kind] ?? '•', x, y + 0.5);
}
