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

// fragment shaders keep colour maths at mediump but every texture coordinate at highp where the GPU
// has it: on GPUs that really run mediump at 16 bits (Mali, most Adreno, PowerVR) a coordinate in
// [0.5, 1) is only good to 1/2048, which resamples a phone-sized canvas by up to half a texel
const HP_DEFINE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define HP highp
#else
#define HP mediump
#endif
precision mediump float;`;

// vSrc: where a screen position reads the world canvas. Its upload is stored top row first (no
// UNPACK_FLIP_Y, which can cost an extra copy on some browsers), so v is flipped, here per vertex
// rather than per pixel
const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
varying vec2 vSrc;
void main() {
  vUv = aPos * 0.5 + 0.5;
  vSrc = vec2(vUv.x, 1.0 - vUv.y);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const BRIGHT_SRC = `${HP_DEFINE}
varying HP vec2 vSrc;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uBoost;
void main() {
  vec3 c = texture2D(uTex, vSrc).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float b = clamp((l - uThreshold) / max(1.0 - uThreshold, 0.001), 0.0, 4.0);
  gl_FragColor = vec4(c * b * uBoost, 1.0);
}`;

// separable blur; reading a level twice this one's size, its centre tap lands between four texels
// and so downsamples it (a 2x2 box) on the way
const BLUR_SRC = `${HP_DEFINE}
varying HP vec2 vUv;
uniform sampler2D uTex;
uniform HP vec2 uDir;
void main() {
  vec3 sum = texture2D(uTex, vUv).rgb * 0.227027;
  HP vec2 o1 = uDir * 1.3846153846, o2 = uDir * 3.2307692308;
  sum += texture2D(uTex, vUv + o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUv - o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUv + o2).rgb * 0.0702702703;
  sum += texture2D(uTex, vUv - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}`;

// two bloom levels weighted into one, so the full-resolution composite reads one bloom texture
const COMBINE_SRC = `${HP_DEFINE}
varying HP vec2 vUv;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uWA, uWB;
void main() {
  gl_FragColor = vec4(texture2D(uA, vUv).rgb * uWA + texture2D(uB, vUv).rgb * uWB, 1.0);
}`;

// The composite comes in two builds of this one source: without FX (nearly every frame) it has none of
// the shockwave, speed blur, aberration and slow-mo code, which mobile compilers would otherwise size
// their registers for; with FX it's the whole thing. Each effect's own threshold picks the build, so
// the image is the same either way.
const COMPOSITE_SRC = `${HP_DEFINE}
varying HP vec2 vUv;
varying HP vec2 vSrc;
uniform sampler2D uTex;
uniform sampler2D uBloom;
uniform float uBloomStrength;
uniform float uAberration;
uniform vec4 uFlash;
uniform float uSpeed;
uniform float uSlowmo;
uniform HP vec4 uShock0, uShock1, uShock2, uShock3;
uniform HP float uAspect;
uniform float uGrainAmt;
uniform float uSharpen;
uniform HP float uTime;
uniform HP vec2 uTexel;
uniform vec3 uLift, uGain;
uniform vec2 uInvGammaRB;
uniform float uGrade;
uniform float uSaturation;
uniform float uVignette;

#define SRC(p) texture2D(uTex, vec2((p).x, 1.0 - (p).y))

#ifdef FX
HP vec2 applyShock(HP vec2 uv, HP vec4 s) {
  if (s.w <= 0.0) return uv;
  HP vec2 d = uv - s.xy;
  d.x *= uAspect;
  HP float dist = length(d);
  HP float fall = (1.0 - smoothstep(0.0, 0.14, abs(dist - s.z))) * s.w;
  HP vec2 dir = dist > 0.0001 ? d / dist : vec2(0.0);
  dir.x /= uAspect;
  return uv + dir * fall * 0.05;
}
#endif

float grainRand(HP vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  HP vec2 uv = vUv;
#ifdef FX
  uv = applyShock(uv, uShock0);
  uv = applyShock(uv, uShock1);
  uv = applyShock(uv, uShock2);
  uv = applyShock(uv, uShock3);

  HP vec2 toC = vec2(0.5) - uv;

  vec3 base;
  if (uSpeed > 0.02) {
    vec3 sum = vec3(0.0);
    const int N = 6;
    for (int i = 0; i < N; i++) {
      float t = float(i) / float(N - 1);
      sum += SRC(uv + toC * uSpeed * 0.16 * t).rgb;
    }
    base = sum / float(N);
  } else {
    base = SRC(uv).rgb;
  }

  if (uSharpen > 0.001) {
    vec3 n = SRC(uv + vec2(0.0, uTexel.y)).rgb;
    vec3 s = SRC(uv - vec2(0.0, uTexel.y)).rgb;
    vec3 e = SRC(uv + vec2(uTexel.x, 0.0)).rgb;
    vec3 w = SRC(uv - vec2(uTexel.x, 0.0)).rgb;
    base += (base - (n + s + e + w) * 0.25) * uSharpen;
  }

  vec3 col = base;
  if (uAberration > 0.001) {
    HP vec2 dir = length(toC) > 0.0001 ? normalize(-toC) : vec2(0.0);
    HP float amt = uAberration * 0.006;
    col.r = SRC(uv + dir * amt).r;
    col.b = SRC(uv - dir * amt).b;
  }
#else
  vec3 base = texture2D(uTex, vSrc).rgb;
  if (uSharpen > 0.001) {
    // (the same four taps as SRC(uv +- texel): v is flipped)
    vec3 n = texture2D(uTex, vSrc - vec2(0.0, uTexel.y)).rgb;
    vec3 s = texture2D(uTex, vSrc + vec2(0.0, uTexel.y)).rgb;
    vec3 e = texture2D(uTex, vSrc + vec2(uTexel.x, 0.0)).rgb;
    vec3 w = texture2D(uTex, vSrc - vec2(uTexel.x, 0.0)).rgb;
    base += (base - (n + s + e + w) * 0.25) * uSharpen;
  }
  vec3 col = base;
#endif

  col += texture2D(uBloom, uv).rgb * uBloomStrength;

  // lift / gamma / gain colour grade (green's gamma is always 1, and a neutral grade is skipped;
  // the clamp stays: the sharpen can take a channel below 0)
  if (uGrade > 0.5) col = col + uLift * (1.0 - col);
  col = max(col, 0.0001);
  if (uGrade > 0.5) {
    col.rb = pow(col.rb, uInvGammaRB);
    col = col * uGain;
  }

  if (uSaturation < 1.0) {
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, uSaturation);
  }

#ifdef FX
  if (uSlowmo > 0.001) {
    float l2 = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l2) * vec3(0.82, 0.9, 1.08), uSlowmo * 0.85);
  }
#endif

  if (uFlash.a > 0.0) col = mix(col, uFlash.rgb, uFlash.a);

  HP vec2 vd = uv - 0.5;
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

/** the bloom levels are summed into one texture scaled by this, so the sum (up to 1.11) fits 8 bits */
const BLOOM_K = 0.85;
/** each bloom level's weight in the composite at tier 2 (half, quarter, eighth) */
const BLOOM_W = [0.55, 0.32, 0.24] as const;
const COMPOSITE_UNIFORMS = [
  'uBloomStrength', 'uAberration', 'uFlash', 'uSpeed', 'uSlowmo', 'uShock0', 'uShock1', 'uShock2', 'uShock3',
  'uAspect', 'uGrainAmt', 'uSharpen', 'uTime', 'uTexel', 'uLift', 'uGain', 'uInvGammaRB', 'uGrade', 'uSaturation', 'uVignette',
];

export class PostFX {
  /** true once a usable GL context was created; false if WebGL is unavailable or was lost */
  active = false;
  private gl: GL | null = null;
  /** WebGL2: render targets are invalidated (not cleared) before being drawn over */
  private gl2 = false;
  private canvas: HTMLCanvasElement;
  private worldCanvas: HTMLCanvasElement;
  private w = 0;
  private h = 0;
  /** the world canvas's resolution relative to full (Game.renderScale): the blur keeps its size on screen */
  private scale = 1;
  private quad: WebGLBuffer | null = null;
  private sourceTex: WebGLTexture | null = null;
  private progBright: WebGLProgram | null = null;
  private progBlur: WebGLProgram | null = null;
  private progCombine: WebGLProgram | null = null;
  /** the composite without and with the transient effects (shockwaves, speed blur, aberration, slow-mo) */
  private progBase: WebGLProgram | null = null;
  private progFx: WebGLProgram | null = null;
  private uBright!: Record<string, WebGLUniformLocation | null>;
  private uBlur!: Record<string, WebGLUniformLocation | null>;
  private uCombine!: Record<string, WebGLUniformLocation | null>;
  private uBase!: Record<string, WebGLUniformLocation | null>;
  private uFx!: Record<string, WebGLUniformLocation | null>;
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
  private visible: boolean | null = null;
  /** size the source texture's storage was allocated at; per-frame uploads reuse it via texSubImage2D */
  private srcW = 0;
  private srcH = 0;

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
    this.gl2 = !!gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
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
    // called every frame: only touch style when it actually flips (a style write
    // each frame dirties style recalc even when the value is unchanged in some browsers)
    if (this.visible === on) return;
    this.visible = on;
    this.canvas.style.opacity = on ? '1' : '0';
    this.worldCanvas.style.opacity = on ? '0' : '1';
  }

  private init() {
    const gl = this.gl;
    if (!gl) return;
    this.progBright = link(gl, VERT_SRC, BRIGHT_SRC);
    this.progBlur = link(gl, VERT_SRC, BLUR_SRC);
    this.progCombine = link(gl, VERT_SRC, COMBINE_SRC);
    this.progBase = link(gl, VERT_SRC, COMPOSITE_SRC);
    this.progFx = link(gl, VERT_SRC, '#define FX\n' + COMPOSITE_SRC);
    if (!this.progBright || !this.progBlur || !this.progCombine || !this.progBase || !this.progFx) {
      this.active = false;
      this.setVisible(false);
      return;
    }
    this.uBright = u(gl, this.progBright, ['uTex', 'uThreshold', 'uBoost']);
    this.uBlur = u(gl, this.progBlur, ['uTex', 'uDir']);
    this.uCombine = u(gl, this.progCombine, ['uA', 'uB', 'uWA', 'uWB']);
    this.uBase = u(gl, this.progBase, ['uTex', 'uBloom', ...COMPOSITE_UNIFORMS]);
    this.uFx = u(gl, this.progFx, ['uTex', 'uBloom', ...COMPOSITE_UNIFORMS]);
    // state that never changes (nothing else draws with this context): set once here, and again after a
    // lost context is restored
    gl.useProgram(this.progBright);
    gl.uniform1i(this.uBright.uTex, 0);
    gl.useProgram(this.progBlur);
    gl.uniform1i(this.uBlur.uTex, 0);
    gl.useProgram(this.progCombine);
    gl.uniform1i(this.uCombine.uA, 0);
    gl.uniform1i(this.uCombine.uB, 1);
    for (const [prog, uc] of [[this.progBase, this.uBase], [this.progFx, this.uFx]] as const) {
      gl.useProgram(prog);
      gl.uniform1i(uc.uTex, 0);
      gl.uniform1i(uc.uBloom, 1);
    }
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
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
    const gl = this.gl!;
    // (re)allocate the source texture's storage once per size, so each frame's upload
    // is a texSubImage2D into existing storage rather than a full reallocation
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.w, this.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.srcW = this.w;
    this.srcH = this.h;
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

  /** `w` x `h`: the world canvas's size in pixels; `scale`: its resolution relative to full */
  resize(w: number, h: number, scale = 1) {
    w = Math.max(1, w);
    h = Math.max(1, h);
    this.scale = scale;
    // (a same-size resize would still clear the canvas and reallocate every texture: a hitch)
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
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
    let live = 0;
    for (const s of this.shockwaves) {
      s.age += dt;
      if (s.age < 0.6) this.shockwaves[live++] = s;
    }
    this.shockwaves.length = live;

    if (!this.gl || !this.active || tier === 0 || !this.w || !this.h) {
      this.setVisible(false);
      return false;
    }
    const gl = this.gl;
    this.setVisible(true);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    try {
      if (worldCanvas.width === this.srcW && worldCanvas.height === this.srcH) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, worldCanvas);
      else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, worldCanvas);
        this.srcW = worldCanvas.width;
        this.srcH = worldCanvas.height;
      }
    } catch {
      this.active = false;
      this.setVisible(false);
      return false;
    }

    const night = atmos.night, day = atmos.daylight, rain = atmos.rain, t = atmos.time;
    const golden = Math.max(0, 1 - Math.abs(t - 18.3) / 2.4) * day;
    const warm = Math.max(0, Math.min(1, golden * 0.85 - rain * 0.15));
    const cool = Math.max(0, Math.min(1, night * 0.6 + rain * 0.35 * (1 - night * 0.5)));

    const threshold = 0.85 - night * 0.32;
    const boost = 1.0 + night * 1.6;
    // the bloom, summed into one texture (and how much it was scaled down to fit 8 bits)
    let bloom: WebGLTexture, bloomScale: number;
    if (tier === 2) {
      // a dry day's bloom is faint (strength 0.12): its sharpest level isn't blurred on its own, but
      // only on the way into the next (the difference is a few 1/255ths on a handful of pixels)
      bloom = night < 0.01 && atmos.wet < 0.01 ? this.bloomDay(threshold, boost) : this.bloomFull(threshold, boost);
      bloomScale = 1 / BLOOM_K;
    } else {
      bloom = this.bloomLow(threshold, boost);
      bloomScale = 1;
    }

    // composite to the real canvas
    const fx = this.speedCur > 0.02 || this.aberration > 0.001 || this.shockwaves.length > 0 || this.slowmoCur > 0.001;
    const uc = fx ? this.uFx : this.uBase;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(fx ? this.progFx : this.progBase);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloom);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    const bloomStrength = 0.12 + night * 0.95 + wetGlow(atmos);
    gl.uniform1f(uc.uBloomStrength, bloomStrength * bloomScale);
    if (fx) {
      gl.uniform1f(uc.uAberration, this.aberration);
      gl.uniform1f(uc.uSpeed, this.speedCur);
      gl.uniform1f(uc.uSlowmo, this.slowmoCur);
      const sw = this.shockwaves;
      const shocks = [uc.uShock0, uc.uShock1, uc.uShock2, uc.uShock3];
      for (let i = 0; i < 4; i++) {
        const s = sw[i];
        if (s) gl.uniform4f(shocks[i], s.x, s.y, s.age * 1.4, s.strength * Math.max(0, 1 - s.age / 0.6));
        else gl.uniform4f(shocks[i], 0, 0, 0, 0);
      }
    }
    gl.uniform4f(uc.uFlash, this.flash[0], this.flash[1], this.flash[2], this.flash[3]);
    gl.uniform1f(uc.uAspect, this.w / this.h);
    gl.uniform1f(uc.uGrainAmt, tier === 2 ? 0.028 + rain * 0.01 : 0);
    // (a world drawn at a reduced resolution is upscaled by the browser afterwards: a little more sharpening)
    gl.uniform1f(uc.uSharpen, (tier === 2 ? 0.32 : 0.16) + 0.25 * (1 - this.scale));
    // (the grain's hash in a bounded range: its pattern is new every frame anyway)
    gl.uniform1f(uc.uTime, time % 16);
    gl.uniform2f(uc.uTexel, 1 / this.w, 1 / this.h);
    const grade = warm !== 0 || cool !== 0 || rain !== 0;
    gl.uniform1f(uc.uGrade, grade ? 1 : 0);
    gl.uniform3f(uc.uLift, 0, 0, cool * 0.03 + rain * 0.015);
    gl.uniform2f(uc.uInvGammaRB, 1 / (1 - warm * 0.05), 1 / (1 + cool * 0.04));
    gl.uniform3f(uc.uGain, 1 + warm * 0.07, 1, 1 + cool * 0.09);
    gl.uniform1f(uc.uSaturation, 1 - rain * 0.4 * (1 - night * 0.3));
    gl.uniform1f(uc.uVignette, 0.26 + night * 0.2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  /** draw into a render target that the pass covers completely: tile-based (mobile) GPUs then needn't
   *  load its old contents first */
  private target(fb: WebGLFramebuffer, w: number, h: number) {
    const gl = this.gl!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    if (this.gl2) (gl as unknown as WebGL2RenderingContext).invalidateFramebuffer(gl.FRAMEBUFFER, [gl.COLOR_ATTACHMENT0]);
    else gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** bright pass: the world canvas -> `lvl` */
  private bright(lvl: Level, threshold: number, boost: number) {
    const gl = this.gl!;
    this.target(lvl.fb, lvl.w, lvl.h);
    gl.useProgram(this.progBright);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.uniform1f(this.uBright.uThreshold, threshold);
    gl.uniform1f(this.uBright.uBoost, boost);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** separable blur of `src` into `lvl` (horizontally into its ping, back vertically), `src` being
   *  `lvl` itself or the level twice its size, which the blur downsamples on the way. Blur program bound. */
  private blur(src: WebGLTexture, lvl: Level) {
    const gl = this.gl!;
    const s = this.scale;
    this.target(lvl.pingFb, lvl.w, lvl.h);
    gl.bindTexture(gl.TEXTURE_2D, src);
    gl.uniform2f(this.uBlur.uDir, s / lvl.w, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.target(lvl.fb, lvl.w, lvl.h);
    gl.bindTexture(gl.TEXTURE_2D, lvl.pingTex);
    gl.uniform2f(this.uBlur.uDir, 0, s / lvl.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** `into`'s ping = a * wa + b * wb (both sampled at `into`'s size) */
  private combine(into: Level, a: WebGLTexture, wa: number, b: WebGLTexture, wb: number) {
    const gl = this.gl!;
    this.target(into.pingFb, into.w, into.h);
    gl.useProgram(this.progCombine);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, b);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, a);
    gl.uniform1f(this.uCombine.uWA, wa);
    gl.uniform1f(this.uCombine.uWB, wb);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** tier 2: half, quarter and eighth levels, each blurred, summed (x BLOOM_K) into half's ping */
  private bloomFull(threshold: number, boost: number): WebGLTexture {
    const half = this.half!, quarter = this.quarter!, eighth = this.eighth!;
    this.bright(half, threshold, boost);
    this.gl!.useProgram(this.progBlur);
    this.blur(half.tex, half);
    this.blur(half.tex, quarter);
    this.blur(quarter.tex, eighth);
    this.combine(quarter, quarter.tex, BLOOM_W[1] * BLOOM_K, eighth.tex, BLOOM_W[2] * BLOOM_K);
    this.combine(half, half.tex, BLOOM_W[0] * BLOOM_K, quarter.pingTex, 1);
    return half.pingTex;
  }

  /** tier 2 on a dry day: the half level is only blurred as part of the quarter's; summed into quarter's ping */
  private bloomDay(threshold: number, boost: number): WebGLTexture {
    const half = this.half!, quarter = this.quarter!, eighth = this.eighth!;
    this.bright(half, threshold, boost);
    this.gl!.useProgram(this.progBlur);
    this.blur(half.tex, quarter);
    this.blur(quarter.tex, eighth);
    this.combine(quarter, quarter.tex, (BLOOM_W[0] + BLOOM_W[1]) * BLOOM_K, eighth.tex, BLOOM_W[2] * BLOOM_K);
    return quarter.pingTex;
  }

  /** tier 1: one quarter level (weight 1) */
  private bloomLow(threshold: number, boost: number): WebGLTexture {
    const quarter = this.quarter!;
    this.bright(quarter, threshold, boost);
    this.gl!.useProgram(this.progBlur);
    this.blur(quarter.tex, quarter);
    return quarter.tex;
  }
}

function wetGlow(atmos: AtmosSnapshot) {
  return atmos.wet * (0.3 + atmos.night * 0.5);
}
