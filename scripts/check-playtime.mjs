// Live browser -> game server -> Supabase verification. Disposable account, guest and admin fixtures.
// No email is sent. Run only against the feature deployment with SUPABASE_SECRET_KEY and public key.
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
const url=process.env.SUPABASE_URL??'https://eejvrdvzteyrwlhjfnfx.supabase.co',secret=process.env.SUPABASE_SECRET_KEY,key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const web=process.env.ADMIN_TEST_WEB_URL??'https://gta-sk.fun';
if(!secret||!key)throw new Error('Supabase credentials required');
const created=[],contexts=[],guests=[];
let browser;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(path,method='GET',body,token){
  const res=await fetch(url+path,{method,headers:{apikey:token?key:secret,Authorization:'Bearer '+(token??secret),'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw new Error(path.split('?')[0]+' failed '+res.status);
  return res.json().catch(()=>null);
}
async function create(label){
  const email='playtime-check-'+label+'-'+randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url')+'Aa1!';
  const u=await api('/auth/v1/admin/users','POST',{email,password,email_confirm:true,user_metadata:{nickname:'QA'+label+randomUUID().slice(0,5)}});
  const user=u.user??u;created.push(user.id);
  const res=await fetch(url+'/auth/v1/token?grant_type=password',{method:'POST',headers:{apikey:key,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  assert(res.ok);return {user,session:await res.json()};
}
async function wait(fn,label,ms=45000){
  const end=Date.now()+ms;
  while(Date.now()<end){const result=await fn();if(result)return result;await pause(1000);}
  throw new Error('Timed out: '+label);
}
async function detail(player,token){
  return api('/rest/v1/rpc/admin_player','POST',{p_player:player,p_days:1},token);
}
try{
  const account=await create('Player'),admin=await create('Admin');
  await api('/rest/v1/admin_users','POST',{user_id:admin.user.id});
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const mode of (process.env.PLAYTIME_MODES ?? 'guest,account').split(',')){
    const token=randomUUID(),guest=createHash('sha256').update(token).digest('hex');
    const player=mode==='account'?'acct:'+account.user.id:guest;
    if(mode==='guest')guests.push(guest);
    const context=await browser.newContext({viewport:{width:1100,height:740}});contexts.push(context);
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(({token,session})=>{
      localStorage.setItem('blava-city-online-id',JSON.stringify({token,nick:'QA hosť'}));
      if(session)localStorage.setItem('blava-city-auth',JSON.stringify(session));
    },{token,session:mode==='account'?account.session:null});
    await page.goto(web+'/?intro=0#online');
    await page.waitForFunction(()=>window.game?.host?.status?.state==='online',{},{timeout:45000});
    await page.bringToFront();
    await page.keyboard.down('KeyW');await pause(8000);await page.keyboard.up('KeyW');
    await page.keyboard.press('Escape'); // real pause control
    const recorded=await wait(async()=>{
      const d=await detail(player,admin.session.access_token);
      return d.player?.active_ms>=4000&&d.player?.connected_ms>=8000?d:null;
    },mode+' playtime');
    await page.screenshot({path:'.cache/admin-check/game-'+mode+'.png'});
    const active=recorded.player.active_ms, connected=recorded.player.connected_ms;
    await pause(17000);
    const paused=await detail(player,admin.session.access_token);
    assert(Math.abs(paused.player.active_ms-active)<1200,'paused time counted as active');
    assert(paused.player.connected_ms>connected+5000,'paused connection was not measured');
    await page.keyboard.press('Escape');
    await page.keyboard.down('KeyD');await pause(6500);await page.keyboard.up('KeyD');
    if(mode==='account'){
      // Do not interact while idle: the game remains visible, unpaused and connected.
      const cutoff = Date.now() + 61_000;
      const beforeInput = await page.evaluate(()=>window.game.input.activity);
      await pause(60000);
      const first=await wait(async()=>{
        const d=await detail(player,admin.session.access_token);
        return d.sessions.length && Date.parse(d.sessions[0].last_seen)>=cutoff?d:null;
      },'checkpoint after the inactivity cutoff');
      const afterInput = await page.evaluate(()=>window.game.input.activity);
      console.log('Idle checkpoint evidence '+JSON.stringify({beforeInput,afterInput,activeSeconds:Math.round(first.player.active_ms/1000),checkpoint:first.sessions[0].last_seen}));
      await pause(17000);
      const idle=await detail(player,admin.session.access_token);
      assert(Math.abs(idle.player.active_ms-first.player.active_ms)<1000,'idle time kept accumulating after confirmed cutoff checkpoint');
      assert(idle.player.connected_ms>first.player.connected_ms+5000);
      console.log('PASS 60-second foreground inactivity cutoff');
    }
    const before=await detail(player,admin.session.access_token);
    await page.reload();
    await page.waitForFunction(()=>window.game?.host?.status?.state==='online',{},{timeout:45000});
    await pause(17000);
    const after=await detail(player,admin.session.access_token);
    assert.equal(after.total,before.total,'reconnect duplicated the session');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log('PASS '+mode+' gameplay, pause, reconnect and Supabase totals '+JSON.stringify({
      sessions:after.total,activeSeconds:Math.round(after.player.active_ms/1000),connectedSeconds:Math.round(after.player.connected_ms/1000)}));
    if(mode==='account'){
      await page.evaluate(()=>window.game.host.conn.send({t:'accountDelete'}));
      await wait(async()=>!(await detail(player,admin.session.access_token)).player,'account deletion');
    }else{
      await page.evaluate(()=>window.game.host.conn.send({t:'leave'}));
    }
    await context.close();
  }
  const overview=await api('/rest/v1/rpc/admin_overview','POST',{p_days:1},admin.session.access_token);
  assert.equal(overview.fresh,true);
  console.log('PASS live collector heartbeat '+overview.heartbeat);
}finally{
  for(const c of contexts)await c.close().catch(()=>{});
  await browser?.close();
  // Guest profiles have no public deletion action; their analytics fixture is explicitly removed.
  for(const player of guests)try{await api('/rest/v1/rpc/analytics_ingest','POST',{p_entries:[{kind:'delete',player}],p_heartbeat:null});}catch{}
  for(const id of created)try{await api('/auth/v1/admin/users/'+id,'DELETE');}catch{}
  console.log('Live analytics verification fixtures cleaned up.');
}
