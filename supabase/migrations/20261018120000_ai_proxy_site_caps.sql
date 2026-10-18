-- Site-wide caps for the ai-proxy Edge Function, on top of the per-IP limit.
-- They bound what the Anthropic key can spend even when someone rotates IPs or forges headers.
-- Counters live in ai_proxy_hits next to the per-IP ones: per-IP rows are keyed by the IP hash,
-- site rows by 'site:minute' and 'site:day'. Like ai_proxy_hit, only the service role can call these.

comment on column public.ai_proxy_hits.ip_hash is
  'SHA-256 of a caller IP, or site:minute / site:day for the site-wide caps';

-- Counts one hit on p_key in a fixed window of p_window_seconds and returns the count so far
create or replace function public.ai_proxy_bump(p_key text, p_window_seconds int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  fresh timestamptz := now() - make_interval(secs => p_window_seconds);
begin
  insert into ai_proxy_hits as h (ip_hash, window_start, hits)
  values (p_key, now(), 1)
  on conflict (ip_hash) do update set
    hits = case when h.window_start < fresh then 1 else h.hits + 1 end,
    window_start = case when h.window_start < fresh then now() else h.window_start end
  returning hits into n;
  return n;
end;
$$;

-- One call per proxied request. Returns 'ok', 'ip' (this IP is over its per-minute limit)
-- or 'site' (the whole site is over its per-minute or per-day cap).
-- Requests refused for their IP don't count against the site.
create or replace function public.ai_proxy_allow(
  p_ip text, p_ip_per_min int, p_site_per_min int, p_site_per_day int
)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  -- now and then, drop counters nobody has used for two days
  if random() < 0.01 then
    delete from ai_proxy_hits where window_start < now() - interval '2 days';
  end if;

  if ai_proxy_bump(p_ip, 60) > p_ip_per_min then return 'ip'; end if;
  if ai_proxy_bump('site:minute', 60) > p_site_per_min then return 'site'; end if;
  if ai_proxy_bump('site:day', 86400) > p_site_per_day then return 'site'; end if;
  return 'ok';
end;
$$;

revoke execute on function public.ai_proxy_bump(text, int) from public, anon, authenticated;
revoke execute on function public.ai_proxy_allow(text, int, int, int) from public, anon, authenticated;
grant execute on function public.ai_proxy_allow(text, int, int, int) to service_role;
