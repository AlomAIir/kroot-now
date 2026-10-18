# Kroot Now AI proxy (Supabase Edge Function)

`functions/ai-proxy` lets every visitor of the site use the AI assistant without the
Anthropic API key ever reaching the browser.

- Holds the key as the function secret `ANTHROPIC_API_KEY`.
- Accepts `POST` only from `https://alomaiir.github.io` (override with an `ALLOWED_ORIGINS` secret,
  comma-separated).
- Forwards the body to `https://api.anthropic.com/v1/messages` with the model pinned to
  `claude-opus-5-5`, `max_tokens` capped at 4000 and `fallbacks` fixed to `"default"`.
  Only `messages`, `system`, `max_tokens`, `temperature` and `stop_sequences` are passed through,
  only text and image blocks are accepted, and a request may hold at most 60,000 characters
  of text and 2 images.
- Limits each IP to 20 requests a minute, and the whole site to 60 a minute and 1,000 a day
  (secrets `AI_SITE_PER_MIN` / `AI_SITE_PER_DAY` change the site caps). The counters live in the
  `ai_proxy_hits` table, with IPs stored as hashes. The IP comes from `cf-connecting-ip`, which
  Cloudflare sets; the first `X-Forwarded-For` entry is whatever the caller sent, so it is only
  a last resort. Returns the API's JSON and status unchanged.
- Deployed with `--no-verify-jwt`, so the page calls it without a Supabase login or anon key.

The page points at it with `CONFIG.aiProxy` in `index.html`
(`https://<project-ref>.supabase.co/functions/v1/ai-proxy`). A key saved through `#ai`
in a browser still overrides the proxy for that browser.

## Deploy

1. **Rate-limit table.** In the Supabase dashboard open SQL Editor, paste each file in
   `migrations/` that isn't applied yet, oldest first, and run it.
   (On a project whose migrations live in this folder, `npx supabase db push` does the same.)
   Apply `20261018120000_ai_proxy_site_caps.sql` before deploying the function that calls it.
2. **Key.** Dashboard → Edge Functions → Secrets → add `ANTHROPIC_API_KEY`.
   Typing it in the dashboard keeps it out of your shell history. To rotate, edit it there.
3. **Function.** From the folder that contains `supabase/`:

   ```bash
   npx supabase login
   npx supabase functions deploy ai-proxy --project-ref <project-ref> --no-verify-jwt
   ```

   On Windows PowerShell use `npx.cmd` if `npx` is blocked by the execution policy.

If the table is missing the function still works but falls back to a rough per-instance
limit and logs `rate limit check failed`.

The origin check stops other websites from using the proxy from a browser, but a script
can fake the `Origin` header, so the rate limit is what protects the key. Also set a monthly
spend limit for the key in the Anthropic Console.
