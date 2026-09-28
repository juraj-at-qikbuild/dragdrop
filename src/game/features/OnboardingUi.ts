// The introduction a newcomer gets on their first start: four short cards over the city before they
// set off. First the basics, then the world events (what's on now, with a way to set the GPS there, or
// when the next one may come), then everything else there is to do, with the way to the Aktivity panel
// that lists all of it from then on, and last what money buys: the shops, the garages, the lawyer (in
// a game without shops, a server from before them, that card is left out). It opens by itself once per device for online play and once for
// offline play, for a player with nothing to show yet (online the server's profile decides, so an
// account on a new device skips it). "📖 Úvod do hry" in the pause menu brings it back. While it's
// open the game is paused (online: away, and shielded once that's safe), like the leaderboard. Later,
// the first time a world event is on while the player still hasn't opened the Aktivity panel, a
// one-line tip says how to find out about it. The words are in onboarding/text.ts.
import type { Game } from '../Game';
import type { Prices } from '../../shared/sim/shops/catalog';
import { KEYS } from '../Input';
import { eventLeft } from '../SimHost';
import { NetSimHost } from '../../net/NetSimHost';
import { addPauseControl, isModalOpen, openModal, toast } from '../../ui/kit/dom';
import type { ClientFeature } from './ClientFeature';
import type { ActivitiesUi } from './ActivitiesUi';
import { SHOP_COLOR } from './ShopsUi';
import { liveForecast } from './activities/forecast';
import { activitiesSeen } from './activities/seen';
import { EVENT_COLOR, EVENT_LABEL, morePlayersLine } from './activities/text';
import {
  EVENTS_TITLE, EVENT_HOOK, MONEY_NOTE, MONEY_TITLE, NAV, OFFLINE_MORE, POLICE_NOTE, THINGS_LEAD, THINGS_TITLE, aktivityHint, autoIntro, basics, comingLine, eventEmoji, eventKinds, eventTip,
  eventsLead, introParam, looksNew, moneyLead, onNowLine, onlineOnlyLine, shopsHint, spending, things, welcomeLead, welcomeTitle, type InputKind, type Parts,
} from './onboarding/text';
import { introDone, markIntro } from './onboarding/seen';

/** online, how long to wait for the server's profile after the welcome before deciding without it (ms) */
const PROFILE_WAIT_MS = 3000;

/** How main.ts greets a player as they come into the city: the message, and whether this may be a
 *  newcomer's first start (not back where they left off, nor on a device that has played online). */
export interface Welcome {
  title: string;
  text: string;
  secs: number;
  newcomer: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void, cls?: string): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

/** a key as the player's input shows it: a key cap, or the pad's button (the face buttons in their
 *  colours, as the HUD draws them) */
function keyCap(label: string, input: InputKind): HTMLElement {
  const k = el('kbd', input === 'pad' ? 'kit-key pad' : 'kit-key', label);
  if (input === 'pad' && 'ABXY'.includes(label) && label.length === 1) k.dataset.face = label;
  return k;
}

export class OnboardingUi implements ClientFeature {
  readonly id = 'onboarding';
  private panel: { close(): void; el: HTMLElement } | null = null;
  private body: HTMLElement | null = null;
  private step = 0;
  /** a newcomer's greeting, waiting for the first calm moment; `fresh`: whether they had nothing to
   *  show as they came in (null: online, until the server's profile comes) */
  private pending: { w: Welcome; at: number; fresh: boolean | null } | null = null;
  /** the greeting's message, shown once the introduction closes */
  private after: Welcome | null = null;
  /** the pause this panel opened itself, to close again with it */
  private pausedByUs = false;
  /** the input the card on show names its keys for; a timer redraws it when the player switches
   *  (the pad counts once it's used; offline, features don't update while paused) */
  private shownInput: InputKind = 'key';
  private watch = 0;

  constructor(private g: Game) {
    addPauseControl(
      button(NAV.again, () => {
        markIntro(g.online ? 'online' : 'offline');
        this.open();
      }),
    );
  }

  /** main.ts, as the player comes into the city: a newcomer may get the introduction first (decided
   *  in update(), once the profile is in), anyone else just the greeting */
  greet(w: Welcome) {
    const g = this.g;
    if (!w.newcomer) return g.message(w.title, w.text, w.secs);
    // offline the save says it now, before the first step finds a landmark next to the spawn place
    // (and pays for it); online the server's profile comes just after the welcome
    this.pending = { w, at: performance.now(), fresh: g.host instanceof NetSimHost ? null : looksNew(g.save) };
  }

  update() {
    if (this.panel) return;
    if (this.pending) this.decide();
    else this.tip();
  }

  reset() {
    this.pending = null;
    this.after = null;
    this.panel?.close();
  }

  private get input(): InputKind {
    return this.g.input.pad.active ? 'pad' : this.g.touch ? 'touch' : 'key';
  }

  /** the introduction, or just the greeting: once the profile is in and nothing else is open */
  private decide() {
    const g = this.g;
    const p = this.pending!;
    if (p.fresh === null) {
      // online: the profile as it came, an account's progress from its other devices included
      const first = g.host instanceof NetSimHost ? g.host.firstProfile : null;
      if (!first && performance.now() - p.at < PROFILE_WAIT_MS) return;
      p.fresh = looksNew(first ?? g.save);
    }
    // not over the pause menu, another panel or the map: it waits for them to close
    if (g.paused || g.showMap || isModalOpen() || g.state !== 'play') return;
    this.pending = null;
    const { w } = p;
    const mode = g.online ? 'online' : 'offline';
    const show = autoIntro({ param: introParam(location.search), automated: navigator.webdriver === true, seen: introDone(mode), fresh: p.fresh });
    if (!show) return g.message(w.title, w.text, w.secs);
    markIntro(mode);
    this.open(w);
  }

  /** the first world event on, for a player who hasn't found the Aktivity panel yet: how to */
  private tip() {
    const g = this.g;
    if (!g.host.live.events.length || introDone('event') || activitiesSeen()) return;
    if (g.paused || g.showMap || isModalOpen() || g.state !== 'play') return;
    markIntro('event');
    g.message('', eventTip(this.input), 7);
  }

  // -------------------------------------------------------------------------------------- panel
  /** Open at the first card. `after`: the greeting to show once it closes (a newcomer's first start,
   *  where the last button says "Hrať!"); without it, it was asked for from the pause menu. */
  open(after: Welcome | null = null) {
    const g = this.g;
    if (this.panel) return;
    this.after = after;
    this.step = 0;
    this.pausedByUs = !g.paused;
    if (this.pausedByUs) g.setPaused(true);
    // a key held down as it opened would never see its keyup (the modal keeps keys to itself)
    g.input.keys.clear();
    g.input.mouseDown = false;
    g.input.resetTouch();
    const body = el('div', 'kit-intro');
    this.body = body;
    // the pause menu under it would only peek out around it
    const pauseMenu = document.getElementById('pause');
    pauseMenu?.classList.add('hidden');
    this.panel = openModal({
      title: '',
      body,
      buttons: [],
      onClose: () => {
        this.panel = null;
        this.body = null;
        clearInterval(this.watch);
        if (this.pausedByUs && g.paused) g.setPaused(false);
        this.pausedByUs = false;
        // opened from the pause menu: back to it
        if (g.paused) pauseMenu?.classList.remove('hidden');
        const w = this.after;
        this.after = null;
        // what to do first, now that they know the rest (the greeting's title was the first card's)
        if (w) g.message('', w.text, w.secs);
      },
    });
    const card = this.panel.el.querySelector('.menu-card');
    card?.classList.add('kit-intro-card');
    const x = button('✕', () => this.panel?.close(), 'kit-intro-x');
    x.title = NAV.close;
    x.setAttribute('aria-label', NAV.close);
    card?.prepend(x);
    // ← and → page through the cards; U goes straight to the Aktivity panel
    this.panel.el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') this.go(this.step + 1);
      else if (e.key === 'ArrowLeft') this.go(this.step - 1);
      else if (e.code === KEYS.activities) this.toActivities();
    });
    this.render();
    this.watch = window.setInterval(() => this.input !== this.shownInput && this.render(), 400);
  }

  /** the cards: the basics, the world events, everything else, and what money buys where there are shops */
  private get cards() {
    const all = [() => this.basicsCard(), () => this.eventsCard(), () => this.thingsCard()];
    const prices = this.g.host.live.catalog;
    if (prices) all.push(() => this.moneyCard(prices));
    return all;
  }

  private go(step: number) {
    if (step < 0 || step >= this.cards.length || step === this.step || !this.panel) return;
    this.step = step;
    this.render();
  }

  private render() {
    const body = this.body, panel = this.panel;
    if (!body || !panel) return;
    this.shownInput = this.input;
    const cards = this.cards;
    // (a price list that went away leaves the last card there is)
    this.step = Math.min(this.step, cards.length - 1);
    const { title, els } = cards[this.step]();
    const h2 = panel.el.querySelector('h2');
    if (h2) h2.textContent = title;
    body.replaceChildren(...els, this.footer());
    // the way on has the focus (Enter, or the pad's A), and a phone that scrolls a card starts at its top
    body.querySelector<HTMLElement>('.kit-intro-foot button.primary')?.focus({ preventScroll: true });
    const card = panel.el.querySelector('.menu-card');
    if (card) card.scrollTop = 0;
  }

  private footer(): HTMLElement {
    const n = this.cards.length;
    const last = this.step === n - 1;
    const foot = el('div', 'kit-intro-foot');
    const back = this.step === 0 ? button(NAV.skip, () => this.panel?.close(), 'kit-intro-skip') : button(NAV.back, () => this.go(this.step - 1));
    const dots = el('span', 'kit-intro-dots');
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < n; i++) dots.appendChild(el('i', i === this.step ? 'on' : undefined));
    const on = button(last ? (this.after ? NAV.play : NAV.done) : NAV.next, () => (last ? this.panel?.close() : this.go(this.step + 1)), 'primary');
    foot.append(back, dots, on);
    return foot;
  }

  // -------------------------------------------------------------------------------------- cards
  /** the first card: where they are, and the four controls to know */
  private basicsCard() {
    const online = !!this.g.online;
    const input = this.input;
    const list = el('ul', 'kit-intro-keys');
    for (const r of basics(input)) {
      const cap = el('span', 'cap');
      if (input === 'touch') cap.textContent = r.cap;
      else cap.appendChild(keyCap(r.cap, input));
      const li = el('li');
      li.append(cap, el('span', undefined, r.text));
      list.appendChild(li);
    }
    return { title: welcomeTitle(online), els: [el('p', 'kit-intro-lead', welcomeLead(online)), list, el('p', 'kit-intro-note', POLICE_NOTE)] };
  }

  /** the second: the world events there are, and what's on now or coming */
  private eventsCard() {
    const g = this.g;
    const live = g.host.live;
    const online = !!g.online;
    // (online the game is paused under this card, and the server doesn't count an away player: count
    // them back in, as the Aktivity panel does)
    const f = liveForecast(live, online && g.paused);
    const kinds = eventKinds(f);
    const grid = this.grid(kinds.here.map((kind) => this.item(eventEmoji(kind), null, EVENT_LABEL[kind], EVENT_HOOK[kind], EVENT_COLOR[kind])));
    const els: HTMLElement[] = [el('p', 'kit-intro-lead', eventsLead(online)), grid];
    const more = onlineOnlyLine(kinds.onlineOnly);
    if (more) els.push(el('p', 'hint small kit-intro-more', more));
    for (const e of live.events) {
      const now = el('div', 'kit-intro-now');
      now.style.setProperty('--c', EVENT_COLOR[e.kind]);
      now.appendChild(el('span', undefined, onNowLine(e, eventLeft(live, e))));
      if (e.x !== undefined && e.y !== undefined) {
        const { x, y } = e;
        now.appendChild(button(NAV.navigate, () => this.navigate(x, y, EVENT_COLOR[e.kind])));
      }
      els.push(now);
    }
    if (!live.events.length && f) els.push(el('div', 'kit-intro-now', comingLine(f)));
    // (the Aktivity panel says it too: a phone on its side leaves it out, kit.css)
    const nudge = f ? morePlayersLine(f) : '';
    if (nudge) els.push(el('p', 'hint small kit-intro-more kit-intro-opt', nudge));
    return { title: EVENTS_TITLE, els };
  }

  /** the third: the mini-games and the rest, and the Aktivity panel that lists it all */
  private thingsCard() {
    const g = this.g;
    const online = !!g.online;
    const grid = this.grid(things({ online, input: this.input, board: !!g.host.live.score }).map((t) => this.item(t.icon, t.key, t.title, t.about)));
    // (the title says it too: a phone on its side leaves this line out, kit.css)
    const els: HTMLElement[] = [el('p', 'kit-intro-lead kit-intro-opt', THINGS_LEAD), grid];
    if (!online) els.push(el('p', 'hint small kit-intro-more', OFFLINE_MORE));
    const hint = el('div', 'kit-intro-now');
    hint.append(this.parts(aktivityHint(this.input)), button(NAV.aktivity, () => this.toActivities()));
    els.push(hint);
    return { title: THINGS_TITLE, els };
  }

  /** the last: what money buys, each kind of shop from its cheapest price, and where they are */
  private moneyCard(prices: Prices) {
    const online = !!this.g.online;
    const grid = this.grid(spending(prices).map((s) => this.item(s.icon, null, s.title, s.about, SHOP_COLOR[s.kind], s.price)));
    const hint = el('div', 'kit-intro-now');
    hint.append(this.parts(shopsHint(this.input)));
    return { title: MONEY_TITLE, els: [el('p', 'kit-intro-lead kit-intro-opt', moneyLead(online)), grid, el('p', 'kit-intro-note', MONEY_NOTE), hint] };
  }

  /** the items in even rows on a wide screen: two, three, four as two pairs, five or six in threes */
  private grid(items: HTMLElement[]): HTMLElement {
    const ul = el('ul', 'kit-intro-grid');
    ul.style.setProperty('--cols', String(items.length === 4 ? 2 : Math.min(3, Math.max(1, items.length))));
    ul.append(...items);
    return ul;
  }

  /** one world event, thing to do or shop: its icon, name, key (or a shop's price) and what it is
   *  (`color`: an event's or a shop's) */
  private item(icon: string, key: string | null, title: string, about: string, color?: string, price?: string): HTMLElement {
    const li = el('li');
    if (color) li.style.setProperty('--c', color);
    const corner = key ? keyCap(key, this.input) : price ? el('span', 'price', price) : el('span');
    li.append(el('span', 'ic', icon), el('b', undefined, title), corner, el('span', 'about', about));
    return li;
  }

  private parts(p: Parts): HTMLElement {
    const span = el('span');
    for (const x of p) span.append(typeof x === 'string' ? x : keyCap(x.key, this.input));
    return span;
  }

  // ------------------------------------------------------------------------------------ the way on
  /** off to a world event: the GPS set, back in the game (out of the pause menu too) */
  private navigate(x: number, y: number, color: string) {
    const g = this.g;
    g.gps.setWaypoint(x, y);
    this.panel?.close();
    if (g.paused) g.setPaused(false);
    toast('Navigácia nastavená – sleduj fialovú šípku.', color);
  }

  private toActivities() {
    this.panel?.close();
    (this.g.features.find((f) => f.id === 'activities') as ActivitiesUi | undefined)?.open();
  }
}
