import type { RadioStation } from '../data/brands';
import type { WeaponId } from '../entities/Ped';

/** Fully procedural WebAudio sound: engine, siren, weapons and chiptune radio. */
export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain!: GainNode;
  private noise!: AudioBuffer;
  private station: RadioStation | null = null;
  private step = 0;
  private nextTime = 0;
  muted = false;
  private rainSrc: AudioBufferSourceNode | null = null;
  private rainFilter!: BiquadFilterNode;
  private rainGain!: GainNode;
  private rainLevel = 0;
  private rotorSrc: AudioBufferSourceNode | null = null;
  private rotorFilter!: BiquadFilterNode;
  private rotorGain!: GainNode;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(c.destination);
    this.sfx = c.createGain();
    this.sfx.connect(this.master);
    this.music = c.createGain();
    this.music.gain.value = 0.32;
    this.music.connect(this.master);

    const len = c.sampleRate * 1.5;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.engineFilter = c.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineGain = c.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter.connect(this.engineGain).connect(this.sfx);
    this.engineOsc = c.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc2 = c.createOscillator();
    this.engineOsc2.type = 'square';
    this.engineOsc.connect(this.engineFilter);
    this.engineOsc2.connect(this.engineFilter);
    this.engineOsc.start();
    this.engineOsc2.start();

    this.sirenGain = c.createGain();
    this.sirenGain.gain.value = 0;
    this.sirenGain.connect(this.sfx);
    this.sirenOsc = c.createOscillator();
    this.sirenOsc.type = 'triangle';
    this.sirenOsc.connect(this.sirenGain);
    this.sirenOsc.start();

    // rain ambience: filtered looping white noise, gain follows atmos.rain
    this.rainFilter = c.createBiquadFilter();
    this.rainFilter.type = 'bandpass';
    this.rainFilter.frequency.value = 3200;
    this.rainFilter.Q.value = 0.5;
    this.rainGain = c.createGain();
    this.rainGain.gain.value = 0;
    this.rainFilter.connect(this.rainGain).connect(this.sfx);
    this.rainSrc = c.createBufferSource();
    this.rainSrc.buffer = this.noise;
    this.rainSrc.loop = true;
    this.rainSrc.connect(this.rainFilter);
    this.rainSrc.start();

    // police helicopter rotor: filtered noise thump, gain/pitch follow distance
    this.rotorFilter = c.createBiquadFilter();
    this.rotorFilter.type = 'bandpass';
    this.rotorFilter.frequency.value = 85;
    this.rotorFilter.Q.value = 5;
    this.rotorGain = c.createGain();
    this.rotorGain.gain.value = 0;
    this.rotorFilter.connect(this.rotorGain).connect(this.sfx);
    this.rotorSrc = c.createBufferSource();
    this.rotorSrc.buffer = this.noise;
    this.rotorSrc.loop = true;
    this.rotorSrc.connect(this.rotorFilter);
    this.rotorSrc.start();

    window.setInterval(() => this.schedule(), 50);
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.55;
  }

  private now() {
    return this.ctx!.currentTime;
  }

  private noiseBurst(dur: number, freq: number, gain: number, q = 1, type: BiquadFilterType = 'lowpass', when = 0) {
    if (!this.ctx) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    const t = when || this.now();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(when ? this.music : this.sfx);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, when = 0, out?: AudioNode, slide = 0) {
    if (!this.ctx) return;
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = type;
    const t = when || this.now();
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(out ?? this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private vol(d: number) {
    return Math.max(0, 1 - d / 120);
  }

  shot(w: WeaponId, d = 0) {
    const v = this.vol(d);
    if (!v) return;
    if (w === 'shotgun') this.noiseBurst(0.35, 1800, 0.9 * v);
    else if (w === 'uzi') this.noiseBurst(0.08, 3000, 0.45 * v, 1, 'bandpass');
    else this.noiseBurst(0.16, 2500, 0.7 * v);
  }
  explosion(d = 0) {
    const v = this.vol(d * 0.5);
    this.noiseBurst(1.4, 500, 1.2 * v);
    this.tone(90, 0.8, 'sine', 0.6 * v, 0, undefined, 0.3);
  }
  crash(intensity: number) {
    this.noiseBurst(0.25, 900, Math.min(0.9, intensity / 18));
  }
  punch() {
    this.noiseBurst(0.08, 400, 0.6);
  }
  whoosh() {
    this.noiseBurst(0.12, 1200, 0.15, 2, 'bandpass');
  }
  scream() {
    if (!this.ctx) return;
    this.tone(700 + Math.random() * 300, 0.35, 'sawtooth', 0.08, 0, undefined, 0.6);
  }
  pickup() {
    this.tone(880, 0.1, 'square', 0.12);
    this.tone(1320, 0.15, 'square', 0.12, this.ctx ? this.now() + 0.08 : 0);
  }
  cash() {
    [1046, 1318, 1568].forEach((f, i) => this.tone(f, 0.12, 'square', 0.1, this.ctx ? this.now() + i * 0.06 : 0));
  }
  bell() {
    // tram bell: ding-ding
    [0, 0.25].forEach((dt) => this.tone(1760, 0.5, 'sine', 0.3, this.ctx ? this.now() + dt : 0));
  }
  horn() {
    this.tone(415, 0.35, 'square', 0.12);
    this.tone(523, 0.35, 'square', 0.1);
  }
  jingle(good: boolean) {
    const notes = good ? [523, 659, 784, 1046] : [392, 330, 262, 196];
    notes.forEach((f, i) => this.tone(f, 0.25, 'square', 0.15, this.ctx ? this.now() + i * 0.14 : 0));
  }

  engine(speed: number, throttle: number, active: boolean) {
    if (!this.ctx || !this.engineOsc) return;
    const t = this.now();
    const gear = Math.min(4, Math.floor(speed / 11));
    const rpm = 0.25 + ((speed - gear * 11) / 11) * 0.75;
    const f = 38 + rpm * 55 + gear * 6;
    this.engineOsc.frequency.setTargetAtTime(f, t, 0.05);
    this.engineOsc2!.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(250 + throttle * 500 + speed * 12, t, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.13 + Math.abs(throttle) * 0.07 : 0, t, 0.1);
  }

  siren(level: number) {
    if (!this.ctx || !this.sirenOsc) return;
    const t = this.now();
    const f = 650 + Math.sin(t * Math.PI * 1.5) * 220;
    this.sirenOsc.frequency.setTargetAtTime(f, t, 0.03);
    this.sirenGain.gain.setTargetAtTime(level * 0.06, t, 0.2);
  }

  /** Police helicopter rotor thump; `level` 0..1 follows proximity to the player. */
  rotor(level: number) {
    if (!this.ctx || !this.rotorGain) return;
    const t = this.now();
    this.rotorFilter.frequency.setTargetAtTime(80 + level * 25, t, 0.15);
    this.rotorGain.gain.setTargetAtTime(level * 0.2, t, 0.2);
  }

  /** Rain ambience loop; `level` 0..1 follows `atmos.rain`. */
  rain(level: number) {
    if (!this.ctx || !this.rainGain) return;
    this.rainLevel = level;
    const t = this.now();
    this.rainFilter.frequency.setTargetAtTime(2200 + level * 2200, t, 0.8);
    this.rainGain.gain.setTargetAtTime(level * 0.16, t, 0.6);
  }

  thunder() {
    if (!this.ctx) return;
    const v = Math.min(1, 0.5 + this.rainLevel * 0.5);
    this.noiseBurst(1.1, 220, 0.55 * v, 0.7, 'lowpass');
    this.tone(60, 1.0, 'sine', 0.35 * v, 0, undefined, 0.4);
  }

  // ------------------------------------------------------------- radio
  setStation(s: RadioStation | null) {
    this.station = s;
    this.step = 0;
    if (this.ctx) this.nextTime = this.now() + 0.1;
    if (s && this.ctx) this.noiseBurst(0.3, 3000, 0.15, 0.5, 'highpass');
  }

  private schedule() {
    if (!this.ctx || !this.station || this.muted) return;
    const bpm = { pop: 118, dance: 128, folk: 150, talk: 90 }[this.station.style];
    const stepDur = 60 / bpm / 4;
    if (this.nextTime < this.now()) this.nextTime = this.now() + 0.05;
    while (this.nextTime < this.now() + 0.2) {
      this.playStep(this.step, this.nextTime, stepDur);
      this.step++;
      this.nextTime += stepDur;
    }
  }

  private playStep(step: number, t: number, sd: number) {
    const st = this.station!.style;
    const bar = Math.floor(step / 16) % 4;
    const s = step % 16;
    const m = this.music;
    const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
    if (st === 'pop') {
      const prog = [[60, 64, 67], [67, 71, 74], [69, 72, 76], [65, 69, 72]][bar];
      if (s % 4 === 0) this.noiseBurst(0.12, 120, 0.8, 1, 'lowpass', t);
      if (s === 4 || s === 12) this.noiseBurst(0.15, 1800, 0.35, 1, 'bandpass', t);
      if (s % 2 === 0) this.tone(midi(prog[(s / 2) % 3] + 12), sd * 1.8, 'square', 0.05, t, m);
      if (s % 8 === 0) this.tone(midi(prog[0] - 24), sd * 7, 'triangle', 0.25, t, m);
      const mel = [76, 0, 74, 72, 74, 0, 76, 0, 79, 0, 76, 74, 72, 0, 74, 0];
      if (bar % 2 === 1 && mel[s]) this.tone(midi(mel[s]), sd * 1.6, 'triangle', 0.1, t, m);
    } else if (st === 'dance') {
      const roots = [57, 53, 48, 55][bar];
      if (s % 4 === 0) {
        this.tone(150, 0.18, 'sine', 0.9, t, m, 0.3);
      }
      if (s % 4 === 2) this.noiseBurst(0.05, 8000, 0.25, 1, 'highpass', t);
      if (s % 2 === 1) this.tone(midi(roots - 12), sd * 0.9, 'sawtooth', 0.09, t, m);
      if (s === 0 || s === 6 || s === 10) this.tone(midi(roots + 12), sd * 3, 'sawtooth', 0.04, t, m);
    } else if (st === 'folk') {
      // an original folk-style tune in D major, 3/4-ish phrasing
      const tune = [62, 66, 69, 69, 71, 69, 66, 64, 62, 64, 66, 64, 62, 0, 57, 0];
      const tune2 = [69, 71, 73, 74, 73, 71, 69, 66, 67, 66, 64, 62, 64, 0, 62, 0];
      const n = (bar % 2 === 0 ? tune : tune2)[s];
      if (n && s % 1 === 0 && step % 2 === 0) this.tone(midi(n + 12), sd * 2.2, 'square', 0.06, t, m);
      if (s % 4 === 0) this.tone(midi(50 + (bar === 2 ? 5 : 0)), sd * 3, 'triangle', 0.22, t, m);
      if (s % 4 === 2) this.tone(midi(57 + (bar === 2 ? 5 : 0)), sd * 1.5, 'triangle', 0.1, t, m);
    } else {
      if (s === 0 && bar === 0) this.tone(midi(48), sd * 60, 'sine', 0.05, t, m);
      if (s === 8 && bar === 2) this.tone(midi(55), sd * 60, 'sine', 0.04, t, m);
    }
  }
}
