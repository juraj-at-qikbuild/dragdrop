/**
 * GPU post-processing for the world canvas: bloom, colour grading, vignette,
 * grain/sharpen and a handful of screen-space effect hooks (damage flash +
 * chromatic aberration, shockwaves, speed blur, slow-mo). WebGL1/2, no libs.
 *
 * Usage (see Game.draw): each frame call `render(worldCanvas, atmosSnapshot,
 * time, qualityTier)`. It uploads the already-drawn 2D world canvas as a
 * texture and re-draws the processed result onto its own canvas, which is
 * stacked visually on top of (and hides) the plain world canvas. When WebGL
 * is unavailable, the context is lost, or `qualityTier` is 0 ("low"), render()
 * returns false and hides itself so the plain 2D canvas + its own vignette
 * show through instead — the caller handles that fallback.
 */

export interface AtmosSnapshot {
  night: number;
  daylight: number;
  rain: number;
  wet: number;
  time: number;
}

type GL = WebGLRenderingContext;

interface Level {
  w: number;
  h: number;
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
  pingTex: WebGLTexture;
  pingFb: WebGLFramebuffer;
}

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BRIGHT_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uBoost;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float b = clamp((l - uThreshold) / max(1.0 - uThreshold, 0.001), 0.0, 4.0);
  gl_FragColor = vec4(c * b * uBoost, 1.0);
}`;

// separable blur; uDir = (0,0) doubles as a cheap passthrough/downsample copy
const BLUR_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec3 sum = texture2D(uTex, vUv).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846153846, o2 = uDir * 3.2307692308;
  sum += texture2D(uTex, vUv + o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUv - o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUv + o2).rgb * 0.0702702703;
  sum += texture2D(uTex, vUv - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

const COMPOSITE_SRC = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uBloom0;
uniform sampler2D uBloom1;
uniform sampler2D uBloom2;
uniform float uBloomW0, uBloomW1, uBloomW2, uBloomStrength;
uniform float uAberration;
uniform vec4 uFlash;
uniform float uSpeed;
uniform float uSlowmo;
uniform vec4 uShock0, uShock1, uShock2, uShock3;
uniform float uAspect;
uniform float uGrainAmt;
uniform float uSharpen;
uniform float uTime;
uniform vec2 uTexel;
uniform vec3 uLift, uGamma, uGain;
uniform float uSaturation;
uniform float uVignette;

vec2 applyShock(vec2 uv, vec4 s) {
  if (s.w <= 0.0) return uv;
  vec2 d = uv - s.xy;
  d.x *= uAspect;
  float dist = length(d);
  float fall = (1.0 - smoothstep(0.0, 0.14, abs(dist - s.z))) * s.w;
  vec2 dir = dist > 0.0001 ? d / dist : vec2(0.0);
  dir.x /= uAspect;
  return uv + dir * fall * 0.05;
}

float grainRand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  uv = applyShock(uv, uShock0);
  uv = applyShock(uv, uShock1);
  uv = applyShock(uv, uShock2);
  uv = applyShock(uv, uShock3);

  vec2 toC = vec2(0.5) - uv;

  vec3 base;
  if (uSpeed > 0.02) {
    vec3 sum = vec3(0.0);
    const int N = 6;
    for (int i = 0; i < N; i++) {
      float t = float(i) / float(N - 1);
      sum += texture2D(uTex, uv + toC * uSpeed * 0.16 * t).rgb;
    }
    base = sum / float(N);
  } else {
    base = texture2D(uTex, uv).rgb;
  }

  if (uSharpen > 0.001) {
    vec3 n = texture2D(uTex, uv + vec2(0.0, uTexel.y)).rgb;
    vec3 s = texture2D(uTex, uv - vec2(0.0, uTexel.y)).rgb;
    vec3 e = texture2D(uTex, uv + vec2(uTexel.x, 0.0)).rgb;
    vec3 w = texture2D(uTex, uv - vec2(uTexel.x, 0.0)).rgb;
    base += (base - (n + s + e + w) * 0.25) * uSharpen;
  }

  vec3 col = base;
  if (uAberration > 0.001) {
    vec2 dir = length(toC) > 0.0001 ? normalize(-toC) : vec2(0.0);
    float amt = uAberration * 0.006;
    col.r = texture2D(uTex, uv + dir * amt).r;
    col.b = texture2D(uTex, uv - dir * amt).b;
  }

  vec3 bloom = texture2D(uBloom0, uv).rgb * uBloomW0
             + texture2D(uBloom1, uv).rgb * uBloomW1
             + texture2D(uBloom2, uv).rgb * uBloomW2;
  col += bloom * uBloomStrength;

  // lift / gamma / gain colour grade
  col = col + uLift * (1.0 - col);
  col = pow(max(col, 0.0001), 1.0 / uGamma);
  col = col * uGain;

  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSaturation);

  if (uSlowmo > 0.001) {
    float l2 = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l2) * vec3(0.82, 0.9, 1.08), uSlowmo * 0.85);
  }

  col = mix(col, uFlash.rgb, uFlash.a);

  vec2 vd = uv - 0.5;
  vd.x *= uAspect;
  float vig = 1.0 - smoothstep(0.32, 0.92, length(vd)) * uVignette;
  col *= vig;

  if (uGrainAmt > 0.001) {
    float g = (grainRand(uv * (uTime + 1.0) * 60.0) - 0.5) * uGrainAmt;
    col += g;
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(gl: GL, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[PostFX] shader compile error:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function link(gl: GL, vsrc: string, fsrc: string): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn('[PostFX] program link error:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function u(gl: GL, p: WebGLProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

interface Shockwave {
  x: number;
  y: number;
  age: number;
  strength: number;
}

export class PostFX {
  /** true once a usable GL context was created; false if WebGL is unavailable or was lost */
  active = false;
  private gl: GL | null = null;
  private canvas: HTMLCanvasElement;
  private worldCanvas: HTMLCanvasElement;
  private w = 0;
  private h = 0;
  private quad: WebGLBuffer | null = null;
  private sourceTex: WebGLTexture | null = null;
  private progBright: WebGLProgram | null = null;
  private progBlur: WebGLProgram | null = null;
  private progComposite: WebGLProgram | null = null;
  private uBright!: Record<string, WebGLUniformLocation | null>;
  private uBlur!: Record<string, WebGLUniformLocation | null>;
  private uComp!: Record<string, WebGLUniformLocation | null>;
  private half: Level | null = null;
  private quarter: Level | null = null;
  private eighth: Level | null = null;

  // effect state
  private aberration = 0;
  private flash: [number, number, number, number] = [0, 0, 0, 0];
  private shockwaves: Shockwave[] = [];
  private speedCur = 0;
  private speedTarget = 0;
  private slowmoCur = 0;
  private slowmoTarget = 0;
  private lastT = -1;

  constructor(canvas: HTMLCanvasElement, worldCanvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.worldCanvas = worldCanvas;
    let gl: GL | null = null;
    try {
      const opts: WebGLContextAttributes = { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'low-power' };
      gl = (canvas.getContext('webgl2', opts) as unknown as GL) || (canvas.getContext('webgl', opts) as GL) || (canvas.getContext('experimental-webgl', opts) as GL);
    } catch {
      gl = null;
    }
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.active = false;
      this.setVisible(false);
    });
    canvas.addEventListener('webglcontextrestored', () => this.init());
    if (gl) this.init();
    else this.setVisible(false);
  }

  private setVisible(on: boolean) {
    this.canvas.style.opacity = on ? '1' : '0';
    this.worldCanvas.style.opacity = on ? '0' : '1';
  }

  private init() {
    const gl = this.gl;
    if (!gl) return;
    this.progBright = link(gl, VERT_SRC, BRIGHT_SRC);
    this.progBlur = link(gl, VERT_SRC, BLUR_SRC);
    this.progComposite = link(gl, VERT_SRC, COMPOSITE_SRC);
    if (!this.progBright || !this.progBlur || !this.progComposite) {
      this.active = false;
      this.setVisible(false);
      return;
    }
    this.uBright = u(gl, this.progBright, ['uTex', 'uThreshold', 'uBoost']);
    this.uBlur = u(gl, this.progBlur, ['uTex', 'uDir']);
    this.uComp = u(gl, this.progComposite, [
      'uTex', 'uBloom0', 'uBloom1', 'uBloom2', 'uBloomW0', 'uBloomW1', 'uBloomW2', 'uBloomStrength',
      'uAberration', 'uFlash', 'uSpeed', 'uSlowmo', 'uShock0', 'uShock1', 'uShock2', 'uShock3',
      'uAspect', 'uGrainAmt', 'uSharpen', 'uTime', 'uTexel', 'uLift', 'uGamma', 'uGain', 'uSaturation', 'uVignette',
    ]);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.active = true;
    if (this.w && this.h) this.buildLevels();
    this.setVisible(true);
  }

  private makeLevel(w: number, h: number): Level {
    const gl = this.gl!;
    const mk = () => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    };
    const a = mk(), b = mk();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { w, h, tex: a.tex, fb: a.fb, pingTex: b.tex, pingFb: b.fb };
  }

  private freeLevel(l: Level | null) {
    if (!l || !this.gl) return;
    const gl = this.gl;
    gl.deleteTexture(l.tex);
    gl.deleteTexture(l.pingTex);
    gl.deleteFramebuffer(l.fb);
    gl.deleteFramebuffer(l.pingFb);
  }

  private buildLevels() {
    this.freeLevel(this.half);
    this.freeLevel(this.quarter);
    this.freeLevel(this.eighth);
    const hw = Math.max(2, this.w >> 1), hh = Math.max(2, this.h >> 1);
    const qw = Math.max(2, this.w >> 2), qh = Math.max(2, this.h >> 2);
    const ew = Math.max(2, this.w >> 3), eh = Math.max(2, this.h >> 3);
    this.half = this.makeLevel(hw, hh);
    this.quarter = this.makeLevel(qw, qh);
    this.eighth = this.makeLevel(ew, eh);
  }

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    if (this.gl && this.active) this.buildLevels();
  }

  // ------------------------------------------------------------ effect API
  pulse(opts: { aberration?: number; flash?: [number, number, number, number] }) {
    if (opts.aberration) this.aberration = Math.max(this.aberration, opts.aberration);
    if (opts.flash) this.flash = [...opts.flash];
  }
  shockwave(screenX: number, screenY: number, strength: number) {
    if (!this.w || !this.h) return;
    if (this.shockwaves.length >= 4) this.shockwaves.shift();
    this.shockwaves.push({ x: screenX / this.w, y: 1 - screenY / this.h, age: 0, strength: Math.max(0.1, strength) });
  }
  speed(amount: number) {
    this.speedTarget = Math.max(0, Math.min(1, amount));
  }
  setSlowmo(amount: number) {
    this.slowmoTarget = Math.max(0, Math.min(1, amount));
  }

  // ---------------------------------------------------------------- render
  /** Returns true if it drew the processed frame; false means "use the 2D fallback". */
  render(worldCanvas: HTMLCanvasElement, atmos: AtmosSnapshot, time: number, tier: 0 | 1 | 2): boolean {
    const dt = this.lastT < 0 ? 0 : Math.max(0, Math.min(0.05, time - this.lastT));
    this.lastT = time;
    this.aberration = Math.max(0, this.aberration - dt * 5);
    this.flash[3] = Math.max(0, this.flash[3] - dt * 3.2);
    this.speedCur += (this.speedTarget - this.speedCur) * Math.min(1, dt * 6);
    this.slowmoCur += (this.slowmoTarget - this.slowmoCur) * Math.min(1, dt * 4);
    for (const s of this.shockwaves) s.age += dt;
    this.shockwaves = this.shockwaves.filter((s) => s.age < 0.6);

    if (!this.gl || !this.active || tier === 0 || !this.w || !this.h) {
      this.setVisible(false);
      return false;
    }
    const gl = this.gl;
    this.setVisible(true);

    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, worldCanvas);
    } catch {
      this.active = false;
      this.setVisible(false);
      return false;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const night = atmos.night, day = atmos.daylight, rain = atmos.rain, t = atmos.time;
    const golden = Math.max(0, 1 - Math.abs(t - 18.3) / 2.4) * day;
    const warm = Math.max(0, Math.min(1, golden * 0.85 - rain * 0.15));
    const cool = Math.max(0, Math.min(1, night * 0.6 + rain * 0.35 * (1 - night * 0.5)));

    const threshold = 0.85 - night * 0.32;
    const boost = 1.0 + night * 1.6;
    if (tier === 2) {
      this.bloomChain([this.half!, this.quarter!, this.eighth!], threshold, boost);
    } else {
      this.bloomChain([this.quarter!], threshold, boost);
    }

    // composite to the real canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(this.progComposite);
    const uc = this.uComp;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.uniform1i(uc.uTex, 0);
    const lvl0 = tier === 2 ? this.half! : this.quarter!;
    const lvl1 = this.quarter!;
    const lvl2 = tier === 2 ? this.eighth! : this.quarter!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, lvl0.tex);
    gl.uniform1i(uc.uBloom0, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, lvl1.tex);
    gl.uniform1i(uc.uBloom1, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, lvl2.tex);
    gl.uniform1i(uc.uBloom2, 3);
    if (tier === 2) {
      gl.uniform1f(uc.uBloomW0, 0.55);
      gl.uniform1f(uc.uBloomW1, 0.32);
      gl.uniform1f(uc.uBloomW2, 0.24);
    } else {
      gl.uniform1f(uc.uBloomW0, 0);
      gl.uniform1f(uc.uBloomW1, 1.0);
      gl.uniform1f(uc.uBloomW2, 0);
    }
    const bloomStrength = 0.12 + night * 0.95 + wetGlow(atmos);
    gl.uniform1f(uc.uBloomStrength, bloomStrength);
    gl.uniform1f(uc.uAberration, this.aberration);
    gl.uniform4f(uc.uFlash, this.flash[0], this.flash[1], this.flash[2], this.flash[3]);
    gl.uniform1f(uc.uSpeed, this.speedCur);
    gl.uniform1f(uc.uSlowmo, this.slowmoCur);
    const sw = this.shockwaves;
    const packShock = (i: number): [number, number, number, number] => {
      const s = sw[i];
      if (!s) return [0, 0, 0, 0];
      const radius = s.age * 1.4;
      const fadeOut = Math.max(0, 1 - s.age / 0.6);
      return [s.x, s.y, radius, s.strength * fadeOut];
    };
    const [s0x, s0y, s0z, s0w] = packShock(0); gl.uniform4f(uc.uShock0, s0x, s0y, s0z, s0w);
    const [s1x, s1y, s1z, s1w] = packShock(1); gl.uniform4f(uc.uShock1, s1x, s1y, s1z, s1w);
    const [s2x, s2y, s2z, s2w] = packShock(2); gl.uniform4f(uc.uShock2, s2x, s2y, s2z, s2w);
    const [s3x, s3y, s3z, s3w] = packShock(3); gl.uniform4f(uc.uShock3, s3x, s3y, s3z, s3w);
    gl.uniform1f(uc.uAspect, this.w / this.h);
    gl.uniform1f(uc.uGrainAmt, tier === 2 ? 0.028 + rain * 0.01 : 0);
    gl.uniform1f(uc.uSharpen, tier === 2 ? 0.32 : 0.16);
    gl.uniform1f(uc.uTime, time);
    gl.uniform2f(uc.uTexel, 1 / this.w, 1 / this.h);
    gl.uniform3f(uc.uLift, 0, 0, cool * 0.03 + rain * 0.015);
    gl.uniform3f(uc.uGamma, 1 - warm * 0.05, 1, 1 + cool * 0.04);
    gl.uniform3f(uc.uGain, 1 + warm * 0.07, 1, 1 + cool * 0.09);
    gl.uniform1f(uc.uSaturation, 1 - rain * 0.4 * (1 - night * 0.3));
    gl.uniform1f(uc.uVignette, 0.26 + night * 0.2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  private bloomChain(levels: Level[], threshold: number, boost: number) {
    const gl = this.gl!;
    // bright-pass: source -> first (largest) level
    const first = levels[0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, first.fb);
    gl.viewport(0, 0, first.w, first.h);
    gl.useProgram(this.progBright);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.uniform1i(this.uBright.uTex, 0);
    gl.uniform1f(this.uBright.uThreshold, threshold);
    gl.uniform1f(this.uBright.uBoost, boost);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    for (let i = 0; i < levels.length; i++) {
      const lvl = levels[i];
      if (i > 0) {
        // downsample the previous level into this one (blur shader, dir=0 = plain copy)
        gl.bindFramebuffer(gl.FRAMEBUFFER, lvl.fb);
        gl.viewport(0, 0, lvl.w, lvl.h);
        gl.useProgram(this.progBlur);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, levels[i - 1].tex);
        gl.uniform1i(this.uBlur.uTex, 0);
        gl.uniform2f(this.uBlur.uDir, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
      // 2-pass separable blur in place (tex -> pingTex -> tex)
      gl.useProgram(this.progBlur);
      gl.uniform1i(this.uBlur.uTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, lvl.pingFb);
      gl.viewport(0, 0, lvl.w, lvl.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, lvl.tex);
      gl.uniform2f(this.uBlur.uDir, 1 / lvl.w, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, lvl.fb);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, lvl.pingTex);
      gl.uniform2f(this.uBlur.uDir, 0, 1 / lvl.h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }
}

function wetGlow(atmos: AtmosSnapshot) {
  return atmos.wet * (0.3 + atmos.night * 0.5);
}
