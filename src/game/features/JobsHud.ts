// Jobs UI: J opens the picker (or a "stop the shift?" confirm while one runs), the objective banner +
// countdown + condition bar + pay + off-screen arrow (Hud.ts's idioms, reimplemented here since those
// are private to Hud), a pulsing world ring and hailing icon at the target, map markers, and toasts.
// The mechanics themselves are the shared Jobs rule (src/shared/sim/rules/jobs/Jobs.ts), which the
// server runs and which also runs offline; this feature only shows what it does.
// Plan: docs/plans/social-events.md ("Vlk courier / Hopík taxi").
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { View } from '../../world/Renderer';
import type { PrivateEvent } from '../../shared/sim/events';
import type { JobKind, JobState } from '../../shared/sim/rules/types';
import { formatMoney } from '../../shared/util/math';
import { outlined } from '../../ui/Hud';
import { bandBottom } from '../../ui/kit/Banners';
import { edgePoint, inPlay } from '../../ui/layout';
import { mapMarker } from '../../ui/MapView';
import { roundRect } from '../../render/shapes';
import { openModal, isModalOpen, toast } from '../../ui/kit/dom';
import { KEYS } from '../Input';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
const BODY = `'Inter', system-ui, sans-serif`;
const ICON: Record<JobKind, 'vlk' | 'hopik'> = { courier: 'vlk', taxi: 'hopik' };
const COLOR: Record<JobKind, string> = { courier: '#8bc34a', taxi: '#ffd600' };
const CONDITION_LABEL: Record<JobKind, string> = { courier: 'Objednávka', taxi: 'Nálada zákazníka' };
// JobState.stage also allows 'offer' (see Jobs.ts's header comment: this rule never actually sends
// it), covered here only so the lookup below stays total rather than needing a cast.
const OBJECTIVE: Record<JobKind, Record<JobState['stage'], (label: string) => string>> = {
  courier: {
    offer: () => 'VLK: čaká sa na objednávku…',
    pickup: (label) => `VLK: vyzdvihni objednávku – ${label}`,
    deliver: (label) => `VLK: doruč na ${label}`,
  },
  taxi: {
    offer: () => 'HOPÍK: čaká sa na jazdu…',
    pickup: () => 'HOPÍK: vyzdvihni zákazníka',
    deliver: (label) => `HOPÍK: odvez zákazníka – ${label}`,
  },
};

export class JobsHud implements ClientFeature {
  readonly id = 'jobsHud';

  constructor(private g: Game) {}

  update() {
    const g = this.g;
    if (g.paused || g.showMap || isModalOpen() || !g.input.hit(KEYS.jobs)) return;
    if (g.host.live.job) this.confirmStop();
    else this.openPicker();
  }

  private openPicker() {
    const g = this.g;
    openModal({
      title: 'Práca',
      body: 'Bratislava potrebuje kuriérov aj taxikárov. Vyber si zmenu:',
      buttons: [
        { label: 'Vlk kuriér – rozvoz jedla', primary: true, onClick: () => g.host.jobStart('courier') },
        { label: 'Hopík taxi – vozenie ľudí', onClick: () => g.host.jobStart('taxi') },
        { label: 'Zrušiť', onClick: () => {} },
      ],
    });
  }

  private confirmStop() {
    const g = this.g;
    openModal({
      title: 'Ukončiť smenu?',
      body: 'Rozrobená objednávka alebo jazda prepadne bez výplaty.',
      buttons: [
        { label: 'Pokračovať', primary: true, onClick: () => {} },
        { label: 'Áno, skončiť', danger: true, onClick: () => g.host.jobStop() },
      ],
    });
  }

  // ------------------------------------------------------------------------------------------ HUD
  drawHud(ctx: CanvasRenderingContext2D) {
    const job = this.g.host.live.job;
    if (!job) return;
    const g = this.g;
    const W = g.viewW;
    const L = g.layout;
    const small = L.small;
    const pad = L.padL;
    // below both the top-right HUD panel and the Banners slot (src/ui/kit/Banners.ts), so this
    // objective/countdown/status stack never overlaps either; on a phone, in the objective's slot
    const top = L.touch ? L.objective.y : bandBottom(L);
    const color = COLOR[job.kind];

    this.drawObjective(ctx, OBJECTIVE[job.kind][job.stage](job.label), W, pad, small, color, top);

    if (job.left > 0) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.font = `700 ${small ? 18 : 24}px ${HEAD}`;
      const s = Math.ceil(job.left);
      outlined(ctx, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, L.band.cx, top + (small ? 26 : 46), s < 20 ? '#ff5252' : '#fff');
    }

    this.drawStatus(ctx, job, top, small);
    this.drawArrowTo(ctx, job.x, job.y, color);
  }

  /** the objective banner, in Hud.ts's `drawObjective` idiom (private there): a rounded glassy panel,
   *  a coloured left accent, the text centred and outlined. */
  private drawObjective(ctx: CanvasRenderingContext2D, text: string, W: number, pad: number, small: boolean, color: string, by: number) {
    const L = this.g.layout;
    const fs = small ? 13 : 16;
    ctx.font = `700 ${fs}px ${BODY}`;
    const maxW = Math.min(W * 0.62, 560, L.band.w - fs * 2);
    const lines = wrapLines(ctx, text, maxW);
    const lh = small ? 17 : 21;
    const bw = Math.min(maxW + fs * 2, W - pad * 2);
    const bh = lines.length * lh + fs * 1.1;
    const bx = L.band.cx - bw / 2;
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
    lines.forEach((l, i) => outlined(ctx, l, L.band.cx, by + fs * 0.55 + i * lh, '#fff59d'));
  }

  /** the condition/mood bar and the running pay, one compact row under the countdown */
  private drawStatus(ctx: CanvasRenderingContext2D, job: JobState, top: number, small: boolean) {
    const cx = this.g.layout.band.cx;
    const y = top + (small ? 52 : 78);
    const bw = small ? 130 : 170, bh = small ? 9 : 11;
    const bx = cx - bw - (small ? 6 : 10);
    roundRect(ctx, bx, y, bw, bh, bh / 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fill();
    const frac = Math.max(0, Math.min(1, job.condition / 100));
    const cColor = frac > 0.5 ? '#8bc34a' : frac > 0.2 ? '#ffb300' : '#ff5252';
    if (frac > 0) {
      roundRect(ctx, bx + 1, y + 1, Math.max(2, (bw - 2) * frac), bh - 2, (bh - 2) / 2);
      ctx.fillStyle = cColor;
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    roundRect(ctx, bx, y, bw, bh, bh / 2);
    ctx.stroke();
    ctx.font = `600 ${small ? 10 : 11}px ${BODY}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    outlined(ctx, CONDITION_LABEL[job.kind], bx, y - 2, '#cfd8dc', 2.5);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${small ? 14 : 17}px ${HEAD}`;
    outlined(ctx, formatMoney(job.pay), cx + (small ? 6 : 10), y + bh / 2, '#8bdc6b', 3);
  }

  /** off-screen arrow to the target, Hud.ts's `drawArrow` idiom (private there, so reimplemented) */
  private drawArrowTo(ctx: CanvasRenderingContext2D, tx: number, ty: number, color: string) {
    const g = this.g;
    const f = g.focus();
    const a = Math.atan2(ty - f.y, tx - f.x);
    const d = Math.hypot(tx - f.x, ty - f.y);
    const cx = g.viewW / 2 + (tx - g.cam.x) * g.cam.scale;
    const cy = g.viewH / 2 + (ty - g.cam.y) * g.cam.scale;
    const onScreen = inPlay(g.layout, cx, cy);
    ctx.save();
    if (onScreen) {
      ctx.translate(cx, cy - 26 + Math.sin(g.time * 5) * 5);
      ctx.rotate(Math.PI / 2);
    } else {
      const e = edgePoint(g.layout, a);
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
      const e = edgePoint(g.layout, a, 28);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 12px ${BODY}`;
      outlined(ctx, `${Math.round(d)} m`, e.x, e.y, color);
    }
  }

  // ---------------------------------------------------------------------------------------- world
  drawWorld(ctx: CanvasRenderingContext2D, v: View) {
    const job = this.g.host.live.job;
    if (!job) return;
    worldPulse(ctx, job.x, job.y, 3.2, COLOR[job.kind], this.g.time, v.scale);
    if (job.kind === 'taxi' && job.stage === 'pickup') {
      const bob = Math.sin(this.g.time * 3) * 0.15;
      ctx.font = `${14 / v.scale}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      outlined(ctx, '✋', job.x, job.y - 2.4 + bob, '#ffd600', 3 / v.scale);
    }
  }

  // ------------------------------------------------------------------------------------------ map
  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    const job = this.g.host.live.job;
    if (!job) return;
    const [x, y] = toScreen(job.x, job.y);
    mapMarker(ctx, x, y, size, ICON[job.kind], { ring: COLOR[job.kind], pulse: this.g.time, label: job.label, full });
  }

  // --------------------------------------------------------------------------------------- events
  onPrivate(e: PrivateEvent) {
    if (e.k !== 'payout') return;
    if (e.reason === 'tip') toast(`Tesne! +${formatMoney(e.amount)}`, '#ffd600', 1300);
    else if (e.reason === 'courier') toast(`Doručené! +${formatMoney(e.amount)}`, '#69f0ae');
    else if (e.reason === 'taxi') toast(`Odvezené! +${formatMoney(e.amount)}`, '#69f0ae');
  }
}

/** the same "light fill inside a shimmering dashed stroke" idiom as MapView's `pulsingCircle`, but in
 *  world metres (that one's fixed-px stroke is meant for the screen-space map/minimap only). */
function worldPulse(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, t: number, scale: number) {
  const pulse = 0.5 + 0.5 * Math.sin(t * 4);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([4 / scale, 3 / scale]);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.globalAlpha = 0.65 + pulse * 0.2;
  ctx.stroke();
  ctx.restore();
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
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
