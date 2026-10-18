// Kroot Now payments (Supabase Edge Function) through Tap Payments' hosted payment page.
// The page asks for a checkout link, sends the customer to Tap, and when Tap sends them back
// with ?tap_id=... the page asks this function whether that charge was paid.
// The price and currency are fixed here, so the page cannot change what is charged.
//
// Secrets: TAP_SECRET_KEY   sk_test_... while testing, sk_live_... at launch
//                           (dashboard → Edge Functions → Secrets)
//          ALLOWED_ORIGINS  optional, comma-separated; defaults to the GitHub Pages site
// Deployed with --no-verify-jwt so the public page can call it without a Supabase login.
//
// POST { action: 'create', name, email, order, returnUrl } → { id, url }
// POST { action: 'verify', id }                          → { paid, status, order }

const PRICE = 15;
const CURRENCY = 'SAR';
const TAP = 'https://api.tap.company/v2/charges';
const RATE_LIMIT = 10, RATE_WINDOW_S = 60; // checkout links per IP per minute

const allowed = (Deno.env.get('ALLOWED_ORIGINS') || 'https://alomaiir.github.io')
  .split(',').map(s => s.trim()).filter(Boolean);

// Per instance only: a guard against someone scripting thousands of checkout links
const hits = new Map<string, { start: number; n: number }>();
function limited(ip: string) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > RATE_WINDOW_S * 1000) { hits.set(ip, { start: now, n: 1 }); return false; }
  h.n++;
  if (hits.size > 5000) hits.clear();
  return h.n > RATE_LIMIT;
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
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const fail = (status: number, message: string, h: Record<string, string>) => reply(status, { error: message }, h);

const clean = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';

async function tap(path: string, key: string, init: RequestInit = {}) {
  const res = await fetch(TAP + path, {
    ...init,
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json', lang_code: 'ar' }
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

Deno.serve(async request => {
  const origin = request.headers.get('Origin') || '';
  if (!allowed.includes(origin)) return fail(403, 'origin not allowed', {});
  const h = cors(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (request.method !== 'POST') return fail(405, 'use POST', h);
  const key = Deno.env.get('TAP_SECRET_KEY');
  if (!key) return fail(500, 'payments are not set up', h);

  let body;
  try { body = JSON.parse((await request.text()).slice(0, 4096)); } catch { return fail(400, 'body must be JSON', h); }

  if (body?.action === 'create') {
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (limited(ip)) return fail(429, 'too many requests, try again in a minute', h);

    const name = clean(body.name, 60), email = clean(body.email, 120), order = clean(body.order, 20);
    if (!name) return fail(400, 'name is required', h);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'a valid email is required', h);
    if (!/^KN-[A-Z0-9]{4,12}$/.test(order)) return fail(400, 'bad order number', h);
    // Tap sends the customer back here, so it must be a page on the site that asked
    let returnUrl;
    try { returnUrl = new URL(clean(body.returnUrl, 300)); } catch { return fail(400, 'bad returnUrl', h); }
    if (returnUrl.origin !== origin) return fail(400, 'returnUrl must be on the calling site', h);
    returnUrl.search = ''; returnUrl.hash = '';

    const r = await tap('', key, {
      method: 'POST',
      body: JSON.stringify({
        amount: PRICE, currency: CURRENCY, threeDSecure: true, save_card: false,
        description: 'Kroot Now invitation card ' + order,
        metadata: { order },
        reference: { transaction: order, order },
        customer: { first_name: name, email },
        source: { id: 'src_all' },
        redirect: { url: returnUrl.toString() }
      })
    });
    const url = r.data?.transaction?.url;
    if (!r.ok || !url) {
      console.error('tap create failed', r.status, JSON.stringify(r.data?.errors || r.data));
      return fail(502, 'could not start the payment', h);
    }
    return reply(200, { id: r.data.id, url }, h);
  }

  if (body?.action === 'verify') {
    const id = clean(body.id, 64);
    if (!/^chg_[A-Za-z0-9]+$/.test(id)) return fail(400, 'bad charge id', h);
    const r = await tap('/' + id, key);
    if (!r.ok || !r.data) {
      console.error('tap retrieve failed', r.status, JSON.stringify(r.data?.errors || r.data));
      return fail(502, 'could not check the payment', h);
    }
    const c = r.data;
    const paid = c.status === 'CAPTURED' && Number(c.amount) === PRICE && c.currency === CURRENCY;
    return reply(200, { paid, status: c.status, order: c.reference?.order || c.metadata?.order || '' }, h);
  }

  return fail(400, 'unknown action', h);
});
