// A rounded image panel with a title strip (the "Kde to je?" daily photo, an account avatar…): loads
// an HTMLImageElement, covers the frame with it (or shows a placeholder while it loads / on error),
// and can blow itself up into a dimmed, centred overlay.
// Plan: docs/plans/social-events.md
import { roundRect } from '../../render/shapes';
import { outlined } from '../Hud';

const HEAD = `'Rajdhani', 'Arial Black', Impact, sans-serif`;
const BODY = `'Inter', system-ui, sans-serif`;

export class ImageCard {
  private img: HTMLImageElement | null = null;
  private loading = false;
  private error = false;
  /** bumped on every setImage(): a load that resolves after a newer call started is ignored */
  private token = 0;

  /** `null` clears the card back to empty (no placeholder spinner, no image). */
  setImage(url: string | null) {
    const mine = ++this.token;
    this.img = null;
    this.error = false;
    this.loading = !!url;
    if (!url) return;
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      if (mine !== this.token) return; // a later setImage() already replaced this load
      this.img = im;
      this.loading = false;
    };
    im.onerror = () => {
      if (mine !== this.token) return;
      this.error = true;
      this.loading = false;
    };
    im.src = url;
  }

  /** A rounded card at (x, y, w, h): the image scaled to cover, or a placeholder, plus a title strip. */
  draw(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, title: string, subtitle?: string) {
    ctx.save();
    roundRect(ctx, x, y, w, h, 10);
    ctx.save();
    ctx.clip();
    if (this.img) {
      const iw = this.img.naturalWidth || 1, ih = this.img.naturalHeight || 1;
      const s = Math.max(w / iw, h / ih);
      const dw = iw * s, dh = ih * s;
      ctx.drawImage(this.img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#23262b';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(Math.min(w, h) * 0.18)}px ${BODY}`;
      ctx.fillText(this.error ? '?' : this.loading ? '…' : '', x + w / 2, y + h / 2);
    }
    ctx.restore(); // undo the clip
    const th = subtitle ? Math.min(h, 40) : Math.min(h, 24);
    const grad = ctx.createLinearGradient(x, y + h - th, x, y + h);
    grad.addColorStop(0, 'rgba(8,9,12,0)');
    grad.addColorStop(1, 'rgba(8,9,12,0.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y + h - th, w, th);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.font = `700 ${Math.round(Math.min(16, h * 0.11))}px ${HEAD}`;
    outlined(ctx, title, x + 8, y + h - (subtitle ? 17 : 6), '#fff', 2.5);
    if (subtitle) {
      ctx.font = `600 ${Math.round(Math.min(12, h * 0.08))}px ${BODY}`;
      outlined(ctx, subtitle, x + 8, y + h - 4, '#cfd8dc', 2);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 10);
    ctx.stroke();
    ctx.restore();
  }

  /** An enlarged, centred version over a dimmed full-screen backdrop (tap/click the card to close it
   *  is the caller's job — this only draws). */
  drawLarge(ctx: CanvasRenderingContext2D, viewW: number, viewH: number, title: string, subtitle?: string) {
    ctx.save();
    ctx.fillStyle = 'rgba(6,7,10,0.75)';
    ctx.fillRect(0, 0, viewW, viewH);
    const w = Math.min(viewW - 48, 640);
    const h = Math.min(viewH - 140, w * 0.68);
    this.draw(ctx, viewW / 2 - w / 2, viewH / 2 - h / 2 - 10, w, h, title, subtitle);
    ctx.restore();
  }
}
