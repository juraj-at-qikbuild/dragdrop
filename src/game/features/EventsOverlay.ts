// The generic HUD/map/world presentation for every world event kind (Horúca Kofolka, Najhľadanejší,
// Hon na Čumila, Obrnené auto, Derby na parkovisku): the active-event list, map markers/circles/zones,
// the floating cash icon over the Kofolka van, and the Slovak radio-style banners. Later agents adding
// the other kinds (most wanted, armoured van, derby) just fill in an `EventEntry` with the fields this
// file already reads — see the per-kind table below — and register their `WorldEventDef`; nothing here
// needs to change.
// Plan: docs/plans/social-events.md
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { View } from '../../world/Renderer';
import type { GlobalEvent, PrivateEvent } from '../../shared/sim/events';
import type { EventEntry, EventKind } from '../../shared/sim/rules/types';
import { eventLeft } from '../SimHost';
import { placeName } from '../../shared/sim/rules/placeName';
import { formatMoney } from '../../shared/util/math';
import { drawEventList, EVENT_ROW_H, type EventRow } from '../../ui/kit/EventList';
import { edgePoint, inPlay } from '../../ui/layout';
import { mapMarker, pulsingCircle, type MapIcon } from '../../ui/MapView';
import { outlined } from '../../ui/Hud';

/** Horúca Kofolka's payout rate ($10/s, Kofolka.ts), for the HUD's "+$10/s" line only. */
const KOFOLKA_RATE = 10;

const KIND_INFO: Record<EventKind, { label: string; icon: MapIcon; color: string }> = {
  kofolka: { label: 'Horúca Kofolka', icon: 'kofolka', color: '#ff8a65' },
  wanted: { label: 'Najhľadanejší', icon: 'wanted', color: '#ff5252' },
  cumil: { label: 'Hon na Čumila', icon: 'goldenCumil', color: '#ffd600' },
  armored: { label: 'Obrnené auto', icon: 'armored', color: '#90caf9' },
  derby: { label: 'Derby na parkovisku', icon: 'derby', color: '#ffab40' },
};

export class EventsOverlay implements ClientFeature {
  readonly id = 'eventsOverlay';
  /** brightens the "+$10/s" line for a moment on each real payout (see onPrivate) */
  private kofolkaFlash = 0;

  constructor(private g: Game) {}

  update(dt: number) {
    if (this.kofolkaFlash > 0) this.kofolkaFlash = Math.max(0, this.kofolkaFlash - dt * 1.5);
  }

  reset() {
    this.kofolkaFlash = 0;
  }

  // ------------------------------------------------------------------------- HUD
  drawHud(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const live = g.host.live;
    if (!live.events.length) return;
    const L = g.layout;
    const rows = live.events.map((e) => this.rowFor(e));
    // just right of the minimap, level with its top edge, growing downward; on a touch screen in the
    // feature stack under the street name
    const spot = g.stackSpot(rows.length * EVENT_ROW_H + 26);
    const x = spot ? spot.x : L.mini.cx + L.mini.r + 12;
    const y = spot ? spot.y : L.mini.cy - L.mini.r;
    const usedH = drawEventList(ctx, x, y, rows, 'left');

    const kof = live.events.find((e) => e.kind === 'kofolka');
    if (kof && kof.holder === g.host.me.id) {
      const k = 1 + this.kofolkaFlash * 0.25;
      ctx.save();
      ctx.globalAlpha = 0.7 + this.kofolkaFlash * 0.3;
      ctx.font = `700 ${13 * k}px 'Inter', system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      outlined(ctx, `+${formatMoney(KOFOLKA_RATE)}/s`, x, y + usedH + 13, '#8bdc6b', 3);
      ctx.restore();
    } else if (kof && kof.phase === 'live') this.drawKofolkaArrow(ctx, kof);
  }

  private rowFor(e: EventEntry): EventRow {
    const info = KIND_INFO[e.kind];
    const value = e.kind === 'derby' && e.alive !== undefined ? `${e.alive} áut` : e.pot !== undefined ? formatMoney(e.pot) : undefined;
    return { icon: info.icon, label: e.place ? `${info.label} · ${e.place}` : info.label, secs: eventLeft(this.g.host.live, e), value, color: info.color };
  }

  /** an off-screen indicator toward the live Kofolka van, when the player isn't already driving it
   *  (the same idiom as Hud.ts's private `drawArrow`, for a mission/waypoint target) */
  private drawKofolkaArrow(ctx: CanvasRenderingContext2D, kof: EventEntry) {
    const g = this.g;
    let tx = kof.x, ty = kof.y;
    if (tx === undefined || ty === undefined) return;
    if (kof.vid !== undefined) {
      const v = g.host.vehicleById(kof.vid);
      if (v) (tx = v.x), (ty = v.y);
    }
    const cx = g.viewW / 2 + (tx - g.cam.x) * g.cam.scale;
    const cy = g.viewH / 2 + (ty - g.cam.y) * g.cam.scale;
    if (inPlay(g.layout, cx, cy)) return; // on screen: the floating cash icon already marks it
    const f = g.focus();
    const a = Math.atan2(ty - f.y, tx - f.x);
    const e = edgePoint(g.layout, a);
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.rotate(a);
    ctx.fillStyle = KIND_INFO.kofolka.color;
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
  }

  // ------------------------------------------------------------------------- map
  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    const g = this.g;
    for (const e of g.host.live.events) {
      const info = KIND_INFO[e.kind];
      const announcing = e.phase === 'announce';
      const blink = announcing && Math.floor(g.time * 3) % 2 === 0;
      if (e.kind === 'cumil') {
        if (e.x === undefined || e.y === undefined || e.r === undefined || blink) continue;
        const [sx, sy] = toScreen(e.x, e.y);
        const [ex] = toScreen(e.x + e.r, e.y);
        pulsingCircle(ctx, sx, sy, Math.abs(ex - sx), info.color, g.time);
        continue;
      }
      if (e.kind === 'derby' && e.zone && e.zone.length >= 6) {
        ctx.save();
        ctx.strokeStyle = info.color;
        ctx.lineWidth = full ? 2.5 : 1.5;
        ctx.globalAlpha = announcing ? 0.55 : 0.9;
        ctx.beginPath();
        for (let i = 0; i < e.zone.length; i += 2) {
          const [sx, sy] = toScreen(e.zone[i], e.zone[i + 1]);
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.restore();
      }
      if (e.kind === 'wanted') {
        if (e.holder === undefined) continue;
        const row = g.online?.roster.find((r) => r[0] === e.holder);
        if (!row) continue;
        const [sx, sy] = toScreen(row[2], row[3]);
        ctx.globalAlpha = announcing ? 0.5 : 1;
        mapMarker(ctx, sx, sy, size, info.icon, { ring: '#ff1744', pulse: g.time, label: info.label, full });
        ctx.globalAlpha = 1;
        continue;
      }
      // kofolka / armored / derby: a marker at the van (its mirror, when in range, for smoothness)
      if (e.x === undefined || e.y === undefined || blink) continue;
      let wx = e.x, wy = e.y;
      if (e.vid !== undefined) {
        const v = g.host.vehicleById(e.vid);
        if (v) (wx = v.x), (wy = v.y);
      }
      const [sx, sy] = toScreen(wx, wy);
      ctx.globalAlpha = announcing ? 0.5 : 1;
      mapMarker(ctx, sx, sy, size, info.icon, { label: info.label, full });
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------------------- world
  drawWorld(ctx: CanvasRenderingContext2D, v: View) {
    const g = this.g;
    const kof = g.host.live.events.find((e) => e.kind === 'kofolka' && e.phase === 'live');
    if (!kof || kof.x === undefined || kof.y === undefined) return;
    let wx = kof.x, wy = kof.y;
    if (kof.vid !== undefined) {
      const veh = g.host.vehicleById(kof.vid);
      if (veh) (wx = veh.x), (wy = veh.y);
    }
    if (wx < v.x0 - 5 || wx > v.x1 + 5 || wy < v.y0 - 5 || wy > v.y1 + 5) return;
    const bob = Math.sin(g.time * 3) * 0.15;
    ctx.save();
    ctx.translate(wx, wy - 2.6 + bob);
    ctx.scale(1 / v.scale, 1 / v.scale); // constant screen size regardless of zoom
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#2e7d32';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#a5d6a7';
    ctx.font = `700 13px 'Inter', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('€', 0, 1);
    ctx.restore();
  }

  // ------------------------------------------------------------------------- news
  onGlobal(e: GlobalEvent) {
    const g = this.g;
    switch (e.k) {
      case 'eventAnnounce': {
        const info = KIND_INFO[e.kind];
        g.banners.push({ title: info.label, text: `O ${e.secs}s ${placeName(g.world, e.x, e.y)}.`, color: info.color, icon: info.icon, priority: 2 });
        break;
      }
      case 'eventStart': {
        const info = KIND_INFO[e.kind];
        g.banners.push({ title: `${info.label}!`, text: `Práve teraz ${placeName(g.world, e.x, e.y)}.`, color: info.color, icon: info.icon, priority: 1 });
        break;
      }
      case 'holder': {
        const info = KIND_INFO[e.kind];
        const text = e.kind === 'kofolka' ? `Kofolku má ${e.nick}!` : `Má ju ${e.nick}!`;
        g.banners.push({ title: info.label, text, color: info.color, icon: info.icon, priority: 1 });
        break;
      }
      case 'eventEnd': {
        const info = KIND_INFO[e.kind];
        const { title, text } = endText(e, info.label, placeName(g.world, e.x, e.y));
        g.banners.push({ title, text, color: info.color, icon: info.icon, priority: 1 });
        break;
      }
      case 'mostWanted':
        g.banners.push({
          title: KIND_INFO.wanted.label, text: `${e.nick} má na hlave ${formatMoney(e.bounty)} ${placeName(g.world, e.x, e.y)}.`,
          color: KIND_INFO.wanted.color, icon: KIND_INFO.wanted.icon, priority: 1,
        });
        break;
      case 'mostWantedEnd':
        g.banners.push({ title: `${KIND_INFO.wanted.label}: koniec`, text: mostWantedEndText(e), color: KIND_INFO.wanted.color, icon: KIND_INFO.wanted.icon, priority: 1 });
        break;
      case 'derbyResult':
        g.banners.push({
          title: KIND_INFO.derby.label, text: `Vyhral(i) ${e.winners.join(', ')} ${e.place}.`, color: KIND_INFO.derby.color, icon: KIND_INFO.derby.icon, priority: 1,
        });
        break;
    }
  }

  onPrivate(e: PrivateEvent) {
    if (e.k === 'payout' && e.reason === 'kofolka') this.kofolkaFlash = 1;
  }
}

function endText(e: Extract<GlobalEvent, { k: 'eventEnd' }>, label: string, place: string): { title: string; text: string } {
  const amt = e.amount !== undefined ? formatMoney(e.amount) : '';
  switch (e.how) {
    case 'won':
      return { title: `${label}: hotovo!`, text: e.winner ? `${e.winner} vyhral ${amt} ${place}.` : `Niekto vyhral ${amt} ${place}.` };
    case 'wrecked':
      return { title: `${label}: rozbité!`, text: `Skončilo to na šrot ${place}.` };
    case 'robbed':
      return { title: `${label}: vykradnuté!`, text: e.winner ? `${e.winner} to vykradol ${place}.` : `Niekto to vykradol ${place}.` };
    case 'delivered':
      return { title: `${label}: doručené`, text: `Došlo to do cieľa ${place}.` };
    case 'expired':
      return { title: `${label}: koniec`, text: `Nikto to nestihol ${place}.` };
    case 'cancelled':
      return { title: `${label}: zrušené`, text: `Nezišlo sa dosť hráčov ${place}.` };
  }
}

function mostWantedEndText(e: Extract<GlobalEvent, { k: 'mostWantedEnd' }>): string {
  switch (e.how) {
    case 'taken':
      return e.by ? `${e.by} zložil ${e.nick} a zhrabol ${formatMoney(e.amount)}!` : `${e.nick} bol zložený.`;
    case 'busted':
      return `${e.nick} skončil v base.`;
    case 'escaped':
      return `${e.nick} ušiel s ${formatMoney(e.amount)}.`;
    case 'died':
      return `${e.nick} to neprežil.`;
    case 'left':
      return `${e.nick} zmizol zo servera, odmena prepadla.`;
  }
}
