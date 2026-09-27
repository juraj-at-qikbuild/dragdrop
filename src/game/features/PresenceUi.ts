// Pausing and coming back online, the client's side (docs/plans/pause-resume.md): the pause menu's note
// on what the city does meanwhile and whether this player is safe, ⏸ and 🛡 on other players' name
// tags, and the dialog after the server moved this player out of the city for being away too long.
import type { Game } from '../Game';
import { NetSimHost } from '../../net/NetSimHost';
import { ROSTER_AWAY, ROSTER_SHIELD, type ServerMsg } from '../../shared/net/protocol';
import { SHIELD_ARM_S } from '../../shared/sim/rules/Presence';
import { addNametagDecorator } from '../../render/nametags';
import { goOnline, goToMenu } from '../../boot/links';
import { openModal } from '../../ui/kit/dom';
import type { ClientFeature } from './ClientFeature';

type Tone = 'ok' | 'wait' | 'warn';

export class PresenceUi implements ClientFeature {
  readonly id = 'presence';
  private note = document.getElementById('pause-note');
  private head = document.createElement('span');
  private status = document.createElement('span');
  private shown = '';
  private pausedAt = 0;
  private wasPaused = false;
  private idleShown = false;

  constructor(private g: Game) {
    this.head.className = 'head';
    this.note?.replaceChildren(this.head, this.status);
    addNametagDecorator((_id, tag) => {
      if (tag.flags & ROSTER_SHIELD) return { icons: ['⏸', '🛡'] };
      return tag.flags & ROSTER_AWAY ? { icons: ['⏸'] } : null;
    });
  }

  update() {
    const g = this.g;
    if (g.paused && !this.wasPaused) this.pausedAt = performance.now();
    this.wasPaused = g.paused;
    if (g.paused) this.show(...this.text());
  }

  /** the pause menu's note: nothing offline (the world waits there), else what the city does and
   *  whether they're safe while the menu is open */
  private text(): [string, string, Tone] {
    const g = this.g;
    const host = g.host;
    if (!(host instanceof NetSimHost)) return ['', '', 'ok'];
    const head = 'Mesto beží ďalej – tvoja postava stojí na mieste.';
    // a server from before the shield: no cover at all
    if (!host.serverPresence) return [head, 'Kým si v menu, môžu ťa obliať.', 'warn'];
    if (host.shielded) return [head, '🛡 V menu si v bezpečí.', 'ok'];
    if (g.state !== 'play') return [head, '', 'ok'];
    if (g.wanted > 0) return [head, '⚠ Polícia ťa hľadá – ani v menu nie si v bezpečí.', 'warn'];
    if (performance.now() - this.pausedAt < (SHIELD_ARM_S + 1) * 1000) return [head, 'O chvíľu budeš v bezpečí…', 'wait'];
    return [head, '⚠ Teraz nie si v bezpečí: je z toho vodná bitka, závodíš alebo si v akcii.', 'warn'];
  }

  private show(head: string, status: string, tone: Tone) {
    const key = `${head}|${status}|${tone}`;
    if (!this.note || key === this.shown) return;
    this.shown = key;
    this.note.classList.toggle('hidden', !head);
    this.head.textContent = head;
    this.status.textContent = status;
    this.status.className = `status ${tone}`;
  }

  /** away too long: the server moved them out of the city (saved); coming back is one click */
  onMessage(m: ServerMsg) {
    if (m.t !== 'bye' || m.reason !== 'idle' || this.idleShown) return;
    this.idleShown = true;
    openModal({
      title: 'Bol si dlho preč',
      body: 'Tvoja postava odišla z mesta a všetko sa uložilo. Keď sa vrátiš, pokračuješ tam, kde si skončil.',
      buttons: [
        { label: 'Vrátiť sa do mesta', primary: true, onClick: () => goOnline() },
        { label: 'Hlavné menu', onClick: () => goToMenu() },
      ],
    });
  }
}
