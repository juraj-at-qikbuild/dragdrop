// Real Supabase + browser verification. Creates disposable confirmed users without sending email.
// Required: SUPABASE_SECRET_KEY, VITE_SUPABASE_PUBLISHABLE_KEY. ADMIN_TEST_WEB_URL defaults to local preview.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const url=process.env.SUPABASE_URL ?? 'https://eejvrdvzteyrwlhjfnfx.supabase.co';
const secret=process.env.SUPABASE_SECRET_KEY, key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const web=process.env.ADMIN_TEST_WEB_URL ?? 'http://127.0.0.1:4195';
if(!secret||!key)throw new Error('Supabase test credentials are required.');
const users=[], guests=[], errors=[];
let browser;
async function req(path,{token,service=false,method='GET',body,expected=200}={}){
  const res=await fetch(url+path,{method,headers:{apikey:service?secret:key,
    ...(service?{Authorization:'Bearer '+secret}:token?{Authorization:'Bearer '+token}:{}),
    'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const data=await res.json().catch(()=>null);
  if(res.status!==expected)throw new Error(path.split('?')[0]+' returned '+res.status+' instead of '+expected+': '+(data?.message??data?.msg??''));
  return data;
}
async function create(label){
  const email='analytics-check-'+label+'-'+randomUUID()+'@example.invalid', password=randomBytes(24).toString('base64url')+'Aa1!';
  const result=await req('/auth/v1/admin/users',{service:true,method:'POST',body:{email,password,email_confirm:true,user_metadata:{nickname:'QA '+label}}});
  const user=result.user??result;users.push(user.id);
  const session=await req('/auth/v1/token?grant_type=password',{method:'POST',body:{email,password}});
  return {id:user.id,email,password,token:session.access_token};
}
const rpc=(name,body,token)=>req('/rest/v1/rpc/'+name,{method:'POST',body,token});
const ingest=(entries)=>req('/rest/v1/rpc/analytics_ingest',{method:'POST',service:true,body:{p_entries:entries,p_heartbeat:null},expected:204});
function snapshot(player,nick,connected=60000,active=30000,id=randomUUID(),revision=1){
  const now=new Date(), day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bratislava',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  return {id,player,nick,started_at:new Date(+now-connected).toISOString(),last_seen:now.toISOString(),
    ended_at:now.toISOString(),connected:false,active:false,revision,days:[{day,connected_ms:connected,active_ms:active,measured_ms:connected}]};
}
function check(name){console.log('PASS '+name);}
try{
  const operator=await create('admin'), regular=await create('player');
  await req('/rest/v1/admin_users',{service:true,method:'POST',body:{user_id:operator.id},expected:201});
  for(const who of [undefined,regular.token]){
    const expected=who?403:401;
    await req('/rest/v1/rpc/admin_overview',{method:'POST',body:{p_days:7},token:who,expected});
    await req('/rest/v1/analytics_players?select=*',{token:who,expected});
    await req('/rest/v1/admin_users',{method:'POST',body:{user_id:regular.id},token:who,expected});
    await req('/rest/v1/rpc/analytics_ingest',{method:'POST',body:{p_entries:[]},token:who,expected});
  }
  check('anonymous and normal users cannot read analytics, promote themselves, or ingest');
  const base=await rpc('admin_overview',{p_days:7},operator.token);
  assert(Array.isArray(base.daily));assert.equal(base.daily.length,7);
  check('admin overview and daily series');
  const guest=createHash('sha256').update(randomUUID()).digest('hex');guests.push(guest);
  const first=snapshot(guest,'QA hosť');
  await ingest([{kind:'session',snapshot:first},{kind:'session',snapshot:first}]);
  let detail=await rpc('admin_player',{p_player:guest},operator.token);
  assert.equal(detail.player.connected_ms,60000);assert.equal(detail.total,1);
  const newer={...first,revision:2,days:first.days.map(d=>({...d,connected_ms:90000,active_ms:45000,measured_ms:90000}))};
  await ingest([{kind:'session',snapshot:newer},{kind:'session',snapshot:first}]);
  detail=await rpc('admin_player',{p_player:guest},operator.token);
  assert.equal(detail.player.connected_ms,90000);assert.equal(detail.player.active_ms,45000);
  check('duplicate and out-of-order snapshots do not double-count or overwrite new totals');
  await ingest([{kind:'claim',from:guest,to:'acct:'+regular.id}]);
  detail=await rpc('admin_player',{p_player:'acct:'+regular.id},operator.token);
  assert.equal(detail.player.connected_ms,90000);
  assert.equal((await rpc('admin_player',{p_player:guest},operator.token)).player,null);
  check('guest history transfers only through successful claim');
  const extra=[];
  for(let i=0;i<28;i++)extra.push({kind:'session',snapshot:snapshot('acct:'+regular.id,'QA player',60000,30000)});
  await ingest(extra);
  const sessions=await rpc('admin_player',{p_player:'acct:'+regular.id,p_page:2,p_limit:25},operator.token);
  assert.equal(sessions.total,29);assert.equal(sessions.sessions.length,4);
  const search=await rpc('admin_players',{p_search:regular.email,p_kind:'account'},operator.token);
  assert.equal(search.total,1);
  const blank=await rpc('admin_player',{p_player:'acct:'+operator.id},operator.token);
  assert.equal(blank.player.sessions,0);
  check('server-side search, account without play, and session pagination');
  // Callback testing uses a generated link, never sends an email or consumes the owner's invitation.
  await mkdir('.cache/admin-check',{recursive:true});
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  const requested=[];
  page.on('request',r=>requested.push(r.url()));
  await page.goto(web+'/admin/');
  await page.getByLabel('E-mail',{exact:true}).fill(operator.email);
  await page.getByLabel('Heslo',{exact:true}).fill(operator.password);
  await page.getByRole('button',{name:'Prihlásiť sa',exact:true}).click();
  await page.getByRole('heading',{name:'Čo sa deje v meste'}).waitFor();
  await page.getByRole('button',{name:'QA player',exact:true}).waitFor();
  assert(!requested.some(u=>u.includes('bratislava.json')||/assets\/game-/.test(u)));
  await page.screenshot({path:'.cache/admin-check/desktop.png',fullPage:true});
  await page.getByLabel('Hľadať',{exact:true}).fill(regular.email);
  await page.getByRole('button',{name:'Použiť',exact:true}).click();
  await page.getByRole('button',{name:'QA player',exact:true}).click();
  await page.getByRole('heading',{name:'QA player',exact:true}).waitFor();
  await page.locator('#detail-next').click();
  await page.locator('#detail-content').getByText('Strana 2 z 2',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Zavrieť ✕',exact:true}).click();
  await page.getByLabel('Obdobie',{exact:true}).selectOption('30');
  await page.waitForFunction(()=>document.querySelectorAll('.charts .panel:first-child .bar-column').length===30);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'.cache/admin-check/mobile.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  check('admin login, separate bundle, filters, detail pagination and mobile layout');
  await page.getByRole('button',{name:'Odhlásiť sa',exact:true}).click();
  await page.getByLabel('E-mail',{exact:true}).fill(regular.email);
  await page.getByLabel('Heslo',{exact:true}).fill(regular.password);
  await page.getByRole('button',{name:'Prihlásiť sa',exact:true}).click();
  await page.getByText('Tento účet nemá prístup do administrácie.',{exact:true}).waitFor();
  check('ordinary account sees denied access');
  await page.getByRole('button',{name:'Odhlásiť sa',exact:true}).click();
  const link=await req('/auth/v1/admin/generate_link?redirect_to='+encodeURIComponent('https://gta-sk.fun/admin/?setup=1'),
    {service:true,method:'POST',body:{type:'recovery',email:operator.email}});
  const verify=await fetch(link.action_link??link.properties?.action_link,{redirect:'manual'});
  const callback=new URL(verify.headers.get('location'));
  assert(callback.hash.includes('access_token='));
  await page.goto(web+'/admin/?setup=1'+callback.hash);
  await page.getByRole('heading',{name:'Nastav si heslo',exact:true}).waitFor();
  const replacement=randomBytes(24).toString('base64url')+'Aa1!';
  await page.getByLabel('Heslo',{exact:true}).fill(replacement);
  await page.getByRole('button',{name:'Uložiť heslo',exact:true}).click();
  await page.getByRole('heading',{name:'Čo sa deje v meste'}).waitFor();
  await req('/auth/v1/token?grant_type=password',{method:'POST',body:{email:operator.email,password:replacement}});
  assert.equal(new URL(page.url()).hash,'');
  assert.equal(errors.length,0,errors.join('\n'));
  check('real recovery callback, password setup and token cleanup');
  await req('/auth/v1/admin/users/'+regular.id,{service:true,method:'DELETE'});
  const after=await rpc('admin_player',{p_player:'acct:'+regular.id},operator.token);
  assert.equal(after.player,null);
  await ingest([{kind:'session',snapshot:newer}]);
  const deletedGuest=await rpc('admin_player',{p_player:guest},operator.token);
  assert.equal(deletedGuest.player,null);
  check('Auth deletion cascades through claimed history and delayed replay stays deleted');
}finally{
  await browser?.close();
  for(const player of guests)try{await ingest([{kind:'delete',player}]);}catch{}
  for(const id of users)try{await req('/auth/v1/admin/users/'+id,{service:true,method:'DELETE'});}catch{}
  console.log('Disposable verification accounts cleaned up.');
}
