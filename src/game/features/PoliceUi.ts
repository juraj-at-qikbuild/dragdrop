// What the police know, on screen, and the player's side of an arrest (docs/plans/gameplay.md,
// Phase 1). The chase itself runs in the shared simulation (src/shared/sim/Pursuit.ts); this shows it:
// - the chip under the stars: what the police are looking for, whether they see the player, whether a
//   unit is looking them over (with how far it's got), lying low;
// - "!" over each police unit that sees the player, "?" while one is looking them over;
// - the units' sight cones and the helicopter's view on the minimap and the city map, drawn with the
//   same sight.ts the simulation decides with;
// - the police radio (Vysielačka): the search, a change of car, the search called off;
// - Úplatok: buying off an arrest with the use key (F, Enter, E, the pad's Y, the touch button).
// Works the same offline and online (LiveState.police and .bribe, from the `police` and `bribe` events).
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { View } from '../../world/Renderer';
import type { PrivateEvent } from '../../shared/sim/events';
import type { Vehicle, VehicleKind } from '../../shared/entities/Vehicle';
import type { Ped } from '../../shared/entities/Ped';
import { BEAM_DARK, HELI_BEAM_R, HELI_DAY_R, SIGHT, inSight, sightEnv, type Sight } from '../../shared/sim/sight';
import { darkness } from '../../shared/sim/Clock';
import { placeName } from '../../shared/sim/rules/placeName';
import { formatMoney } from '../../shared/util/math';
import { buttonGlyph, outlined, panel } from '../../ui/Hud';
import type { Rect } from '../../ui/layout';
import { roundRect } from '../../render/shapes';
import { DISPATCH, describeCar, describeWalker, wantedLine } from './police/text';

const BODY = `'Inter', system-ui, sans-serif`;
const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
/** the police radio: a line at most this often (ms), shown this long (s) */
const LINE_GAP = 5000;
const LINE_TIME = 5;
/** they must have lost the player this long (s) before the radio says so (a lamp post in the way
 *  for a moment is no news) */
const LOST_AFTER = 1.5;
/** units further than this (m) get no cone on the minimap */
const CONE_R = 160;

const SEEN = '#ff5252', WATCH = '#ffd740', LOST = '#90caf9', OK = '#b2ff59';

/** a unit whose eyes the police chase goes by: a police car (or SWAT van) in the chase, or a cop */
interface Unit {
  x: number;
  y: number;
  a: number;
  sight: Sight;
  level: number;
}

export class PoliceUi implements ClientFeature {
  readonly id = 'police';
  /** the last `police` status seen, for the radio's "he changed cars" (or clothes) */
  private prev: { car: number; color: string; hat: number } | null = null;
  private lineAt = -Infinity;
  private searchingFor = 0;
  private toldLost = false;

  constructor(private g: Game) {}

  // --------------------------------------------------------------------------------------- update
  update(dt: number) {
    const g = this.g;
    const live = g.host.live;
    // Úplatok: the use key while an arrest can still be bought off
    const offer = live.bribe;
    if (offer && g.state === 'busted' && performance.now() < offer.until) {
      // the arrest has the screen: the radio line would sit right where the offer is (on a phone)
      g.radioText.time = 0;
      if (!g.paused && g.input.hit('KeyF', 'Enter', 'KeyE')) {
        g.host.bribe();
        live.bribe = null;
      }
    }
    // the radio: the police have lost the player (for more than a moment), or found them again
    const searching = g.wanted > 0 && g.state === 'play' && g.host.me.searching;
    this.searchingFor = searching ? this.searchingFor + dt : 0;
    if (this.searchingFor > LOST_AFTER && !this.toldLost) {
      this.toldLost = true;
      const z = g.searchZone ?? g.focus();
      this.say(DISPATCH.lost(placeName(g.world, z.x, z.y)));
    } else if (!searching && this.toldLost) {
      this.toldLost = false;
      if (g.wanted > 0 && g.state === 'play') {
        const f = g.focus();
        this.say(DISPATCH.found(placeName(g.world, f.x, f.y)));
      }
    }
  }

  onPrivate(e: PrivateEvent) {
    if (e.k !== 'police') return;
    const g = this.g;
    const prev = this.prev;
    if (e.car < 0) {
      this.prev = null;
      this.toldLost = false;
      if (prev && g.state === 'play') this.say(DISPATCH.off());
      return;
    }
    const hat = e.hat ?? 0;
    this.prev = { car: e.car, color: e.color, hat };
    const what = e.car === 0 ? describeWalker(e.color, hat) : describeCar(e.kind as VehicleKind, e.color);
    if (!prev) {
      const z = g.searchZone ?? g.focus();
      this.say(DISPATCH.start(what, placeName(g.world, z.x, z.y)), true);
    } else if (prev.car !== e.car) this.say(e.car === 0 ? DISPATCH.onFoot() : DISPATCH.switched(what), true);
    // new clothes, and they've seen through them (the Butik, docs/plans/gameplay.md Phase 2)
    else if (e.car === 0 && (prev.color !== e.color || prev.hat !== hat)) this.say(DISPATCH.changed(what), true);
  }

  reset() {
    this.prev = null;
    this.toldLost = false;
    this.searchingFor = 0;
  }

  /** a line on the police radio, in the radio's slot (Game.radioText); `urgent` ones don't wait */
  private say(text: string, urgent = false) {
    const g = this.g;
    const now = performance.now();
    if (!urgent && now - this.lineAt < LINE_GAP) return;
    this.lineAt = now;
    g.radioText = { text: `🚨 Vysielačka: ${text}`, time: LINE_TIME };
    // the car radio's own chatter waits (Game.updateInfo)
    g.newsUntil = g.time + LINE_TIME;
  }

  // ---------------------------------------------------------------------------------------- units
  /** the police whose eyes count in a chase, near the player */
  private units(maxD: number): Unit[] {
    const g = this.g;
    const f = g.focus();
    const out: Unit[] = [];
    const near = (x: number, y: number) => Math.abs(x - f.x) < maxD && Math.abs(y - f.y) < maxD;
    for (const v of g.host.vehicles as readonly Vehicle[])
      if (v.siren && !v.wrecked && !v.isPlayer && (v.kind === 'police' || v.kind === 'van') && near(v.x, v.y))
        out.push({ x: v.x, y: v.y, a: v.angle, sight: SIGHT.car, level: v.level });
    for (const p of g.host.peds as readonly Ped[])
      if (p.kind === 'cop' && !p.dead && !p.vehicle && near(p.x, p.y)) out.push({ x: p.x, y: p.y, a: p.angle, sight: SIGHT.foot, level: p.level });
    return out;
  }

  private chasing() {
    const g = this.g;
    return g.wanted > 0 && g.state === 'play' && !!g.host.live.police;
  }

  // ------------------------------------------------------------------------------------ the world
  /** "!" over each unit that sees the player, "?" while one looks them over */
  drawWorld(ctx: CanvasRenderingContext2D, _v: View) {
    const g = this.g;
    if (!this.chasing()) return;
    const seen = !g.host.me.searching;
    const watched = !!g.host.live.police?.watched;
    if (!seen && !watched) return;
    const env = sightEnv(g.atmos.time, g.atmos.rain);
    const f = g.focus();
    const lvl = g.focusLevel();
    // about a finger's width on screen, whatever the zoom
    const s = Math.max(0.9, 26 / g.cam.scale);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = `900 ${s}px ${HEAD}`;
    ctx.lineJoin = 'round';
    for (const u of this.units(SIGHT.car.range + 5)) {
      if ((u.level === -1) !== (lvl === -1)) continue;
      if (inSight(u.x, u.y, u.a, u.sight, env.scale, f.x, f.y) < 0 || g.world.raycast(u.x, u.y, f.x, f.y, lvl) < 1) continue;
      const y = u.y - (u.sight === SIGHT.car ? 2.2 : 1.4) - Math.abs(Math.sin(g.time * 6)) * 0.3;
      ctx.lineWidth = s * 0.22;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(seen ? '!' : '?', u.x, y);
      ctx.fillStyle = seen ? SEEN : WATCH;
      ctx.fillText(seen ? '!' : '?', u.x, y);
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------------------- the map
  /** each unit's cone of sight (red while they see the player, blue while they search) and the
   *  helicopter's view: the circle under it by day, its beam after dark */
  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, _full: boolean, _size: number) {
    const g = this.g;
    if (!this.chasing()) return;
    const f = g.focus();
    // the map is a plain scale-and-shift of the world: work it out from two points near the player
    // (the minimap pins far points to its rim, so anything that doesn't fit the line is off it)
    const [ox, oy] = toScreen(f.x, f.y);
    const k = (toScreen(f.x + 20, f.y)[0] - ox) / 20;
    if (!(k > 0)) return;
    const at = (x: number, y: number): [number, number] | null => {
      const [sx, sy] = toScreen(x, y);
      const lx = ox + (x - f.x) * k, ly = oy + (y - f.y) * k;
      return Math.abs(sx - lx) > 1 || Math.abs(sy - ly) > 1 ? null : [lx, ly];
    };
    const env = sightEnv(g.atmos.time, g.atmos.rain);
    const seen = !g.host.me.searching;
    const watched = !!g.host.live.police?.watched;
    const fill = seen ? 'rgba(255,82,82,0.24)' : watched ? 'rgba(255,215,64,0.24)' : 'rgba(66,133,244,0.22)';
    const line = seen ? 'rgba(255,82,82,0.65)' : watched ? 'rgba(255,215,64,0.6)' : 'rgba(100,160,255,0.55)';
    ctx.save();
    ctx.lineWidth = 1;
    for (const u of this.units(CONE_R)) {
      const p = at(u.x, u.y);
      if (!p) continue;
      const r = u.sight.range * env.scale * k;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      ctx.arc(p[0], p[1], r, u.a - u.sight.half, u.a + u.sight.half);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = line;
      ctx.stroke();
    }
    const beam = darkness(g.atmos.time) >= BEAM_DARK;
    for (const h of g.host.helis) {
      const p = beam ? at(h.tx, h.ty) : at(h.x, h.y);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], (beam ? HELI_BEAM_R : HELI_DAY_R) * k, 0, Math.PI * 2);
      ctx.fillStyle = beam ? 'rgba(255,249,214,0.3)' : fill;
      ctx.fill();
      ctx.strokeStyle = beam ? 'rgba(255,249,214,0.8)' : line;
      ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------------------------- the chip
  /** The chip under the stars while wanted (the HUD places it: `place` picks its corner once its
   *  size is known). Returns where it went, or null when there's nothing to show (no chase, or a
   *  server that doesn't say what the police know). */
  drawChip(ctx: CanvasRenderingContext2D, small: boolean, place: (w: number, h: number) => { x: number; y: number }): Rect | null {
    const g = this.g;
    const pv = g.host.live.police;
    if (!pv || !this.chasing()) return null;
    const seen = !g.host.me.searching;
    const title = `🚔 ${wantedLine(pv.car, pv.kind, pv.color, pv.hat)}`;
    let status: string, color: string;
    if (seen) (status = '● Vidia ťa!'), (color = SEEN);
    else if (pv.watched) (status = '? Obzerajú si ťa…'), (color = WATCH);
    else {
      status = '○ Stratili ťa';
      if (!pv.match) status += ' · nepoznajú ťa';
      if (pv.low) status += pv.low === 2 ? ' · v úkryte' : ' · pritajený';
      color = !pv.match || pv.low ? OK : LOST;
    }
    const fs = small ? 12 : 14, fs2 = small ? 10 : 12;
    ctx.save();
    ctx.font = `700 ${fs}px ${BODY}`;
    const tw = ctx.measureText(title).width;
    ctx.font = `600 ${fs2}px ${BODY}`;
    const sw = ctx.measureText(status).width;
    const meter = !seen && pv.watched;
    const w = Math.max(tw, sw) + 20;
    const h = (small ? 34 : 40) + (meter ? 8 : 0);
    const { x, y } = place(w, h);
    panel(ctx, x, y, w, h, small ? 9 : 11);
    // a red edge while they see the player, pulsing
    if (seen) {
      roundRect(ctx, x, y, w, h, small ? 9 : 11);
      ctx.strokeStyle = `rgba(255,82,82,${0.45 + 0.4 * Math.abs(Math.sin(g.time * 5))})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${fs}px ${BODY}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(title, x + 10, y + (small ? 11 : 13));
    ctx.font = `600 ${fs2}px ${BODY}`;
    ctx.fillStyle = color;
    ctx.fillText(status, x + 10, y + (small ? 25 : 29));
    if (meter) {
      const bx = x + 10, by = y + h - 9, bw = w - 20;
      roundRect(ctx, bx, by, bw, 4, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
      roundRect(ctx, bx, by, Math.max(4, bw * pv.spot), 4, 2);
      ctx.fillStyle = pv.spot > 0.66 ? SEEN : WATCH;
      ctx.fill();
    }
    ctx.restore();
    return { x, y, w, h };
  }

  // ---------------------------------------------------------------------------------- the arrest
  /** under "ZATKNUTÝ": the bribe on offer, with the time left */
  drawHud(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const offer = g.host.live.bribe;
    if (!offer || g.state !== 'busted') return;
    const left = (offer.until - performance.now()) / 1000;
    if (left <= 0) return;
    const L = g.layout;
    const small = L.small;
    const afford = g.save.money >= offer.price;
    const text = afford ? `Podplatiť policajta: ${formatMoney(offer.price)}` : `Na úplatok nemáš (${formatMoney(offer.price)})`;
    const cx = g.viewW / 2, cy = g.viewH / 2 + (small ? 56 : 88);
    ctx.save();
    const fs = small ? 14 : 18;
    ctx.font = `700 ${fs}px ${BODY}`;
    // the key or the pad's button; on a touch screen the "Podplatiť" button itself (TouchControls)
    const glyph = afford && (g.input.pad.active || !g.touch);
    const h = small ? 34 : 42, gw = glyph ? h - 8 : 0;
    const w = ctx.measureText(text).width + gw + 30;
    const x = cx - w / 2, y = cy - h / 2;
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = 'rgba(10,12,18,0.8)';
    ctx.fill();
    ctx.strokeStyle = afford ? `rgba(178,255,89,${0.5 + 0.4 * Math.sin(g.time * 5)})` : 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (glyph) buttonGlyph(ctx, g.input.pad.active ? 'Y' : 'F', x + 6 + gw / 2, cy, gw / 2, g.input.pad.active ? 'pad' : 'key');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = afford ? '#fff' : '#b0bec5';
    ctx.fillText(text, x + (glyph ? gw + 16 : 15), cy + 1);
    // the time left, draining under it
    const frac = Math.max(0, Math.min(1, left / 5));
    roundRect(ctx, x + h / 2, y + h + 6, (w - h) * frac, 4, 2);
    ctx.fillStyle = afford ? OK : 'rgba(255,255,255,0.3)';
    ctx.fill();
    ctx.font = `600 ${small ? 11 : 13}px ${BODY}`;
    ctx.textAlign = 'center';
    outlined(ctx, 'Úplatok: policajt ťa pustí, zbrane ti ostanú.', cx, y + h + (small ? 22 : 26), '#cfd8dc', 3);
    ctx.restore();
  }
}
