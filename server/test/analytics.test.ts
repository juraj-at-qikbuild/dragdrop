import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db';
import { Room } from '../src/Room';
import { Supa } from '../src/supa';
import { Analytics } from '../src/features/Analytics';
import { addInterval } from '../src/analytics/time';
import type { PlayDay, PlaySnapshot } from '../src/analytics/types';
import { FakeClock, FakeLink, TOKEN_A, disabledSupa, loadWorld } from './helpers';
import { PROTOCOL_VERSION } from '../../src/shared/net/protocol';

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); vi.restoreAllMocks(); });
function setup() {
  const store = new Store(':memory:'); stores.push(store);
  const clock = new FakeClock();
  const room = new Room({world:loadWorld(),store,now:clock.now,wallClock:()=>Date.UTC(2026,8,28,12)+clock.t,supa:disabledSupa()});
  const requests: object[][]=[];
  let fail=false;
  const supa = new Supa('https://test.invalid','secret',{fetch:vi.fn(async (_u,init)=>{
    if(fail)throw new Error('offline');
    requests.push(JSON.parse(String(init?.body)).p_entries);
    return new Response('null');
  }) as typeof fetch});
  const analytics=new Analytics(room,supa); room.addFeature(analytics);
  const join=(telemetry=true)=>{
    const link=new FakeLink(), conn=room.onJoin(link);
    room.onMessage(conn,JSON.stringify({t:'hello',v:PROTOCOL_VERSION,token:TOKEN_A,nick:'Hráč',presence:true,analytics:telemetry}));
    return {link,conn,session:room.sessionById(link.last('welcome').id)!};
  };
  const advance=(ms:number)=>{clock.advance(ms);analytics.tick();};
  const snapshot=()=>store.analytics.pending().map(r=>JSON.parse(r.payload)).find(r=>r.kind==='session')?.snapshot as PlaySnapshot;
  return {store,room,clock,analytics,requests,join,advance,snapshot,setFail:(v:boolean)=>{fail=v;}};
}
describe('server playtime',()=>{
  it('excludes pause and disconnected time, keeps short reconnects in one session',async()=>{
    const t=setup(), a=t.join();
    t.analytics.messages.activity(a.session);
    t.clock.advance(10_000);
    t.room.onMessage(a.conn,JSON.stringify({t:'away',on:true}));
    expect(t.snapshot().days[0]).toMatchObject({connected_ms:10_000,active_ms:10_000});
    t.clock.advance(20_000);
    t.room.onLeave(a.conn);
    const id=t.snapshot().id;
    expect(t.snapshot().days[0]).toMatchObject({connected_ms:30_000,active_ms:10_000});
    t.clock.advance(20_000);
    const b=t.join();
    expect(t.snapshot().id).toBe(id);
    t.analytics.messages.activity(b.session);
    t.clock.advance(5000);
    t.analytics.shutdown();
    expect(t.snapshot().days[0]).toMatchObject({connected_ms:35_000,active_ms:15_000});
    await t.analytics.drain();t.analytics.dispose();
  });
  it('stops active time at 60s without input, never trusts a duration from the browser',async()=>{
    const t=setup(), a=t.join();
    t.room.onMessage(a.conn,JSON.stringify({t:'activity',active_ms:1e12}));
    a.session.lastReportAt=t.clock.t+120_000;
    t.clock.advance(120_000);t.analytics.shutdown();
    expect(t.snapshot().days[0]).toMatchObject({connected_ms:120_000,active_ms:60_000,measured_ms:120_000});
    await t.analytics.drain();t.analytics.dispose();
  });
  it('marks legacy time unmeasured and replacement tabs do not multiply sessions',async()=>{
    const t=setup(), a=t.join(false);
    t.clock.advance(5000);t.join(false);
    expect(a.link.closed?.reason).toBe('replaced');
    t.clock.advance(5000);t.analytics.shutdown();
    expect(t.store.analytics.pending().filter(r=>r.key.startsWith('session:'))).toHaveLength(1);
    expect(t.snapshot().days[0]).toMatchObject({connected_ms:10_000,active_ms:0,measured_ms:0});
    await t.analytics.drain();t.analytics.dispose();
  });
  it('retains failed uploads, finalizes a crashed session at its last checkpoint',async()=>{
    const t=setup(), a=t.join();
    t.analytics.messages.activity(a.session);t.clock.advance(15000);
    t.setFail(true); t.analytics.tick();await t.analytics.flush();
    expect(t.store.analytics.count()).toBe(1);
    t.analytics.dispose();
    const restored=new Analytics(t.room,new Supa('https://test.invalid','secret',{fetch:vi.fn(async()=>new Response('null')) as typeof fetch}));
    expect(t.snapshot().ended_at).toBe(t.snapshot().last_seen);
    expect(t.snapshot().connected).toBe(false);
    expect(t.snapshot().days[0].active_ms).toBe(15000);
    await restored.drain();restored.dispose();
  });
  it('does not acknowledge a newer checkpoint written during an upload',()=>{
    const t=setup(); t.join();
    const old=t.store.analytics.pending();
    t.clock.advance(1000);t.analytics.shutdown();
    t.store.analytics.acknowledge(old);
    expect(t.store.analytics.count()).toBe(1);
    t.analytics.dispose();
  });
  it('purges claimed guest retries and queues deletion for both identities',()=>{
    const t=setup();t.join();t.analytics.shutdown();
    const guest=t.snapshot().player, account='acct:11111111-1111-4111-8111-111111111111';
    t.store.analytics.claim(guest,account);
    t.store.analytics.forget(account);
    expect(t.store.analytics.pending().map(r=>JSON.parse(r.payload))).toEqual([
      {kind:'delete',player:account},{kind:'delete',player:guest},
    ]);
    t.analytics.dispose();
  });
});
describe('Bratislava day allocation',()=>{
  it.each([
    ['2026-09-28T21:59:50Z','2026-09-28','2026-09-29'],
    ['2026-03-28T22:59:50Z','2026-03-28','2026-03-29'],
    ['2026-10-24T21:59:50Z','2026-10-24','2026-10-25'],
  ])('splits midnight at %s',(iso,first,second)=>{
    const days:PlayDay[]=[];addInterval(days,Date.parse(iso),20_000,15_000,true);
    expect(days).toEqual([
      {day:first,connected_ms:10000,active_ms:10000,measured_ms:10000},
      {day:second,connected_ms:10000,active_ms:5000,measured_ms:10000},
    ]);
  });
  it('allocates the complete 23-hour spring day and 25-hour autumn day',()=>{
    for(const [start,length,day] of [['2026-03-28T23:00:00Z',23,'2026-03-29'],['2026-10-24T22:00:00Z',25,'2026-10-25']] as const){
      const days:PlayDay[]=[];addInterval(days,Date.parse(start),length*3_600_000,length*3_600_000,true);
      expect(days).toEqual([{day,connected_ms:length*3_600_000,active_ms:length*3_600_000,measured_ms:length*3_600_000}]);
    }
  });
});
