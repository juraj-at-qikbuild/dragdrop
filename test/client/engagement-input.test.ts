import { afterEach,describe,expect,it,vi } from 'vitest';
import { Input } from '../../src/game/Input';
type Listener=(event: Record<string,unknown>)=>void;
afterEach(()=>vi.unstubAllGlobals());
function setup(){
  const events=new Map<string,Listener[]>(), canvasEvents=new Map<string,Listener[]>();
  const listen=(map:Map<string,Listener[]>)=>(name:string,fn:Listener)=>map.set(name,[...(map.get(name)??[]),fn]);
  class Element {tagName='INPUT';isContentEditable=false;}
  const doc={activeElement:null as Element|null,hidden:false,addEventListener:listen(events)};
  let pads:unknown[]=[];
  vi.stubGlobal('HTMLElement',Element);
  vi.stubGlobal('document',doc);
  vi.stubGlobal('addEventListener',listen(events));
  vi.stubGlobal('navigator',{getGamepads:()=>pads});
  const input=new Input({addEventListener:listen(canvasEvents)} as unknown as HTMLCanvasElement);
  const emit=(name:string,e:Record<string,unknown>,canvas=false)=>{
    for(const fn of (canvas?canvasEvents:events).get(name)??[])fn({preventDefault:()=>{},...e});
  };
  return {input,emit,doc,Element,setPads:(v:unknown[])=>{pads=v;}};
}
describe('all gameplay input methods feed telemetry',()=>{
  it('records keyboard input and held controls, but not text-field typing',()=>{
    const t=setup();t.emit('keydown',{code:'KeyW',target:null});
    expect(t.input.activity).toBe(1);t.input.pollPad();expect(t.input.activity).toBe(2);
    t.emit('keyup',{code:'KeyW'});
    t.doc.activeElement=new t.Element();
    t.emit('keydown',{code:'KeyA',target:t.doc.activeElement});t.input.pollPad();
    expect(t.input.activity).toBe(2);
  });
  it('records real mouse motion, wheel and fire but not repeated stationary coordinates',()=>{
    const t=setup();t.emit('pointermove',{pointerType:'mouse',clientX:30,clientY:20,buttons:0});
    expect(t.input.activity).toBe(1);
    t.emit('pointermove',{pointerType:'mouse',clientX:30,clientY:20,buttons:0});
    expect(t.input.activity).toBe(1);
    t.emit('wheel',{deltaY:10},true);t.emit('pointerdown',{pointerType:'mouse',button:0},true);
    expect(t.input.activity).toBe(3);
  });
  it('records touch stick, held buttons, and single touch actions',()=>{
    const t=setup();t.input.touch.move={x:1,y:0,on:true};t.input.pollPad();expect(t.input.activity).toBe(1);
    t.input.resetTouch();t.input.touchButtons.add('gas');t.input.pollPad();expect(t.input.activity).toBe(2);
    t.input.resetTouch();t.input.press('KeyF');expect(t.input.activity).toBe(3);
  });
  it('records gamepad sticks and buttons while ignoring drift inside the dead zone',()=>{
    const t=setup();
    const pad={connected:true,axes:[.01,0,0,0],buttons:Array.from({length:16},()=>({pressed:false,value:0}))};
    t.setPads([pad]);t.input.pollPad();expect(t.input.activity).toBe(0);
    pad.axes[0]=.7;t.input.pollPad();expect(t.input.activity).toBe(1);
    pad.axes[0]=0;pad.buttons[0].pressed=true;t.input.pollPad();expect(t.input.activity).toBe(2);
  });
});
