// Party panel (N), a compact HUD list, map markers and the "[TAG]" nametag prefix
// (docs/plans/social-events.md "Partia + invite link"; server: server/src/features/Party.ts).
import type { Game } from '../Game';
import { KEYS } from '../Input';
import { NetSimHost } from '../../net/NetSimHost';
import type { PrivateEvent } from '../../shared/sim/events';
import { ROSTER_DOWNED } from '../../shared/net/protocol';
import { dist } from '../../shared/util/math';
import { addNametagDecorator } from '../../render/nametags';
import { roundRect } from '../../render/shapes';
import { mapMarker } from '../../ui/MapView';
import { isModalOpen, openModal, shareLink, toast } from '../../ui/kit/dom';
import type { ClientFeature, ToScreen } from './ClientFeature';

const FONT = `system-ui, sans-serif`;
/** re-render the open panel's distances at least this often even without a state change */
const PANEL_REFRESH_S = 1;

/** nick → the invite link's decoration: lowercase, no diacritics, spaces to '-', alnum/dash only, ≤12 */
function slug(nick: string): string {
  const s = nick
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // decomposed diacritics (NFD): drop the combining marks
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 12);
  return s || 'hrac';
}

function hint(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = text;
  return p;
}

export class PartyUi implements ClientFeature {
  readonly id = 'party';
  private panel: { close(): void } | null = null;
  private panelBody: HTMLElement | null = null;
  /** the `live.party` reference last rendered into the open panel (re-render whenever it changes) */
  private shown: unknown = null;
  private refreshT = 0;

  constructor(private g: Game) {
    addNametagDecorator((_id, tag) => {
      if (!tag.partyId) return null;
      const info = this.g.host.live.partyTags.get(tag.partyId);
      return info ? { prefix: `[${info.tag}]`, prefixColor: info.color } : null;
    });
  }

  update(dt: number) {
    if (!isModalOpen() && this.g.input.hit(KEYS.party)) this.openPanel();
    if (!this.panel) return;
    this.refreshT -= dt;
    const party = this.g.host.live.party;
    if (party !== this.shown || this.refreshT <= 0) {
      this.refreshT = PANEL_REFRESH_S;
      this.renderPanel();
    }
  }

  onPrivate(e: PrivateEvent) {
    if (e.k === 'invite') this.onInviteCode(e.code);
  }

  reset() {
    this.panel?.close();
  }

  // -------------------------------------------------------------------------------------- panel
  private openPanel() {
    if (this.panel) return;
    const body = document.createElement('div');
    this.panelBody = body;
    this.panel = openModal({
      title: 'Partia',
      body,
      buttons: [{ label: 'Zavrieť', primary: true, onClick: () => {} }],
      onClose: () => {
        this.panel = null;
        this.panelBody = null;
        this.shown = null;
      },
    });
    this.renderPanel();
  }

  private renderPanel() {
    const body = this.panelBody;
    if (!body) return;
    const g = this.g;
    const party = g.host.live.party;
    this.shown = party;
    body.replaceChildren();
    if (!g.online) {
      body.appendChild(hint('Partia funguje iba online.'));
      return;
    }
    const meId = g.host.me.id;
    const my = g.focus();
    if (!party) body.appendChild(hint('Nie si v partii. Pozvi kamaráta a založ si ju.'));
    else {
      const amLeader = party.members.find((m) => m.id === meId)?.leader ?? false;
      const list = document.createElement('div');
      list.className = 'kit-party-list';
      for (const m of party.members) {
        const row = document.createElement('div');
        row.className = 'kit-party-row';
        const rr = g.online.roster.find((r) => r[0] === m.id);
        const downed = !!rr && !!(rr[8] & ROSTER_DOWNED);
        const d = m.id === meId ? 0 : rr ? Math.round(dist(rr[2], rr[3], my.x, my.y)) : null;
        const info = document.createElement('span');
        info.textContent = `${m.leader ? '★ ' : ''}${m.nick}${m.online ? '' : ' (offline)'}${downed ? ' ✚' : ''}${d !== null ? ` · ${d} m` : ''}`;
        row.appendChild(info);
        if (amLeader && m.id !== meId) {
          const kick = document.createElement('button');
          kick.type = 'button';
          kick.className = 'kick';
          kick.textContent = 'Vyhodiť';
          kick.onclick = () => this.kick(m.id);
          row.appendChild(kick);
        }
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    const actions = document.createElement('div');
    actions.className = 'buttons';
    const invite = document.createElement('button');
    invite.type = 'button';
    invite.textContent = 'Pozvať kamaráta';
    invite.onclick = () => this.invite();
    actions.appendChild(invite);
    if (party) {
      const leave = document.createElement('button');
      leave.type = 'button';
      leave.className = 'danger';
      leave.textContent = 'Opustiť partiu';
      leave.onclick = () => this.leaveParty();
      actions.appendChild(leave);
    }
    body.appendChild(actions);
  }

  private invite() {
    if (this.g.host instanceof NetSimHost) this.g.host.conn.send({ t: 'partyInvite' });
  }

  private leaveParty() {
    if (this.g.host instanceof NetSimHost) this.g.host.conn.send({ t: 'partyLeave' });
    toast('Opustil si partiu.', '#ffd740');
  }

  private kick(id: number) {
    if (this.g.host instanceof NetSimHost) this.g.host.conn.send({ t: 'partyKick', id });
  }

  private onInviteCode(code: string) {
    const nick = this.g.online?.nick ?? '';
    const url = `${location.origin}${location.pathname}#join=${slug(nick)}-${code}`;
    void shareLink(url, 'Poď hrať Blava City so mnou!');
  }

  // ---------------------------------------------------------------------------------- HUD + map
  drawHud(ctx: CanvasRenderingContext2D) {
    const g = this.g;
    const party = g.host.live.party;
    if (!party || !g.online) return;
    const small = g.viewW < 700;
    const pad = small ? 10 : 16;
    const rowH = small ? 15 : 17;
    const w = small ? 132 : 154;
    const h = 8 + rowH * (party.members.length + 1);
    const meId = g.host.me.id;
    const my = g.focus();
    ctx.save();
    roundRect(ctx, pad, pad, w, h, 10);
    ctx.fillStyle = 'rgba(10,12,16,0.62)';
    ctx.fill();
    ctx.strokeStyle = party.color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.font = `700 ${small ? 10 : 11}px ${FONT}`;
    ctx.fillStyle = party.color;
    ctx.fillText(`PARTIA ${party.tag}`, pad + 8, pad + 5);
    ctx.font = `600 ${small ? 11 : 12}px ${FONT}`;
    party.members.forEach((m, i) => {
      const y = pad + 6 + rowH * (i + 1);
      const rr = g.online!.roster.find((r) => r[0] === m.id);
      const downed = !!rr && !!(rr[8] & ROSTER_DOWNED);
      const d = m.id === meId ? 0 : rr ? Math.round(dist(rr[2], rr[3], my.x, my.y)) : null;
      ctx.textAlign = 'left';
      ctx.fillStyle = m.online ? '#fff' : 'rgba(255,255,255,0.45)';
      ctx.fillText(`${m.leader ? '★' : ' '} ${m.nick}${downed ? ' ✚' : ''}`, pad + 8, y);
      if (d !== null) {
        ctx.textAlign = 'right';
        ctx.fillText(`${d} m`, pad + w - 8, y);
      }
    });
    ctx.restore();
  }

  /** party members over the default purple roster dots (MapView.blips() draws this after them),
   *  in their party colour, with names on the full map only. */
  drawMap(ctx: CanvasRenderingContext2D, toScreen: ToScreen, full: boolean, size: number) {
    const g = this.g;
    if (!g.online) return;
    const tags = g.host.live.partyTags;
    if (!tags.size) return;
    const meId = g.host.me.id;
    for (const r of g.online.roster) {
      if (r[0] === meId) continue;
      const info = tags.get(r[7]);
      if (!info) continue;
      const [x, y] = toScreen(r[2], r[3]);
      mapMarker(ctx, x, y, size * 0.85, 'party', { color: info.color, label: full ? r[1] : undefined, full });
    }
  }
}
