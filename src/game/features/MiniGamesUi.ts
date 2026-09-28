// The mini-games on screen (docs/plans/minigames.md): the round this player is in — its headline, the
// objective and the countdown, a meter, a few numbers, the standings, the action key's prompt, an
// arrow to the target and the result card — and its marks in the city and on the map; plus a line
// about a round nearby that they could join. The rules are the shared MiniGames rule's (the server's
// online); this only shows what it sends (LiveState.mini) and passes on the action key (B, the pad's
// R3, the violet touch button). A game's own drawing is in minigames/draw/.
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { View } from '../../world/Renderer';
import type { PrivateEvent } from '../../shared/sim/events';
import type { MiniMark, MiniState } from '../../shared/sim/rules/minigames/types';
import { MINI_INFO } from '../../shared/sim/rules/minigames/catalog';
import { dist, formatMoney } from '../../shared/util/math';
import { outlined } from '../../ui/Hud';
import { edgePoint, inPlay } from '../../ui/layout';
import { pulsingCircle } from '../../ui/MapView';
import { roundRect } from '../../render/shapes';
import { isModalOpen, toast } from '../../ui/kit/dom';
import { KEYS } from '../Input';
import { miniLeft } from '../SimHost';
import { boardLine, countdown, headline, inviteLine, resultLines } from './minigames/text';
import { MINI_DRAW } from './minigames/draw';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
const BODY = `'Inter', system-ui, sans-serif`;
/** a round someone else opened, this close (m), gets a line on this player's screen */
const INVITE_R = 500;

export class MiniGamesUi implements ClientFeature {
  readonly id = 'minigames';
  /** the phase last seen, to mark the moment it starts or ends */
  private phase = '';
  /** the objective box's width, as last drawn (the arrow keeps out from under the round's HUD) */
  private boxW = 0;

  constructor(private g: Game) {}

  update() {
    const g = this.g;
    const s = g.host.live.mini;
    if (s && s.phase !== this.phase) {
      if (s.phase === 'live' && this.phase === 'lobby') toast(`${MINI_INFO[s.kind].emoji} Štart!`, MINI_INFO[s.kind].color, 1500);
      this.phase = s.phase;
    } else if (!s) this.phase = '';
    if (g.paused || g.showMap || isModalOpen()) return;
    if (!g.input.hit(KEYS.mini)) return;
    if (s && (s.act || s.phase === 'lobby')) g.host.mini({ op: 'act' });
  }

  reset() {
    this.phase = '';
  }

  // -------------------------------------------------------------------------------------- HUD
  drawHud(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const s = g.host.live.mini;
    if (!s) return this.drawInvite(ctx);
    const L = g.layout;
    const small = L.small;
    const info = MINI_INFO[s.kind];
    // the mission objective's slot at the top (a round can't start during a mission, and city-wide
    // banners only pass through the band under it for a few seconds)
    const top = L.objective.y;
    const cx = L.band.cx;
    if (s.phase === 'done') return this.drawResult(ctx, s, top);

    // the headline and the objective, then the countdown
    let y = this.drawObjective(ctx, s.goal, top, info.color, headline(s));
    const left = miniLeft(g.host.live);
    const cd = countdown(s, left);
    if (cd) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `700 ${small ? 18 : 24}px ${HEAD}`;
      outlined(ctx, cd, cx, y + 4, s.phase === 'live' && left < 15 ? '#ff5252' : '#fff');
      y += small ? 26 : 32;
    }
    // the meter and the numbers, in one row
    y = this.drawStatus(ctx, s, y + 4);
    // the standings
    if (s.board && s.board.length > 1) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `600 ${small ? 11 : 13}px ${BODY}`;
      outlined(ctx, boardLine(s.board, g.host.net?.nick ?? ''), cx, y + 2, '#e0e0e0', 3);
      y += small ? 16 : 19;
    }
    MINI_DRAW[s.kind]?.hud?.(ctx, s, g);
    // the arrow to the target, kept out from under all of the above
    const target = s.marks?.find((m) => m.arrow);
    if (target) {
      const at = this.markPos(target);
      this.drawArrowTo(ctx, at.x, at.y, target.color ?? info.color, { x0: cx - this.boxW / 2 - 16, x1: cx + this.boxW / 2 + 16, y1: y + 6 });
    }
    // what the action key does (on a touch screen, the violet button says it)
    const act = s.act;
    if (act && !(L.touch && !g.input.pad.active)) {
      const car = !!g.player.vehicle;
      const py = (car ? L.prompt.car : L.prompt.foot) - (small ? 40 : 48);
      this.drawAct(ctx, act, L.prompt.cx, py, small);
    }
  }

  /** the objective box (JobsHud's look), the game's name over it: returns the y under it */
  private drawObjective(ctx: CanvasRenderingContext2D, text: string, by: number, color: string, head: string): number {
    const g = this.g, L = g.layout, small = L.small;
    const fs = small ? 13 : 16;
    ctx.font = `700 ${fs}px ${BODY}`;
    const maxW = Math.min(g.viewW * 0.62, 560, L.band.w - fs * 2);
    const lines = wrap(ctx, text, maxW);
    const lh = small ? 17 : 21;
    const hh = small ? 14 : 17;
    const bw = Math.min(maxW + fs * 2, g.viewW - L.padL * 2);
    const bh = lines.length * lh + fs * 1.1 + hh;
    const bx = L.band.cx - bw / 2;
    this.boxW = bw;
    roundRect(ctx, bx, by, bw, bh, Math.min(12, bh / 2));
    const grad = ctx.createLinearGradient(bx, by, bx, by + bh);
    grad.addColorStop(0, 'rgba(32,34,42,0.68)');
    grad.addColorStop(1, 'rgba(10,11,15,0.72)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(bx, by, 3, bh);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${small ? 11 : 13}px ${HEAD}`;
    outlined(ctx, head, L.band.cx, by + fs * 0.4, color, 3);
    ctx.font = `700 ${fs}px ${BODY}`;
    lines.forEach((l, i) => outlined(ctx, l, L.band.cx, by + fs * 0.4 + hh + i * lh, '#fff59d'));
    return by + bh;
  }

  /** the meter (if any) and the numbers, centred in one row; returns the y under it */
  private drawStatus(ctx: CanvasRenderingContext2D, s: MiniState, y: number): number {
    const L = this.g.layout, small = L.small, cx = L.band.cx;
    const stats = s.stats ?? [];
    if (!s.bar && !stats.length) return y;
    ctx.font = `700 ${small ? 13 : 15}px ${HEAD}`;
    const statText = stats.map(([k, v]) => `${k} ${v}`).join('   ');
    const tw = statText ? ctx.measureText(statText).width : 0;
    const bw = s.bar ? (small ? 120 : 160) : 0, bh = small ? 9 : 11;
    const gap = s.bar && statText ? (small ? 12 : 16) : 0;
    let x = cx - (bw + gap + tw) / 2;
    const rowY = y + (small ? 12 : 14);
    if (s.bar) {
      const bar = s.bar;
      ctx.font = `600 ${small ? 10 : 11}px ${BODY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      outlined(ctx, bar.label, x, rowY - bh / 2 - 2, '#cfd8dc', 2.5);
      roundRect(ctx, x, rowY - bh / 2, bw, bh, bh / 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
      const v = Math.max(0, Math.min(1, bar.v));
      if (v > 0) {
        roundRect(ctx, x + 1, rowY - bh / 2 + 1, Math.max(2, (bw - 2) * v), bh - 2, (bh - 2) / 2);
        ctx.fillStyle = bar.color ?? '#4fc3f7';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      roundRect(ctx, x, rowY - bh / 2, bw, bh, bh / 2);
      ctx.stroke();
      x += bw + gap;
    }
    if (statText) {
      ctx.font = `700 ${small ? 13 : 15}px ${HEAD}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      outlined(ctx, statText, x, rowY, '#fff', 3);
    }
    return rowY + (small ? 12 : 14);
  }

  /** the action key's prompt: the key cap and what it does */
  private drawAct(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, small: boolean) {
    const g = this.g;
    const key = g.input.pad.active ? 'R3' : 'B';
    ctx.save();
    ctx.font = `700 ${small ? 13 : 15}px ${BODY}`;
    ctx.textBaseline = 'middle';
    const h = small ? 28 : 32, kw = ctx.measureText(key).width + 14, tw = ctx.measureText(text).width;
    const w = kw + tw + 26;
    const x = cx - w / 2, y = cy - h / 2;
    const pulse = 0.5 + 0.5 * Math.sin(g.time * 4);
    ctx.fillStyle = 'rgba(10,12,18,0.74)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(179,136,255,${0.45 + pulse * 0.4})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#b388ff';
    roundRect(ctx, x + 5, y + 4, kw, h - 8, 6);
    ctx.fill();
    ctx.fillStyle = '#15161a';
    ctx.textAlign = 'center';
    ctx.fillText(key, x + 5 + kw / 2, cy + 0.5);
    ctx.textAlign = 'left';
    outlined(ctx, text, x + kw + 14, cy + 0.5, '#fff', 3);
    ctx.restore();
  }

  /** the result card: what happened, the money, the place */
  private drawResult(ctx: CanvasRenderingContext2D, s: MiniState, top: number) {
    const g = this.g, L = g.layout, small = L.small, cx = L.band.cx;
    const info = MINI_INFO[s.kind];
    const lines = resultLines(s);
    const board = s.board && s.board.length > 1 ? boardLine(s.board, g.host.net?.nick ?? '', 5) : '';
    ctx.font = `700 ${small ? 14 : 17}px ${BODY}`;
    const w = Math.min(g.viewW - L.padL * 2, Math.max(260, ...lines.map((l) => ctx.measureText(l).width + 40)));
    const h = (small ? 44 : 54) + lines.length * (small ? 20 : 24) + (board ? (small ? 18 : 22) : 0) + (small ? 16 : 20);
    const x = cx - w / 2, y = top;
    roundRect(ctx, x, y, w, h, 14);
    ctx.fillStyle = 'rgba(12,13,18,0.84)';
    ctx.fill();
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${small ? 18 : 24}px ${HEAD}`;
    outlined(ctx, `${info.emoji} ${info.title}`, cx, y + (small ? 10 : 12), info.color);
    let ly = y + (small ? 38 : 46);
    ctx.font = `700 ${small ? 14 : 17}px ${BODY}`;
    lines.forEach((l, i) => {
      outlined(ctx, l, cx, ly, i === 1 && (s.result?.pay ?? 0) > 0 ? '#8bdc6b' : '#fff', 3);
      ly += small ? 20 : 24;
    });
    if (board) {
      ctx.font = `600 ${small ? 11 : 13}px ${BODY}`;
      outlined(ctx, board, cx, ly, '#e0e0e0', 3);
      ly += small ? 18 : 22;
    }
    ctx.font = `600 ${small ? 10 : 12}px ${BODY}`;
    outlined(ctx, `Ďalšia hra: ${g.input.pad.active ? 'd-pad ↓' : g.touch ? 'Aktivity' : 'U'}`, cx, ly + 2, '#b0bec5', 2.5);
  }

  /** a round nearby that this player could join */
  private drawInvite(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const open = g.host.live.miniOpen;
    if (!open.length || g.state !== 'play') return;
    const f = g.focus();
    const me = g.host.net?.nick;
    const o = open.find((q) => q.nick !== me && dist(q.x, q.y, f.x, f.y) <= INVITE_R);
    if (!o) return;
    const L = g.layout, small = L.small;
    const key = g.input.pad.active ? 'd-pad ↓' : g.touch ? 'Aktivity' : 'U';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = `700 ${small ? 12 : 14}px ${BODY}`;
    const pulse = 0.75 + 0.25 * Math.sin(g.time * 3);
    ctx.globalAlpha = pulse;
    // under the mission objective's slot, where a mission would have its own
    outlined(ctx, inviteLine(o, key), L.band.cx, L.objective.y + (small ? 30 : 38), MINI_INFO[o.kind].color, 3);
    ctx.globalAlpha = 1;
  }

  /** the off-screen arrow (JobsHud's look); `under`: the round's HUD at the top, which an arrow
   *  pointing up would sit on (it goes just below it instead) */
  private drawArrowTo(ctx: CanvasRenderingContext2D, tx: number, ty: number, color: string, under?: { x0: number; x1: number; y1: number }) {
    const g = this.g;
    const f = g.focus();
    const a = Math.atan2(ty - f.y, tx - f.x);
    const d = Math.hypot(tx - f.x, ty - f.y);
    const sx = g.viewW / 2 + (tx - g.cam.x) * g.cam.scale;
    const sy = g.viewH / 2 + (ty - g.cam.y) * g.cam.scale;
    const onScreen = inPlay(g.layout, sx, sy);
    const e = edgePoint(g.layout, a), label = edgePoint(g.layout, a, 28);
    if (under && e.x > under.x0 && e.x < under.x1 && e.y - 16 < under.y1) {
      const dy = under.y1 + 16 - e.y;
      e.y += dy;
      label.y += dy;
    }
    ctx.save();
    if (onScreen) {
      ctx.translate(sx, sy - 30 + Math.sin(g.time * 5) * 5);
      ctx.rotate(Math.PI / 2);
    } else {
      ctx.translate(e.x, e.y);
      ctx.rotate(a);
    }
    ctx.fillStyle = color;
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
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 12px ${BODY}`;
      outlined(ctx, `${Math.round(d)} m`, label.x, label.y, color);
    }
  }

  // ------------------------------------------------------------------------------------ world
  /** where a mark is now: its entity's position when the client has it */
  private markPos(m: MiniMark): { x: number; y: number } {
    if (m.e) {
      const h = this.g.host;
      const o = h.vehicleById(m.e) ?? h.pedById(m.e);
      if (o) return { x: o.x, y: o.y };
    }
    return m;
  }

  drawWorld(ctx: CanvasRenderingContext2D, v: View) {
    const g = this.g;
    const s = g.host.live.mini;
    if (!s || s.phase === 'done') return;
    MINI_DRAW[s.kind]?.world?.(ctx, s, v, g);
    const info = MINI_INFO[s.kind];
    const k = 1 / v.scale;
    for (const m of s.marks ?? []) {
      const at = this.markPos(m);
      const reach = Math.max(m.r ?? 0, m.w ?? 0, m.h ?? 0) + 20;
      if (!m.poly && (at.x < v.x0 - reach || at.x > v.x1 + reach || at.y < v.y0 - reach || at.y > v.y1 + reach)) continue;
      const color = m.color ?? info.color;
      ctx.save();
      if (m.dim) ctx.globalAlpha = 0.45;
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      if (m.poly && m.poly.length >= 6) {
        ctx.beginPath();
        for (let i = 0; i < m.poly.length; i += 2) i ? ctx.lineTo(m.poly[i], m.poly[i + 1]) : ctx.moveTo(m.poly[i], m.poly[i + 1]);
        ctx.closePath();
        ctx.globalAlpha *= 0.18;
        ctx.fill();
        ctx.globalAlpha /= 0.18;
        ctx.lineWidth = 2 * k;
        ctx.setLineDash([6 * k, 4 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (m.w && m.h) {
        ctx.translate(at.x, at.y);
        ctx.rotate(m.a ?? 0);
        ctx.globalAlpha *= 0.28;
        ctx.fillRect(-m.w / 2, -m.h / 2, m.w, m.h);
        ctx.globalAlpha /= 0.28;
        ctx.lineWidth = 2.5 * k;
        ctx.strokeRect(-m.w / 2, -m.h / 2, m.w, m.h);
      } else if (m.r) {
        const pulse = m.arrow ? 0.5 + 0.5 * Math.sin(g.time * 4) : 0.5;
        ctx.beginPath();
        ctx.arc(at.x, at.y, m.r, 0, Math.PI * 2);
        ctx.globalAlpha *= 0.2;
        ctx.fill();
        ctx.globalAlpha /= 0.2;
        ctx.globalAlpha *= 0.6 + pulse * 0.3;
        ctx.lineWidth = 1.5 * k;
        ctx.setLineDash([4 * k, 3 * k]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
      if (m.icon || m.label) {
        ctx.save();
        if (m.dim) ctx.globalAlpha = 0.5;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const bob = m.arrow ? Math.sin(g.time * 3) * 0.2 : 0;
        const iy = at.y - (m.r ? Math.min(m.r, 3) : 1.2) - 1.2 + bob;
        if (m.icon) {
          ctx.font = `${16 * k}px system-ui, sans-serif`;
          ctx.fillText(m.icon, at.x, iy);
        }
        if (m.label) {
          ctx.font = `700 ${11 * k}px ${BODY}`;
          outlined(ctx, m.label, at.x, iy + (m.icon ? 13 * k : 0), '#fff', 3 * k);
        }
        ctx.restore();
      }
    }
  }

  // -------------------------------------------------------------------------------------- map
  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    const g = this.g;
    const s = g.host.live.mini;
    // rounds nearby others opened, to join
    if (!s || s.phase === 'done') {
      const me = g.host.net?.nick;
      for (const o of g.host.live.miniOpen) {
        if (o.nick === me) continue;
        const [x, y] = toScreen(o.x, o.y);
        pulsingCircle(ctx, x, y, size * 1.8, MINI_INFO[o.kind].color, g.time, false);
        this.emoji(ctx, MINI_INFO[o.kind].emoji, x, y, size, full ? `${o.nick}: ${MINI_INFO[o.kind].title}` : '');
      }
      return;
    }
    MINI_DRAW[s.kind]?.map?.(ctx, s, toScreen, full, size, g);
    const info = MINI_INFO[s.kind];
    for (const m of s.marks ?? []) {
      if (m.noMap) continue;
      const at = this.markPos(m);
      const [x, y] = toScreen(at.x, at.y);
      const color = m.color ?? info.color;
      ctx.save();
      if (m.dim) ctx.globalAlpha = 0.45;
      if (m.poly && m.poly.length >= 6) {
        ctx.strokeStyle = color;
        ctx.lineWidth = full ? 2 : 1.3;
        ctx.beginPath();
        for (let i = 0; i < m.poly.length; i += 2) {
          const [px, py] = toScreen(m.poly[i], m.poly[i + 1]);
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
      if (m.r && m.r > 12) {
        const [ex] = toScreen(at.x + m.r, at.y);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, Math.abs(ex - x), 0, Math.PI * 2);
        ctx.stroke();
      }
      if (m.arrow) pulsingCircle(ctx, x, y, size * 1.6, color, g.time, false);
      ctx.restore();
      if (m.icon) {
        ctx.save();
        if (m.dim) ctx.globalAlpha = 0.5;
        // on the big map only the target's label: a city full of them would be unreadable
        this.emoji(ctx, m.icon, x, y, size, full && m.arrow ? (m.label ?? '') : '');
        ctx.restore();
      } else if (m.w || m.r) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2, size * 0.45), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private emoji(ctx: CanvasRenderingContext2D, e: string, x: number, y: number, size: number, label: string) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.max(10, size * 1.5)}px system-ui, sans-serif`;
    ctx.fillText(e, x, y);
    if (label) {
      ctx.font = `700 11px ${BODY}`;
      ctx.textBaseline = 'bottom';
      outlined(ctx, label, x, y - size - 2, '#fff59d', 3);
    }
  }

  // ----------------------------------------------------------------------------------- events
  onPrivate(e: PrivateEvent) {
    if (e.k === 'payout' && e.reason === 'minigame') toast(`Minihra: +${formatMoney(e.amount)}`, '#69f0ae');
  }
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
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
  return lines;
}
