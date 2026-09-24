/** Keyboard + mouse + simple touch controls. */
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

  constructor(canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => {
      const k = e.code;
      if (!this.keys.has(k)) this.pressed.add(k);
      this.keys.add(k);
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
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.mouseDown = true;
        this.clicked = true;
      }
    });
    addEventListener('mouseup', () => (this.mouseDown = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c) || this.touchButtons.has(c));
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

  press(code: string) {
    this.pressed.add(code);
  }

  endFrame() {
    this.pressed.clear();
    this.clicked = false;
  }

  /** movement axes, keyboard or touch stick */
  axis() {
    let x = 0, y = 0;
    if (this.down('KeyA', 'ArrowLeft')) x -= 1;
    if (this.down('KeyD', 'ArrowRight')) x += 1;
    if (this.down('KeyW', 'ArrowUp')) y -= 1;
    if (this.down('KeyS', 'ArrowDown')) y += 1;
    if (this.stick.active) (x = this.stick.x), (y = this.stick.y);
    return { x, y };
  }
}
