/** Keyboard + mouse + gamepad + simple touch controls. */
export class Input {
  keys = new Set<string>();
  private pressed = new Set<string>();
  mouseX = 0;
  mouseY = 0;
  mouseDown = false;
  private clicked = false;
  /** virtual joystick (touch) in [-1, 1] */
  stick = { x: 0, y: 0, active: false };
  touchButtons = new Set<string>();
  /** mouse-wheel zoom steps since the last `takeWheel` (+ zooms in) */
  private wheel = 0;
  /** The first connected gamepad (standard mapping), read by `pollPad` once a frame: sticks with a
   *  dead zone, analog triggers. `active` while it's the last thing the player touched. */
  pad = { active: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
  /** pad buttons held down as keys (see PAD_HELD) */
  private padKeys = new Set<string>();
  private padButtons: boolean[] = [];

  constructor(canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      const k = e.code;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
      this.pad.active = false;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(k)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    canvas.addEventListener('mousemove', (e) => {
      this.mouseX = e.offsetX;
      this.mouseY = e.offsetY;
      this.pad.active = false;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouseDown = true;
        this.clicked = true;
      }
    });
    addEventListener('mouseup', () => (this.mouseDown = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheel -= Math.sign(e.deltaY);
      },
      { passive: false },
    );
  }

  down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c) || this.touchButtons.has(c) || this.padKeys.has(c));
  }

  /** true once per key press */
  hit(...codes: string[]) {
    let r = false;
    for (const c of codes)
      if (this.pressed.has(c)) {
        this.pressed.delete(c);
        r = true;
      }
    return r;
  }

  takeClick() {
    const c = this.clicked;
    this.clicked = false;
    return c;
  }

  /** mouse-wheel steps since the last call (+ = zoom in) */
  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  press(code: string) {
    this.pressed.add(code);
  }

  endFrame() {
    this.pressed.clear();
    this.clicked = false;
  }

  /** Read the gamepad (call once a frame, before reading input). Buttons act as the keys they stand
   *  in for (PAD_PRESS on the press, PAD_HELD while held), sticks and triggers land in `pad`. */
  pollPad() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const g of pads) if (g && g.connected) (gp ??= g);
    this.padKeys.clear();
    const P = this.pad;
    if (!gp) {
      P.active = false;
      P.lx = P.ly = P.rx = P.ry = P.lt = P.rt = 0;
      return;
    }
    const dz = (v = 0) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
    P.lx = dz(gp.axes[0]);
    P.ly = dz(gp.axes[1]);
    P.rx = dz(gp.axes[2]);
    P.ry = dz(gp.axes[3]);
    P.lt = gp.buttons[6]?.value ?? 0;
    P.rt = gp.buttons[7]?.value ?? 0;
    let any = Math.abs(P.lx) + Math.abs(P.ly) + Math.abs(P.rx) + Math.abs(P.ry) + P.lt + P.rt > 0.05;
    gp.buttons.forEach((b, i) => {
      const was = this.padButtons[i];
      this.padButtons[i] = b.pressed;
      if (!b.pressed) return;
      any = true;
      if (!was && PAD_PRESS[i]) this.pressed.add(PAD_PRESS[i]);
      if (PAD_HELD[i]) this.padKeys.add(PAD_HELD[i]);
    });
    if (any) P.active = true;
  }

  /** Vibrate the pad (dual-rumble where the browser supports it): strong and weak motors 0..1. */
  rumble(strong: number, weak: number, ms: number) {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of pads) {
      const act = (g as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, p: object) => Promise<unknown> } }) | null)?.vibrationActuator;
      if (!g?.connected || !act?.playEffect) continue;
      act.playEffect('dual-rumble', { duration: Math.round(ms), strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
      return;
    }
  }

  /** movement axes: keyboard, touch stick, or the gamepad's left stick */
  axis() {
    let x = 0, y = 0;
    if (this.down('KeyA', 'ArrowLeft')) x -= 1;
    if (this.down('KeyD', 'ArrowRight')) x += 1;
    if (this.down('KeyW', 'ArrowUp')) y -= 1;
    if (this.down('KeyS', 'ArrowDown')) y += 1;
    if (this.stick.active) (x = this.stick.x), (y = this.stick.y);
    else if (this.pad.active && (this.pad.lx || this.pad.ly)) (x = this.pad.lx), (y = this.pad.ly);
    return { x, y };
  }
}

/** Keys of the social features (docs/plans/social-events.md). The horn doubles as the race challenge:
 *  hold it next to another player's car. */
export const KEYS = {
  /** push-to-talk (voice chat) */
  talk: 'KeyV',
  party: 'KeyN',
  jobs: 'KeyJ',
  /** the "Kde to je?" photo card */
  daily: 'KeyK',
  /** downed: give up and go to hospital */
  giveUp: 'KeyG',
  horn: 'KeyH',
} as const;

/** Standard-mapping pad buttons that press a key once: Y enter/exit, X horn, B next weapon, Start
 *  pause, Back map, d-pad up radio, d-pad down map, d-pad right next weapon, d-pad left jobs. */
const PAD_PRESS: Record<number, string> = { 1: 'KeyQ', 2: 'KeyH', 3: 'KeyF', 8: 'KeyM', 9: 'Escape', 12: 'KeyR', 13: 'KeyM', 14: KEYS.jobs, 15: 'KeyQ' };
/** ...and ones held like a key: A sprint (nitro in a car), RB handbrake, LB nitro, L3 push-to-talk */
const PAD_HELD: Record<number, string> = { 0: 'ShiftLeft', 4: 'ShiftLeft', 5: 'Space', 10: KEYS.talk };
