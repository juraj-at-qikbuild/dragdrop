import './style.css';
import { auth, available, rpc, ApiError, type Overview, type PlayerPage, type PlayerDetail, type Daily } from './api';

const app = document.querySelector<HTMLDivElement>('#app')!;
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const number = (n: number) => new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 1 }).format(n);
const hours = (ms: number) => number(ms / 3_600_000) + ' h';
const duration = (ms: number) => ms < 3_600_000 ? number(ms / 60_000) + ' min' : hours(ms);
const date = (v: string | null) => v ? new Intl.DateTimeFormat('sk-SK', {
  dateStyle:'short', timeStyle:'short', timeZone:'Europe/Bratislava',
}).format(new Date(v)) : 'Zatiaľ nehral';
let days = 7, page = 1, kind = 'all', sort = 'last_seen', direction = 'desc', search = '';
let generation = 0, detailGeneration = 0, refreshing = false;
let selected: string | null = null, detailPage = 1;
let latest: Overview | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const setup = new URLSearchParams(location.search).get('setup') === '1' || /type=(invite|recovery)/.test(location.hash);

function brand() {
  return '<a class="brand" href="/admin/"><img src="/assets/erb.svg" alt="" /><span>GTA <b>SK</b><small>Administrácia</small></span></a>';
}
function errorText(e: unknown) {
  return e instanceof ApiError ? e.message : 'Spojenie sa nepodarilo. Skús to znova.';
}
function message(text: string, error = false) {
  const box = document.querySelector<HTMLElement>('#message');
  if (box) { box.textContent = text; box.className = error ? 'message error' : 'message'; }
}
async function login(mode: 'login' | 'reset' | 'setup' = 'login', initial = '') {
  clearInterval(timer); generation++; detailGeneration++; selected = null;
  const title = mode === 'setup' ? 'Nastav si heslo' : mode === 'reset' ? 'Obnovenie hesla' : 'Vitaj v administrácii';
  app.innerHTML = `<main class="auth-shell">${brand()}<section class="auth-card"><p class="eyebrow">PREHĽAD HRÁČOV</p>
    <h1>${title}</h1><p class="muted">${mode === 'setup' ? 'Zvoľ si heslo pre svoj správcovský účet.' : 'Prihlás sa účtom s prístupom k štatistikám GTA SK.'}</p>
    <form id="auth-form">${mode !== 'setup' ? '<label>E-mail<input name="email" type="email" autocomplete="username" required /></label>' : ''}
    ${mode !== 'reset' ? '<label>Heslo<input name="password" type="password" autocomplete="' + (mode === 'setup' ? 'new-password' : 'current-password') + '" minlength="8" required /></label>' : ''}
    <button class="primary" type="submit">${mode === 'setup' ? 'Uložiť heslo' : mode === 'reset' ? 'Poslať odkaz' : 'Prihlásiť sa'}</button></form>
    <p id="message" class="message" role="status">${escape(initial)}</p>
    <button id="auth-other" class="text-button">${mode === 'login' ? 'Zabudnuté heslo' : 'Späť na prihlásenie'}</button>
    <a class="back-link" href="/">← Späť do hry</a></section></main>`;
  document.querySelector('#auth-other')!.addEventListener('click', () => void login(mode === 'login' ? 'reset' : 'login'));
  document.querySelector<HTMLFormElement>('#auth-form')!.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement, button = form.querySelector('button')!;
    const data = new FormData(form), email = String(data.get('email') ?? '').trim(), password = String(data.get('password') ?? '');
    button.disabled = true; message('');
    try {
      if (mode === 'reset') {
        const { error } = await auth!.resetPasswordForEmail(email, { redirectTo: location.origin + '/admin/?setup=1' });
        message(error ? 'Odkaz sa nepodarilo poslať. Skús neskôr.' : 'Ak účet existuje, poslali sme odkaz na nastavenie hesla.', !!error);
      } else {
        const result = mode === 'setup' ? await auth!.updateUser({ password }) : await auth!.signInWithPassword({ email, password });
        if (result.error) {
          message(mode === 'setup' ? 'Heslo sa nepodarilo uložiť. Použi platný odkaz a aspoň 8 znakov.' : 'Prihlásenie zlyhalo. Skontroluj e-mail a heslo.', true);
        } else {
          history.replaceState(null, '', '/admin/');
          await dashboard();
        }
      }
    } catch { message('Spojenie sa nepodarilo. Skús to znova.', true); }
    finally { button.disabled = false; }
  });
}
function chart(rows: Daily[], field: 'active_ms' | 'players', label: string) {
  if (!rows.length) return '<p class="muted">Zatiaľ bez údajov.</p>';
  const max = Math.max(1, ...rows.map(r => r[field] ?? 0));
  return `<div class="chart" role="img" aria-label="${label}">${rows.map(r => {
    const v = r[field] ?? 0, text = field === 'players' ? number(v) : duration(v);
    return `<div class="bar-column" title="${escape(r.day + ': ' + text)}"><span class="bar-value">${text}</span>
      <div class="bar-track"><i style="height:${Math.max(v ? 2 : 0, v / max * 100)}%"></i></div><small>${r.day.slice(8)}.${r.day.slice(5,7)}</small></div>`;
  }).join('')}</div>`;
}
function card(label: string, value: string, note = '') {
  return `<article class="metric"><p>${label}</p><strong>${value}</strong>${note ? '<small>' + note + '</small>' : ''}</article>`;
}
async function dashboard() {
  const identity = await auth!.getUser();
  if (!identity.data.user) return login();
  app.innerHTML = `<header>${brand()}<div class="header-actions"><span>${escape(identity.data.user.email)}</span><button id="logout">Odhlásiť sa</button></div></header>
    <main class="dashboard"><div class="page-heading"><div><p class="eyebrow">ONLINE HRÁČI</p><h1>Čo sa deje v meste</h1>
    <p class="muted">Účty, hostia a čas strávený hraním.</p></div><label class="range">Obdobie<select id="days" aria-label="Obdobie"><option value="1">Dnes</option>
    <option value="7">Posledných 7 dní</option><option value="30">Posledných 30 dní</option><option value="90">Posledných 90 dní</option></select></label></div>
    <div id="message" class="message" role="status"></div><div id="freshness" class="freshness">Načítavam údaje…</div>
    <section id="overview" aria-busy="true"><div class="placeholder">Načítavam prehľad…</div></section>
    <section class="panel users"><div class="section-heading"><h2>Hráči</h2><span id="user-count"></span></div>
      <form id="filters" class="filters"><label>Hľadať<input id="search" type="search" maxlength="100" placeholder="Prezývka alebo e-mail" /></label>
      <label>Typ<select id="kind" aria-label="Typ"><option value="all">Všetci</option><option value="account">Účty</option><option value="guest">Hostia</option></select></label>
      <label>Zoradiť<select id="sort" aria-label="Zoradiť"><option value="last_seen">Posledná návšteva</option><option value="active_ms">Aktívny čas</option><option value="connected_ms">Pripojený čas</option><option value="sessions">Relácie</option><option value="registered_at">Registrácia / prvá návšteva</option><option value="nick">Prezývka</option></select></label>
      <label>Smer<select id="direction" aria-label="Smer"><option value="desc">Zostupne</option><option value="asc">Vzostupne</option></select></label><button type="submit">Použiť</button></form>
      <div id="players" aria-live="polite"></div></section>
      <p class="footnote">Aktívny čas nezahŕňa pauzu, skrytú kartu ani čas po 60 sekundách bez herného vstupu. Pripojený čas zahŕňa aj pauzu.
      Dni sa počítajú v časovom pásme Europe/Bratislava. Staršie karty hry merajú iba pripojený čas.</p>
    </main><dialog id="detail" aria-labelledby="detail-title"><div id="detail-content"></div></dialog>`;
  (document.querySelector('#days') as HTMLSelectElement).value = String(days);
  document.querySelector('#logout')!.addEventListener('click', async () => { await auth!.signOut(); await login(); });
  document.querySelector('#days')!.addEventListener('change', e => { days = Number((e.target as HTMLSelectElement).value); page=1; void refresh(); });
  document.querySelector('#filters')!.addEventListener('submit', e => {
    e.preventDefault(); search=(document.querySelector('#search') as HTMLInputElement).value.trim();
    kind=(document.querySelector('#kind') as HTMLSelectElement).value; sort=(document.querySelector('#sort') as HTMLSelectElement).value;
    direction=(document.querySelector('#direction') as HTMLSelectElement).value; page=1; void refresh();
  });
  document.querySelector<HTMLDialogElement>('#detail')!.addEventListener('close', () => { selected=null; detailGeneration++; });
  await refresh();
  clearInterval(timer);
  if (document.querySelector('.dashboard')) timer = setInterval(() => { if (!document.hidden && !refreshing) void refresh(); }, 30_000);
}
async function refresh() {
  const id = ++generation; refreshing=true;
  const overviewBox=document.querySelector('#overview');
  overviewBox?.setAttribute('aria-busy','true');
  try {
    const [overview, players] = await Promise.all([
      rpc<Overview>('admin_overview',{p_days:days}),
      rpc<PlayerPage>('admin_players',{p_days:days,p_search:search,p_kind:kind,p_sort:sort,p_direction:direction,p_page:page,p_limit:25}),
    ]);
    if (id !== generation) return;
    latest=overview; message('');
    document.querySelector('#freshness')!.innerHTML = `<span class="dot ${overview.fresh?'live':'stale'}"></span>
      ${overview.fresh?'Zber údajov je aktívny':'Údaje čakajú na aktualizáciu'} · Posledná aktualizácia: ${overview.heartbeat?date(overview.heartbeat):'zatiaľ žiadna'}
      <span>Meranie od ${overview.tracking_since?date(overview.tracking_since):'prvého pripojenia zberača'}</span>`;
    const t=overview.totals;
    document.querySelector('#overview')!.innerHTML = `<div class="metrics">
      ${card('Registrované účty',number(overview.registered),'Všetky účty')}
      ${card('Aktívni hráči',number(t.players),'Vo vybranom období')}
      ${card('Práve pripojení',overview.fresh?number(t.online):'—',overview.fresh?'Vrátane hráčov v pauze':'Čaká na aktualizáciu')}
      ${card('Herné relácie',number(t.sessions))}
      ${card('Aktívne hranie',hours(t.active_ms))}
      ${card('Čas pripojenia',hours(t.connected_ms))}
      ${card('Priemerné aktívne hranie',duration(t.sessions?t.active_ms/t.sessions:0),'Na jednu reláciu')}
      </div><div class="charts"><section class="panel"><h2>Aktívne hranie po dňoch</h2>${chart(overview.daily,'active_ms','Aktívny čas podľa dní')}</section>
      <section class="panel"><h2>Denní aktívni hráči</h2>${chart(overview.daily,'players','Počet denných aktívnych hráčov')}</section></div>
      <div class="audiences">${(['account','guest'] as const).map(kind=>overview.groups.find(g=>g.kind===kind)??{kind,players:0,sessions:0,connected_ms:0,active_ms:0}).map(g=>`<div><span>${g.kind==='account'?'Registrovaní hráči':'Hostia'}</span><strong>${number(g.players)} aktívnych</strong><small>${hours(g.active_ms)} hrania · ${hours(g.connected_ms)} pripojenia · ${number(g.sessions)} relácií</small></div>`).join('')}</div>
      ${t.measured_ms<t.connected_ms?'<p class="notice">Časť relácií používa staršiu kartu hry. Ich aktívny čas zatiaľ nie je meraný.</p>':''}`;
    document.querySelector('#user-count')!.textContent=number(players.total)+' hráčov';
    document.querySelector('#players')!.innerHTML = players.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Hráč</th><th>Typ</th><th>Registrácia / prvá návšteva</th><th>Posledná návšteva</th><th>Relácie</th><th>Aktívny čas</th><th>Pripojený čas</th><th>Stav</th></tr></thead><tbody>
      ${players.rows.map(p=>`<tr><td><button class="player-link" data-player="${escape(p.player)}">${escape(p.nick)}</button><small>${escape(p.email||'Hosť')}</small></td>
      <td>${p.kind==='account'?'Účet':'Hosť'}</td><td>${date(p.registered_at)}</td><td>${date(p.last_seen)}</td><td>${number(p.sessions)}</td>
      <td>${p.measured_ms?duration(p.active_ms):'—'}</td><td>${duration(p.connected_ms)}</td><td><span class="badge ${p.online?'online':''}">${!overview.fresh?'Neaktuálne':p.online?'Online':'Offline'}</span></td></tr>`).join('')}
      </tbody></table></div>${pager(page,players.total,'users')}` : '<div class="placeholder">Žiadni hráči pre tieto filtre.</div>';
    document.querySelectorAll<HTMLButtonElement>('[data-player]').forEach(b=>b.addEventListener('click',()=>{ selected=b.dataset.player!; detailPage=1; void showDetail(); }));
    bindPager('users',players.total,()=>page,n=>{page=n;void refresh();});
  } catch(e) {
    if(id!==generation)return;
    if(e instanceof ApiError && e.status===401) { await login('login',e.message); return; }
    if(e instanceof ApiError && e.status===403) {
      document.querySelector('#overview')!.innerHTML='<div class="placeholder">Prístup zamietnutý. Prihlás sa správcovským účtom.</div>';
      document.querySelector('#players')!.replaceChildren();
      document.querySelector('#freshness')!.textContent='Bez prístupu k údajom';
      clearInterval(timer);
    }
    message(errorText(e),true);
  } finally {
    if(id===generation){refreshing=false;overviewBox?.setAttribute('aria-busy','false');}
  }
}
function pager(current:number,total:number,id:string) {
  return `<div class="pager"><button id="${id}-prev" ${current<=1?'disabled':''}>← Predošlá</button>
    <span>Strana ${current} z ${Math.max(1,Math.ceil(total/25))}</span><button id="${id}-next" ${current*25>=total?'disabled':''}>Ďalšia →</button></div>`;
}
function bindPager(id:string,total:number,current:()=>number,set:(n:number)=>void){
  document.querySelector('#'+id+'-prev')?.addEventListener('click',()=>{if(current()>1)set(current()-1);});
  document.querySelector('#'+id+'-next')?.addEventListener('click',()=>{if(current()*25<total)set(current()+1);});
}
async function showDetail(){
  const id=++detailGeneration, key=selected!;
  const dialog=document.querySelector<HTMLDialogElement>('#detail')!;
  const content=document.querySelector('#detail-content')!;
  content.innerHTML='<button id="detail-close" class="close">Zavrieť ✕</button><h2 id="detail-title">Detail hráča</h2><p role="status">Načítavam…</p>';
  document.querySelector('#detail-close')!.addEventListener('click',()=>dialog.close());
  if(!dialog.open)dialog.showModal();
  try{
    const d=await rpc<PlayerDetail>('admin_player',{p_player:key,p_days:days,p_page:detailPage,p_limit:25});
    if(id!==detailGeneration)return;
    const p=d.player;
    content.innerHTML=`<button id="detail-close" class="close">Zavrieť ✕</button><h2 id="detail-title">${escape(p?.nick||'Hráč nenájdený')}</h2>
      ${p?`<p class="muted">${escape(p.email||'Hosť')} · ${date(p.registered_at)}</p><div class="detail-metrics">
      ${card('Aktívny čas',p.measured_ms?duration(p.active_ms):'Nemerané')}${card('Čas pripojenia',duration(p.connected_ms))}${card('Relácie',number(p.sessions))}</div>
      <h3>Aktívne hranie po dňoch</h3>${chart(d.daily,'active_ms','Aktívny čas hráča podľa dní')}
      <h3>Herné relácie</h3>${d.sessions.length?`<div class="table-wrap"><table><thead><tr><th>Začiatok</th><th>Koniec / posledný kontakt</th><th>Aktívne</th><th>Pripojený</th></tr></thead><tbody>
      ${d.sessions.map(s=>`<tr><td>${date(s.started_at)}</td><td>${s.ended_at?date(s.ended_at):s.connected&&latest?.fresh&&Date.now()-Date.parse(s.last_seen)<90_000?'Prebieha':date(s.last_seen)}</td>
      <td>${s.measured_ms?duration(s.active_ms):'Nemerané'}</td><td>${duration(s.connected_ms)}</td></tr>`).join('')}</tbody></table></div>${pager(detailPage,d.total,'detail')}`:'<p class="muted">V tomto období nemá zaznamenané hranie.</p>'}`:''}`;
    document.querySelector('#detail-close')!.addEventListener('click',()=>dialog.close());
    bindPager('detail',d.total,()=>detailPage,n=>{detailPage=n;void showDetail();});
  }catch(e){if(id===detailGeneration){content.querySelector('[role=status]')!.textContent=errorText(e);}}
}
async function boot(){
  if(!available){app.innerHTML='<main class="auth-shell"><h1>Administrácia nie je nakonfigurovaná</h1><p>Prihlásenie je momentálne nedostupné.</p></main>';return;}
  const initialized=await auth!.initialize();
  history.replaceState(null,'',location.pathname); // strip setup and any error/callback details
  const {data}=await auth!.getSession();
  if(initialized.error) return login('login','Odkaz je neplatný alebo vypršal. Vyžiadaj si nový cez Zabudnuté heslo.');
  if(setup&&data.session)return login('setup');
  if(data.session)await dashboard();else await login(setup?'reset':'login');
}
void boot().catch(()=>{app.innerHTML='<main class="auth-shell"><h1>Administráciu sa nepodarilo načítať</h1><a href="/admin/">Skúsiť znova</a></main>';});
