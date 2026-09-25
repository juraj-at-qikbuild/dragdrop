import type { ClientLink } from '../src/Room';
import type { ServerMsg } from '../../src/shared/net/protocol';

/** In-memory ClientLink that records everything the server sends. */
export class FakeLink implements ClientLink {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  bufferedAmount = 0;
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  /** parsed JSON messages, optionally of one type */
  json<T extends ServerMsg['t']>(t?: T): Extract<ServerMsg, { t: T }>[] {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((s) => JSON.parse(s) as ServerMsg)
      .filter((m) => !t || m.t === t) as Extract<ServerMsg, { t: T }>[];
  }
  last<T extends ServerMsg['t']>(t: T) {
    const all = this.json(t);
    return all[all.length - 1];
  }
  clear() {
    this.sent = [];
  }
}

export const TOKEN_A = '11111111-1111-4111-8111-111111111111';
export const TOKEN_B = '22222222-2222-4222-8222-222222222222';
export const TOKEN_C = '33333333-3333-4333-8333-333333333333';

export class FakeClock {
  t = 1000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}
