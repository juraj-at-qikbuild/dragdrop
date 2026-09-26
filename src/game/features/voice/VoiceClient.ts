// The WebRTC mesh itself: one RTCPeerConnection per linked peer (server/src/features/Voice.ts decides
// who), perfect negotiation (MDN) using the server-assigned `polite` flag, Opus DTX/FEC + a bitrate
// cap, and the Chrome/iOS playback workarounds. Entirely peer-to-peer once connected — audio never
// touches the server. docs/plans/social-events.md ("Proximity voice"), and the researched facts in the
// plan (Chrome's muted-<audio>-element requirement, iOS's read-only HTMLMediaElement.volume, perfect
// negotiation, Opus fmtp params).
import type { Audio as GameAudio } from '../../../audio/Audio';
import type { IceServer, VoiceSignal } from '../../../shared/net/protocol';
import { mungeOpusFec } from './sdp';

/** Cloudflare/STUN round-trip plus DTLS handshake normally finishes in ~1-3s; well past 10s, the NAT
 *  pair almost certainly won't work without help this connection doesn't have (no TURN, symmetric NAT) */
const CONNECT_TIMEOUT_MS = 10_000;
/** after giving up, wait this long before trying the same peer again (a still-linked pair keeps
 *  getting `add`-ed on every pairing tick otherwise, hammering a connection that just won't form) */
const RETRY_BACKOFF_MS = 60_000;
const MAX_BITRATE = 24_000;
const MIC_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

interface Peer {
  id: number;
  polite: boolean;
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  restartedOnce: boolean;
  connectingSince: number;
  /** Chrome workaround: a remote track routed only into Web Audio can go silent unless the same
   *  stream is also attached to a *muted* media element, kept alive for as long as the peer exists */
  audioEl: HTMLAudioElement;
  source: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  pan: StereoPannerNode | null;
}

export type SendSignal = (to: number, data: VoiceSignal) => void;

export class VoiceClient {
  private peers = new Map<number, Peer>();
  private backoff = new Map<number, { polite: boolean; until: number }>();
  private iceServers: IceServer[] = [];
  private localStream: MediaStream | null = null;
  private localTrack: MediaStreamTrack | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private micBuf: Uint8Array<ArrayBuffer> | null = null;

  constructor(
    private audio: GameAudio,
    private sendSignal: SendSignal,
  ) {}

  setIceServers(ice: IceServer[]) {
    this.iceServers = ice;
  }

  get micOpen() {
    return !!this.localTrack;
  }

  /** Opens (or, given a running mic, switches) the microphone. Must be called from a user gesture. */
  async openMic(deviceId?: string): Promise<void> {
    const constraints: MediaStreamConstraints = { audio: deviceId ? { ...MIC_CONSTRAINTS, deviceId: { exact: deviceId } } : MIC_CONSTRAINTS };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = stream;
    this.localTrack = stream.getAudioTracks()[0] ?? null;
    // iOS 17+: without this, opening the mic can silently duck/stop concurrent game audio playback
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'play-and-record';
    this.setupMicMeter(stream);
    for (const peer of this.peers.values()) await this.attachLocalTrack(peer);
  }

  closeMic() {
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.localTrack = null;
    this.micAnalyser = null;
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio' || !s.track);
      void sender?.replaceTrack(null).catch(() => {});
    }
  }

  /** push-to-talk: mute/unmute the outgoing track without touching the connection (still transmits
   *  silence, so Opus DTX — usedtx=1 — is what actually saves the bandwidth while it's muted) */
  setTrackEnabled(on: boolean) {
    if (this.localTrack) this.localTrack.enabled = on;
  }

  /** local mic level (RMS, 0..1) for the HUD meter; 0 while the mic is closed */
  micLevel(): number {
    if (!this.micAnalyser || !this.micBuf) return 0;
    this.micAnalyser.getByteTimeDomainData(this.micBuf);
    let sum = 0;
    for (const v of this.micBuf) {
      const n = (v - 128) / 128;
      sum += n * n;
    }
    return Math.sqrt(sum / this.micBuf.length);
  }

  private setupMicMeter(stream: MediaStream) {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const src = ctx.createMediaStreamSource(stream);
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 512;
    this.micBuf = new Uint8Array(this.micAnalyser.fftSize);
    src.connect(this.micAnalyser); // never connected onward: we don't want to hear ourselves
  }

  // ---------------------------------------------------------------------------------- peers/signals
  handlePeers(add: { id: number; polite: boolean }[], del: number[]) {
    for (const id of del) {
      this.backoff.delete(id);
      this.closePeer(id);
    }
    for (const a of add) this.ensurePeer(a.id, a.polite);
  }

  async handleSignal(from: number, data: VoiceSignal) {
    const peer = this.peers.get(from);
    if (!peer || !data || typeof data !== 'object') return;
    const pc = peer.pc;
    try {
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        if (collision) await Promise.all([pc.setLocalDescription({ type: 'rollback' }), pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit)]);
        else await pc.setRemoteDescription(data.sdp as RTCSessionDescriptionInit);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          if (answer.sdp) answer.sdp = mungeOpusFec(answer.sdp);
          await pc.setLocalDescription(answer);
          this.sendSignal(peer.id, { sdp: { type: answer.type, sdp: pc.localDescription?.sdp } });
        }
      } else if (data.ice) {
        try {
          await pc.addIceCandidate(data.ice);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      console.error('voice: signal handling failed', e);
    }
  }

  /** every peer id currently known (connecting or connected; not ones backing off) */
  peerIds(): number[] {
    return [...this.peers.keys()];
  }

  connectionState(id: number): RTCPeerConnectionState | null {
    return this.peers.get(id)?.pc.connectionState ?? null;
  }

  /** remote speaking level (0..1), from the RTP receiver's synchronization source — cheap enough to
   *  poll but callers should still throttle to ~10 Hz (see VoiceFeature) since it's per peer */
  speakingLevel(id: number): number {
    const peer = this.peers.get(id);
    const receiver = peer?.pc.getReceivers().find((r) => r.track.kind === 'audio');
    const src = receiver?.getSynchronizationSources?.()[0];
    return src?.audioLevel ?? 0;
  }

  /** applies this frame's distance-driven gain/pan for one peer (VoiceFeature computes the numbers —
   *  see voiceMath.ts — this just writes them to the audio graph, smoothed to avoid zipper noise) */
  applyGain(id: number, gain: number, pan: number) {
    const peer = this.peers.get(id);
    const ctx = this.audio.ctx;
    if (!peer?.gain || !peer.pan || !ctx) return;
    peer.gain.gain.setTargetAtTime(gain, ctx.currentTime, 0.08);
    peer.pan.pan.setTargetAtTime(pan, ctx.currentTime, 0.08);
  }

  /** call every so often (VoiceFeature.update): times out a peer stuck connecting, and retries one
   *  that finished backing off */
  poll(now = performance.now()) {
    for (const [id, peer] of this.peers) {
      if (peer.pc.connectionState === 'connected') continue;
      if (peer.pc.connectionState === 'failed' || now - peer.connectingSince > CONNECT_TIMEOUT_MS) {
        const polite = peer.polite;
        this.closePeer(id);
        this.backoff.set(id, { polite, until: now + RETRY_BACKOFF_MS });
      }
    }
    for (const [id, bo] of this.backoff) {
      if (now >= bo.until) {
        this.backoff.delete(id);
        this.createPeer(id, bo.polite);
      }
    }
  }

  dispose() {
    this.closeMic();
    this.closePeers();
  }

  /** drop every peer connection but keep the mic open (a reconnect: the server re-pairs from scratch) */
  closePeers() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    this.backoff.clear();
  }

  // ------------------------------------------------------------------------------------- internals
  private ensurePeer(id: number, polite: boolean) {
    if (this.peers.has(id)) return;
    const bo = this.backoff.get(id);
    if (bo && bo.until > performance.now()) return; // still backing off; poll() retries it later
    this.backoff.delete(id);
    this.createPeer(id, polite);
  }

  private createPeer(id: number, polite: boolean) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    const audioEl = new Audio();
    audioEl.muted = true;
    audioEl.autoplay = true;
    const peer: Peer = { id, polite, pc, makingOffer: false, ignoreOffer: false, restartedOnce: false, connectingSince: performance.now(), audioEl, source: null, gain: null, pan: null };
    this.peers.set(id, peer);
    if (this.localTrack && this.localStream) pc.addTrack(this.localTrack, this.localStream);
    this.capBitrate(pc);
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        const offer = await pc.createOffer();
        if (offer.sdp) offer.sdp = mungeOpusFec(offer.sdp);
        await pc.setLocalDescription(offer);
        this.sendSignal(id, { sdp: { type: offer.type, sdp: pc.localDescription?.sdp } });
      } catch (e) {
        console.error('voice: negotiation failed', e);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal(id, { ice: { candidate: candidate.candidate, sdpMid: candidate.sdpMid, sdpMLineIndex: candidate.sdpMLineIndex, usernameFragment: candidate.usernameFragment } });
    };
    pc.ontrack = (e) => this.attachRemote(peer, e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !peer.polite && !peer.restartedOnce) {
        peer.restartedOnce = true;
        pc.restartIce();
      }
    };
    return peer;
  }

  private async attachLocalTrack(peer: Peer) {
    if (!this.localTrack) return;
    const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio' || !s.track);
    if (sender) await sender.replaceTrack(this.localTrack).catch(() => {});
    else if (this.localStream) peer.pc.addTrack(this.localTrack, this.localStream);
    this.capBitrate(peer.pc);
  }

  private capBitrate(pc: RTCPeerConnection) {
    const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = MAX_BITRATE;
      void sender.setParameters(params).catch(() => {});
    } catch {
      /* some browsers reject getParameters() before the first negotiation: harmless, not critical */
    }
  }

  private attachRemote(peer: Peer, stream: MediaStream) {
    peer.audioEl.srcObject = stream;
    void peer.audioEl.play().catch(() => {});
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    gain.gain.value = 0; // ramps up once VoiceFeature starts computing a real distance each frame
    const pan = ctx.createStereoPanner();
    source.connect(gain).connect(pan);
    if (this.audio.voiceBus) pan.connect(this.audio.voiceBus);
    peer.source = source;
    peer.gain = gain;
    peer.pan = pan;
  }

  private closePeer(id: number) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.audioEl.pause();
    peer.audioEl.srcObject = null;
    peer.source?.disconnect();
    peer.gain?.disconnect();
    peer.pan?.disconnect();
    this.peers.delete(id);
  }
}
