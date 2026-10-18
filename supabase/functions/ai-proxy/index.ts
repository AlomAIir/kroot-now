// Kroot Now AI proxy (Supabase Edge Function).
// Holds the Anthropic API key as a secret and forwards the page's Messages API calls,
// so the key never reaches the browser. The model and token cap are fixed here,
// and only the page's own origin is allowed.
//
// Secrets: ANTHROPIC_API_KEY  (npx supabase secrets set ANTHROPIC_API_KEY)
//          ALLOWED_ORIGINS    optional, comma-separated; defaults to the GitHub Pages site
//          AI_SITE_PER_MIN, AI_SITE_PER_DAY  optional, override the site-wide caps below
// Supabase provides SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to every function;
// they are used for the rate limits (ai_proxy_allow in supabase/migrations).
// Deployed with --no-verify-jwt so the public page can call it without a Supabase login.

const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 4000;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // the page sends images up to 5 MB, base64 adds a third
const MAX_TEXT_CHARS = 60000; // all text in one request; the assistant's longest chats are well under this
const MAX_IMAGES = 2;          // the page sends at most one photo
const RATE_LIMIT = 20, RATE_WINDOW_S = 60; // requests per IP per minute
// Site-wide caps: they bound what the key can spend even if someone rotates IPs
const cap = (name: string, fallback: number) => Math.max(1, Number(Deno.env.get(name)) || fallback);
const SITE_PER_MIN = cap('AI_SITE_PER_MIN', 60), SITE_PER_DAY = cap('AI_SITE_PER_DAY', 1000);
// Request fields passed through to the API; everything else (model, tools, stream, fallbacks...) is dropped
const PASS = ['messages', 'system', 'max_tokens', 'temperature', 'stop_sequences'];

const allowed = (Deno.env.get('ALLOWED_ORIGINS') || 'https://alomaiir.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

// Fallback limiter when the database check fails: per instance, so only a rough guard
const hits = new Map<string, { start: number; n: number }>();
function localLimited(ip: string) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > RATE_WINDOW_S * 1000) { hits.set(ip, { start: now, n: 1 }); return false; }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n > RATE_LIMIT;
}

// The caller's IP. Cloudflare sets cf-connecting-ip itself; X-Forwarded-For keeps whatever the
// caller sent at the front, so its first entry is only a last resort.
function clientIp(request: Request) {
  const h = request.headers;
  return (h.get('cf-connecting-ip') || h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0]).trim()
    || 'unknown';
}

// IPs are stored hashed, never as-is
async function ipHash(ip: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kroot-now:' + ip));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

// 'ok', 'ip' (this caller is over its limit) or 'site' (the whole site is over its cap)
async function check(ip: string): Promise<string> {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  try {
    if (!url || !key) throw new Error('no database settings');
    const headers: Record<string, string> = { 'content-type': 'application/json', apikey: key };
    // a legacy service_role key is a JWT and also goes in Authorization; an sb_secret_ key must not
    if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key;
    const res = await fetch(url + '/rest/v1/rpc/ai_proxy_allow', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        p_ip: await ipHash(ip), p_ip_per_min: RATE_LIMIT, p_site_per_min: SITE_PER_MIN, p_site_per_day: SITE_PER_DAY
      })
    });
    if (!res.ok) throw new Error('ai_proxy_allow ' + res.status + ' ' + await res.text());
    const verdict = await res.json();
    if (!['ok', 'ip', 'site'].includes(verdict)) throw new Error('ai_proxy_allow returned ' + JSON.stringify(verdict));
    return verdict;
  } catch (e) {
    console.error('rate limit check failed, using the in-memory limit:', e);
    return localLimited(ip) ? 'ip' : 'ok';
  }
}

// Characters of text and number of images in the request. The page only sends text and image
// blocks; any other block (document, tool result...) is counted in `other` and refused,
// so nothing can carry text past the cap.
function measure(v: unknown, m = { text: 0, images: 0, other: 0 }) {
  if (typeof v === 'string') m.text += v.length;
  else if (Array.isArray(v)) for (const x of v) measure(x, m);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.type === 'image') m.images++;
    else if (o.type !== undefined && o.type !== 'text') m.other++;
    else for (const x of Object.values(o)) measure(x, m);
  }
  return m;
}

function cors(origin: string) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers }
  });
}
function apiError(status: number, type: string, message: string, headers: Record<string, string> = {}) {
  return reply(status, { type: 'error', error: { type, message } }, headers);
}

Deno.serve(async request => {
  const origin = request.headers.get('Origin') || '';
  if (!allowed.includes(origin)) return apiError(403, 'permission_error', 'origin not allowed');
  const h = cors(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (request.method !== 'POST') return apiError(405, 'invalid_request_error', 'use POST', h);
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return apiError(500, 'api_error', 'proxy has no API key', h);

  if (Number(request.headers.get('content-length') || 0) > MAX_BODY_BYTES) {
    return apiError(413, 'request_too_large', 'request too large', h);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return apiError(413, 'request_too_large', 'request too large', h);

  let body;
  try { body = JSON.parse(raw); } catch { return apiError(400, 'invalid_request_error', 'body must be JSON', h); }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    return apiError(400, 'invalid_request_error', 'messages is required', h);
  }

  const out: Record<string, unknown> = {};
  for (const k of PASS) if (body[k] !== undefined) out[k] = body[k];
  const size = measure([out.messages, out.system]);
  if (size.other) return apiError(400, 'invalid_request_error', 'only text and image content is accepted', h);
  if (size.text > MAX_TEXT_CHARS || size.images > MAX_IMAGES) {
    return apiError(413, 'request_too_large', 'request too large', h);
  }

  // Counted only for requests that would reach the API, so junk can't use up the site's cap
  const verdict = await check(clientIp(request));
  if (verdict === 'ip') {
    return apiError(429, 'rate_limit_error', 'too many requests, try again in a minute', { ...h, 'Retry-After': '60' });
  }
  if (verdict === 'site') {
    return apiError(429, 'rate_limit_error', 'the assistant is busy, try again later', { ...h, 'Retry-After': '300' });
  }

  out.model = MODEL;
  out.max_tokens = Math.min(Math.max(1, Number(out.max_tokens) || MAX_TOKENS), MAX_TOKENS);
  // Anthropic picks the fallback model for a declined request; callers can't name a pricier one
  out.fallbacks = 'default';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01'
    },
    body: JSON.stringify(out)
  });
  // The API's JSON goes back unchanged, with the same status
  return reply(res.status, await res.text(), h);
});
