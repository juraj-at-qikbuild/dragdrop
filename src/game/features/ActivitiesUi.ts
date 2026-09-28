// The Aktivity panel (U, the pad's d-pad down, a tap on the HUD chip, or "Aktivity" in the pause
// menu): everything there is to do in the city, in one place. The world events on right now (with a
// way to set the GPS there), when the next one may come and what each one needs, and the mini-games
// a player starts by themselves (jobs, races, the daily photo, the party, the leaderboard, voice
// chat) with their keys. The chip that opens it is Hud.drawActivities; what's coming is worked out in
// activities/forecast.ts from the director's plan (`wev.up` online, the rules offline).
import type { Game } from '../Game';
import { KEYS } from '../Input';
import { eventLeft } from '../SimHost';
import type { EventEntry, EventKind } from '../../shared/sim/rules/types';
import { dist, formatMoney, formatPoints } from '../../shared/util/math';
import { MINI_INFO, playersLine } from '../../shared/sim/rules/minigames/catalog';
import { MINI_KINDS, type MiniReq } from '../../shared/sim/rules/minigames/types';
import { addPauseControl, isModalOpen, openModal, toast } from '../../ui/kit/dom';
import type { ClientFeature } from './ClientFeature';
import { liveForecast, type Forecast } from './activities/forecast';
import { markActivitiesSeen } from './activities/seen';
import { suggest, type Suggestion } from './activities/suggest';
import { EVENT_ABOUT, EVENT_COLOR, EVENT_LABEL, EVENT_ORDER, candidatesLine, clock, morePlayersLine, nextLine, players, statusText } from './activities/text';

/** the open panel's countdowns tick this often (ms); its rows are rebuilt only when what they hold
 *  changes, so a button isn't swapped out from under a click */
const TICK_MS = 500;

type InputKind = 'key' | 'pad' | 'touch';

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

/** a key as the player's input shows it: a key cap, or the pad's button */
function keyCap(label: string, input: InputKind): HTMLElement {
  return el('kbd', input === 'key' ? 'kit-key' : 'kit-key pad', label);
}

export class ActivitiesUi implements ClientFeature {
  readonly id = 'activities';
  private panel: { close(): void; el: HTMLElement } | null = null;
  private body: HTMLElement | null = null;
  /** what the rows were last built from (see TICK_MS) */
  private shape = '';
  /** refresh the text that counts down in the rows as they are */
  private tickers: (() => void)[] = [];
  private tickedAt = 0;

  constructor(private g: Game) {
    addPauseControl(button('📋 Aktivity', () => this.open()));
  }

  update() {
    const g = this.g;
    if (this.panel) {
      // U itself is caught on the panel (the modal keeps its keys from the game); on the pad, the
      // d-pad moves around the panel and B closes it (Game.padModal)
      if (g.input.hit(KEYS.activities)) this.panel.close();
      else if (performance.now() - this.tickedAt >= TICK_MS) this.refresh();
      return;
    }
    // online, Game.update doesn't freeze features while paused: the pause menu has its own button
    if (g.paused || g.showMap || isModalOpen()) return;
    if (g.input.hit(KEYS.activities)) this.open();
  }

  reset() {
    this.panel?.close();
  }

  // -------------------------------------------------------------------------------------- panel
  /** Open the panel. Unlike the leaderboard, it doesn't pause: online an away player doesn't count
   *  for world events, so the panel would show fewer of them for as long as it's open. */
  open() {
    const g = this.g;
    if (this.panel) return;
    markActivitiesSeen();
    // a key held down as the panel opened would never see its keyup (the modal keeps keys to itself)
    g.input.keys.clear();
    g.input.mouseDown = false;
    g.input.resetTouch();
    const body = el('div', 'kit-act');
    this.body = body;
    // opened from the pause menu: that menu would only peek out around this one
    const pauseMenu = document.getElementById('pause');
    pauseMenu?.classList.add('hidden');
    this.panel = openModal({
      title: 'Aktivity',
      body,
      buttons: [{ label: 'Zavrieť', primary: true, onClick: () => {} }],
      onClose: () => {
        this.panel = null;
        this.body = null;
        this.shape = '';
        this.tickers = [];
        if (g.paused) pauseMenu?.classList.remove('hidden');
      },
    });
    const card = this.panel.el.querySelector('.menu-card');
    card?.classList.add('kit-act-card');
    // a way out at the top too, for a phone where the list scrolls the bottom button away
    const x = button('✕', () => this.panel?.close(), 'kit-act-x');
    x.title = 'Zavrieť';
    card?.prepend(x);
    // U closes it again
    this.panel.el.addEventListener('keydown', (e) => {
      if (e.code === KEYS.activities) this.panel?.close();
    });
    this.refresh();
    // the modal focuses its bottom button, which would scroll a tall panel to its end: start at the top
    setTimeout(() => {
      x.focus({ preventScroll: true });
      if (card) card.scrollTop = 0;
    }, 0);
  }

  /** leave the panel for something to do: back to the game (out of the pause menu too), then the key
   *  that does it, so each feature opens its own panel or starts its own thing as usual */
  private go(code?: string) {
    const g = this.g;
    this.panel?.close();
    if (g.paused) g.setPaused(false);
    if (code) g.input.press(code);
  }

  private get input(): InputKind {
    return this.g.input.pad.active ? 'pad' : this.g.touch ? 'touch' : 'key';
  }

  private forecast(): Forecast | null {
    const g = this.g;
    return liveForecast(g.host.live, !!g.online && g.paused);
  }

  /** rebuild the rows if what they hold changed, else just tick their countdowns */
  private refresh() {
    this.tickedAt = performance.now();
    const shape = this.shapeKey();
    if (shape !== this.shape) this.render(shape);
    else for (const t of this.tickers) t();
  }

  /** everything the rows are built from, minus the numbers that count down */
  private shapeKey(): string {
    const g = this.g;
    const live = g.host.live;
    const f = this.forecast();
    const kinds = f?.kinds.map((k) => `${k.kind}:${k.status.s}:${'need' in k.status ? `${k.status.need}/${k.status.have}` : ''}`).join(',');
    const events = live.events.map((e) => `${e.id}:${e.kind}:${e.phase}:${e.x !== undefined}:${e.place ?? ''}`).join(',');
    const job = live.job?.kind ?? '';
    const daily = live.daily ? `${live.daily.img}:${live.daily.solvedBy}:${live.daily.hints.length}` : '';
    const party = live.party ? `${live.party.tag}:${live.party.members.length}` : '';
    const others = g.online ? Math.max(0, g.online.roster.length - 1) : -1;
    const mini = live.mini ? `${live.mini.id}:${live.mini.phase}:${live.mini.n}:${live.mini.owner}` : '';
    const open = live.miniOpen.map((o) => `${o.id}:${o.n}:${o.phase}`).join(',');
    const next = this.suggestions().map((x) => x.title + x.label).join(',');
    return [this.input, !!g.online, g.online?.account, others, next, f ? `${f.busy}:${f.next === null}:${f.candidates}` : 'none', kinds, events, job, daily, party, !!live.score, mini, open, g.host.takesMini].join('|');
  }

  private render(shape: string) {
    const body = this.body;
    if (!body) return;
    this.shape = shape;
    this.tickers = [];
    const next = this.nextSection();
    body.replaceChildren(...(next ? [next] : []), this.miniSection(), this.eventsSection(), this.gamesSection());
    // on a phone the rows keep to a line: a tap on one shows what it's about
    body.onclick = (e) => {
      const t = e.target as HTMLElement;
      if (!t.closest('button')) t.closest('.kit-act-row')?.classList.toggle('open');
    };
  }

  // -------------------------------------------------------------------------------- Čo teraz?
  /** what's worth doing right now (activities/suggest.ts); TouchControls' "Čo teraz?" button too */
  suggestions(): Suggestion[] {
    const g = this.g;
    const live = g.host.live;
    const v = g.player.vehicle;
    return suggest({
      me: g.focus(),
      inCar: !!v && !v.spec.twoWheeler && !v.spec.boat,
      online: !!g.online,
      wanted: g.wanted,
      busy: !!g.missions.active || !!live.job || (!!live.mini && live.mini.phase !== 'done'),
      events: live.events,
      open: live.miniOpen.filter((o) => o.nick !== g.host.net?.nick),
      booths: g.missions.enabled ? g.missions.available().map((b) => ({ x: b.x, y: b.y, title: b.def.title })) : [],
      sprayShops: g.world.pois('fuel'),
      // (a different mini-game every ten minutes)
      turn: Math.floor(Date.now() / 600_000),
    });
  }

  /** the top of the panel: the best thing to do now as one big button, and two more beside it */
  private nextSection(): HTMLElement | null {
    const list = this.suggestions();
    if (!list.length) return null;
    const sec = el('section', 'kit-act-sec kit-act-nextsec');
    sec.appendChild(el('h3', undefined, 'Čo teraz?'));
    const row = el('div', 'kit-act-now');
    list.forEach((x, i) => {
      const b = button('', () => this.doSuggestion(x), i === 0 ? 'primary' : undefined);
      b.append(el('span', 'ic', x.icon), el('span', 't', x.title), el('span', 'why', x.why));
      row.appendChild(b);
    });
    sec.appendChild(row);
    return sec;
  }

  /** Do a suggestion: set the GPS, join or start a round, start a shift. */
  doSuggestion(x: Suggestion) {
    const g = this.g;
    const a = x.act;
    if (a.op === 'gps') {
      g.gps.setWaypoint(a.x, a.y);
      this.go();
      toast(`${x.icon} ${x.title}: navigácia nastavená – sleduj fialovú šípku.`, '#b388ff');
    } else if (a.op === 'join') this.miniReq({ op: 'join', id: a.id });
    else if (a.op === 'mini') this.miniReq({ op: 'start', kind: a.kind });
    else this.startJob(a.kind);
  }

  // ------------------------------------------------------------------------------- mini-games
  /** the mini-games (docs/plans/minigames.md): the round this player is in, rounds nearby to join,
   *  and every game with a button to start it, alone or with whoever joins */
  private miniSection(): HTMLElement {
    const g = this.g;
    const live = g.host.live;
    const sec = el('section', 'kit-act-sec');
    sec.appendChild(el('h3', undefined, 'Minihry'));
    if (!g.host.takesMini) {
      sec.appendChild(el('p', 'hint', 'Tento server minihry ešte nemá.'));
      return sec;
    }
    const cur = live.mini;
    if (cur && cur.phase !== 'done') {
      const info = MINI_INFO[cur.kind];
      const row = el('div', 'kit-act-live');
      row.appendChild(el('span', undefined, `${info.emoji} Hráš: ${info.title}${cur.n > 1 ? ` (${cur.n} hráči)` : ''}`));
      if (cur.phase === 'lobby' && cur.owner) row.appendChild(button('▶ Začať hneď', () => this.miniReq({ op: 'go' })));
      row.appendChild(button('Odísť z hry', () => this.miniReq({ op: 'leave' }), 'danger'));
      sec.appendChild(row);
    }
    // rounds others opened, to join
    const f = g.focus();
    const me = g.host.net?.nick;
    const open = live.miniOpen.filter((o) => o.nick !== me && cur?.id !== o.id);
    if (open.length) {
      const list = el('ul', 'kit-act-list');
      for (const o of open.sort((a, b) => dist(a.x, a.y, f.x, f.y) - dist(b.x, b.y, f.x, f.y)).slice(0, 5)) {
        const info = MINI_INFO[o.kind];
        const li = el('li', 'kit-act-row live');
        li.style.setProperty('--c', info.color);
        li.append(el('span', 'ic', info.emoji), el('span', 'name', `${o.nick}: ${info.title}`), el('span', 'st live', `${o.n}/${o.max}`));
        const d = Math.round(dist(o.x, o.y, f.x, f.y));
        li.appendChild(el('span', 'about', `${d < 1000 ? `${d} m` : `${(d / 1000).toFixed(1)} km`} odtiaľto · ${o.phase === 'lobby' ? 'čaká na hráčov' : 'už beží, dá sa pridať'}`));
        const acts = el('div', 'kit-act-acts');
        acts.append(
          button('➕ Pridať sa', () => this.miniReq({ op: 'join', id: o.id })),
          button('📍 Navigovať', () => {
            g.gps.setWaypoint(o.x, o.y);
            this.go();
          }),
        );
        li.appendChild(acts);
        list.appendChild(li);
      }
      sec.appendChild(list);
    }
    const busy = !!cur && cur.phase !== 'done';
    const list = el('ul', 'kit-act-list');
    for (const kind of MINI_KINDS) {
      const info = MINI_INFO[kind];
      const li = el('li', 'kit-act-row game');
      li.style.setProperty('--c', info.color);
      li.append(el('span', 'ic', info.emoji), el('span', 'name', info.title), el('span', 'st', playersLine(kind)));
      li.appendChild(el('span', 'about', info.about));
      if (info.needs) li.appendChild(el('span', 'state', `Treba: ${info.needs}.`));
      if (!busy) {
        const acts = el('div', 'kit-act-acts');
        acts.append(button('▶ Hrať', () => this.miniReq({ op: 'start', kind })));
        li.appendChild(acts);
      }
      list.appendChild(li);
    }
    sec.appendChild(list);
    sec.appendChild(el('p', 'hint small kit-act-more', g.online ? 'Kto je blízko alebo v tvojej partii, môže sa pridať počas odpočtu. Sám hráš proti mestu.' : 'Online sa k tvojej hre môžu pridať ostatní hráči.'));
    return sec;
  }

  private miniReq(req: MiniReq) {
    this.go();
    // offline, a mission (the phone booths) has the HUD and the city to itself
    if ((req.op === 'start' || req.op === 'join') && this.g.missions.active) {
      toast('Najprv dokonči misiu.', '#ff8a80');
      return;
    }
    this.g.host.mini(req);
  }

  // ------------------------------------------------------------------------------ world events
  private eventsSection(): HTMLElement {
    const g = this.g;
    const live = g.host.live;
    const sec = el('section', 'kit-act-sec');
    sec.appendChild(el('h3', undefined, 'Udalosti v meste'));
    const f = this.forecast();
    if (!f) {
      sec.appendChild(el('p', 'hint', 'Tento server zatiaľ neposiela, čo sa chystá. Udalosti, ktoré práve bežia, sú na mape.'));
    } else {
      const next = el('p', 'kit-act-next');
      const tickNext = () => {
        const now = this.forecast();
        if (now) next.textContent = nextLine(now);
      };
      tickNext();
      this.tickers.push(tickNext);
      sec.appendChild(next);
      const cand = candidatesLine(f);
      if (cand) sec.appendChild(el('p', 'hint small kit-act-cand', cand));
    }
    const list = el('ul', 'kit-act-list');
    for (const kind of EVENT_ORDER) {
      const st = f?.kinds.find((k) => k.kind === kind)?.status;
      const running = live.events.filter((e) => e.kind === kind);
      // without a plan (an older server) only what's on is listed
      if (!st && !running.length) continue;
      list.appendChild(this.eventRow(kind, running, st?.s === 'never'));
    }
    sec.appendChild(list);
    const more = f ? morePlayersLine(f) : '';
    if (more) sec.appendChild(el('p', 'hint small kit-act-more', more));
    return sec;
  }

  private eventRow(kind: EventKind, running: EventEntry[], never: boolean): HTMLElement {
    const li = el('li', running.length ? 'kit-act-row live' : never ? 'kit-act-row never' : 'kit-act-row');
    li.style.setProperty('--c', EVENT_COLOR[kind]);
    li.appendChild(el('span', 'ic', EVENT_ABOUT[kind].emoji));
    li.appendChild(el('span', 'name', EVENT_LABEL[kind]));
    const st = el('span', 'st');
    const tickSt = () => {
      const status = this.forecast()?.kinds.find((k) => k.kind === kind)?.status;
      const t = running.length ? { text: 'práve beží', tone: 'live' as const } : status ? statusText(status) : null;
      st.textContent = t?.text ?? '';
      st.className = `st ${t?.tone ?? ''}`;
    };
    tickSt();
    this.tickers.push(tickSt);
    li.appendChild(st);
    li.appendChild(el('span', 'about', EVENT_ABOUT[kind].about));
    for (const e of running) li.appendChild(this.liveLine(e));
    return li;
  }

  /** what's on: where, how long, the pot, and a way to set the GPS there */
  private liveLine(e: EventEntry): HTMLElement {
    const g = this.g;
    const line = el('div', 'kit-act-live');
    const text = el('span');
    const tick = () => {
      const left = clock(eventLeft(g.host.live, e));
      const when = e.phase === 'announce' ? `začína o ${left}` : `ešte ${left}`;
      const value = e.kind === 'derby' && e.alive !== undefined ? ` · ${e.alive} áut` : e.pot !== undefined ? ` · ${formatMoney(e.pot)}` : '';
      text.textContent = `${e.place ? `${e.place} · ` : ''}${when}${value}`;
    };
    tick();
    this.tickers.push(tick);
    line.appendChild(text);
    if (e.x !== undefined && e.y !== undefined) {
      const { x, y } = e;
      line.appendChild(
        button('📍 Navigovať', () => {
          g.gps.setWaypoint(x, y);
          this.go();
          toast('Navigácia nastavená – sleduj fialovú šípku.', EVENT_COLOR[e.kind]);
        }),
      );
    }
    return line;
  }

  // --------------------------------------------------------------------------------- mini-games
  private gamesSection(): HTMLElement {
    const g = this.g;
    const live = g.host.live;
    const input = this.input;
    const sec = el('section', 'kit-act-sec');
    sec.appendChild(el('h3', undefined, 'Čo môžeš robiť'));
    const list = el('ul', 'kit-act-list');

    // jobs: solo, online or off
    const job = live.job;
    const jobActs = job
      ? [button('Ukončiť zmenu', () => this.go(KEYS.jobs), 'danger')]
      : [button('🍔 Vlk kuriér', () => this.startJob('courier')), button('🚕 Hopík taxi', () => this.startJob('taxi'))];
    list.appendChild(
      this.gameRow({
        key: input === 'key' ? 'J' : input === 'pad' ? '←' : null,
        icon: '💼',
        title: 'Vlk kuriér · Hopík taxi',
        about: 'Rozvážaj jedlo alebo voz ľudí po meste. Ide aj sólo; na taxík treba auto.',
        state: job ? `Zmena beží: ${job.kind === 'courier' ? 'Vlk kuriér' : 'Hopík taxi'} (cieľ máš na obrazovke).` : '',
        acts: jobActs,
      }),
    );

    if (!g.online) {
      list.appendChild(
        this.gameRow({
          key: null,
          icon: '☎',
          title: 'Misie',
          about: 'Šesť príbehov po meste. Začínajú pri žltých telefónnych búdkach – nájdeš ich na mape.',
          acts: [button('🗺 Mapa', () => this.go('KeyM'))],
        }),
      );
      sec.appendChild(list);
      sec.appendChild(el('p', 'hint small kit-act-more', 'Online navyše: závody, partia, denná fotka Kde to je?, rebríček a hlasový chat.'));
      return sec;
    }

    // races: pull up next to another player's car and hold the horn
    const others = Math.max(0, g.online.roster.length - 1);
    const horn = input === 'key' ? 'H' : input === 'pad' ? 'X' : '📣';
    list.appendChild(
      this.gameRow({
        key: horn,
        icon: '🏁',
        title: 'Závod?',
        about: `Zastav pri aute iného hráča a podrž ${input === 'touch' ? 'klaksón 📣' : horn}. Pretekáte k pamiatke 1–2 km ďaleko o stávku do ${formatMoney(250)}.`,
        state: others ? `V meste ${others >= 2 && others <= 4 ? 'sú' : 'je'} ešte ${players(others)}.` : 'Teraz tu nie je nikto iný.',
      }),
    );

    // the daily photo
    const daily = live.daily;
    list.appendChild(
      this.gameRow({
        key: input === 'key' ? 'K' : null,
        icon: '📷',
        title: 'Kde to je?',
        about: `Denná fotka miesta v meste. Kto sa tam prvý postaví, vyhrá ${formatMoney(1000)}.`,
        state: !daily ? 'Dnešná fotka ešte nie je.' : daily.solvedBy ? `Dnes už vyriešené – ${daily.solvedBy}.` : daily.hints.length ? `Nápovedy: ${daily.hints.join(' · ')}` : 'Dnešná fotka je vonku!',
        acts: daily ? [button('📷 Ukázať fotku', () => this.go(KEYS.daily))] : [],
      }),
    );

    // the party
    const party = live.party;
    list.appendChild(
      this.gameRow({
        key: input === 'key' ? 'N' : null,
        icon: '👥',
        title: 'Partia',
        about: 'Pozvi kamaráta odkazom – objaví sa hneď pri tebe a delíte sa o odmeny z udalostí a práce.',
        state: party ? `Si v partii ${party.tag} (${party.members.length}/4).` : '',
        acts: [button(party ? 'Otvoriť' : '➕ Pozvať kamaráta', () => this.go(KEYS.party))],
      }),
    );

    // the leaderboard (a server that keeps one sends this player's points)
    if (live.score) {
      list.appendChild(
        this.gameRow({
          key: input === 'key' ? 'L' : null,
          icon: '🏆',
          title: 'Rebríček',
          about: 'Body za udalosti, prácu, závody a ďalšie – na dnes, tento týždeň aj celkovo.',
          state: () => {
            const s = this.g.host.live.score;
            return s ? `Dnes máš ${formatPoints(s.d)} b${s.r ? ` · ${s.r}. miesto` : ''}.` : '';
          },
          acts: [button('🏆 Otvoriť', () => this.go(KEYS.board))],
        }),
      );
    }

    // voice chat
    list.appendChild(
      this.gameRow({
        key: input === 'key' ? 'V' : input === 'pad' ? 'L3' : '🎙',
        icon: '🎙',
        title: 'Hlasový chat',
        about: `Hovor s hráčmi okolo seba – podrž ${input === 'key' ? 'V' : input === 'pad' ? 'L3' : '🎙'}.`,
        state: g.online.account ? '' : 'Iba s účtom – vytvoríš si ho v menu pauzy.',
      }),
    );
    sec.appendChild(list);
    return sec;
  }

  /** one mini-game: its key for the player's input (else its icon), what it is, how it stands for
   *  this player (a function: kept up to date while the panel is open), and buttons to get going */
  private gameRow(o: { key: string | null; icon: string; title: string; about: string; state?: string | (() => string); acts?: HTMLButtonElement[] }): HTMLElement {
    const li = el('li', 'kit-act-row game');
    const ic = el('span', 'ic');
    if (o.key) ic.appendChild(keyCap(o.key, this.input));
    else ic.textContent = o.icon;
    li.append(ic, el('span', 'name', o.title), el('span', 'st'));
    li.appendChild(el('span', 'about', o.about));
    const stateOf = o.state;
    if (typeof stateOf === 'function') {
      const state = el('span', 'state');
      const tick = () => (state.textContent = stateOf());
      tick();
      this.tickers.push(tick);
      li.appendChild(state);
    } else if (stateOf) li.appendChild(el('span', 'state', stateOf));
    if (o.acts?.length) {
      const acts = el('div', 'kit-act-acts');
      acts.append(...o.acts);
      li.appendChild(acts);
    }
    return li;
  }

  private startJob(kind: 'courier' | 'taxi') {
    this.go();
    this.g.host.jobStart(kind);
  }
}
