// "Kde to je?" HUD card (docs/plans/social-events.md): a thumbnail of today's photo under the
// minimap, K (KEYS.daily) blows it up, and the four GlobalEvents turn into a banner/toast/map marker.
// Purely a reader of SimHost.live.daily (server-fed online, always null offline: see LocalSimHost) —
// this feature draws nothing and does nothing while offline.
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { GlobalEvent } from '../../shared/sim/events';
import { placeName } from '../../shared/sim/rules/placeName';
import { ImageCard } from '../../ui/kit/ImageCard';
import { toast } from '../../ui/kit/dom';
import { mapMarker } from '../../ui/MapView';
import { KEYS } from '../Input';

const CARD_W = 150;
const CARD_H = 100;
/** how long the "Včerajšie miesto…" marker stays on the map after a dailyAnswer */
const ANSWER_MARKER_MS = 120_000;

export class DailyCard implements ClientFeature {
  readonly id = 'daily';
  private card = new ImageCard();
  private lastImg: string | null = null;
  private expanded = false;
  /** yesterday's revealed spot (dailyAnswer), shown on the map for ANSWER_MARKER_MS then dropped */
  private answer: { x: number; y: number; until: number } | null = null;

  constructor(private g: Game) {}

  update() {
    const live = this.g.host.live;
    if (live.daily && this.g.input.hit(KEYS.daily)) this.expanded = !this.expanded;
    if (this.answer && performance.now() > this.answer.until) this.answer = null;
  }

  drawHud(ctx: CanvasRenderingContext2D) {
    const live = this.g.host.live;
    const daily = live.daily;
    if (!daily) return;
    if (daily.img !== this.lastImg) {
      this.lastImg = daily.img;
      this.card.setImage(daily.img || null);
    }
    const subtitle = daily.solvedBy ? `Vyriešil ${daily.solvedBy} ✓` : daily.hints.length ? daily.hints.join(' · ') : 'Nájdi to miesto!';
    if (this.expanded) {
      this.card.drawLarge(ctx, this.g.viewW, this.g.viewH, 'Kde to je?', subtitle);
      return;
    }
    // stacked directly above the minimap (bottom-left corner): the minimap itself already touches
    // the bottom edge (Hud.ts: cy = H - pad - mr), so there is no room to put this card under it on
    // screen — "under" here means the next item in that corner's stack, not further down the page
    const small = this.g.viewW < 700;
    const pad = small ? 10 : 16;
    const mr = small ? 60 : 88;
    const x = pad, y = this.g.viewH - pad - mr * 2 - 8 - CARD_H;
    this.card.draw(ctx, x, y, CARD_W, CARD_H, 'Kde to je?', subtitle);
  }

  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    if (!this.answer) return;
    const [x, y] = toScreen(this.answer.x, this.answer.y);
    mapMarker(ctx, x, y, size, 'daily', { label: 'Včerajšie miesto', full });
  }

  onGlobal(e: GlobalEvent) {
    switch (e.k) {
      case 'dailyReveal':
        this.g.banners.push({ title: 'KDE TO JE?', text: 'Nová fotka mesta – nájdi to miesto a postav sa naň!', icon: 'daily' });
        break;
      case 'dailyHint':
        toast('Nápoveda: ' + e.text);
        break;
      case 'dailySolved':
        this.g.banners.push({ title: `${e.nick} našiel dnešné miesto!`, icon: 'daily' });
        break;
      case 'dailyAnswer':
        this.answer = { x: e.x, y: e.y, until: performance.now() + ANSWER_MARKER_MS };
        this.g.banners.push({ title: 'Včerajšie miesto bolo ' + placeName(this.g.world, e.x, e.y), icon: 'daily' });
        break;
    }
  }

  reset() {
    this.expanded = false;
    this.answer = null;
    this.lastImg = null;
    this.card = new ImageCard();
  }
}
