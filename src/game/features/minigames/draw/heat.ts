// Horúčava's own drawing (games/heat.ts): the heat itself, which no mark can show — a warm haze closing
// in from the edges of the screen as the player overheats, pulsing when they're about to faint. The
// middle, where they're going, and the objective's box at the top stay clear. From the state's `x.h`
// (the heat, 0..1).
import type { MiniDrawer } from './index';

/** the haze starts at this heat, and pulses from this one */
const FROM = 0.45, PULSE = 0.8;

export const HEAT_DRAW: MiniDrawer = {
  hud(ctx, s, g) {
    if (s.phase !== 'live') return;
    const h = Number(s.x?.h) || 0;
    const k = Math.min(1, Math.max(0, (h - FROM) / (1 - FROM)));
    if (k <= 0) return;
    const w = g.viewW, H = g.viewH;
    const pulse = h >= PULSE ? 0.5 + 0.5 * Math.sin(g.time * 5) : 0;
    const alpha = 0.08 + k * 0.3 + pulse * 0.12;
    const grad = ctx.createRadialGradient(w / 2, H / 2, Math.min(w, H) * (0.55 - k * 0.18), w / 2, H / 2, Math.hypot(w, H) / 2);
    grad.addColorStop(0, 'rgba(255,140,40,0)');
    grad.addColorStop(1, `rgba(255,${Math.round(120 - k * 80)},30,${alpha.toFixed(3)})`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, H);
    ctx.restore();
  },
};
