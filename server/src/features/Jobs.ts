// The wire hookup for jobs (Vlk courier / Hopík taxi): `job{op, kind}` -> the shared rule
// (src/shared/sim/rules/jobs/Jobs.ts), which runs the state machine and sends every {k:'job'} update
// itself. Plan: docs/plans/social-events.md ("Vlk courier / Hopík taxi").
import type { RoomFeature } from './RoomFeature';
import type { Room, Session } from '../Room';
import { Jobs as JobsRule } from '../../../src/shared/sim/rules/jobs/Jobs';
import type { JobKind } from '../../../src/shared/sim/rules/types';

export class Jobs implements RoomFeature {
  readonly id = 'jobs';

  constructor(private room: Room) {}

  messages = {
    job: (s: Session, msg: { op: 'start' | 'stop'; kind?: JobKind }) => {
      const rule = this.room.sim.rule<JobsRule>('jobs');
      if (!rule) return;
      if (msg.op === 'stop') rule.stop(s.player);
      else if (msg.kind === 'courier' || msg.kind === 'taxi') rule.start(s.player, msg.kind);
    },
  };
}
