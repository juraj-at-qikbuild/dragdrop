// WebSocket connection to the game server: handshake, automatic reconnect with backoff,
// RTT and server-clock estimation. Knows nothing about game state; NetSimHost/OnlineSession do.
import type { ClientMsg, ErrorCode, HelloMsg, ServerMsg, WelcomeMsg } from '../shared/net/protocol';

/** why the server won't have this client: refused on hello (ErrorCode), replaced by another tab, or
 *  the account behind this session was deleted */
export type FatalReason = ErrorCode | 'replaced' | 'deleted';

export type NetState = 'connecting' | 'online' | 'reconnecting' | 'failed' | 'closed';

export interface NetStatus {
  state: NetState;
  /** players in the world (from the roster) */
  players: number;
  /** round-trip time, ms */
  rtt: number;
  /** seconds until the next reconnect attempt */
  retryIn: number;
}

export interface ConnectionHandlers {
  /** every successful handshake, including reconnects */
  welcome(w: WelcomeMsg, reconnect: boolean): void;
  message(m: ServerMsg): void;
  binary?(data: ArrayBuffer): void;
  /** the server said the client is outdated, or took the identity over in another tab */
  fatal?(reason: FatalReason): void;
  /** a chance to fix an 'auth' error (the access token expired or was rejected) before giving up on
   *  it: return true to retry the connection once more right away, false to make it fatal. Tried at
   *  most once per successful connection. */
  authRetry?(): Promise<boolean>;
}

const PING_MS = 2000;
const FIRST_CONNECT_TIMEOUT = 10_000;

export class Connection {
  status: NetStatus = { state: 'connecting', players: 0, rtt: 0, retryIn: 0 };
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryAt = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private everWelcomed = false;
  private stopped = false;
  /** serverClock ≈ performance.now() + offset */
  private offset = 0;
  private offsetSamples: { rtt: number; off: number }[] = [];
  private nextRetryFast = false;
  /** 'auth' has already been retried once since the last welcome (or the start of the connection) */
  private authRetried = false;
  /** an authRetry() is in flight: onclose must not also schedule its own reconnect while we wait */
  private authRetryPending = false;

  constructor(
    private url: string,
    private makeHello: () => HelloMsg,
    private h: ConnectionHandlers,
  ) {}

  /** Opens the first connection; resolves on the first welcome, rejects if the server can't be reached. */
  start(): Promise<WelcomeMsg> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => this.settleFirst(new Error('timeout')), FIRST_CONNECT_TIMEOUT);
      this.first = { resolve, reject, timer };
      this.open();
    });
  }
  private first: { resolve: (w: WelcomeMsg) => void; reject: (e: Error) => void; timer: number } | null = null;

  private settleFirst(result: WelcomeMsg | Error) {
    const f = this.first;
    if (!f) return false;
    this.first = null;
    clearTimeout(f.timer);
    if (result instanceof Error) {
      this.stop();
      this.status.state = 'failed';
      f.reject(result);
    } else f.resolve(result);
    return true;
  }

  private fatal(reason: FatalReason) {
    this.stop();
    this.status.state = 'failed';
    if (!this.settleFirst(new Error(reason))) this.h.fatal?.(reason);
  }

  private open() {
    if (this.stopped) return;
    this.status.state = this.everWelcomed ? 'reconnecting' : 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(this.makeHello()));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        this.h.binary?.(ev.data as ArrayBuffer);
        return;
      }
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      // an authRetry() is awaiting a fresh token; it (not onclose) decides what happens next
      if (this.stopped || this.authRetryPending) return;
      this.scheduleRetry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(m: ServerMsg) {
    switch (m.t) {
      case 'welcome': {
        const reconnect = this.everWelcomed;
        this.everWelcomed = true;
        this.attempt = 0;
        this.authRetried = false; // a fresh connection earns its own one 'auth' retry again
        this.status.state = 'online';
        // coarse offset until the first pong refines it
        this.offsetSamples = [];
        this.offset = m.st - performance.now();
        this.ping();
        clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
        this.settleFirst(m);
        this.h.welcome(m, reconnect);
        return;
      }
      case 'pong': {
        const now = performance.now();
        const rtt = now - m.ct;
        this.status.rtt = rtt;
        this.offsetSamples.push({ rtt, off: m.st + rtt / 2 - now });
        if (this.offsetSamples.length > 20) this.offsetSamples.shift();
        // the sample with the smallest RTT has the least queueing error
        let best = this.offsetSamples[0];
        for (const s of this.offsetSamples) if (s.rtt < best.rtt) best = s;
        this.offset = best.off;
        return;
      }
      case 'roster':
        this.status.players = m.ps.length;
        break;
      case 'error':
        // a rename's nick-taken (after we're already playing) is a normal message, not fatal: the
        // server kept the old nickname, and NetSimHost just tells the player. At hello time
        // (everWelcomed still false, since this is the very first response on this connection) it
        // stays fatal, so the caller can ask for another nick and reconnect.
        if (m.code === 'nick-taken' && this.everWelcomed) break;
        if (m.code === 'auth' && this.h.authRetry && !this.authRetried) {
          this.authRetried = true;
          this.authRetryPending = true;
          void this.h.authRetry().then((ok) => {
            this.authRetryPending = false;
            if (ok && !this.stopped) this.open();
            else this.fatal('auth');
          });
          return;
        }
        this.fatal(m.code);
        return;
      case 'bye':
        if (m.reason === 'replaced' || m.reason === 'kicked') {
          this.fatal('replaced');
          return;
        }
        if (m.reason === 'deleted') {
          this.fatal('deleted');
          return;
        }
        // server restarting (deploy): come back quickly
        this.nextRetryFast = true;
        break;
    }
    this.h.message(m);
  }

  private ping() {
    this.send({ t: 'ping', ct: performance.now() });
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.status.state = this.everWelcomed ? 'reconnecting' : 'connecting';
    const base = this.nextRetryFast ? 1500 : Math.min(10_000, 500 * 2 ** this.attempt) * (0.5 + Math.random());
    this.nextRetryFast = false;
    this.attempt++;
    this.retryAt = performance.now() + base;
    clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.open(), base);
  }

  /** server clock now, ms */
  serverNow() {
    return performance.now() + this.offset;
  }

  get online() {
    return this.status.state === 'online';
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  sendBinary(buf: ArrayBufferView | ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf as ArrayBuffer);
  }

  /** refresh the countdown shown in the HUD */
  tick() {
    this.status.retryIn = this.status.state === 'reconnecting' || this.status.state === 'connecting' ? Math.max(0, (this.retryAt - performance.now()) / 1000) : 0;
  }

  /** leave for good (quit to menu) */
  close() {
    this.send({ t: 'leave' });
    this.stop();
    this.status.state = 'closed';
  }

  private stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
  }
}
