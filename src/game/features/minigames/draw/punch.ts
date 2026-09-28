// Punčová cesta's market (games/punch.ts, docs/plans/minigames.md): the little wooden stalls on Hlavné
// and Hviezdoslavovo námestie, each with its roof, a striped awning over the counter and fairy lights
// along the eaves. The game's marks say what each one sells; this draws the huts themselves, where
// marketStalls() puts them (worked out from the map alone, so exactly where the game has them).
import type { MiniDrawer } from './index';
import { marketStalls, type StallKind } from '../../../../shared/sim/rules/minigames/games/punch';

/** the awning's two stripes, by what the stall sells */
const AWNING: Record<StallKind, [string, string]> = {
  drink: ['#c62828', '#fafafa'],
  turbo: ['#e65100', '#212121'],
  food: ['#f9a825', '#c62828'],
  tree: ['#2e7d32', '#fafafa'],
  gloves: ['#1565c0', '#fafafa'],
  deposit: ['#43a047', '#e8f5e9'],
};
const BULBS = ['#ffe082', '#ff5252', '#69f0ae', '#40c4ff', '#ffd740'];
/** the hut (m): its depth (the counter faces +x) and width, and how far the roof overhangs it */
const D = 2.2, W = 3.2, EAVE = 0.2;

export const PUNCH_DRAW: MiniDrawer = {
  world(ctx, _s, v, g) {
    const night = g.atmos.night, t = g.time;
    for (const st of marketStalls(g.world)) {
      if (st.x < v.x0 - 4 || st.x > v.x1 + 4 || st.y < v.y0 - 4 || st.y > v.y1 + 4) continue;
      ctx.save();
      ctx.translate(st.x, st.y);
      ctx.rotate(st.a);
      const x0 = -D / 2 - EAVE, x1 = D / 2 + EAVE, y0 = -W / 2 - EAVE, y1 = W / 2 + EAVE;
      // the roof: two slopes either side of the ridge, boards across them
      ctx.fillStyle = '#8d6e63';
      ctx.fillRect(x0, y0, -x0, y1 - y0);
      ctx.fillStyle = '#6d4c41';
      ctx.fillRect(0, y0, x1, y1 - y0);
      ctx.strokeStyle = 'rgba(40,20,10,0.35)';
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      for (let y = y0 + 0.45; y < y1; y += 0.45) {
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
      ctx.strokeStyle = '#3e2723';
      ctx.lineWidth = 0.14;
      ctx.beginPath();
      ctx.moveTo(0, y0);
      ctx.lineTo(0, y1);
      ctx.stroke();
      // the awning over the counter
      const [c1, c2] = AWNING[st.kind];
      const n = 6, sw = (y1 - y0) / n;
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = i % 2 ? c2 : c1;
        ctx.fillRect(x1, y0 + i * sw, 0.55, sw);
      }
      // (after dark the hut is in the dark with everything else; only its lights shine)
      if (night > 0.05) {
        ctx.fillStyle = `rgba(8,10,24,${0.55 * night})`;
        ctx.fillRect(x0, y0, x1 - x0 + 0.55, y1 - y0);
      }
      // fairy lights along the eaves, twinkling
      const pts: [number, number][] = [];
      for (let y = y0; y <= y1 + 1e-6; y += 0.4) pts.push([x0, y], [x1 + 0.55, y]);
      for (let x = x0 + 0.4; x < x1 + 0.55; x += 0.4) pts.push([x, y0], [x, y1]);
      pts.forEach(([x, y], i) => {
        const tw = 0.55 + 0.45 * Math.sin(t * 2.6 + i * 1.7 + st.x);
        const c = BULBS[i % BULBS.length];
        if (night > 0.05) {
          ctx.globalAlpha = 0.28 * night * tw;
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(x, y, 0.32, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 0.5 + 0.5 * tw;
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(x, y, 0.08, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }
  },
};
