# Kroot Now AI proxy

A small Cloudflare Worker that lets every visitor of the site use the AI assistant
without the Anthropic API key ever reaching the browser.

- Holds the key as a Worker secret (`ANTHROPIC_API_KEY`).
- Accepts `POST` only from the origins in `ALLOWED_ORIGINS` (the GitHub Pages site).
- Forwards the body to `https://api.anthropic.com/v1/messages` with the model pinned to
  `claude-opus-5-5` and `max_tokens` capped at 4000. Only `messages`, `system`, `max_tokens`,
  `temperature`, `stop_sequences` and `fallbacks` are passed through.
- Limits each IP to 20 requests a minute and returns the API's JSON unchanged.

The page points at it with `CONFIG.aiProxy` in `index.html`. A key saved through `#ai`
in a browser still overrides the proxy for that browser.

## Deploy

```bash
cd proxy
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

`secret put` asks for the key in a hidden prompt; it is stored by Cloudflare only.
To rotate the key, run `secret put` again with the new one (no redeploy needed).

The origin check stops other websites from using the proxy from a browser, but a script
can fake the `Origin` header, so the rate limit is what protects the key. Also set a monthly
spend limit for the key in the Anthropic Console.
