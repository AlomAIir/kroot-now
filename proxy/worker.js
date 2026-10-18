// Kroot Now AI proxy (Cloudflare Worker).
// Holds the Anthropic API key as a secret and forwards the page's Messages API calls,
// so the key never reaches the browser. The model and token cap are fixed here,
// and only the page's own origin is allowed.
//
// Secret:  ANTHROPIC_API_KEY   (wrangler secret put ANTHROPIC_API_KEY)
// Vars:    ALLOWED_ORIGINS     comma-separated list, see wrangler.toml
// Binding: RATE_LIMITER        per-IP limit, see wrangler.toml

const MODEL = 'claude-opus-5-5';
const MAX_TOKENS = 4000;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // the page sends images up to 5 MB, base64 adds a third
// Request fields passed through to the API; everything else (model, tools, stream...) is dropped
const PASS = ['messages', 'system', 'max_tokens', 'temperature', 'stop_sequences', 'fallbacks'];

// Fallback limiter when the RATE_LIMITER binding is missing: per isolate, so only a rough guard
const LOCAL_LIMIT = 20, LOCAL_WINDOW_MS = 60 * 1000;
const hits = new Map();
function localLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > LOCAL_WINDOW_MS) { hits.set(ip, { start: now, n: 1 }); return false; }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n > LOCAL_LIMIT;
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function reply(status, body, headers) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status, headers: Object.assign({ 'content-type': 'application/json' }, headers)
  });
}
function apiError(status, type, message, headers) {
  return reply(status, { type: 'error', error: { type, message } }, headers);
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    if (!allowed.includes(origin)) return apiError(403, 'permission_error', 'origin not allowed');
    const h = cors(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    if (request.method !== 'POST') return apiError(405, 'invalid_request_error', 'use POST', h);
    if (!env.ANTHROPIC_API_KEY) return apiError(500, 'api_error', 'proxy has no API key', h);

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const limited = env.RATE_LIMITER ? !(await env.RATE_LIMITER.limit({ key: ip })).success : localLimited(ip);
    if (limited) return apiError(429, 'rate_limit_error', 'too many requests, try again in a minute', h);

    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY_BYTES) return apiError(413, 'request_too_large', 'request too large', h);
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return apiError(413, 'request_too_large', 'request too large', h);

    let body;
    try { body = JSON.parse(raw); } catch (e) { return apiError(400, 'invalid_request_error', 'body must be JSON', h); }
    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
      return apiError(400, 'invalid_request_error', 'messages is required', h);
    }

    const out = {};
    for (const k of PASS) if (body[k] !== undefined) out[k] = body[k];
    out.model = MODEL;
    out.max_tokens = Math.min(Math.max(1, Number(out.max_tokens) || MAX_TOKENS), MAX_TOKENS);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'server-side-fallback-2026-07-01'
      },
      body: JSON.stringify(out)
    });
    // The API's JSON goes back unchanged, with the same status
    return reply(res.status, await res.text(), h);
  }
};
