// The leaderboard (docs/plans/leaderboard.md; server: server/src/features/Leaderboard.ts). L, or
// "Rebríček" in the pause menu, opens the boards: today, this week or all time, for everything or one
// kind of thing, the player's own place in each, yesterday's (or last week's) winner and what every
// point is for. Points float up where they're scored ("+30 b"); the HUD's pill under the online
// badge (Hud.drawScore) shows today's total. Online only: the server keeps the books.
import type { Game } from '../Game';
import { KEYS } from '../Input';
import { NetSimHost } from '../../net/NetSimHost';
import type { GlobalEvent, PrivateEvent } from '../../shared/sim/events';
import { BOARD_ACCOUNT, BOARD_ME, BOARD_ONLINE, type BoardMsg, type ServerMsg } from '../../shared/net/protocol';
import { BOARDS, PERIODS, type BoardId, type ScorePeriod } from '../../shared/sim/rules/points';
import { formatPoints } from '../../shared/util/math';
import { addPauseControl, isModalOpen, openModal } from '../../ui/kit/dom';
import type { ClientFeature } from './ClientFeature';
import { BOARD_INFO, PERIOD_LABEL, PREV_LABEL, pointsHelp, until } from './leaderboard/text';
import { forDevice } from '../../ui/deviceText';

/** while the panel is open, the page on show is asked for again this often (ms) */
const REFRESH_MS = 5000;
const MEDALS = ['🥇', '🥈', '🥉'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class LeaderboardUi implements ClientFeature {
  readonly id = 'leaderboard';
  private panel: { close(): void; el: HTMLElement } | null = null;
  private body: HTMLElement | null = null;
  private period: ScorePeriod = 'day';
  private board: BoardId = 'all';
  /** the last page the server sent for each period+board, so switching back shows it at once */
  private pages = new Map<string, BoardMsg>();
  private askedAt = 0;
  /** the pause this panel opened itself (L during play), to close again with it */
  private pausedByUs = false;
  /** "Za čo sú body" stays open across the refreshes once opened */
  private helpOpen = false;

  constructor(private g: Game) {
    const btn = el('button', undefined, '🏆 Rebríček');
    btn.type = 'button';
    btn.onclick = () => this.open();
    addPauseControl(btn, { onlineOnly: true });
  }

  update() {
    const g = this.g;
    if (this.panel) {
      if (performance.now() - this.askedAt > REFRESH_MS) this.ask();
      return;
    }
    // online, Game.update doesn't stop the features while paused: the pause menu has its own button
    if (g.paused || g.showMap || isModalOpen()) return;
    if (g.input.hit(KEYS.board)) this.open();
  }

  onPrivate(e: PrivateEvent) {
    // a near miss already floats its own "TESNE!": its couple of points just go on the HUD's total
    if (e.k === 'points' && e.src !== 'tip') this.g.juice.pointsText(e.x, e.y, e.n);
  }

  onGlobal(e: GlobalEvent) {
    const g = this.g;
    if (e.k === 'leader' && e.nick !== g.online?.nick) {
      g.banners.push({ title: 'REBRÍČEK', text: `${e.nick} vedie dnešný rebríček (${formatPoints(e.pts)} b).`, icon: 'star', priority: 0 });
    } else if (e.k === 'dayWinner') {
      const me = e.nick === g.online?.nick;
      g.banners.push({ title: me ? 'VYHRAL SI DEŇ!' : 'KONIEC DŇA', text: `${me ? 'Najviac bodov včera: ty' : `Včera nazbieral najviac bodov ${e.nick}`} – ${formatPoints(e.pts)} b.`, icon: 'star', priority: 1 });
    }
  }

  onMessage(m: ServerMsg) {
    if (m.t !== 'board') return;
    const key = `${m.period}|${m.board}`;
    const same = JSON.stringify(this.pages.get(key)) === JSON.stringify(m);
    this.pages.set(key, m);
    // a refresh that changed nothing leaves the panel (and where it's scrolled to) alone
    if (!same && m.period === this.period && m.board === this.board) this.render();
  }

  reset() {
    this.panel?.close();
    this.pages.clear();
  }

  // -------------------------------------------------------------------------------------- panel
  /** open the panel; from play (L) it pauses the game while it's open, like the pause menu does
   *  (online: away, and shielded when it's safe) */
  open() {
    const g = this.g;
    if (this.panel) return;
    this.pausedByUs = !g.paused;
    if (this.pausedByUs) g.setPaused(true);
    // a key held down as the panel opened would never see its keyup (the modal keeps keys to itself)
    g.input.keys.clear();
    g.input.mouseDown = false;
    const body = el('div', 'kit-board');
    this.body = body;
    // the pause menu (under this panel) would only peek out around it
    const pauseMenu = document.getElementById('pause');
    pauseMenu?.classList.add('hidden');
    this.panel = openModal({
      title: 'Rebríček',
      body,
      buttons: [{ label: 'Zavrieť', primary: true, onClick: () => {} }],
      onClose: () => {
        this.panel = null;
        this.body = null;
        if (this.pausedByUs && g.paused) g.setPaused(false);
        this.pausedByUs = false;
        // opened from the pause menu: back to it
        if (g.paused) pauseMenu?.classList.remove('hidden');
      },
    });
    const card = this.panel.el.querySelector('.menu-card');
    card?.classList.add('kit-board-card');
    // a way out at the top too, for a phone where the list scrolls the bottom button away
    const x = el('button', 'kit-board-x', '✕');
    x.type = 'button';
    x.title = 'Zavrieť';
    x.onclick = () => this.panel?.close();
    card?.prepend(x);
    // L closes it again (the modal keeps its keys from the game's own listener)
    this.panel.el.addEventListener('keydown', (e) => {
      if (e.code === KEYS.board && !(e.target instanceof HTMLInputElement)) this.panel?.close();
    });
    this.render();
    this.ask();
  }

  /** the scores server-side: only a server that keeps a leaderboard ever pushed one */
  private get host(): NetSimHost | null {
    const h = this.g.host;
    return h instanceof NetSimHost && h.live.score ? h : null;
  }

  private ask() {
    this.askedAt = performance.now();
    this.host?.conn.send({ t: 'board', period: this.period, board: this.board });
  }

  private pick(period: ScorePeriod, board: BoardId) {
    if (period === this.period && board === this.board) return;
    this.period = period;
    this.board = board;
    this.render();
    this.ask();
  }

  private render() {
    const body = this.body;
    if (!body) return;
    body.replaceChildren();
    const g = this.g;
    if (!g.online) {
      body.appendChild(el('p', 'hint', 'Rebríček funguje iba online – v spoločnom meste, kde sa body rátajú každému hráčovi.'));
      body.appendChild(this.help());
      return;
    }
    const score = g.host.live.score;
    if (!score) {
      body.appendChild(el('p', 'hint', 'Tento server rebríček zatiaľ nemá.'));
      return;
    }
    // this player's own totals
    const me = el('div', 'kit-board-me');
    const cell = (label: string, value: string) => {
      const c = el('div');
      c.append(el('span', undefined, label), el('b', undefined, value));
      return c;
    };
    me.append(
      cell('Dnes', `${formatPoints(score.d)} b${score.r ? ` · ${score.r}. z ${score.n}` : ''}`),
      cell('Týždeň', `${formatPoints(score.w)} b`),
      cell('Celkovo', `${formatPoints(score.a)} b`),
    );
    body.appendChild(me);

    const tabs = el('div', 'kit-board-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const p of PERIODS) tabs.appendChild(this.toggle(PERIOD_LABEL[p], p === this.period, () => this.pick(p, this.board)));
    body.appendChild(tabs);
    const chips = el('div', 'kit-board-chips');
    for (const b of BOARDS) chips.appendChild(this.toggle(`${BOARD_INFO[b].icon} ${BOARD_INFO[b].label}`, b === this.board, () => this.pick(this.period, b)));
    body.appendChild(chips);
    body.appendChild(el('p', 'hint small kit-board-about', BOARD_INFO[this.board].about));

    const page = this.pages.get(`${this.period}|${this.board}`);
    if (!page) body.appendChild(el('p', 'hint kit-board-empty', 'Načítavam…'));
    else if (!page.rows.length) body.appendChild(el('p', 'hint kit-board-empty', this.period === 'day' ? 'Dnes tu ešte nikto nemá body. Buď prvý!' : 'Zatiaľ tu nikto nemá body. Buď prvý!'));
    else {
      const list = el('ol', 'kit-board-list');
      for (const [rank, nick, pts, flags] of page.rows) {
        const li = el('li');
        if (flags & BOARD_ME) li.classList.add('me');
        li.appendChild(el('span', 'rank', rank <= 3 ? MEDALS[rank - 1] : `${rank}.`));
        const name = el('span', 'nick', nick);
        if (flags & BOARD_ACCOUNT) {
          const b = el('span', 'acct', '✓');
          b.title = 'Hráč s účtom';
          name.appendChild(b);
        }
        if (flags & BOARD_ONLINE) {
          const d = el('span', 'online', '●');
          d.title = 'Práve je v meste';
          name.appendChild(d);
        }
        li.append(name, el('span', 'pts', formatPoints(pts)));
        list.appendChild(li);
      }
      body.appendChild(list);
    }
    if (page) {
      const foot = el('div', 'kit-board-foot');
      const [myRank, myPts] = page.me;
      const shown = page.rows.some((r) => r[3] & BOARD_ME);
      if (!myRank) foot.appendChild(el('p', undefined, 'Tu ešte nemáš body.'));
      else if (!shown) foot.appendChild(el('p', 'mine', `Ty: ${myRank}. z ${page.n} · ${formatPoints(myPts)} b`));
      else if (page.n > page.rows.length) foot.appendChild(el('p', undefined, `${page.n} hráčov v rebríčku`));
      if (page.prev && this.period !== 'all') foot.appendChild(el('p', undefined, `${PREV_LABEL[this.period]} ${page.prev[0]} (${formatPoints(page.prev[1])} b)`));
      if (page.ends !== undefined) foot.appendChild(el('p', undefined, this.period === 'day' ? `Nový deň o ${until(page.ends)}` : `Týždeň končí o ${until(page.ends)}`));
      body.appendChild(foot);
    }
    body.appendChild(this.help());
  }

  private toggle(label: string, on: boolean, onClick: () => void): HTMLButtonElement {
    const b = el('button', on ? 'on' : undefined, label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(on));
    b.onclick = onClick;
    return b;
  }

  private help(): HTMLElement {
    const d = el('details', 'kit-board-help');
    d.open = this.helpOpen;
    d.addEventListener('toggle', () => (this.helpOpen = d.open));
    d.appendChild(el('summary', undefined, 'Za čo sú body'));
    const ul = el('ul');
    for (const line of pointsHelp()) ul.appendChild(el('li', undefined, forDevice(line, this.g.device)));
    d.appendChild(ul);
    return d;
  }
}
