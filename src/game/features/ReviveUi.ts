// Revive UI: the "come help him" prompt and progress ring over a downed player, the local player's
// own bleed-out HUD (vignette, countdown, give-up prompt), the Samaritan bonus banner, the "revived"
// toast, a pulsing map marker and a nametag '✚'. The mechanics themselves are the shared Revive rule
// (src/shared/sim/rules/Revive.ts), which the server runs; this feature only shows what it does.
// Plan: docs/plans/social-events.md ("Revive")
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { View } from '../../world/Renderer';
import type { Ped } from '../../shared/entities/Ped';
import type { GlobalEvent, PrivateEvent } from '../../shared/sim/events';
import { REVIVE_RANGE, REVIVE_TIME } from '../../shared/sim/rules/Revive';
import { ROSTER_DOWNED } from '../../shared/net/protocol';
import { dist, formatMoney } from '../../shared/util/math';
import { worldRing } from '../../ui/kit/HoldRing';
import { outlined, buttonGlyph } from '../../ui/Hud';
import { roundRect } from '../../render/shapes';
import { mapMarker } from '../../ui/MapView';
import { toast } from '../../ui/kit/dom';
import { addNametagDecorator } from '../../render/nametags';
import { KEYS } from '../Input';

/** downed players seen further than this away don't nudge you to come help */
const PROMPT_RANGE = 6;
/** a "so-and-so was revived" toast is only worth showing to bystanders this close */
const NEWS_RANGE = 80;

export class ReviveUi implements ClientFeature {
  readonly id = 'revive';
  /** this client's own guess at reviving the nearest downed player within range, corrected by the
   *  server's `live.revive` the moment it says otherwise (see `progressFor`) */
  private predictId = 0;
  private predictT = 0;

  constructor(private g: Game) {
    addNametagDecorator((_pid, tag) => (tag.flags & ROSTER_DOWNED ? { icons: ['✚'] } : null));
  }

  update(dt: number) {
    const g = this.g;
    const me = g.host.me;
    const onFoot = me.state === 'play' && !g.player.vehicle;
    const near = onFoot ? this.nearestDowned(REVIVE_RANGE) : null;
    if (near && near.playerId === this.predictId) this.predictT = Math.min(REVIVE_TIME, this.predictT + dt);
    else (this.predictId = near?.playerId ?? 0), (this.predictT = 0);
    if (!g.paused && !g.showMap && me.state === 'downed' && g.input.hit(KEYS.giveUp)) g.host.giveUp();
  }

  /** the nearest downed player's figure within `r` metres of the local player, or null */
  private nearestDowned(r: number): Ped | null {
    const f = this.g.focus();
    let best: Ped | null = null, bd = r;
    for (const p of this.g.host.peds) {
      if (!p.downed || !p.playerId) continue;
      const d = dist(p.x, p.y, f.x, f.y);
      if (d <= bd) (bd = d), (best = p);
    }
    return best;
  }

  /** 0..1 progress reviving `ped`: the server's word once it has spoken for this pair, else this
   *  client's own guess (it only ever guesses about the one downed player it's next to). */
  private progressFor(ped: Ped): number {
    const live = this.g.host.live.revive;
    if (live && live.other === ped.playerId && live.progress !== undefined) return live.progress;
    return this.predictId === ped.playerId ? this.predictT / REVIVE_TIME : 0;
  }

  drawWorld(ctx: CanvasRenderingContext2D, v: View) {
    const g = this.g;
    if (!g.host.net) return; // offline never downs a player
    const me = g.host.me;
    const f = g.focus();
    for (const p of g.host.peds) {
      if (!p.downed || !p.playerId) continue;
      const frac = this.progressFor(p);
      if (frac > 0) worldRing(ctx, p.x, p.y - 1.1, 0.85, frac, '#ff5252', v.scale);
      if (me.state !== 'play' || dist(p.x, p.y, f.x, f.y) > PROMPT_RANGE) continue;
      const fs = 12 / v.scale;
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      outlined(ctx, 'Pomôž mu vstať – postoj pri ňom', p.x, p.y - 1.7 - fs * 1.4, '#ff8a80', 3 / v.scale);
    }
  }

  drawHud(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    if (g.host.me.state !== 'downed') return;
    const W = g.viewW, H = g.viewH;
    const pulse = 0.5 + 0.5 * Math.sin(g.time * 2.2);
    const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    grad.addColorStop(0, 'rgba(140,0,0,0)');
    grad.addColorStop(1, `rgba(140,0,0,${0.5 + pulse * 0.18})`);
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    const small = g.layout.small;
    const secs = Math.max(0, Math.ceil(g.host.me.stateTimer));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${small ? 22 : 30}px 'Rajdhani', 'Arial Black', Impact, sans-serif`;
    outlined(ctx, `Krvácaš – ${secs} s`, W / 2, H * 0.22, '#ff5252', 4);
    // a touch screen has its own "Vzdať sa" button (TouchControls)
    if (!g.touch || g.input.pad.active) this.drawGiveUpPrompt(ctx, W, H, small);
  }

  private drawGiveUpPrompt(ctx: CanvasRenderingContext2D, W: number, H: number, small: boolean) {
    const label = 'Vzdať sa';
    ctx.save();
    ctx.font = `700 ${small ? 13 : 16}px 'Inter', system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const r = small ? 12 : 14;
    const tw = ctx.measureText(label).width;
    const w = tw + r * 2 + 22, h = small ? 28 : 34;
    const cx = W / 2, cy = H - (small ? 100 : 130);
    const x = cx - w / 2, y = cy - h / 2;
    ctx.fillStyle = 'rgba(10,12,18,0.72)';
    roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    buttonGlyph(ctx, 'G', x + 12 + r, cy, r, 'key');
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 24 + r * 2, cy + 1);
    ctx.restore();
  }

  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    const g = this.g;
    const roster = g.online?.roster;
    if (!roster) return;
    for (const r of roster) {
      if (r[0] === g.host.me.id || !(r[8] & ROSTER_DOWNED)) continue;
      const [x, y] = toScreen(r[2], r[3]);
      mapMarker(ctx, x, y, size, 'revive', { ring: '#ff5252', pulse: g.time, label: r[1], full });
    }
  }

  onPrivate(e: PrivateEvent) {
    if (e.k === 'payout' && e.reason === 'samaritan') {
      this.g.banners.push({ title: 'Dobrý samaritán!', text: `+${formatMoney(e.amount)}`, icon: 'revive', color: '#ff5252' });
    }
  }

  onGlobal(e: GlobalEvent) {
    if (e.k !== 'revived') return;
    const g = this.g;
    const myNick = g.online?.nick;
    if (myNick && e.who === myNick) g.message('', `${e.by} ťa postavil na nohy!`, 3, '#69f0ae');
    else if (myNick && e.by !== myNick && dist(e.x, e.y, g.focus().x, g.focus().y) < NEWS_RANGE) {
      toast(`${e.by} postavil na nohy hráča ${e.who}`, '#69f0ae');
    }
  }
}
