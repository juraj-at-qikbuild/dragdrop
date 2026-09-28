import { describe,expect,it } from 'vitest';
import { EngagementPulse } from '../../src/net/engagement';
describe('gameplay input pulses',()=>{
  it('sends only fresh input, throttles held input, and does not queue idle activity',()=>{
    const p=new EngagementPulse();
    expect(p.poll(0,1,true)).toBe(true);
    expect(p.poll(1000,2,true)).toBe(false);
    expect(p.poll(6000,2,true)).toBe(false);
    expect(p.poll(6001,3,true)).toBe(true);
    expect(p.poll(100000,3,true)).toBe(false);
  });
  it('discards input while paused, hidden, offline, or on a legacy server',()=>{
    const p=new EngagementPulse();
    expect(p.poll(0,3,false)).toBe(false);
    expect(p.poll(10000,3,true)).toBe(false);
    expect(p.poll(11000,4,true)).toBe(true);
  });
});
