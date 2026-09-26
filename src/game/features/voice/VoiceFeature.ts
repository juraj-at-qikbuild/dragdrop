// Client glue for proximity voice chat: settings, the first-enable warning, pause-menu controls, the
// nearby-players modal (mute/report), the speaking-indicator nametag decoration, the HUD mic meter and
// peer count, and the per-frame distance→gain/pan drive. The actual WebRTC mesh lives in VoiceClient.ts;
// this file only ever decides "what should the numbers be right now" and wires up the DOM.
// docs/plans/social-events.md ("Proximity voice", accounts only).
import type { Game } from '../../Game';
import { KEYS } from '../../Input';
import type { NetSimHost } from '../../../net/NetSimHost';
import type { ServerMsg } from '../../../shared/net/protocol';
import { addPauseControl, field, openModal, toast, type ModalButton } from '../../../ui/kit/dom';
import { setting } from '../../../ui/kit/settings';
import { addNametagDecorator } from '../../../render/nametags';
import type { ClientFeature } from '../ClientFeature';
import { VoiceClient } from './VoiceClient';
import { voiceGain, voicePan } from './voiceMath';

type VoiceMode = 'off' | 'ptt' | 'open';
const isVoiceMode = (v: unknown): v is VoiceMode => v === 'off' || v === 'ptt' || v === 'open';
const VOLUME_STEPS = [0, 25, 50, 75, 100];
const isVolumeStep = (v: unknown): v is number => typeof v === 'number' && VOLUME_STEPS.includes(v);
/** a remote audioLevel (0..1, from getSynchronizationSources) above this counts as "speaking" for the
 *  🎙 nametag icon — comfortably above the noise floor of an open (non-DTX-silent) mic */
const SPEAK_THRESHOLD = 0.02;
/** how often the (per-peer, WebRTC-stats-backed) speaking indicator is refreshed */
const SPEAK_POLL_S = 0.1;

export class VoiceFeature implements ClientFeature {
  readonly id = 'voice';
  private client: VoiceClient;
  /** true once this session has actually opened the mic and told the server voice{on:true} — distinct
   *  from the persisted `mode` setting, which survives a reset() (host change) that the live state
   *  does not: after a reconnect the button must show "Vypnutý" and re-run the full enable() flow */
  private active = false;
  private mode = setting<VoiceMode>('voice-mode', 'off', isVoiceMode);
  private device = setting<string>('voice-device', '');
  private volume = setting<number>('voice-volume', 100, isVolumeStep);
  private warned = setting<boolean>('voice-warned', false);
  private mutes = setting<string[]>('voice-mutes', [], (v): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string'));
  /** per peer, refreshed at SPEAK_POLL_S: drives the nametag 🎙 icon and the peers-modal listing */
  private speaking = new Map<number, boolean>();
  /** this frame's distance to each peer (metres), for the peers modal; stale (but harmless) if the
   *  peer's ped hasn't arrived in host.peds yet */
  private peerDist = new Map<number, number>();
  private speakAcc = 0;
  private modeBtn = document.createElement('button');
  private micSelect = document.createElement('select');
  private volBtn = document.createElement('button');
  private peersBtn = document.createElement('button');

  constructor(private game: Game) {
    this.client = new VoiceClient(game.audio, (to, data) => this.net()?.sendVoice({ t: 'voiceSig', to, data }));
    this.buildPauseControls();
    // registered once for the whole page's life (like every other nametag decorator, src/render/nametags.ts)
    addNametagDecorator((playerId) => (this.speaking.get(playerId) ? { icons: ['🎙'] } : null));
  }

  private net(): NetSimHost | null {
    return this.game.host.mode === 'net' ? (this.game.host as NetSimHost) : null;
  }

  // ------------------------------------------------------------------------------------ per-frame
  update(dt: number) {
    const net = this.net();
    if (!net) return;
    this.client.poll();
    if (this.client.micOpen) this.client.setTrackEnabled(this.mode.get() === 'open' || this.game.input.down(KEYS.talk));

    const focus = this.game.focus();
    const myUnderground = this.game.focusLevel() === -1;
    const byPlayer = new Map<number, { x: number; y: number; level: number }>();
    for (const p of this.game.host.peds) if (p.playerId) byPlayer.set(p.playerId, p);
    const volume = this.volume.get() / 100;
    for (const id of this.client.peerIds()) {
      const ped = byPlayer.get(id);
      if (!ped) {
        this.client.applyGain(id, 0, 0);
        continue;
      }
      const dx = ped.x - focus.x, dy = ped.y - focus.y;
      const d = Math.hypot(dx, dy);
      const mismatch = (ped.level === -1) !== myUnderground;
      const muted = this.isMuted(net.tagFor(id)?.nick ?? '');
      this.client.applyGain(id, voiceGain(d, mismatch, muted, volume), voicePan(dx));
      this.peerDist.set(id, d);
    }

    this.speakAcc += dt;
    if (this.speakAcc >= SPEAK_POLL_S) {
      this.speakAcc = 0;
      for (const id of this.client.peerIds()) this.speaking.set(id, this.client.speakingLevel(id) > SPEAK_THRESHOLD);
    }
  }

  drawHud(ctx: CanvasRenderingContext2D) {
    const net = this.net();
    if (!net || !this.active) return;
    const g = this.game;
    const small = g.viewW < 700;
    const pad = small ? 10 : 16;
    const mr = small ? 60 : 88; // Hud.ts's minimap radius: sit just clear of it, still bottom-left
    const x = pad + mr * 2 + 14;
    const y = g.viewH - pad - (small ? 10 : 13);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 ${small ? 12 : 14}px system-ui, sans-serif`;
    const n = this.client.peerIds().length;
    ctx.fillStyle = n > 0 ? '#69f0ae' : 'rgba(255,255,255,0.55)';
    const label = `🎙 ${n}`;
    ctx.fillText(label, x, y);
    const talking = this.client.micOpen && (this.mode.get() === 'open' || g.input.down(KEYS.talk));
    if (talking) {
      const bx = x + ctx.measureText(label).width + 10, bw = 26;
      const level = this.client.micLevel();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(bx, y - 3, bw, 6);
      ctx.fillStyle = '#69f0ae';
      ctx.fillRect(bx, y - 3, bw * Math.min(1, level * 2.2), 6);
    }
    ctx.restore();
  }

  onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'voicePeers':
        this.client.handlePeers(m.add, m.del);
        break;
      case 'voiceIce':
        this.client.setIceServers(m.ice);
        break;
      case 'voiceSig':
        void this.client.handleSignal(m.from, m.data);
        break;
    }
  }

  /** host change (offline↔online) or leaving: the old peer ids are meaningless on the new host, and
   *  offline has no one to talk to anyway — a full stop, same as the explicit "turn it off" button */
  reset() {
    this.active = false;
    this.client.dispose();
    this.speaking.clear();
    this.peerDist.clear();
    this.refreshModeLabel();
  }

  // ------------------------------------------------------------------------------------- enable/off
  private async onModeClick() {
    if (!this.active) return void this.enable();
    if (this.mode.get() === 'ptt') {
      this.mode.set('open');
      this.refreshModeLabel();
      return;
    }
    this.disable();
  }

  private async enable() {
    const net = this.net();
    if (!net) return;
    // scripts/e2e-voice.mjs's only way to reach a real 'account' session: no auth server is wired up
    // in this environment (that's I3's), so it opts a *guest* into voice by combining this narrow,
    // explicit flag with the server's own e2e override of voice_requires_account (RemoteConfig.ts).
    // Inert (and unset) for every real player.
    const e2eGuestOk = (window as unknown as { __voiceE2E?: boolean }).__voiceE2E === true;
    if (!net.account && !e2eGuestOk) return this.explainGuestOnly();
    if (!this.warned.get()) {
      const ok = await this.showWarning();
      if (!ok) return;
      this.warned.set(true);
    }
    this.game.audio.init(); // a user gesture (the button click): safe to (re)start/resume the context
    this.game.audio.ctx?.resume();
    this.game.audio.setVoiceVolume(this.volume.get() / 100);
    try {
      await this.client.openMic(this.device.get() || undefined);
    } catch {
      try {
        await this.client.openMic(); // the saved device may no longer exist: retry with the default
      } catch {
        toast('Mikrofón sa nepodarilo otvoriť.', '#ff8a80');
        return;
      }
    }
    void this.refreshDeviceList();
    this.active = true;
    this.mode.set('ptt'); // always lands on push-to-talk first, regardless of what it was last time
    net.sendVoice({ t: 'voice', on: true });
    this.refreshModeLabel();
  }

  private disable() {
    this.active = false;
    this.mode.set('off');
    this.client.dispose();
    this.net()?.sendVoice({ t: 'voice', on: false });
    this.refreshModeLabel();
  }

  private showWarning(): Promise<boolean> {
    return new Promise((resolve) => {
      let decided = false;
      openModal({
        title: 'Hlasový chat',
        body: 'Hráči v okolí ťa budú počuť. Buď slušný – nahlásiť ťa môžu jedným klikom. Hlasový chat môžeš kedykoľvek vypnúť.',
        buttons: [
          { label: 'Zrušiť', onClick: () => (decided = true) && resolve(false) },
          { label: 'Zapnúť', primary: true, onClick: () => (decided = true) && resolve(true) },
        ],
        onClose: () => {
          if (!decided) resolve(false);
        },
      });
    });
  }

  private explainGuestOnly() {
    const w = window as unknown as { openAccountModal?: () => void };
    const buttons: ModalButton[] = [{ label: 'Zrušiť', onClick: () => {} }];
    if (typeof w.openAccountModal === 'function') {
      const open = w.openAccountModal;
      buttons.push({ label: 'Prihlásiť sa', primary: true, onClick: () => open() });
    }
    openModal({ title: 'Hlasový chat', body: 'Hlasový chat je len pre prihlásených hráčov', buttons });
  }

  // -------------------------------------------------------------------------------- pause-menu UI
  private buildPauseControls() {
    this.modeBtn.type = 'button';
    this.modeBtn.id = 'voice-mode-btn'; // stable hooks for scripts/e2e-voice.mjs
    this.refreshModeLabel();
    this.modeBtn.onclick = () => void this.onModeClick();
    addPauseControl(this.modeBtn, { onlineOnly: true });

    this.micSelect.id = 'voice-mic-select';
    this.micSelect.appendChild(new Option('Mikrofón: predvolený', ''));
    this.micSelect.onchange = () => {
      this.device.set(this.micSelect.value);
      if (this.client.micOpen) void this.client.openMic(this.micSelect.value || undefined);
    };
    addPauseControl(this.micSelect, { onlineOnly: true });

    this.volBtn.type = 'button';
    this.volBtn.id = 'voice-volume-btn';
    this.refreshVolumeLabel();
    this.volBtn.onclick = () => {
      const next = VOLUME_STEPS[(VOLUME_STEPS.indexOf(this.volume.get()) + 1) % VOLUME_STEPS.length];
      this.volume.set(next);
      this.game.audio.setVoiceVolume(next / 100);
      this.refreshVolumeLabel();
    };
    addPauseControl(this.volBtn, { onlineOnly: true });

    this.peersBtn.type = 'button';
    this.peersBtn.id = 'voice-peers-btn';
    this.peersBtn.textContent = 'Hráči v okolí…';
    this.peersBtn.onclick = () => this.openPeersModal();
    addPauseControl(this.peersBtn, { onlineOnly: true });
  }

  private refreshModeLabel() {
    const label = !this.active ? 'Vypnutý' : this.mode.get() === 'open' ? 'Otvorený mikrofón' : 'Stlač V a hovor';
    this.modeBtn.textContent = 'Hlasový chat: ' + label;
  }

  private refreshVolumeLabel() {
    this.volBtn.textContent = `Hlasitosť hlasov: ${this.volume.get()} %`;
  }

  private async refreshDeviceList() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      const cur = this.device.get();
      this.micSelect.innerHTML = '';
      this.micSelect.appendChild(new Option('Predvolený mikrofón', ''));
      for (const d of mics) this.micSelect.appendChild(new Option(d.label || 'Mikrofón', d.deviceId));
      this.micSelect.value = mics.some((d) => d.deviceId === cur) ? cur : '';
    } catch {
      /* enumerateDevices unsupported or blocked: the default-only option still works fine */
    }
  }

  // --------------------------------------------------------------------------------- nearby players
  private isMuted(nick: string): boolean {
    return !!nick && this.mutes.get().includes(nick);
  }

  private toggleMute(nick: string) {
    const cur = this.mutes.get();
    this.mutes.set(cur.includes(nick) ? cur.filter((n) => n !== nick) : [...cur, nick]);
  }

  private openPeersModal() {
    const net = this.net();
    const body = document.createElement('div');
    const ids = this.client.peerIds();
    if (!ids.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Momentálne nie si spojený s nikým nablízko.';
      body.appendChild(p);
    }
    for (const id of ids) {
      const nick = net?.tagFor(id)?.nick ?? 'Hráč #' + id;
      const row = document.createElement('div');
      row.className = 'kit-field';
      const label = document.createElement('span');
      const dist = this.peerDist.get(id);
      label.textContent = `${this.speaking.get(id) ? '🎙 ' : ''}${nick} · ${dist !== undefined ? Math.round(dist) + ' m' : '—'}`;
      row.appendChild(label);
      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      const setMuteLabel = () => (muteBtn.textContent = this.isMuted(nick) ? 'Zapnúť' : 'Stlmiť');
      setMuteLabel();
      muteBtn.onclick = () => {
        this.toggleMute(nick);
        setMuteLabel();
      };
      row.appendChild(muteBtn);
      const reportBtn = document.createElement('button');
      reportBtn.type = 'button';
      reportBtn.textContent = 'Nahlásiť';
      reportBtn.onclick = () => this.reportFlow(id, nick);
      row.appendChild(reportBtn);
      body.appendChild(row);
    }
    openModal({ title: 'Hráči v okolí', body, buttons: [{ label: 'Zavrieť', primary: true, onClick: () => {} }] });
  }

  private reportFlow(id: number, nick: string) {
    const f = field('Dôvod nahlásenia', { placeholder: 'Voliteľné', maxLength: 200 });
    openModal({
      title: 'Nahlásiť ' + nick,
      body: f.el,
      buttons: [
        { label: 'Zrušiť', onClick: () => {} },
        {
          label: 'Nahlásiť', primary: true, danger: true,
          onClick: () => {
            this.net()?.sendVoice({ t: 'report', target: id, reason: f.input.value.slice(0, 200) });
            toast('Nahlásenie odoslané', '#69f0ae');
          },
        },
      ],
    });
  }
}
