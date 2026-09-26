// Rádio Kecy's breaking news: turns GlobalEvents into Slovak DJ lines (news/lines.ts), rate-limits
// and prioritises them (news/NewsQueue.ts), shows them the way the car radio always has
// (Game.radioText) while driving, and reaches players on foot with a plain toast instead — the HUD's
// radio banner implies a car radio is playing, which isn't true off foot. Optionally reads the line
// aloud with speechSynthesis. Works the same online and offline: both hosts route GlobalEvents
// through ClientEvents.global -> onGlobal (see src/game/ClientEvents.ts).
// Plan: docs/plans/social-events.md ("Rádio Kecy breaking news")
import type { Game } from '../Game';
import type { ClientFeature } from './ClientFeature';
import type { GlobalEvent } from '../../shared/sim/events';
import { placeName } from '../../shared/sim/rules/placeName';
import { formatNews } from './news/lines';
import { NewsQueue } from './news/NewsQueue';
import { RADIO } from '../../data/brands';
import { setting } from '../../ui/kit/settings';
import { addPauseControl, toast } from '../../ui/kit/dom';

/** how long a shown line stays on screen (Game.radioText / the toast), in seconds */
const SHOW_TIME = 8;

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export class News implements ClientFeature {
  readonly id = 'news';
  private queue = new NewsQueue();
  /** pause-menu "Hlásateľ" toggle: read breaking news aloud in the car. Defaults on; not
   *  online-only, since an offline Čumil hunt makes news too. */
  private voiceOn = setting('newsVoice', true, isBool);
  private voice: SpeechSynthesisVoice | null = null;
  private wasInCar = false;
  private wasPaused = false;

  constructor(private g: Game) {
    if (typeof speechSynthesis !== 'undefined') {
      const pickVoice = () => {
        this.voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('sk')) ?? null;
      };
      pickVoice();
      // Chrome (and others) load voices asynchronously; onvoiceschanged fires once they're ready
      speechSynthesis.addEventListener('voiceschanged', pickVoice);
    }
    const btn = document.createElement('button');
    const label = () => `Hlásateľ: ${this.voiceOn.get() ? 'zap.' : 'vyp.'}`;
    btn.textContent = label();
    btn.onclick = () => {
      this.voiceOn.set(!this.voiceOn.get());
      btn.textContent = label();
      if (!this.voiceOn.get()) this.cancelSpeech();
    };
    addPauseControl(btn);
  }

  onGlobal(e: GlobalEvent) {
    const line = formatNews(e, (x, y) => placeName(this.g.world, x, y));
    if (line) this.queue.push(line, performance.now());
  }

  update(_dt: number) {
    const g = this.g;
    const inCar = !!g.player.vehicle;
    // speech shouldn't outlive the moment that made it possible (getting out, opening the menu)
    if ((g.paused && !this.wasPaused) || (this.wasInCar && !inCar)) this.cancelSpeech();
    this.wasInCar = inCar;
    this.wasPaused = g.paused;
    if (g.paused) return;

    const text = this.queue.next(performance.now());
    if (text === null) return;
    // updateInfo's own random DJ chatter must not immediately overwrite this
    g.newsUntil = g.time + SHOW_TIME;
    if (this.radioAudible()) g.radioText = { text: `📻 Rádio Kecy – MIMORIADNE: ${text}`, time: SHOW_TIME };
    else toast(`📻 ${text}`, '#f8bbd0', SHOW_TIME * 1000);
    g.audio.newsSting();
    this.speak(text);
  }

  reset() {
    this.cancelSpeech();
  }

  /** whether the HUD's radio banner currently means anything (a real station, playing in a car the
   *  player is actually driving) — the condition under which it's fair to put news there instead of
   *  a toast (Hud.ts itself draws radioText regardless of this, so News.ts has to decide). */
  private radioAudible(): boolean {
    const g = this.g;
    const v = g.player.vehicle;
    return !!v && v.kind !== 'police' && g.state === 'play';
  }

  private speak(text: string) {
    const g = this.g;
    if (typeof speechSynthesis === 'undefined' || !this.voice || !this.voiceOn.get()) return;
    // in a car, with a real station on, unmuted — same shape as radioAudible() plus the audio side
    const v = g.player.vehicle;
    if (!v || v.kind === 'police' || g.radio >= RADIO.length || g.audio.muted) return;
    const u = new SpeechSynthesisUtterance(text);
    u.voice = this.voice;
    u.lang = this.voice.lang;
    const restore = () => g.audio.duckMusic(false);
    u.onend = restore;
    u.onerror = restore;
    g.audio.duckMusic(true);
    speechSynthesis.cancel(); // one bulletin at a time
    speechSynthesis.speak(u);
  }

  private cancelSpeech() {
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.g.audio.duckMusic(false);
  }
}
