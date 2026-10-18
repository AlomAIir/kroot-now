# Kroot Now payments (Tap Payments)

`tap-checkout` sends customers to Tap's hosted payment page and confirms the charge when they come back.
It runs in the same Supabase project as `ai-proxy`.

- The price (15 SAR) is fixed in `index.ts`; the page cannot change what is charged. If you change the
  price, change `PRICE` there and `CONFIG.price` in `index.html` together.
- `create` makes a Tap charge with `source: src_all`, so Tap shows every payment method enabled on
  your account (mada, cards, and Apple Pay once Tap enables it), then returns Tap's page URL.
- When it creates a charge, it saves a row in the `tap_orders` table tying the charge to the order
  number and to a random secret the buyer's browser made (stored as a hash). No names or emails
  are kept; Tap has them.
- Tap sends the customer back to the site with `?tap_id=chg_...`; the page calls `verify` with its
  order number and secret. `verify` retrieves the charge, reports `paid` only for `CAPTURED`, 15,
  `SAR`, and `unlock` only when the order number and secret also match the saved row. So a paid
  `tap_id` that is shared or replayed can't unlock another card. The first unlock is recorded in
  `claimed_at`; the same browser can check again (a reload) and stays unlocked.
- Only `https://alomaiir.github.io` may call it (override with an `ALLOWED_ORIGINS` secret).
- Each IP can open 10 checkout links a minute (per function instance; the IP comes from
  `cf-connecting-ip`).
- The public key (`pk_...`) is not used: it is only for Tap's embedded card form (Card SDK).

## Deploy

1. **Orders table.** Apply `supabase/migrations/20261018130000_tap_orders.sql` (SQL Editor, or
   `npx supabase db push`). Without it `create` refuses to start payments.
2. **Secret key.** Supabase dashboard → Edge Functions → Secrets → add `TAP_SECRET_KEY` with your
   **test** secret key (`sk_test_...`). Type it there, never in chat or in this repo.
3. **Function.** From the folder that contains `supabase/`:

   ```bash
   npx supabase functions deploy tap-checkout --project-ref <project-ref> --no-verify-jwt
   ```

4. **Page.** In `index.html` set `CONFIG.payUrl` to
   `https://<project-ref>.supabase.co/functions/v1/tap-checkout`. This switches the pay step to Tap
   and removes the "prototype" banner.
5. **Test** on the live site with a Tap test card, e.g. mada `4464040000000007` or Visa
   `4508750015741019`, expiry `01/39`, CVV `100`. Then try a decline with expiry `05/22`.
6. **Go live.** Replace the secret with `sk_live_...` after Tap approves your account and you have
   done one live payment per method, as Tap recommends.
