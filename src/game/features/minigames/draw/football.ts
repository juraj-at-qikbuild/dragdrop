// Vydrž do 95. minúty's own drawing (docs/plans/minigames.md; the game: shared/…/games/football.ts):
// the pitch chalked on the car park (its lines, the goals' nets and posts, the boards round it with
// their parody sponsors), a TV score bug in the corner ("SVK 1 : 0 ENG  94:12"), the goal and the
// bicycle kick called out big, and the pitch and the ball on the map. Everything from the state's
// `x`: the pitch `p` [x, y, angle, half-length, half-width, goal width, goal depth], the ball's id `b`,
// the teams' tags and colours (ta/tb, ca/cb), the score (sa/sb), which side this player is on (me),
// the clock (clk), the stage (st), and the moments (noz: the bicycle kick coming, gl: a goal, 1 home 2
// away). The ball itself is drawn as a vehicle (render/drawVehicle.ts).
import type { MiniDrawer } from './index';
import type { MiniState } from '../../../../shared/sim/rules/minigames/types';
import type { Game } from '../../../Game';
import { outlined } from '../../../../ui/Hud';
import { roundRect } from '../../../../render/shapes';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
const BODY = `'Inter', system-ui, sans-serif`;
/** the parody sponsors along the boards */
const BOARDS = ['KOFOLKA', 'HOPÍK TAXI', 'GTA SK', 'BILLKA', 'RÁDIO KECY', 'LIDEL', 'DPB'];

interface Pitch {
  x: number;
  y: number;
  a: number;
  hl: number;
  hw: number;
  gw: number;
  gd: number;
}

function pitchOf(s: MiniState): Pitch | null {
  const p = s.x?.p;
  if (!Array.isArray(p) || p.length < 7) return null;
  const [x, y, a, hl, hw, gw, gd] = p;
  return { x, y, a, hl, hw, gw, gd };
}

const str = (s: MiniState, k: string, d = '') => (typeof s.x?.[k] === 'string' ? (s.x[k] as string) : d);
const num = (s: MiniState, k: string, d = 0) => (typeof s.x?.[k] === 'number' ? (s.x[k] as number) : d);

export const FOOTBALL_DRAW: MiniDrawer = {
  /** the pitch, under the marks: chalk on the asphalt, the nets, the boards */
  world(ctx, s, v) {
    const q = pitchOf(s);
    if (!q) return;
    const R = q.hl + q.gd + q.hw + 4;
    if (q.x + R < v.x0 || q.x - R > v.x1 || q.y + R < v.y0 || q.y - R > v.y1) return;
    const { hl, hw, gw, gd } = q;
    ctx.save();
    ctx.translate(q.x, q.y);
    ctx.rotate(q.a);
    // a faint green wash, mown in stripes
    for (let i = 0, n = Math.max(4, Math.round(hl / 3.5)) * 2; i < n; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(90,170,90,0.13)' : 'rgba(90,170,90,0.19)';
      ctx.fillRect(-hl + (2 * hl * i) / n, -hw, (2 * hl) / n + 0.02, 2 * hw);
    }
    // the chalk
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 0.14;
    ctx.strokeRect(-hl, -hw, 2 * hl, 2 * hw);
    ctx.beginPath();
    ctx.moveTo(0, -hw);
    ctx.lineTo(0, hw);
    ctx.stroke();
    const cr = Math.min(6, hw * 0.35);
    ctx.beginPath();
    ctx.arc(0, 0, cr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 0.3, 0, Math.PI * 2);
    ctx.fill();
    const boxD = Math.min(8, hl * 0.3), boxW = Math.min(hw - 1.5, gw / 2 + 5);
    const areaD = Math.min(3, boxD * 0.4), areaW = gw / 2 + 1.8;
    for (const s2 of [-1, 1]) {
      ctx.strokeRect(s2 < 0 ? -hl : hl - boxD, -boxW, boxD, 2 * boxW);
      ctx.strokeRect(s2 < 0 ? -hl : hl - areaD, -areaW, areaD, 2 * areaW);
      ctx.beginPath();
      ctx.arc(s2 * (hl - boxD * 0.7), 0, 0.25, 0, Math.PI * 2);
      ctx.fill();
      // the arc at the top of the box
      ctx.beginPath();
      const px = s2 * (hl - boxD * 0.7), rr = boxD * 0.55;
      const t = Math.acos(Math.min(1, (boxD * 0.3) / rr));
      if (s2 < 0) ctx.arc(px, 0, rr, -t, t);
      else ctx.arc(px, 0, rr, Math.PI - t, Math.PI + t);
      ctx.stroke();
    }
    // corner arcs and flags
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(sx * hl, sy * hw, 1, sx < 0 ? (sy < 0 ? 0 : -Math.PI / 2) : sy < 0 ? Math.PI / 2 : Math.PI, sx < 0 ? (sy < 0 ? Math.PI / 2 : 0) : sy < 0 ? Math.PI : (Math.PI * 3) / 2);
        ctx.stroke();
        ctx.fillStyle = '#ffeb3b';
        ctx.beginPath();
        ctx.moveTo(sx * hl, sy * hw);
        ctx.lineTo(sx * hl - sx * 0.1, sy * hw - sy * 0.8);
        ctx.lineTo(sx * hl + sx * 0.5, sy * hw - sy * 0.55);
        ctx.closePath();
        ctx.fill();
      }
    // the boards along the sides, and across the ends either side of the goals
    const bt = 0.45;
    ctx.fillStyle = '#12306b';
    ctx.fillRect(-hl - bt, -hw - bt, 2 * hl + 2 * bt, bt);
    ctx.fillRect(-hl - bt, hw, 2 * hl + 2 * bt, bt);
    for (const s2 of [-1, 1]) {
      ctx.fillRect(s2 < 0 ? -hl - bt : hl, -hw, bt, hw - gw / 2);
      ctx.fillRect(s2 < 0 ? -hl - bt : hl, gw / 2, bt, hw - gw / 2);
    }
    if (v.scale > 3) {
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${bt * 0.8}px ${BODY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      let i = 0;
      for (let x = -hl + 5; x < hl - 3; x += 9, i++) {
        const t = BOARDS[i % BOARDS.length];
        ctx.fillText(t, x, -hw - bt / 2);
        ctx.save();
        ctx.translate(x, hw + bt / 2);
        ctx.fillText(BOARDS[(i + 3) % BOARDS.length], 0, 0);
        ctx.restore();
      }
    }
    // the goals: a net behind each goal line, the posts, the bar between them (seen from above)
    for (const s2 of [-1, 1]) {
      const x0 = s2 < 0 ? -hl - gd : hl;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x0, -gw / 2, gd, gw);
      ctx.strokeStyle = 'rgba(235,240,245,0.55)';
      ctx.lineWidth = 0.04;
      ctx.beginPath();
      for (let y = -gw / 2; y <= gw / 2 + 1e-6; y += 0.4) (ctx.moveTo(x0, y), ctx.lineTo(x0 + gd, y));
      for (let x = x0; x <= x0 + gd + 1e-6; x += 0.4) (ctx.moveTo(x, -gw / 2), ctx.lineTo(x, gw / 2));
      ctx.stroke();
      ctx.strokeStyle = 'rgba(220,225,230,0.9)';
      ctx.lineWidth = 0.08;
      ctx.strokeRect(x0, -gw / 2, gd, gw);
      ctx.fillStyle = '#fafafa';
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.05;
      ctx.fillRect(s2 * hl - 0.1, -gw / 2, 0.2, gw);
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s2 * hl, (sy * gw) / 2, 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  },

  /** the score bug (a TV's, top left), and the goal or the bicycle kick called out big */
  hud(ctx, s, g) {
    if (s.phase !== 'live' || typeof s.x?.st !== 'string') return;
    const L = g.layout, small = L.small;
    const ta = str(s, 'ta', 'SVK'), tb = str(s, 'tb', 'ENG');
    const ca = str(s, 'ca', '#1565c0'), cb = str(s, 'cb', '#f5f5f5');
    const me = num(s, 'me');
    const score = `${num(s, 'sa')} : ${num(s, 'sb')}`;
    const clk = str(s, 'clk');
    const h = small ? 26 : 32;
    ctx.save();
    ctx.font = `700 ${small ? 14 : 17}px ${HEAD}`;
    const tw = Math.max(ctx.measureText(ta).width, ctx.measureText(tb).width) + (small ? 12 : 16);
    ctx.font = `700 ${small ? 17 : 21}px ${HEAD}`;
    const sw = ctx.measureText(score).width + (small ? 14 : 18);
    ctx.font = `700 ${small ? 13 : 15}px ${HEAD}`;
    const cw = ctx.measureText(clk || '0:00').width + (small ? 14 : 18);
    const w = tw * 2 + sw + cw;
    // top left (on a touch screen in the stack under the street name), under the party's panel
    // (the score comes first: it always gets its spot)
    const spot = g.stackSpot(h, w, true);
    if (spot === false) return;
    const party = g.online ? g.host.live.party : null;
    const x = spot ? spot.x : L.padL;
    const y = spot ? spot.y : L.padT + (party ? 8 + (small ? 15 : 17) * (party.members.length + 1) + 8 : 0);
    roundRect(ctx, x, y, w, h, 6);
    ctx.fillStyle = 'rgba(10,12,18,0.84)';
    ctx.fill();
    const team = (tag: string, color: string, bx: number, mine: boolean) => {
      ctx.fillStyle = color;
      ctx.fillRect(bx + 3, y + 4, 4, h - 8);
      ctx.font = `700 ${small ? 14 : 17}px ${HEAD}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = mine ? '#fff59d' : '#ffffff';
      ctx.fillText(tag, bx + 5 + (tw - 5) / 2, y + h / 2 + 1);
    };
    team(ta, ca, x, me === 0);
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(x + tw, y + 3, sw, h - 6);
    ctx.fillStyle = '#12161f';
    ctx.font = `700 ${small ? 17 : 21}px ${HEAD}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(score, x + tw + sw / 2, y + h / 2 + 1);
    team(tb, cb, x + tw + sw, me === 1);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(x + tw * 2 + sw, y + 3, cw - 3, h - 6);
    ctx.font = `700 ${small ? 13 : 15}px ${HEAD}`;
    ctx.fillStyle = '#b9f6ca';
    ctx.fillText(clk, x + tw * 2 + sw + cw / 2 - 1, y + h / 2 + 1);
    // the moment: a goal (the scorers' colour), or the bicycle kick coming (red, flashing)
    const gl = num(s, 'gl'), noz = num(s, 'noz');
    if (gl || noz) {
      const big = small ? 34 : 54;
      ctx.font = `700 ${big}px ${HEAD}`;
      const pulse = 0.75 + 0.25 * Math.sin(g.time * (noz ? 14 : 6));
      ctx.globalAlpha = noz ? pulse : 1;
      const ours = gl ? gl - 1 === me : false;
      const text = noz ? 'NOŽNIČKA!' : ours ? 'GÓÓÓL!' : 'GÓL…';
      const color = noz ? '#ff5252' : ours ? '#69f0ae' : '#ffab91';
      ctx.save();
      // between the objective's box and the line where messages come up
      ctx.translate(L.band.cx, (L.objective.y + (small ? 50 : 62) + L.msgY) / 2);
      if (!noz && ours) ctx.scale(pulse * 0.2 + 0.95, pulse * 0.2 + 0.95);
      outlined(ctx, text, 0, 0, color, small ? 5 : 7);
      ctx.restore();
    }
    ctx.restore();
  },

  /** the pitch and the ball on the map and the minimap */
  map(ctx, s, toScreen, full, size, g: Game) {
    const q = pitchOf(s);
    if (!q) return;
    const ca = Math.cos(q.a), sa = Math.sin(q.a);
    const at = (lx: number, ly: number) => toScreen(q.x + lx * ca - ly * sa, q.y + lx * sa + ly * ca);
    const poly = (pts: [number, number][]) => {
      ctx.beginPath();
      pts.forEach(([lx, ly], i) => {
        const [sx, sy] = at(lx, ly);
        i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy);
      });
      ctx.closePath();
    };
    ctx.save();
    poly([[-q.hl, -q.hw], [q.hl, -q.hw], [q.hl, q.hw], [-q.hl, q.hw]]);
    ctx.fillStyle = 'rgba(76,175,80,0.45)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = full ? 1.5 : 1;
    ctx.stroke();
    const [m0x, m0y] = at(0, -q.hw), [m1x, m1y] = at(0, q.hw);
    ctx.beginPath();
    ctx.moveTo(m0x, m0y);
    ctx.lineTo(m1x, m1y);
    ctx.stroke();
    for (const [s2, color] of [[-1, str(s, 'ca', '#1565c0')], [1, str(s, 'cb', '#f5f5f5')]] as const) {
      const x0 = s2 < 0 ? -q.hl - q.gd : q.hl;
      poly([[x0, -q.gw / 2], [x0 + q.gd, -q.gw / 2], [x0 + q.gd, q.gw / 2], [x0, q.gw / 2]]);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // the ball: where the host has it now
    const id = num(s, 'b');
    const ball = id ? g.host.vehicleById(id) : null;
    if (ball) {
      const [bx, by] = toScreen(ball.x, ball.y);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(2.5, size * 0.55), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  },
};
