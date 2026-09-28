// Invite or reuse one operator. Secrets come from the environment; nothing sensitive is logged.
const url = (process.env.SUPABASE_URL ?? process.env.GTA_BRATISKA_SUPABASE_URL ?? 'https://eejvrdvzteyrwlhjfnfx.supabase.co').replace(/\/$/,'');
const secret = process.env.SUPABASE_SECRET_KEY ?? process.env.GTA_BRATISKA_SUPABASE_SECRET_KEY;
const email = process.argv[2] ?? 'juraj+admin@qikbuild.com';
const redirect = process.env.ADMIN_REDIRECT_URL ?? 'https://gta-sk.fun/admin/?setup=1';
if (!secret) throw new Error('SUPABASE_SECRET_KEY is required.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email.');

async function request(path, options = {}, auth = false) {
  const res = await fetch(url + path, { ...options, headers: {
    apikey: secret, ...(auth ? {Authorization:'Bearer '+secret}:{}), 'Content-Type':'application/json',
    ...options.headers,
  }, signal:AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('Provisioning request failed (' + res.status + '). Account or role may already exist; rerunning is safe.');
  return res.status === 204 || res.headers.get('content-length') === '0' ? null : res.json().catch(()=>null);
}
let found;
for(let page=1;;page++){
  const result=await request('/auth/v1/admin/users?page='+page+'&per_page=1000',{},true);
  found=result.users.find(u=>u.email?.toLowerCase()===email.toLowerCase());
  if(found || result.users.length<1000)break;
}
let invited=false;
if(!found){
  const result=await request('/auth/v1/invite?redirect_to='+encodeURIComponent(redirect),{method:'POST',body:JSON.stringify({email,data:{nickname:'Juraj'}})},true);
  found=result.user ?? result;
  invited=true;
}
if(!found?.id)throw new Error('Auth did not return a user ID.');
await request('/rest/v1/admin_users?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({user_id:found.id})});
const roles=await request('/rest/v1/admin_users?user_id=eq.'+encodeURIComponent(found.id)+'&select=user_id');
if(roles.length!==1)throw new Error('Admin membership verification failed.');
if(!invited) await request('/auth/v1/recover?redirect_to='+encodeURIComponent(redirect),{method:'POST',body:JSON.stringify({email})},true);
console.log(JSON.stringify({email,userId:found.id,admin:true,emailRequestAccepted:true,emailType:invited?'invite':'recovery',redirect}));
