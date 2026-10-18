-- Per-IP rate limit for the ai-proxy Edge Function.
-- Only the function (service role) can touch it: RLS on with no policies, and the
-- counter function is not executable by anon or signed-in users.

create table if not exists public.ai_proxy_hits (
  ip_hash text primary key,              -- SHA-256 of the caller's IP, never the IP itself
  window_start timestamptz not null default now(),
  hits int not null default 0
);
alter table public.ai_proxy_hits enable row level security;
revoke all on public.ai_proxy_hits from anon, authenticated;

-- Counts one request for p_ip and returns true while it is within p_limit per p_window_seconds
create or replace function public.ai_proxy_hit(p_ip text, p_limit int default 20, p_window_seconds int default 60)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  fresh timestamptz := now() - make_interval(secs => p_window_seconds);
begin
  insert into ai_proxy_hits as h (ip_hash, window_start, hits)
  values (p_ip, now(), 1)
  on conflict (ip_hash) do update set
    hits = case when h.window_start < fresh then 1 else h.hits + 1 end,
    window_start = case when h.window_start < fresh then now() else h.window_start end
  returning hits into n;

  -- now and then, drop counters nobody has used for a day
  if random() < 0.01 then
    delete from ai_proxy_hits where window_start < now() - interval '1 day';
  end if;

  return n <= p_limit;
end;
$$;

revoke execute on function public.ai_proxy_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.ai_proxy_hit(text, int, int) to service_role;
