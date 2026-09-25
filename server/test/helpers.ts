import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ClientLink } from '../src/Room';
import type { ServerMsg } from '../../src/shared/net/protocol';
import { World } from '../../src/shared/world/World';
import type { MapJSON } from '../../src/shared/types';
import { Reader, Writer, decodeSnapshot, encodeState, type Snapshot, type StateReport } from '../../src/shared/net/codec';

let world: World | null = null;
/** the real Bratislava map, loaded once per test file */
export function loadWorld(): World {
  if (!world) world = new World(JSON.parse(readFileSync(path.resolve(__dirname, '../../public/data/bratislava.json'), 'utf8')) as MapJSON);
  return world;
}

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
  snapshots(): Snapshot[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== 'string').map((b) => decodeSnapshot(new Reader(b)));
  }
  lastSnapshot() {
    const s = this.snapshots();
    return s[s.length - 1];
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

let seq = 0;
/** a binary STATE message for a player on foot (or driving, with `veh`) */
export function stateMsg(x: number, y: number, extra: Partial<StateReport> = {}): Uint8Array {
  const r: StateReport = { seq: ++seq & 0xffff, epoch: 0, lvl: 0, x, y, a: 0, vx: 0, vy: 0, weapon: 'fist', camDx: 0, camDy: 0, hw: 30, hh: 18, veh: null, ...extra };
  const w = new Writer();
  encodeState(w, r);
  return w.finish();
}
