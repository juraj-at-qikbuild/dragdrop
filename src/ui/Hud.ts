import type { Game } from '../game/Game';
import { WEAPONS } from '../game/Combat';
import { formatMoney } from '../util/math';

const FONT = '"Arial Black", "Helvetica Neue", Impact, sans-serif';

export class Hud {
  hurt = 0;
  flashStars = 0;
  private shownMoney = 0;

  constructor(private g: Game) {
    this.shownMoney = g.save.money;
  }

  draw(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const W = g.viewW, H = g.viewH;
    const small = W < 700;
    const dt = 1 / 60;
    if (this.hurt > 0) {
      ctx.fillStyle = `rgba(200,0,0,${this.hurt * 0.5})`;
      ctx.fillRect(0, 0, W, H);
      this.hurt -= dt;
    }
    this.shownMoney += (g.save.money - this.shownMoney) * 0.15;
    if (Math.abs(g.save.money - this.shownMoney) < 1) this.shownMoney = g.save.money;

    // money
    const pad = small ? 10 : 18;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.font = `${small ? 22 : 30}px ${FONT}`;
    outlined(ctx, formatMoney(this.shownMoney), W - pad, pad, '#8bdc6b');

    // wanted stars
    const stars = Math.ceil(g.wanted - 0.001);
    const sy = pad + (small ? 30 : 40);
    const flash = this.flashStars > 0 && Math.floor(g.time * 8) % 2 === 0;
    if (this.flashStars > 0) this.flashStars -= dt;
    for (let i = 0; i < 5; i++) {
      const x = W - pad - 12 - (4 - i) * (small ? 22 : 28);
      drawStar(ctx, x, sy + 12, small ? 9 : 12, i < stars ? (flash ? '#fff' : '#ffd600') : 'rgba(0,0,0,0.35)');
    }

    // clock + weather glyph, under the money/stars area
    const cy = sy + (small ? 26 : 32);
    this.drawClock(ctx, W - pad, cy, small);

    // health + weapon
    const hy = cy + (small ? 22 : 26);
    const bw = small ? 110 : 150;
    const bh = 10;
    roundRect(ctx, W - pad - bw, hy, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    const hpFrac = Math.max(0, g.player.health / 100);
    if (hpFrac > 0) {
      roundRect(ctx, W - pad - bw + 2, hy + 2, Math.max(4, (bw - 4) * hpFrac), bh - 4, (bh - 4) / 2);
      ctx.fillStyle = g.player.health > 30 ? '#e53935' : Math.floor(g.time * 4) % 2 ? '#ff8a80' : '#b71c1c';
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    roundRect(ctx, W - pad - bw, hy, bw, bh, bh / 2);
    ctx.stroke();
    const w = g.player.weapon;
    ctx.font = `${small ? 14 : 17}px ${FONT}`;
    const ammo = w === 'fist' ? '' : `  ${g.ammo[w]}`;
    outlined(ctx, WEAPONS[w].name + ammo, W - pad, hy + 16, '#fff');
    const car = g.player.vehicle;
    if (car) {
      ctx.font = `${small ? 12 : 14}px ${FONT}`;
      const kmh = Math.round(car.speed * 3.6);
      outlined(ctx, `${car.spec.name}  ${kmh} km/h`, W - pad, hy + 38, '#b3e5fc');
      const hp = Math.max(0, car.health / car.spec.health);
      roundRect(ctx, W - pad - bw, hy + 58, bw, 6, 3);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
      if (hp > 0) {
        roundRect(ctx, W - pad - bw + 1, hy + 59, Math.max(3, (bw - 2) * hp), 4, 2);
        ctx.fillStyle = hp > 0.35 ? '#90caf9' : '#ff7043';
        ctx.fill();
      }
    }

    // minimap
    const mr = small ? 62 : 90;
    g.mapView.drawMini(ctx, pad + mr, H - pad - mr, mr);

    // street and district name
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    if (g.street.timer > 0 && g.street.name) {
      ctx.globalAlpha = Math.min(1, g.street.timer);
      ctx.font = `${small ? 16 : 22}px ${FONT}`;
      outlined(ctx, g.street.name, W - pad, H - pad - (small ? 22 : 28), '#fff');
      ctx.globalAlpha = 1;
    }
    ctx.font = `600 ${small ? 11 : 13}px system-ui, sans-serif`;
    shadowed(ctx, `${g.district} · Bratislava`, W - pad, H - pad, '#cfd8dc');

    // mission objective + timer
    const m = g.missions;
    if (m.active) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `700 ${small ? 13 : 16}px system-ui, sans-serif`;
      const t = m.text();
      if (t) wrapOutlined(ctx, t, W / 2, pad + (small ? 44 : 8), Math.min(W * 0.55, 560), small ? 17 : 21, '#fff59d');
      if (m.timeLeft > 0) {
        ctx.font = `${small ? 20 : 26}px ${FONT}`;
        const s = Math.ceil(m.timeLeft);
        outlined(ctx, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, W / 2, pad + (small ? 80 : 56), s < 20 ? '#ff5252' : '#fff');
      }
      // arrow toward the objective
      const tgt = m.target();
      if (tgt) this.drawArrow(ctx, tgt.x, tgt.y);
    }

    // messages (one at a time)
    const msg = g.messages[0];
    if (msg) {
      const a = Math.min(1, msg.time * 2);
      ctx.globalAlpha = a;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let y = H * 0.28;
      if (msg.title) {
        ctx.font = `${small ? 24 : 38}px ${FONT}`;
        outlined(ctx, msg.title, W / 2, y, msg.color);
        y += small ? 30 : 42;
      }
      ctx.font = `700 ${small ? 14 : 18}px system-ui, sans-serif`;
      wrapOutlined(ctx, msg.text, W / 2, y, Math.min(W * 0.8, 680), small ? 18 : 24, '#fff');
      ctx.globalAlpha = 1;
    }

    // radio
    if (g.radioText.time > 0) {
      ctx.globalAlpha = Math.min(1, g.radioText.time);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = `700 ${small ? 12 : 15}px system-ui, sans-serif`;
      wrapOutlined(ctx, g.radioText.text, W / 2, H - pad - (small ? 40 : 10), Math.min(W * 0.6, 700), 20, '#f8bbd0', true);
      ctx.globalAlpha = 1;
    }

    // wasted / busted
    if (g.state !== 'play') {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `${small ? 44 : 84}px ${FONT}`;
      outlined(ctx, g.state === 'busted' ? 'ZATKNUTÝ' : 'ZOŠROTOVANÝ', W / 2, H / 2, g.state === 'busted' ? '#448aff' : '#ff1744', 6);
    }
    if (g.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  /** clock + a small sun/moon/rain glyph, drawn as canvas paths (no emoji). */
  private drawClock(ctx: CanvasRenderingContext2D, right: number, y: number, small: boolean) {
    const g = this.g;
    const atmos = g.atmos;
    const fs = small ? 15 : 18;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const text = atmos.clock();
    const tw = ctx.measureText(text).width;
    shadowed(ctx, text, right, y, '#e8eef2');
    const r = fs * 0.42;
    const cx = right - tw - fs * 0.7 - r;
    if (atmos.rain > 0.15) {
      drawRainGlyph(ctx, cx, y, r, atmos.rain);
    } else if (atmos.daylight > 0.35) {
      drawSunGlyph(ctx, cx, y, r, atmos.daylight);
    } else {
      drawMoonGlyph(ctx, cx, y, r);
    }
  }

  private drawArrow(ctx: CanvasRenderingContext2D, tx: number, ty: number) {
    const g = this.g;
    const f = g.focus();
    const a = Math.atan2(ty - f.y, tx - f.x);
    const d = Math.hypot(tx - f.x, ty - f.y);
    const cx = g.viewW / 2 + (tx - g.cam.x) * g.cam.scale;
    const cy = g.viewH / 2 + (ty - g.cam.y) * g.cam.scale;
    const onScreen = cx > 40 && cx < g.viewW - 40 && cy > 40 && cy < g.viewH - 40;
    ctx.save();
    if (onScreen) {
      ctx.translate(cx, cy - 26 + Math.sin(g.time * 5) * 5);
      ctx.rotate(Math.PI / 2);
    } else {
      const r = Math.min(g.viewW, g.viewH) * 0.38;
      ctx.translate(g.viewW / 2 + Math.cos(a) * r, g.viewH / 2 + Math.sin(a) * r);
      ctx.rotate(a);
    }
    ctx.fillStyle = '#ffd600';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-10, -11);
    ctx.lineTo(-5, 0);
    ctx.lineTo(-10, 11);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (!onScreen) {
      const r = Math.min(g.viewW, g.viewH) * 0.38 - 28;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 12px system-ui, sans-serif';
      outlined(ctx, `${Math.round(d)} m`, g.viewW / 2 + Math.cos(a) * r, g.viewH / 2 + Math.sin(a) * r, '#ffd600');
    }
  }
}

export function outlined(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, width = 4) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** softer alternative to `outlined`: a drop shadow instead of a heavy stroke, for less critical text */
function shadowed(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawSunGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, strength: number) {
  ctx.save();
  ctx.fillStyle = `rgba(255,214,90,${0.6 + 0.4 * strength})`;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = r * 0.22;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.25);
    ctx.lineTo(x + Math.cos(a) * r * 1.75, y + Math.sin(a) * r * 1.75);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMoonGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.save();
  ctx.fillStyle = '#cfd8dc';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(20,24,32,0.92)';
  ctx.beginPath();
  ctx.arc(x + r * 0.45, y - r * 0.15, r * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawRainGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, intensity: number) {
  ctx.save();
  ctx.fillStyle = 'rgba(207,213,219,0.95)';
  ctx.beginPath();
  ctx.arc(x - r * 0.35, y - r * 0.1, r * 0.6, 0, Math.PI * 2);
  ctx.arc(x + r * 0.25, y - r * 0.25, r * 0.7, 0, Math.PI * 2);
  ctx.arc(x + r * 0.15, y + r * 0.1, r * 0.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(120,180,235,${0.6 + 0.4 * intensity})`;
  ctx.lineWidth = r * 0.2;
  ctx.lineCap = 'round';
  for (const dx of [-0.35, 0.15, 0.55]) {
    ctx.beginPath();
    ctx.moveTo(x + dx * r, y + r * 0.7);
    ctx.lineTo(x + dx * r - r * 0.15, y + r * 1.25);
    ctx.stroke();
  }
  ctx.restore();
}

function wrapOutlined(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, color: string, up = false) {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = t;
  }
  if (line) lines.push(line);
  const y0 = up ? y - (lines.length - 1) * lh : y;
  lines.forEach((l, i) => outlined(ctx, l, x, y0 + i * lh, color, 3.5));
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
