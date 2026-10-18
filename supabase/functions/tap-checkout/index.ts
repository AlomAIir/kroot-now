// Kroot Now payments (Supabase Edge Function) through Tap Payments.
// The page either charges a token from Tap's card form or Apple Pay button on the page (pay), or asks
// for a link to Tap's hosted payment page (create). When Tap sends the customer back from 3-D Secure
// or its hosted page with ?tap_id=..., the page asks this function whether that charge was paid.
// The price and currency are fixed here, so the page cannot change what is charged.
//
// Secrets: TAP_SECRET_KEY   sk_test_... while testing, sk_live_... at launch
//                           (dashboard → Edge Functions → Secrets)
//          ALLOWED_ORIGINS  optional, comma-separated; defaults to the GitHub Pages site
// Supabase provides SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY; they are used for the
// tap_orders table (supabase/migrations), which ties each charge to the browser that started it.
// Deployed with --no-verify-jwt so the public page can call it without a Supabase login.
//
// POST { action: 'create', name, email, order, token, returnUrl } → { id, url }
// POST { action: 'pay', source: 'tok_...', name, email, order, token, returnUrl }
//        → { paid: true, unlock: true, order } paid now | { id, url } go to 3-D Secure | { paid: false, status }
// POST { action: 'verify', id, order?, token? }                  → { paid, unlock, status, order }
//   paid:   Tap captured the full price for this charge
//   unlock: paid, and order + token match the ones sent when the charge was created,
//           so a paid tap_id shared or replayed elsewhere can't unlock another card

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

// The caller's IP. Cloudflare sets cf-connecting-ip itself; X-Forwarded-For keeps whatever the
// caller sent at the front, so its first entry is only a last resort.
function clientIp(request: Request) {
  const h = request.headers;
  return (h.get('cf-connecting-ip') || h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0]).trim()
    || 'unknown';
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}

// The tap_orders table through the REST API, as the service role
async function db(path: string, init: RequestInit = {}) {
  const url = Deno.env.get('SUPABASE_URL'), key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('no database settings');
  const headers: Record<string, string> = { 'content-type': 'application/json', apikey: key, prefer: 'return=representation' };
  // a legacy service_role key is a JWT and also goes in Authorization; an sb_secret_ key must not
  if (key.startsWith('eyJ')) headers.authorization = 'Bearer ' + key;
  const res = await fetch(url + '/rest/v1/' + path, { ...init, headers });
  if (!res.ok) throw new Error('tap_orders ' + res.status + ' ' + await res.text());
  return await res.json();
}

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

  // create: a charge paid on Tap's hosted page; pay: a charge on a tok_ from the page's card form or Apple Pay
  if (body?.action === 'create' || body?.action === 'pay') {
    if (limited(clientIp(request))) return fail(429, 'too many requests, try again in a minute', h);

    const name = clean(body.name, 60), email = clean(body.email, 120), order = clean(body.order, 20);
    const token = clean(body.token, 64);
    const source = body.action === 'pay' ? clean(body.source, 64) : 'src_all';
    if (!/^(src_all|tok_[A-Za-z0-9]+)$/.test(source)) return fail(400, 'bad card token', h);
    if (!name) return fail(400, 'name is required', h);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'a valid email is required', h);
    if (!/^KN-[A-Z0-9]{4,12}$/.test(order)) return fail(400, 'bad order number', h);
    if (!/^[a-f0-9]{32,64}$/.test(token)) return fail(400, 'bad token', h);
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
        source: { id: source },
        redirect: { url: returnUrl.toString() }
      })
    });
    const c = r.data;
    if (!r.ok || !c?.id) {
      console.error('tap charge failed', r.status, JSON.stringify(c?.errors || c));
      return fail(502, 'could not start the payment', h);
    }
    // CAPTURED: paid on the spot (Apple Pay, or a card without 3-D Secure).
    // INITIATED with a URL: the customer goes there (Tap's page, or their bank's 3-D Secure check)
    // and comes back with ?tap_id=, which verify confirms. Anything else was declined.
    const paid = c.status === 'CAPTURED' && Number(c.amount) === PRICE && c.currency === CURRENCY;
    const url = c.status === 'INITIATED' ? c.transaction?.url : '';
    if (!paid && !url) {
      console.error('tap charge not paid', c.status, JSON.stringify(c.response || {}));
      return reply(200, { paid: false, unlock: false, status: c.status, order }, h);
    }
    // Record the charge before sending anyone to pay it; without the record it could never unlock
    try {
      await db('tap_orders', {
        method: 'POST',
        body: JSON.stringify({
          charge_id: c.id, order_no: order, token_hash: await sha256(token), amount: PRICE, currency: CURRENCY,
          status: c.status, claimed_at: paid ? new Date().toISOString() : null
        })
      });
    } catch (e) {
      console.error('saving the order failed', c.id, e);
      // already paid: the customer still gets the card; Tap has the charge
      if (!paid) return fail(502, 'could not start the payment', h);
    }
    if (paid) return reply(200, { paid: true, unlock: true, status: c.status, order }, h);
    return reply(200, { id: c.id, url }, h);
  }

  if (body?.action === 'verify') {
    const id = clean(body.id, 64), order = clean(body.order, 20), token = clean(body.token, 64);
    if (!/^chg_[A-Za-z0-9]+$/.test(id)) return fail(400, 'bad charge id', h);
    const r = await tap('/' + id, key);
    if (!r.ok || !r.data) {
      console.error('tap retrieve failed', r.status, JSON.stringify(r.data?.errors || r.data));
      return fail(502, 'could not check the payment', h);
    }
    const c = r.data;
    const paid = c.status === 'CAPTURED' && Number(c.amount) === PRICE && c.currency === CURRENCY;
    let unlock = false;
    if (paid && order && token) {
      try {
        const [row] = await db(`tap_orders?charge_id=eq.${id}&select=order_no,token_hash`);
        unlock = !!row && row.order_no === order && row.token_hash === await sha256(token);
        // the first unlock is recorded; checking again from the same browser stays unlocked
        if (unlock) {
          await db(`tap_orders?charge_id=eq.${id}&claimed_at=is.null`, {
            method: 'PATCH', body: JSON.stringify({ status: c.status, claimed_at: new Date().toISOString() })
          });
        }
      } catch (e) {
        console.error('checking the order failed', e);
        return fail(502, 'could not check the payment', h);
      }
    }
    return reply(200, { paid, unlock, status: c.status, order: c.reference?.order || c.metadata?.order || '' }, h);
  }

  return fail(400, 'unknown action', h);
});
