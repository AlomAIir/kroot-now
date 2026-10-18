-- Orders paid through Tap (tap-checkout Edge Function).
-- A row is written when a checkout link is created. It ties the Tap charge to the order number
-- and to a secret only the buyer's browser holds (stored as a hash), so verify unlocks a card
-- only for that browser: a paid tap_id shared or replayed elsewhere can't unlock another card.
-- No names or emails are kept here; Tap has them.
-- Only the function (service role) can touch it: RLS on with no policies.

create table if not exists public.tap_orders (
  charge_id text primary key,           -- Tap's chg_...
  order_no text not null,               -- KN-..., made by the page
  token_hash text not null,             -- SHA-256 of the browser's secret, never the secret itself
  amount numeric not null,
  currency text not null,
  status text not null default 'INITIATED',
  created_at timestamptz not null default now(),
  claimed_at timestamptz                -- when the buyer's browser first unlocked the card
);
alter table public.tap_orders enable row level security;
revoke all on public.tap_orders from anon, authenticated;
grant select, insert, update on public.tap_orders to service_role;
