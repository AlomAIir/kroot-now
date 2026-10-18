# Kroot Now AI proxy (Supabase Edge Function)

`functions/ai-proxy` lets every visitor of the site use the AI assistant without the
Anthropic API key ever reaching the browser.

- Holds the key as the function secret `ANTHROPIC_API_KEY`.
- Accepts `POST` only from `https://alomaiir.github.io` (override with an `ALLOWED_ORIGINS` secret,
  comma-separated).
- Forwards the body to `https://api.anthropic.com/v1/messages` with the model pinned to
  `claude-opus-5-5` and `max_tokens` capped at 4000. Only `messages`, `system`, `max_tokens`,
  `temperature`, `stop_sequences` and `fallbacks` are passed through.
- Limits each IP to 20 requests a minute using the `ai_proxy_hits` table (IPs stored as hashes),
  and returns the API's JSON and status unchanged.
- Deployed with `--no-verify-jwt`, so the page calls it without a Supabase login or anon key.

The page points at it with `CONFIG.aiProxy` in `index.html`
(`https://<project-ref>.supabase.co/functions/v1/ai-proxy`). A key saved through `#ai`
in a browser still overrides the proxy for that browser.

## Deploy

1. **Rate-limit table.** In the Supabase dashboard open SQL Editor, paste
   `migrations/20261018000000_ai_proxy_rate_limit.sql` and run it.
   (On a project whose migrations live in this folder, `npx supabase db push` does the same.)
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
