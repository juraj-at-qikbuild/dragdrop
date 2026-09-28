// The referral card (docs/referrals.md): this player's link with a copy/share button, the rules, and
// what their friends have earned them so far. One in the main menu, one in the pause menu (main.ts
// mounts both); each refreshes when it's shown and whenever the server sends new stats.
import { REFERRAL_MAX, REFERRAL_TIERS } from '../shared/referral';
import { formatMoney } from '../shared/util/math';
import { lastStats, myReferralCode, myReferralLink, onReferralStats } from '../net/referral';
import { openModal, shareLink } from './kit/dom';

/** "€1 000", never broken across two lines */
const eur = (n: number) => formatMoney(n).replace(/ /g, '\u00a0');

/** "Keď si kamarát založí účet a odohrá 50 minút, dostaneš €1 000. Po hodine hrania spolu €3 000." */
export function referralRules(): string {
  const [first, ...rest] = REFERRAL_TIERS;
  const after = (min: number) => (min === 60 ? 'hodine' : `${min} minútach`);
  let text = `Keď si kamarát založí účet a odohrá ${first.min} minút, dostaneš ${eur(first.total)}.`;
  for (const t of rest) text += ` Po ${after(t.min)} hrania spolu ${eur(t.total)}.`;
  return text;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class ReferralCard {
  readonly root = el('div', 'ref-card');
  private body = el('div', 'ref-body');
  /** a newer refresh() supersedes a slower earlier one */
  private gen = 0;

  /** `nick`: the link's decoration (the player's current nickname, if any) */
  constructor(private nick: () => string) {
    const head = el('div', 'ref-head');
    head.append('🎁 Pozvi kamaráta', el('span', 'ref-prize', `až ${eur(REFERRAL_MAX)}`));
    this.root.append(head, this.body);
    onReferralStats(() => {
      if (this.root.isConnected) void this.refresh();
    });
  }

  async refresh() {
    const gen = ++this.gen;
    const code = await myReferralCode();
    if (gen !== this.gen) return;
    const body = this.body;
    body.replaceChildren();
    body.appendChild(el('p', 'ref-rule', referralRules()));
    if (!code) {
      body.appendChild(el('p', 'ref-rule', 'Zahraj si online a dostaneš vlastný odkaz.'));
      return;
    }
    const url = myReferralLink(this.nick(), code);
    const row = el('div', 'ref-link');
    const input = el('input', 'ref-url');
    input.readOnly = true;
    input.value = url;
    input.setAttribute('aria-label', 'Tvoj odkaz na pozvanie');
    input.onfocus = () => input.select();
    const share = el('button', 'ref-share', 'share' in navigator ? 'Zdieľať' : 'Kopírovať');
    share.type = 'button';
    share.onclick = () => void shareLink(url, 'Poď hrať GTA SK so mnou!');
    row.append(input, share);
    body.appendChild(row);
    // the server's numbers, when they're this identity's (another account's stay out)
    const stats = lastStats();
    if (stats && stats.code === code && stats.n > 0) {
      const line = el('p', 'ref-stats');
      line.append(`Pozvaní: ${stats.n} · zarobené ${eur(stats.paid)} `);
      const more = el('button', 'kit-link', 'Zoznam');
      more.type = 'button';
      more.onclick = () => showFriends();
      line.appendChild(more);
      body.appendChild(line);
    }
  }
}

/** who came in through the link, and how far along each one is */
function showFriends() {
  const stats = lastStats();
  const body = document.createElement('div');
  const list = el('div', 'kit-party-list');
  const top = REFERRAL_TIERS[REFERRAL_TIERS.length - 1].min;
  for (const [nick, min, paid, account] of stats?.friends ?? []) {
    const row = el('div', 'kit-party-row');
    const where = paid ? `+${eur(paid)}` : account ? `${Math.min(min, top)}/${top} min` : `${min} min · ešte nemá účet`;
    row.append(el('span', '', nick), el('span', 'ref-friend-state', where));
    list.appendChild(row);
  }
  body.appendChild(list);
  if (stats && stats.n > stats.friends.length) body.appendChild(el('p', 'hint small', `…a ďalší (spolu ${stats.n}).`));
  body.appendChild(el('p', 'hint small', 'Počítajú sa iba minúty skutočného hrania (nie pauza).'));
  openModal({ title: 'Pozvaní kamaráti', body, buttons: [{ label: 'Zavrieť', primary: true, onClick: () => {} }] });
}
