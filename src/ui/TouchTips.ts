// First-run tips for the touch controls: one bubble at a time, next to the control it's about, gone
// once the player has done it (or taps the bubble, or after a while). Remembered, so they show once;
// "Zobraziť tipy znova" in the controls panel brings them back. Also a hint to turn a phone held
// upright on its side, once a session.
import type { Game } from '../game/Game';
import { setting } from './kit/settings';
import type { TouchControls } from './TouchControls';

interface Tip {
  id: string;
  /** the control the bubble points at */
  at: string;
  /** when it may show */
  when: (g: Game) => boolean;
  text: (g: Game) => string;
}

const TIPS: Tip[] = [
  { id: 'stick', at: 'idle', when: (g) => !g.player.vehicle, text: () => 'Polož ľavý palec kamkoľvek vľavo a ťahaj. Potlačíš naplno = beh.' },
  { id: 'fire', at: 'fire', when: (g) => !g.player.vehicle, text: () => 'Podrž: strieľa na najbližší cieľ. Ťahaj z tlačidla: mieriš sám.' },
  { id: 'map', at: 'map', when: (g) => !g.player.vehicle, text: () => 'Ťukni na minimapu: mapa mesta a navigácia. ⏸ pauza a nastavenia.' },
  { id: 'use', at: 'use', when: (g) => !g.player.vehicle && !!g.prompt()?.use, text: () => 'Ťukni: nastúpiš do auta (aj cudzieho).' },
  {
    id: 'car',
    at: 'nitro',
    when: (g) => !!g.player.vehicle,
    text: (g) =>
      g.driveControls === 'classic'
        ? 'Palcom vľavo zatáčaš, vpravo plyn a brzda (drž brzdu = cúvanie). Riadenie zmeníš v pauze.'
        : 'Páčkou ukáž, kam chceš ísť, auto sa rozbehne samo. BRZDA, RUČNÁ, N₂O vpravo. Riadenie zmeníš v pauze.',
  },
];
/** which tip a control's use finishes */
const DONE_BY: Record<string, string> = { stick: 'stick', fire: 'fire', map: 'map', pause: 'map', use: 'use', brake: 'car', pedal: 'car' };
/** seconds a tip stays up at most */
const SHOW_FOR = 9;

const store = setting<string[]>('touch-tips-v1', [], (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'));

export class TouchTips {
  private done = new Set(store.get());
  private cur: Tip | null = null;
  private t = 0;
  private bubble: HTMLElement;
  private rotate: HTMLElement;
  private rotateSeen = false;
  private rotateT = 0;

  constructor(private g: Game, private tc: TouchControls) {
    this.bubble = document.createElement('div');
    this.bubble.className = 't-tip off';
    this.bubble.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.cur) this.finish(this.cur.id);
    });
    this.rotate = document.createElement('div');
    this.rotate.className = 't-rotate off';
    this.rotate.textContent = '📱⟳ Na šírku sa hrá lepšie';
    this.rotate.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.rotateSeen = true;
    });
    tc.root.append(this.bubble, this.rotate);
  }

  /** a control was used: finish the tip it teaches */
  did(control: string) {
    const id = DONE_BY[control];
    if (id) this.finish(id);
  }

  /** show the tips again from the start */
  reset() {
    this.done.clear();
    store.set([]);
  }

  private finish(id: string) {
    if (this.done.has(id)) return;
    this.done.add(id);
    store.set([...this.done]);
    if (this.cur?.id === id) this.cur = null;
  }

  update() {
    const g = this.g;
    const dt = 1 / 60;
    const playing = this.tc.root.dataset.ctx !== 'off' && this.tc.root.dataset.ctx !== 'map';
    // the rotate hint: held upright, once a session, a few seconds
    const upright = playing && g.layout.portrait && !this.rotateSeen;
    if (upright) {
      this.rotateT += dt;
      if (this.rotateT > 6) this.rotateSeen = true;
    }
    this.rotate.classList.toggle('off', !upright);
    // the current tip: still relevant, still on screen for a while
    if (this.cur && (!playing || !this.cur.when(g))) this.cur = null;
    if (!this.cur && playing) {
      this.cur = TIPS.find((t) => !this.done.has(t.id) && t.when(g)) ?? null;
      this.t = 0;
      if (this.cur) this.bubble.textContent = this.cur.text(g);
    }
    if (this.cur) {
      this.t += dt;
      if (this.t > SHOW_FOR) this.finish(this.cur.id);
    }
    const tip = this.cur;
    const anchor = tip ? (tip.at === 'idle' ? this.tc.root.querySelector<HTMLElement>('.t-idle') : this.tc.element(tip.at)) : null;
    if (!tip || !anchor || anchor.classList.contains('off')) {
      this.bubble.classList.add('off');
      return;
    }
    this.bubble.classList.remove('off');
    // above the control, nudged onto the screen
    const r = anchor.getBoundingClientRect();
    const bw = this.bubble.offsetWidth, bh = this.bubble.offsetHeight;
    const x = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    const below = r.top - bh - 12 < 8;
    const y = below ? r.bottom + 12 : r.top - bh - 12;
    this.bubble.style.transform = `translate(${x}px, ${y}px)`;
  }
}
