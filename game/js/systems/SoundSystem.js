/**
 * SoundSystem — procedural Web Audio API sounds, no audio files needed.
 * Generates beeps, noise bursts, and oscillator effects programmatically.
 */
class SoundSystem {
  constructor() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.35;
      this.masterGain.connect(this.ctx.destination);
      this._engineOsc = null;
      this._engineGain = null;
      this._engineActive = false;
      this._ready = true;
    } catch (e) {
      this._ready = false;
    }
  }

  _ensure() {
    if (!this._ready) return false;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  /** Short noise burst (gunshot, explosion, punch) */
  _noise(duration, gainPeak, filterFreq) {
    if (!this._ensure()) return;
    const bufSize = this.ctx.sampleRate * duration;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1);

    const src = this.ctx.createBufferSource();
    src.buffer = buf;

    const filt = this.ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.value = filterFreq;
    filt.Q.value = 0.8;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gainPeak, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

    src.connect(filt).connect(g).connect(this.masterGain);
    src.start();
    src.stop(this.ctx.currentTime + duration);
  }

  /** Short pitched beep */
  _beep(freq, duration, gainPeak, type = 'square', detune = 0) {
    if (!this._ensure()) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gainPeak, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

    osc.connect(g).connect(this.masterGain);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
  }

  play(id) {
    if (!this._ready) return;
    switch (id) {
      case 'pistol_shot':
        this._noise(0.12, 1.2, 2200);
        this._beep(120, 0.08, 0.4, 'sawtooth');
        break;
      case 'shotgun_shot':
        this._noise(0.25, 2.0, 800);
        this._beep(80, 0.15, 0.5, 'sawtooth');
        break;
      case 'machineGun_shot':
        this._noise(0.06, 0.9, 3000);
        break;
      case 'punch':
        this._noise(0.08, 0.8, 300);
        this._beep(60, 0.05, 0.3, 'sine');
        break;
      case 'pickup':
        this._beep(880, 0.06, 0.3, 'sine');
        setTimeout(() => this._beep(1100, 0.08, 0.3, 'sine'), 60);
        break;
      case 'explosion':
        this._noise(0.8, 3.0, 200);
        this._beep(50, 0.4, 0.6, 'sawtooth');
        break;
      case 'car_start':
        this._beep(180, 0.15, 0.2, 'sawtooth');
        break;
      case 'siren_tick':
        this._beep(800, 0.15, 0.15, 'square');
        setTimeout(() => this._beep(640, 0.15, 0.15, 'square'), 180);
        break;
      case 'npc_hurt':
        this._noise(0.05, 0.3, 1500);
        break;
      case 'star_up':
        this._beep(440, 0.1, 0.2, 'square');
        setTimeout(() => this._beep(330, 0.15, 0.2, 'square'), 120);
        break;
    }
  }

  playWeapon(weaponId) {
    switch (weaponId) {
      case 'pistol':    this.play('pistol_shot'); break;
      case 'shotgun':   this.play('shotgun_shot'); break;
      case 'machineGun': this.play('machineGun_shot'); break;
    }
  }

  // --- Continuous engine sound ---

  startEngine() {
    if (!this._ensure() || this._engineActive) return;
    this._engineOsc = this.ctx.createOscillator();
    this._engineOsc.type = 'sawtooth';
    this._engineOsc.frequency.value = 80;

    // Add a bit of tremolo
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 12;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 8;
    lfo.connect(lfoGain);
    lfoGain.connect(this._engineOsc.frequency);
    lfo.start();

    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 400;

    this._engineGain = this.ctx.createGain();
    this._engineGain.gain.value = 0.12;

    this._engineOsc.connect(filt).connect(this._engineGain).connect(this.masterGain);
    this._engineOsc.start();
    lfo.stop(this.ctx.currentTime + 3600); // stop after 1 hour
    this._engineActive = true;
  }

  stopEngine() {
    if (!this._engineOsc) return;
    try {
      this._engineGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);
      this._engineOsc.stop(this.ctx.currentTime + 0.3);
    } catch (e) {}
    this._engineOsc = null;
    this._engineGain = null;
    this._engineActive = false;
  }

  /** Called every frame with normalized speed (0–1) to pitch the engine */
  setEngineFreq(normalized) {
    if (!this._engineOsc || !this._ready) return;
    const targetFreq = 60 + normalized * 140;
    this._engineOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.05);
  }

  // --- Siren loop for police ---
  _sirenTimer = null;

  startSiren() {
    if (this._sirenTimer) return;
    this._sirenTimer = setInterval(() => this.play('siren_tick'), 360);
  }

  stopSiren() {
    clearInterval(this._sirenTimer);
    this._sirenTimer = null;
  }
}
