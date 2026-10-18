# Kroot Now payments (Tap Payments)

`tap-checkout` sends customers to Tap's hosted payment page and confirms the charge when they come back.
It runs in the same Supabase project as `ai-proxy`.

- The price (15 SAR) is fixed in `index.ts`; the page cannot change what is charged. If you change the
  price, change `PRICE` there and `CONFIG.price` in `index.html` together.
- `create` makes a Tap charge with `source: src_all`, so Tap shows every payment method enabled on
  your account (mada, cards, and Apple Pay once Tap enables it), then returns Tap's page URL.
- Tap sends the customer back to the site with `?tap_id=chg_...`; the page calls `verify`, which
  retrieves the charge and reports paid only for `CAPTURED`, 15, `SAR`. The page also checks the
  order number matches the one it started, so a shared link can't unlock someone else's card.
- Only `https://alomaiir.github.io` may call it (override with an `ALLOWED_ORIGINS` secret).
- Each IP can open 10 checkout links a minute.
- The public key (`pk_...`) is not used: it is only for Tap's embedded card form (Card SDK).

## Deploy

1. **Secret key.** Supabase dashboard → Edge Functions → Secrets → add `TAP_SECRET_KEY` with your
   **test** secret key (`sk_test_...`). Type it there, never in chat or in this repo.
2. **Function.** From the folder that contains `supabase/`:

   ```bash
   npx supabase functions deploy tap-checkout --project-ref <project-ref> --no-verify-jwt
   ```

3. **Page.** In `index.html` set `CONFIG.payUrl` to
   `https://<project-ref>.supabase.co/functions/v1/tap-checkout`. This switches the pay step to Tap
   and removes the "prototype" banner.
4. **Test** on the live site with a Tap test card, e.g. mada `4464040000000007` or Visa
   `4508750015741019`, expiry `01/39`, CVV `100`. Then try a decline with expiry `05/22`.
5. **Go live.** Replace the secret with `sk_live_...` after Tap approves your account and you have
   done one live payment per method, as Tap recommends.
