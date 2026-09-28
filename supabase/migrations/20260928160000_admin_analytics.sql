-- Server-written online playtime. All browser access goes through membership-checked RPCs.
create schema if not exists analytics_private;
revoke all on schema analytics_private from public, anon, authenticated;
grant usage on schema analytics_private to service_role;

create table public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.analytics_players (
  player text primary key,
  user_id uuid unique references auth.users(id) on delete cascade,
  nick text not null,
  first_seen timestamptz not null,
  last_seen timestamptz not null
);
create table public.analytics_aliases (
  guest text primary key,
  account text not null references public.analytics_players(player) on delete cascade
);
create table public.analytics_deleted (player text primary key, deleted_at timestamptz not null default now());
create table public.play_sessions (
  id uuid primary key,
  player text not null references public.analytics_players(player) on delete cascade,
  started_at timestamptz not null,
  last_seen timestamptz not null,
  ended_at timestamptz,
  connected boolean not null default false,
  active boolean not null default false,
  revision bigint not null check (revision > 0)
);
create index play_sessions_player_started on public.play_sessions(player,started_at desc);
create index play_sessions_live on public.play_sessions(last_seen desc) where connected and ended_at is null;
create table public.play_session_days (
  session_id uuid not null references public.play_sessions(id) on delete cascade,
  day date not null,
  connected_ms bigint not null check (connected_ms >= 0),
  active_ms bigint not null check (active_ms >= 0 and active_ms <= connected_ms),
  measured_ms bigint not null check (measured_ms >= active_ms and measured_ms <= connected_ms),
  primary key(session_id,day)
);
create index play_session_days_day on public.play_session_days(day);
create table public.analytics_collector (
  id boolean primary key default true check(id),
  tracking_since timestamptz not null,
  heartbeat timestamptz not null
);

alter table public.admin_users enable row level security;
alter table public.analytics_players enable row level security;
alter table public.analytics_aliases enable row level security;
alter table public.analytics_deleted enable row level security;
alter table public.play_sessions enable row level security;
alter table public.play_session_days enable row level security;
alter table public.analytics_collector enable row level security;
revoke all on public.admin_users,public.analytics_players,public.analytics_aliases,public.analytics_deleted,
  public.play_sessions,public.play_session_days,public.analytics_collector from public,anon,authenticated;
grant all on public.admin_users,public.analytics_players,public.analytics_aliases,public.analytics_deleted,
  public.play_sessions,public.play_session_days,public.analytics_collector to service_role;

-- Tombstones also cover Auth-admin deletions and prevent delayed outbox replays resurrecting identities.
create function analytics_private.deleted_player() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.analytics_deleted(player) values(old.player) on conflict do nothing;
  insert into public.analytics_deleted(player) select a.guest from public.analytics_aliases a where a.account=old.player on conflict do nothing;
  if old.player like 'acct:%' then
    delete from public.analytics_players p where p.player in(select a.guest from public.analytics_aliases a where a.account=old.player);
  end if;
  return old;
end $$;
create trigger analytics_player_delete before delete on public.analytics_players for each row execute function analytics_private.deleted_player();

create function analytics_private.player_key(p_key text) returns text language sql stable set search_path='' as $$
  select coalesce((select a.account from public.analytics_aliases a where a.guest=p_key),p_key)
$$;

create function analytics_private.ensure_player(p_key text,p_nick text,p_first timestamptz,p_last timestamptz)
returns text language plpgsql set search_path='' as $$
declare k text := analytics_private.player_key(p_key); uid uuid;
begin
  if exists(select 1 from public.analytics_deleted where player in(p_key,k)) then return null; end if;
  if k like 'acct:%' then
    uid := substring(k from 6)::uuid;
    if not exists(select 1 from auth.users where id=uid) then return null; end if;
  elsif k !~ '^[a-f0-9]{64}$' then raise exception 'Invalid player identity'; end if;
  insert into public.analytics_players(player,user_id,nick,first_seen,last_seen)
    values(k,uid,left(p_nick,64),p_first,p_last)
    on conflict(player) do update set
      nick=case when excluded.last_seen>=analytics_players.last_seen then excluded.nick else analytics_players.nick end,
      first_seen=least(analytics_players.first_seen,excluded.first_seen),
      last_seen=greatest(analytics_players.last_seen,excluded.last_seen);
  return k;
end $$;

create function public.analytics_ingest(p_entries jsonb,p_heartbeat timestamptz default null)
returns void language plpgsql security definer set search_path='' as $$
declare e jsonb; s jsonb; d jsonb; k text; target text; changed integer;
begin
  if jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries)>200 then raise exception 'Invalid analytics batch'; end if;
  for e in select value from jsonb_array_elements(p_entries) loop
    case e->>'kind'
    when 'player' then
      perform analytics_private.ensure_player(e->>'player',e->>'nick',(e->>'first_seen')::timestamptz,(e->>'last_seen')::timestamptz);
    when 'delete' then
      k:=analytics_private.player_key(e->>'player');
      insert into public.analytics_deleted(player) values(k) on conflict do nothing;
      delete from public.analytics_players where player=k;
    when 'claim' then
      k:=e->>'from'; target:=e->>'to';
      if k=target or k !~ '^[a-f0-9]{64}$' or target !~ '^acct:' then raise exception 'Invalid claim'; end if;
      if exists(select 1 from public.analytics_deleted where player in(k,target)) then continue; end if;
      target:=analytics_private.ensure_player(target,'Hráč',now(),now());
      if target is null then continue; end if;
      if exists(select 1 from public.analytics_aliases where guest=k and account<>target) then raise exception 'Identity already claimed'; end if;
      -- No deletion here: retain the old guest record for tombstoning, hide aliases in the directory.
      insert into public.analytics_aliases(guest,account) values(k,target) on conflict do nothing;
      update public.play_sessions set player=target where player=k;
      update public.analytics_players a set first_seen=least(a.first_seen,g.first_seen)
        from public.analytics_players g where a.player=target and g.player=k;
    when 'session' then
      s:=e->'snapshot';
      k:=analytics_private.ensure_player(s->>'player',s->>'nick',(s->>'started_at')::timestamptz,(s->>'last_seen')::timestamptz);
      if k is null then continue; end if;
      insert into public.play_sessions(id,player,started_at,last_seen,ended_at,connected,active,revision)
      values((s->>'id')::uuid,k,(s->>'started_at')::timestamptz,(s->>'last_seen')::timestamptz,
        (s->>'ended_at')::timestamptz,(s->>'connected')::boolean,(s->>'active')::boolean,(s->>'revision')::bigint)
      on conflict(id) do update set last_seen=excluded.last_seen, ended_at=excluded.ended_at,
        connected=excluded.connected,active=excluded.active,revision=excluded.revision
        where play_sessions.revision<excluded.revision;
      get diagnostics changed=row_count;
      if changed>0 then
        for d in select value from jsonb_array_elements(s->'days') loop
          insert into public.play_session_days(session_id,day,connected_ms,active_ms,measured_ms)
          values((s->>'id')::uuid,(d->>'day')::date,(d->>'connected_ms')::bigint,(d->>'active_ms')::bigint,(d->>'measured_ms')::bigint)
          on conflict(session_id,day) do update set connected_ms=greatest(play_session_days.connected_ms,excluded.connected_ms),
            active_ms=greatest(play_session_days.active_ms,excluded.active_ms),measured_ms=greatest(play_session_days.measured_ms,excluded.measured_ms);
        end loop;
      end if;
    else raise exception 'Unknown analytics entry';
    end case;
  end loop;
  if p_heartbeat is not null then
    insert into public.analytics_collector(id,tracking_since,heartbeat) values(true,p_heartbeat,p_heartbeat)
      on conflict(id) do update set heartbeat=greatest(analytics_collector.heartbeat,excluded.heartbeat);
  end if;
end $$;
revoke all on function public.analytics_ingest(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.analytics_ingest(jsonb,timestamptz) to service_role;

create function analytics_private.require_admin(p_days integer default 7)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from public.admin_users a where a.user_id=auth.uid()) then
    raise exception 'Admin access required' using errcode='42501';
  end if;
  if p_days not in(1,7,30,90) then raise exception 'Invalid date range' using errcode='22023'; end if;
end $$;

create function analytics_private.player_rows(p_days integer)
returns table(player text,nick text,email text,kind text,registered_at timestamptz,last_seen timestamptz,
  sessions bigint,connected_ms bigint,active_ms bigint,measured_ms bigint,online boolean)
language sql stable security definer set search_path='' as $$
  with totals as (
    select s.player,count(distinct s.id) filter(where d.connected_ms>0) as sessions,
      sum(d.connected_ms)::bigint as connected_ms,sum(d.active_ms)::bigint as active_ms,sum(d.measured_ms)::bigint as measured_ms
    from public.play_sessions s join public.play_session_days d on d.session_id=s.id
    where d.day >= (now() at time zone 'Europe/Bratislava')::date-(p_days-1) and d.day <= (now() at time zone 'Europe/Bratislava')::date
    group by s.player
  ), directory as (
    select 'acct:'||u.id::text as player,coalesce(p.nick,u.raw_user_meta_data->>'nickname','Bez prezývky') as nick,
      u.email,'account'::text as kind,u.created_at as registered_at,p.last_seen
    from auth.users u left join public.analytics_players p on p.user_id=u.id
    union all
    select p.player,p.nick,null,'guest',p.first_seen,p.last_seen
    from public.analytics_players p where p.user_id is null
      and not exists(select 1 from public.analytics_aliases a where a.guest=p.player)
      and not exists(select 1 from public.analytics_deleted x where x.player=p.player)
  )
  select x.*,coalesce(t.sessions,0),coalesce(t.connected_ms,0),coalesce(t.active_ms,0),coalesce(t.measured_ms,0),
    exists(select 1 from public.play_sessions s where s.player=x.player and s.connected and s.ended_at is null and s.last_seen>now()-interval '90 seconds')
      and exists(select 1 from public.analytics_collector c where c.heartbeat>now()-interval '90 seconds')
  from directory x left join totals t on t.player=x.player
$$;

create function public.admin_overview(p_days integer default 7)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; lower_day date := (now() at time zone 'Europe/Bratislava')::date-(p_days-1);
begin
  perform analytics_private.require_admin(p_days);
  select jsonb_build_object(
    'registered', (select count(*) from auth.users),
    'tracking_since',(select tracking_since from public.analytics_collector where id),
    'heartbeat',(select heartbeat from public.analytics_collector where id),
    'fresh',coalesce((select heartbeat>now()-interval '90 seconds' from public.analytics_collector where id),false),
    'totals',(select jsonb_build_object('players',count(*) filter(where r.active_ms>0),'online',count(*) filter(where r.online),
      'sessions',coalesce(sum(r.sessions),0),'connected_ms',coalesce(sum(r.connected_ms),0),
      'active_ms',coalesce(sum(r.active_ms),0),'measured_ms',coalesce(sum(r.measured_ms),0)) from analytics_private.player_rows(p_days) r),
    'groups',(select coalesce(jsonb_agg(g),'[]') from (
      select r.kind,count(*) filter(where r.active_ms>0) as players,coalesce(sum(r.sessions),0) as sessions,
        coalesce(sum(r.connected_ms),0) as connected_ms,coalesce(sum(r.active_ms),0) as active_ms
      from analytics_private.player_rows(p_days) r group by r.kind order by r.kind) g),
    'daily',(select coalesce(jsonb_agg(x order by x.day),'[]') from (
      select calendar.bucket::date as day,count(distinct s.player) filter(where d.active_ms>0) as players,
        coalesce(sum(d.connected_ms),0) as connected_ms,coalesce(sum(d.active_ms),0) as active_ms
      from generate_series(lower_day::timestamp,(now() at time zone 'Europe/Bratislava')::date::timestamp,interval '1 day') as calendar(bucket)
      left join public.play_session_days d on d.day=calendar.bucket::date left join public.play_sessions s on s.id=d.session_id group by calendar.bucket
    ) x)
  ) into result;
  return result;
end $$;

create function public.admin_players(p_days integer default 7,p_search text default '',p_kind text default 'all',
  p_sort text default 'last_seen',p_direction text default 'desc',p_page integer default 1,p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform analytics_private.require_admin(p_days);
  if p_page<1 or p_limit<1 or p_limit>100 or length(p_search)>100 or p_kind not in('all','account','guest')
    or p_sort not in('nick','registered_at','last_seen','sessions','active_ms','connected_ms')
    or p_direction not in('asc','desc') then raise exception 'Invalid list options' using errcode='22023'; end if;
  with filtered as (
    select * from analytics_private.player_rows(p_days) r where (p_kind='all' or r.kind=p_kind)
      and (p_search='' or strpos(lower(r.nick),lower(p_search))>0 or strpos(lower(coalesce(r.email,'')),lower(p_search))>0)
  ), paged as (
    select * from filtered r order by
      case when p_direction='asc' and p_sort='nick' then lower(r.nick) end asc,
      case when p_direction='desc' and p_sort='nick' then lower(r.nick) end desc,
      case when p_direction='asc' then case p_sort when 'registered_at' then extract(epoch from r.registered_at)
        when 'last_seen' then extract(epoch from r.last_seen) when 'sessions' then r.sessions when 'active_ms' then r.active_ms when 'connected_ms' then r.connected_ms end end asc nulls last,
      case when p_direction='desc' then case p_sort when 'registered_at' then extract(epoch from r.registered_at)
        when 'last_seen' then extract(epoch from r.last_seen) when 'sessions' then r.sessions when 'active_ms' then r.active_ms when 'connected_ms' then r.connected_ms end end desc nulls last,
      r.player asc limit p_limit offset (p_page-1)*p_limit
  ) select jsonb_build_object('total',(select count(*) from filtered),'rows',coalesce((select jsonb_agg(p) from paged p),'[]')) into result;
  return result;
end $$;

create function public.admin_player(p_player text,p_days integer default 7,p_page integer default 1,p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; lower_day date := (now() at time zone 'Europe/Bratislava')::date-(p_days-1);
begin
  perform analytics_private.require_admin(p_days);
  if p_page<1 or p_limit<1 or p_limit>100 then raise exception 'Invalid pagination' using errcode='22023'; end if;
  with sessions as (
    select s.id,s.started_at,s.last_seen,s.ended_at,s.connected,
      sum(d.connected_ms)::bigint as connected_ms,sum(d.active_ms)::bigint as active_ms,sum(d.measured_ms)::bigint as measured_ms
    from public.play_sessions s join public.play_session_days d on d.session_id=s.id
    where s.player=p_player and d.day>=lower_day and d.day <= (now() at time zone 'Europe/Bratislava')::date
    group by s.id
  ), paged as (select * from sessions order by started_at desc,id limit p_limit offset (p_page-1)*p_limit)
  select jsonb_build_object(
    'player',(select to_jsonb(r) from analytics_private.player_rows(p_days) r where r.player=p_player),
    'total',(select count(*) from sessions),'sessions',coalesce((select jsonb_agg(p) from paged p),'[]'),
    'daily',(select coalesce(jsonb_agg(x order by x.day),'[]') from (
      select d.day,sum(d.connected_ms)::bigint as connected_ms,sum(d.active_ms)::bigint as active_ms
      from public.play_sessions s join public.play_session_days d on d.session_id=s.id
      where s.player=p_player and d.day>=lower_day and d.day <= (now() at time zone 'Europe/Bratislava')::date group by d.day
    ) x)
  ) into result;
  return result;
end $$;

revoke all on all functions in schema analytics_private from public,anon,authenticated;
revoke all on function public.admin_overview(integer),public.admin_players(integer,text,text,text,text,integer,integer),
  public.admin_player(text,integer,integer,integer) from public,anon;
grant execute on function public.admin_overview(integer),public.admin_players(integer,text,text,text,text,integer,integer),
  public.admin_player(text,integer,integer,integer) to authenticated;
