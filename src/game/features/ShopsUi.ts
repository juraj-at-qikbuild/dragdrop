// The shops on screen (docs/plans/gameplay.md, Phase 2): where they are (a ring and a sign in the
// street, a badge on the minimap and the city map) and each one's panel. The panel opens on walking in
// (or on stopping a car in a workshop or at a garage door), once per visit, and closes on leaving.
// What it offers and for how much comes from the price list (LiveState.catalog: the rule's offline,
// the server's `catalog` online; a server without shops sends none, and then there are none). Every
// purchase is a request the shared rule checks (SimHost.shop → rules/Shops.ts), and its answer shows
// at the bottom of the panel (LiveState.shop).
import type { Game } from '../Game';
import type { ClientFeature, ToScreen } from './ClientFeature';
import type { View } from '../../world/Renderer';
import type { PrivateEvent } from '../../shared/sim/events';
import { PLAYER_SHIRTS } from '../../shared/entities/Ped';
import { SPECS, type Vehicle } from '../../shared/entities/Vehicle';
import {
  COLLECTION, COLLECTION_REWARD, HATS, MOD_MAX, NEONS, PAINTS, SLOTS_MAX, SLOTS_START, type PriceId, type Prices, type ShopKind,
} from '../../shared/sim/shops/catalog';
import { shopAt, shopPlaces, type ShopPlace } from '../../shared/sim/shops/places';
import { ownable, type ShopReq } from '../../shared/sim/rules/Shops';
import { POINTS } from '../../shared/sim/rules/points';
import { dist, formatMoney } from '../../shared/util/math';
import { mapMarker, type MapIcon } from '../../ui/MapView';
import { outlined } from '../../ui/Hud';
import { isModalOpen, openModal } from '../../ui/kit/dom';
import {
  GUN_NAME, HAT_NAMES, JACKET_NAMES, MOD_INFO, MOD_KEYS, NEON_NAMES, SHOP_KIND, collectionLine, condition, gunLine, modName, modsLine,
  paintName, placesWord, storedCarLine,
} from './shops/text';

const BODY = `'Inter', system-ui, sans-serif`;
const ICON: Record<ShopKind, MapIcon> = { guns: 'guns', clothes: 'clothes', lawyer: 'lawyer', tuning: 'tuning', garage: 'garage' };
const COLOR: Record<ShopKind, string> = { guns: '#ff7043', clothes: '#f06292', lawyer: '#bcaaa4', tuning: '#4fc3f7', garage: '#aed581' };
/** a shop's answer stays at the bottom of the panel this long (ms) */
const STATUS_MS = 5000;
/** the panel opens for someone this slow (m/s): a car pulled up, a player stopped at the door */
const STOPPED = 1;
/** leaving takes this much more than arriving (m), so the edge of a door doesn't open it again */
const LEAVE_SLACK = 2;
/** the name over a shop's sign shows within this (m) */
const NAME_R = 30;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class ShopsUi implements ClientFeature {
  readonly id = 'shops';
  private panel: { close(): void; el: HTMLElement } | null = null;
  private body: HTMLElement | null = null;
  private place: ShopPlace | null = null;
  /** the shop whose panel already opened this visit, on foot and in a car ('id|car', 'id|foot'): one
   *  that closed opens again only on leaving and coming back, or coming back the other way (walked up
   *  to the garage, then drove a car to its door) */
  private visited = new Set<string>();
  private visitedAt: string | null = null;
  /** the car the player was in last frame, and the shop they got into it at, if they did: its panel
   *  waits until that car has moved (see update) */
  private lastCar: Vehicle | null = null;
  private gotInAt: string | null = null;
  /** what the panel was last built from (it's rebuilt only when that changes) */
  private shape = '';
  /** the last request sent (a car taken out of the garage closes the panel: time to drive) */
  private asked: ShopReq['op'] | null = null;

  constructor(private g: Game) {}

  /** every shop in the city (for the e2e checks, which drive the page from outside) */
  get places(): readonly ShopPlace[] {
    return shopPlaces(this.g.world);
  }

  // --------------------------------------------------------------------------------------- update
  update() {
    const g = this.g;
    const live = g.host.live;
    if (!live.catalog || g.state !== 'play') {
      this.panel?.close();
      return;
    }
    const p = g.player;
    const v = p.vehicle;
    const gotIn = !!v && v !== this.lastCar;
    this.lastCar = v;
    const f = g.focus();
    // (no shop serves anyone on a scooter or a bike, or aboard a tram: Shops.placeOf)
    const zone = v?.spec.twoWheeler || g.host.live.tram ? null : shopAt(g.world, f.x, f.y, !!v, LEAVE_SLACK);
    if (this.panel) {
      if (!zone || zone.id !== this.place?.id) this.panel.close();
      else {
        // (on foot now, having parked in the garage: this visit counts for that too)
        this.visited.add(`${zone.id}|${v ? 'car' : 'foot'}`);
        if (this.shapeKey() !== this.shape) this.render();
      }
      return;
    }
    if (zone?.id !== this.visitedAt) {
      this.visited.clear();
      this.visitedAt = zone?.id ?? null;
      this.gotInAt = null;
    }
    // getting into a car parked at a shop's door isn't pulling up there (its panel would take the
    // controls from someone who only wanted the car): it waits until the car has moved, and then
    // stopping at the door is
    if (gotIn && zone) {
      this.visited.add(`${zone.id}|car`);
      this.gotInAt = zone.id;
    } else if (this.gotInAt && (!v || v.speed > STOPPED)) {
      if (v) this.visited.delete(`${this.gotInAt}|car`);
      this.gotInAt = null;
    }
    // it opens for someone who stops there: a car pulled up, a player at the door (not one running past)
    if (!zone || (v ? v.speed > STOPPED : Math.hypot(p.vx, p.vy) > STOPPED) || this.visited.has(`${zone.id}|${v ? 'car' : 'foot'}`)) return;
    const here = shopAt(g.world, f.x, f.y, !!v);
    if (!here || g.paused || g.showMap || isModalOpen()) return;
    this.visited.add(`${here.id}|${v ? 'car' : 'foot'}`);
    this.open(here);
  }

  onPrivate(e: PrivateEvent) {
    // a car out of the garage waits at the door: the panel makes way (and doesn't open again the
    // moment they're in it)
    if (e.k === 'shop' && e.ok && this.asked === 'take') {
      if (this.place) this.visited.add(`${this.place.id}|car`);
      this.panel?.close();
    }
    if (e.k === 'shop') this.asked = null;
  }

  reset() {
    this.panel?.close();
    this.visited.clear();
    this.visitedAt = null;
    this.lastCar = null;
    this.gotInAt = null;
  }

  private ask(req: ShopReq) {
    this.asked = req.op;
    this.g.host.shop(req);
  }

  // ---------------------------------------------------------------------------------------- panel
  private open(place: ShopPlace) {
    const g = this.g;
    // a key held down as the panel opened would never see its keyup (the modal keeps keys to itself)
    g.input.keys.clear();
    g.input.mouseDown = false;
    g.input.resetTouch();
    this.place = place;
    this.body = el('div', 'kit-shop');
    this.panel = openModal({
      title: place.name,
      body: this.body,
      buttons: [{ label: 'Odísť', primary: true, onClick: () => {} }],
      onClose: () => {
        this.panel = null;
        this.body = null;
        this.place = null;
        this.shape = '';
      },
    });
    const card = this.panel.el.querySelector<HTMLElement>('.menu-card');
    card?.classList.add('kit-shop-card');
    const x = el('button', 'kit-act-x', '✕');
    x.type = 'button';
    x.title = 'Odísť';
    x.onclick = () => this.panel?.close();
    card?.prepend(x);
    this.render();
    // start at the top, on the first thing to buy (the modal would focus its bottom button)
    setTimeout(() => {
      this.body?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
      if (card) card.scrollTop = 0;
    }, 0);
  }

  /** everything the panel shows, so it's rebuilt only when something in it changed */
  private shapeKey(): string {
    const g = this.g;
    const live = g.host.live;
    const v = g.player.vehicle;
    const shop = live.shop && performance.now() - live.shop.at < STATUS_MS ? live.shop.at : 0;
    const car = v ? [v.id, v.color, v.mods, Math.round(v.health), ownable(v)] : 0;
    return JSON.stringify([
      this.place?.id, Math.round(g.save.money), g.save.gear ?? {}, g.ammo.pistol, g.ammo.uzi, g.ammo.shotgun, Math.round(g.player.armor), g.player.look, g.player.hat, car, live.catalog, shop,
    ]);
  }

  private render() {
    const body = this.body, place = this.place;
    const prices = this.g.host.live.catalog;
    if (!body || !place || !prices) return;
    this.shape = this.shapeKey();
    // the pad's (or the keyboard's) place in the panel survives the rebuild
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement.dataset.k : undefined;
    const g = this.g;
    const parts: HTMLElement[] = [el('p', 'kit-shop-about', SHOP_KIND[place.kind].about), el('p', 'kit-shop-money', `Máš ${formatMoney(g.save.money)}`)];
    switch (place.kind) {
      case 'guns':
        parts.push(this.guns(prices));
        break;
      case 'clothes':
        parts.push(...this.clothes(prices));
        break;
      case 'lawyer':
        parts.push(this.lawyer(prices));
        break;
      case 'tuning':
        parts.push(...this.tuning(prices, g.player.vehicle));
        break;
      case 'garage':
        parts.push(...this.garage(prices, place, g.player.vehicle));
        break;
    }
    parts.push(this.status());
    body.replaceChildren(...parts);
    // the same control as before the rebuild, or (when it's gone: the garage just bought) the first one
    if (focused) (body.querySelector<HTMLElement>(`[data-k="${focused}"]`) ?? body.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------------------------ building blocks
  /** a line of the panel: what it is, a word about it, and the button that buys it (or a note why not) */
  private row(o: { k: string; name: string; about?: string; price?: number; label?: string; req?: ShopReq; note?: string; swatch?: string }): HTMLElement {
    const row = el('div', 'kit-shop-row');
    const text = el('div', 'kit-shop-text');
    const name = el('div', 'name', o.name);
    if (o.swatch) {
      const dot = el('span', 'kit-shop-dot');
      dot.style.background = o.swatch;
      name.prepend(dot);
    }
    text.appendChild(name);
    if (o.about) text.appendChild(el('div', 'about', o.about));
    row.appendChild(text);
    if (o.req) {
      const req = o.req;
      const poor = o.price !== undefined && o.price > this.g.save.money;
      const b = el('button', poor ? 'poor' : 'primary', o.label ?? (o.price !== undefined ? formatMoney(o.price) : 'OK'));
      b.type = 'button';
      b.dataset.k = o.k;
      b.onclick = () => this.ask(req);
      row.appendChild(b);
    } else if (o.note) row.appendChild(el('span', 'kit-shop-note', o.note));
    return row;
  }

  /** a heading with the price that goes for everything under it */
  private head(text: string, price?: string): HTMLElement {
    const h = el('h3', undefined, text);
    if (price) h.appendChild(el('span', 'price', price));
    return h;
  }

  /** a row of colour swatches: `on` is the one there now (it can't be bought again) */
  private swatches(k: string, colors: readonly string[], names: readonly string[], on: number, req: (i: number) => ShopReq, noneFirst = false): HTMLElement {
    const wrap = el('div', 'kit-shop-swatches');
    colors.forEach((c, i) => {
      const b = el('button', `kit-swatch${i === on ? ' on' : ''}${noneFirst && i === 0 ? ' none' : ''}`);
      b.type = 'button';
      b.dataset.k = `${k}:${i}`;
      if (!(noneFirst && i === 0)) b.style.background = c;
      b.title = names[i] ?? '';
      b.setAttribute('aria-label', names[i] ?? '');
      if (i === on) b.setAttribute('aria-pressed', 'true');
      b.onclick = () => i !== on && this.ask(req(i));
      wrap.appendChild(b);
    });
    return wrap;
  }

  private note(text: string): HTMLElement {
    return el('p', 'hint kit-shop-hint', text);
  }

  private list(...rows: HTMLElement[]): HTMLElement {
    const l = el('div', 'kit-shop-list');
    l.append(...rows);
    return l;
  }

  private status(): HTMLElement {
    const s = this.g.host.live.shop;
    const fresh = s && performance.now() - s.at < STATUS_MS;
    const p = el('p', `kit-shop-status${fresh ? (s.ok ? ' ok' : ' bad') : ''}`, fresh ? s.text : ' ');
    p.setAttribute('role', 'status');
    return p;
  }

  // ------------------------------------------------------------------------------ Poľovnícke potreby
  private guns(prices: Prices): HTMLElement {
    const g = this.g;
    const list = el('div', 'kit-shop-list');
    for (const w of ['pistol', 'uzi', 'shotgun'] as const) {
      const have = g.ammo[w];
      const about = have > 0 ? `Máš ${have} ${have === 1 ? 'náboj' : have <= 4 ? 'náboje' : 'nábojov'}.` : `${GUN_NAME[w]} zatiaľ nemáš.`;
      list.appendChild(have >= 999 ? this.row({ k: w, name: gunLine(w), about, note: 'Viac neunesieš' }) : this.row({ k: w, name: gunLine(w), about, price: prices[w], req: { op: 'buy', item: w } }));
    }
    const vest = { k: 'vest', name: 'Nepriestrelná vesta', about: 'Zachytí 100 bodov zásahov.' };
    list.appendChild(g.player.armor >= 100 ? this.row({ ...vest, note: 'Máš ju na sebe' }) : this.row({ ...vest, price: prices.vest, req: { op: 'buy', item: 'vest' } }));
    return list;
  }

  // ------------------------------------------------------------------------------------------ Butik
  private clothes(prices: Prices): HTMLElement[] {
    const p = this.g.player;
    return [
      this.head('Bunda', formatMoney(prices.jacket)),
      this.swatches('jacket', PLAYER_SHIRTS, JACKET_NAMES, p.look, (i) => ({ op: 'buy', item: `jacket:${i}` })),
      this.head('Na hlavu', `${formatMoney(prices.hat)} · dať dole zadarmo`),
      this.hats(p.hat),
    ];
  }

  private hats(on: number): HTMLElement {
    const wrap = el('div', 'kit-shop-chips');
    HATS.forEach((_, i) => {
      const b = el('button', `kit-chip${i === on ? ' on' : ''}`, HAT_NAMES[i]);
      b.type = 'button';
      b.dataset.k = `hat:${i}`;
      if (i === on) b.setAttribute('aria-pressed', 'true');
      b.onclick = () => i !== on && this.ask({ op: 'buy', item: `hat:${i}` });
      wrap.appendChild(b);
    });
    return wrap;
  }

  // ---------------------------------------------------------------------------------------- Advokát
  private lawyer(prices: Prices): HTMLElement {
    return this.list(
      this.g.save.gear?.lawyer
        ? this.row({ k: 'lawyer', name: 'JUDr. Paragraf ťa zastupuje', about: 'Platí na najbližšie zatknutie.', note: 'Najatý' })
        : this.row({ k: 'lawyer', name: 'Najať advokáta', about: 'Na najbližšie zatknutie: zbrane ti ostanú a pokutu zaplatíš polovičnú.', price: prices.lawyer, req: { op: 'buy', item: 'lawyer' } }),
    );
  }

  // ----------------------------------------------------------------------------------------- Dielňa
  private tuning(prices: Prices, v: Vehicle | null): HTMLElement[] {
    if (!v) return [this.note('Do dielne sa chodí autom.')];
    if (!ownable(v)) return [this.note('Toto auto tu neupravia: policajné auto ani auto z udalosti či zákazky dielňa neberie.')];
    const list = el('div', 'kit-shop-list');
    for (const key of MOD_KEYS) {
      const tier = v.mods[key];
      const next = tier + 1;
      const now = tier > 0 ? `Teraz: ${modName(key, tier)}. ` : '';
      if (next > MOD_MAX[key]) list.appendChild(this.row({ k: key, name: modName(key, tier), about: MOD_INFO[key].about, note: 'Najlepšie, čo je' }));
      else {
        const id = `${key}${next}` as PriceId;
        list.appendChild(this.row({ k: key, name: modName(key, next), about: `${now}${MOD_INFO[key].about}`, price: prices[id], req: { op: 'buy', item: key } }));
      }
    }
    return [
      this.head(`Lak a oprava · auto na ${condition(v.kind, v.health)} %`, formatMoney(prices.respray)),
      this.swatches('respray', PAINTS, PAINTS.map(paintName), PAINTS.indexOf(v.color as (typeof PAINTS)[number]), (i) => ({ op: 'buy', item: `respray:${i}` })),
      this.head('Úpravy'),
      list,
      this.head('Neón pod autom', `${formatMoney(prices.glow)} · dať dole zadarmo`),
      this.swatches('glow', NEONS, NEON_NAMES, v.mods.glow, (i) => ({ op: 'buy', item: `glow:${i}` }), true),
    ];
  }

  // ------------------------------------------------------------------------------------------ Garáž
  private garage(prices: Prices, place: ShopPlace, v: Vehicle | null): HTMLElement[] {
    const g = this.g;
    const gear = g.save.gear ?? {};
    const out: HTMLElement[] = [];
    if (!gear.garages?.includes(place.id)) {
      const others = gear.garages?.length ?? 0;
      const about = others ? `Máš ${others === 1 ? 'jednu garáž' : `${others} garáže`}: autá z nich budeš mať aj tu.` : `Začneš s ${placesWord(SLOTS_START)} pre autá.`;
      out.push(this.list(this.row({ k: 'garage', name: 'Kúpiť túto garáž', about, price: prices.garage, req: { op: 'buy', item: 'garage' } })));
    } else {
      const slots = gear.slots ?? SLOTS_START;
      const cars = gear.cars ?? [];
      out.push(this.head(`Tvoje autá · ${cars.length}/${slots}`));
      const list = el('div', 'kit-shop-list');
      cars.forEach((c, i) =>
        list.appendChild(
          v
            ? this.row({ k: `car:${i}`, name: storedCarLine(c), swatch: c.color, note: 'Najprv vystúp' })
            : this.row({ k: `car:${i}`, name: storedCarLine(c), swatch: c.color, label: 'Vybrať', req: { op: 'take', slot: i } }),
        ),
      );
      if (!cars.length) list.appendChild(this.note('Zatiaľ tu nemáš žiadne auto. Prídi autom a zaparkuj ho tu.'));
      if (v) {
        const name = `${SPECS[v.kind].name} · ${modsLine(v.mods)}`;
        if (!ownable(v)) list.appendChild(this.row({ k: 'store', name: 'Toto auto si tu nenecháš', about: 'Policajné auto ani auto z udalosti či zákazky garáž neberie.' }));
        else if (cars.length >= slots) list.appendChild(this.row({ k: 'store', name, about: 'Garáž je plná.', note: 'Plno' }));
        else list.appendChild(this.row({ k: 'store', name, about: 'Auto, v ktorom sedíš.', label: 'Zaparkovať', req: { op: 'store' } }));
      }
      out.push(list);
      out.push(
        this.list(
          slots >= SLOTS_MAX
            ? this.row({ k: 'slots', name: `${placesWord(slots)} pre autá`, note: 'Viac sa nedá' })
            : this.row({ k: 'slots', name: `Viac miesta: ${placesWord(slots + 2)}`, about: 'Pre všetky tvoje garáže naraz.', price: prices[slots < 4 ? 'slots4' : 'slots6'], req: { op: 'buy', item: 'slots' } }),
        ),
      );
    }
    out.push(...this.collection());
    return out;
  }

  /** the collection: every kind of vehicle driven, ticked off */
  private collection(): HTMLElement[] {
    const gear = this.g.save.gear ?? {};
    const seen = new Set(gear.seen ?? []);
    const chips = el('div', 'kit-shop-chips');
    for (const k of COLLECTION) chips.appendChild(el('span', `kit-chip static${seen.has(k) ? ' on' : ''}`, `${seen.has(k) ? '✓ ' : ''}${SPECS[k].name}`));
    const reward = gear.seenAll
      ? 'Kompletná. Jazdil si na všetkom, čo po meste jazdí.'
      : `Za všetkých ${COLLECTION.length}: ${formatMoney(COLLECTION_REWARD)}${this.g.online ? ` a ${POINTS.collection} bodov do rebríčka` : ''}.`;
    return [this.head(collectionLine(gear.seen)), chips, this.note(reward)];
  }

  // ------------------------------------------------------------------------------------- the street
  /** each shop's door: a ring on the ground (walk into it, or stop a car in it) and a sign over it */
  drawWorld(ctx: CanvasRenderingContext2D, v: View) {
    const g = this.g;
    if (!g.host.live.catalog) return;
    const f = g.focus();
    const k = 1 / g.cam.scale;
    const owned = g.save.gear?.garages;
    for (const s of shopPlaces(g.world)) {
      if (s.x < v.x0 - 30 || s.x > v.x1 + 30 || s.y < v.y0 - 30 || s.y > v.y1 + 30) continue;
      const color = COLOR[s.kind];
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.1;
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([1.2, 0.9]);
      ctx.lineWidth = Math.max(0.12, 1.5 * k);
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
      // the sign, the same size on screen whatever the zoom, bobbing a little
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.scale(k, k);
      const bob = Math.sin(g.time * 2.4 + s.x * 0.1) * 2;
      mapMarker(ctx, 0, -16 + bob, 11, ICON[s.kind], { ring: s.kind === 'garage' && owned?.includes(s.id) ? '#c5e1a5' : undefined });
      if (dist(f.x, f.y, s.x, s.y) < NAME_R) {
        ctx.font = `700 12px ${BODY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        outlined(ctx, s.name, 0, -31 + bob, '#fff', 3);
      }
      ctx.restore();
    }
  }

  // ---------------------------------------------------------------------------------------- the map
  /** a badge for every shop but the workshops (the fuel stations' own badges mark those); an owned
   *  garage ringed */
  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    const g = this.g;
    if (!g.host.live.catalog) return;
    const f = g.focus();
    // the minimap pins far points to its rim: work its scale out from two points near the player, and
    // leave out whatever doesn't fit it (it's off the minimap)
    const [ox, oy] = toScreen(f.x, f.y);
    const k = (toScreen(f.x + 20, f.y)[0] - ox) / 20;
    const owned = g.save.gear?.garages;
    for (const s of shopPlaces(g.world)) {
      if (s.kind === 'tuning') continue;
      const [sx, sy] = toScreen(s.x, s.y);
      if (!full && (!(k > 0) || Math.abs(sx - (ox + (s.x - f.x) * k)) > 1 || Math.abs(sy - (oy + (s.y - f.y) * k)) > 1)) continue;
      mapMarker(ctx, sx, sy, size * (full ? 0.95 : 0.8), ICON[s.kind], { ring: s.kind === 'garage' && owned?.includes(s.id) ? '#c5e1a5' : undefined });
    }
  }
}
