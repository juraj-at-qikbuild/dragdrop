import type { Game } from '../game/Game';
import { outlined } from './Hud';

const PX = 0.6; // pixels per metre in the cached map image
const GOLD_FRAME = '#ffd600';

/** Pre-rendered city map used by the minimap and the full-screen map (M). */
export class MapView {
  private img: HTMLCanvasElement | null = null;

  constructor(private g: Game) {}

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

  private blips(ctx: CanvasRenderingContext2D, toScreen: (x: number, y: number) => [number, number], size: number, full: boolean) {
    const g = this.g;
    // mission booths and targets
    if (!g.missions.active)
      for (const b of g.missions.available()) {
        const [x, y] = toScreen(b.x, b.y);
        ctx.fillStyle = '#ffd600';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, size * 1.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#000';
        ctx.font = `900 ${size * 1.3}px Arial`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('☎', x, y + 0.5);
        if (full) {
          ctx.font = '700 12px system-ui, sans-serif';
          outlined(ctx, b.def.title, x, y - size * 2.2, '#ffd600', 3);
        }
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
    for (const f of g.world.pois('fuel')) {
      const [x, y] = toScreen(f.x, f.y);
      ctx.fillStyle = '#29b6f6';
      ctx.fillRect(x - size * 0.6, y - size * 0.6, size * 1.2, size * 1.2);
    }
    if (full)
      for (const l of g.world.landmarks.values()) {
        const [x, y] = toScreen(l.x, l.y);
        ctx.fillStyle = g.save.found.includes(l.id) ? '#80d8ff' : '#9e9e9e';
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        outlined(ctx, l.name, x, y - 5, g.save.found.includes(l.id) ? '#e1f5fe' : '#bdbdbd', 3);
      }
    for (const v of g.vehicles) {
      if (v.kind !== 'police' || !v.siren) continue;
      const [x, y] = toScreen(v.x, v.y);
      ctx.fillStyle = Math.floor(g.time * 6) % 2 ? '#ff1744' : '#2979ff';
      ctx.beginPath();
      ctx.arc(x, y, size * 0.7, 0, Math.PI * 2);
      ctx.fill();
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
    const toScreen = (x: number, y: number): [number, number] => {
      let dx = (x - f.x) * k, dy = (y - f.y) * k;
      const d = Math.hypot(dx, dy);
      if (d > r - 6) (dx *= (r - 6) / d), (dy *= (r - 6) / d);
      return [cx + dx, cy + dy];
    };
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
  }

  drawFull(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const img = this.image();
    const W = g.viewW, H = g.viewH;
    ctx.fillStyle = 'rgba(10,12,16,0.92)';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min((W - 40) / img.width, (H - 90) / img.height);
    const iw = img.width * s, ih = img.height * s;
    const ox = (W - iw) / 2, oy = (H - ih) / 2 + 20;
    ctx.drawImage(img, ox, oy, iw, ih);
    ctx.save();
    ctx.shadowColor = 'rgba(255,214,0,0.35)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = '#ffd600';
    ctx.lineWidth = 2;
    ctx.strokeRect(ox, oy, iw, ih);
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 4, oy - 4, iw + 8, ih + 8);
    const b = g.world.bounds;
    const toScreen = (x: number, y: number): [number, number] => [ox + (x - b.x0) * PX * s, oy + (y - b.y0) * PX * s];
    this.blips(ctx, toScreen, 5, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = '26px "Arial Black", Impact, sans-serif';
    outlined(ctx, 'BRATISLAVA – mapa', W / 2, 12, '#ffd600');
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    outlined(ctx, `☎ misie · ■ striekareň Slovnafta · Čumil ${g.save.cumils.length}/10 · pamiatky ${g.save.found.length}/${g.world.landmarks.size}   |   M – zavrieť   ·   © OpenStreetMap prispievatelia`, W / 2, H - 8, '#cfd8dc', 3);
  }
}
