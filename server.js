#!/usr/bin/env node
// Cine/Figure OS payments server: creates Stripe Checkout sessions for Keys packs and Passes, and checks that they were really paid.
// No npm packages. Host this yourself (Render, Railway, Fly, your own PC + a tunnel...). The Stripe SECRET key lives ONLY here, never in the app.
//
//   STRIPE_SECRET_KEY=sk_test_xxx PUBLIC_URL=https://your-pay-server.example.com node server.js
//
//   STRIPE_SECRET_KEY    required. Use an sk_test_ key first (test cards, no real money), then your sk_live_ key.
//   PUBLIC_URL           this server's public address (Stripe sends the buyer back to it). Default http://localhost:PORT
//   PORT                 default 4242
//   PAYMENT_METHOD_TYPES optional, e.g. "card,cashapp". Leave empty (recommended): Stripe then shows every method you switched on in
//                        Dashboard > Settings > Payment methods (cards, Apple Pay, Google Pay, Cash App Pay ...)
//   DATA_FILE            where claimed purchases are remembered (default data.json next to this file)
const http = require('http'), fs = require('fs'), path = require('path');
const KEY = process.env.STRIPE_SECRET_KEY || '';
const PORT = +process.env.PORT || 4242;
const BASE = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const METHODS = (process.env.PAYMENT_METHOD_TYPES || '').split(',').map(s => s.trim()).filter(Boolean);
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// Prices live HERE, so the app cannot change what it pays. Keep in sync with PACKS / PLANS at the top of public/shop.js.
const PACKS = { starter: { name: 'Starter', keys: 500, cents: 499 }, player: { name: 'Player', keys: 1100, cents: 999 }, pro: { name: 'Pro Pack', keys: 2400, cents: 1999 }, legend: { name: 'Legend Vault', keys: 6500, cents: 4999 } };
const PLANS = { pro: { name: 'Pro', month: 999, year: 8999 }, plus: { name: 'Ultimate+', month: 1999, year: 16999 } };

let db = { claimed: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
const save = () => { try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { console.error('save failed', e.message); } };

function flat(o, p = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}[${k}]` : k;
    if (v && typeof v === 'object') flat(v, key, out); else if (v !== undefined && v !== null) out.push([key, String(v)]);
  }
  return out;
}
async function stripe(method, url, params) {
  if (!KEY) throw Object.assign(new Error('The payments server has no STRIPE_SECRET_KEY.'), { status: 503 });
  const init = { method, headers: { authorization: 'Bearer ' + KEY } };
  let u = (process.env.STRIPE_API || 'https://api.stripe.com/v1') + url;
  const q = new URLSearchParams(params ? flat(params) : []);
  if (method === 'GET') { if ([...q].length) u += (u.includes('?') ? '&' : '?') + q; }
  else { init.headers['content-type'] = 'application/x-www-form-urlencoded'; init.body = q.toString(); }
  const r = await fetch(u, init), j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || 'Stripe error'), { status: 502 });
  return j;
}
const periodEnd = s => (s && (s.current_period_end || (s.items && s.items.data && s.items.data[0] && s.items.data[0].current_period_end))) || 0;
const okSid = s => /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(String(s || ''));
const okDev = d => /^[a-z0-9]{16,64}$/.test(String(d || ''));
class Err extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (c, s, m) => { if (!c) throw new Err(s, m); };

async function getSession(b) {
  need(okSid(b.session_id) && okDev(b.device), 400, 'Bad request');
  const s = await stripe('GET', '/checkout/sessions/' + b.session_id, { expand: ['subscription'] });
  need(s.client_reference_id === b.device, 403, 'That purchase belongs to another device');
  return s;
}
const subInfo = sub => sub && typeof sub === 'object' ? { active: ['active', 'trialing'].includes(sub.status), status: sub.status, until: periodEnd(sub), ending: !!sub.cancel_at_period_end || sub.status === 'canceled' } : null;

const routes = {
  async 'POST /checkout'(b) {
    need(okDev(b.device), 400, 'Bad request');
    const base = { success_url: `${BASE}/done?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${BASE}/cancelled`, client_reference_id: b.device, metadata: { kind: b.kind, id: b.id } };
    if (METHODS.length) base.payment_method_types = METHODS;
    let params;
    if (b.kind === 'pack') {
      const p = PACKS[b.id]; need(p, 400, 'Unknown pack');
      params = Object.assign(base, { mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: p.cents, product_data: { name: `${p.name}: ${p.keys} Keys` } } }] });
    } else if (b.kind === 'plan') {
      const p = PLANS[b.id], yearly = b.cycle === 'yearly'; need(p, 400, 'Unknown plan');
      base.metadata.cycle = yearly ? 'yearly' : 'monthly';
      params = Object.assign(base, { mode: 'subscription', line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: yearly ? p.year : p.month, recurring: { interval: yearly ? 'year' : 'month' }, product_data: { name: `Cine/Figure ${p.name} (${yearly ? 'yearly' : 'monthly'})` } } }] });
    } else throw new Err(400, 'Unknown product');
    const s = await stripe('POST', '/checkout/sessions', params);
    return { id: s.id, url: s.url };
  },
  // The app polls this after sending the buyer to Stripe. Keys for a pack are handed out ONCE per paid session.
  async 'GET /claim'(b) {
    const s = await getSession(b), m = s.metadata || {};
    if (s.status === 'expired') return { status: 'expired' };
    if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return { status: 'pending' };
    const first = !db.claimed[s.id];
    if (m.kind === 'pack') {
      const p = PACKS[m.id]; need(p, 400, 'Unknown pack');
      if (!first) return { status: 'claimed' };
      db.claimed[s.id] = Date.now(); save();
      return { status: 'paid', kind: 'pack', id: m.id, keys: p.keys };
    }
    if (m.kind === 'plan') {
      need(PLANS[m.id], 400, 'Unknown plan');
      if (first) { db.claimed[s.id] = Date.now(); save(); }
      return { status: 'paid', kind: 'plan', id: m.id, cycle: m.cycle === 'yearly' ? 'yearly' : 'monthly', first, sub: subInfo(s.subscription) };
    }
    throw new Err(400, 'Unknown product');
  },
  async 'GET /plan'(b) { const s = await getSession(b); return { sub: subInfo(s.subscription) }; },
  async 'POST /cancel'(b) { // now:true ends it immediately (used when you switch plans), otherwise it stops at the end of the paid period
    const s = await getSession(b); const id = s.subscription && (s.subscription.id || s.subscription);
    need(id, 400, 'No subscription');
    const sub = b.now ? await stripe('DELETE', '/subscriptions/' + id, { prorate: true }) : await stripe('POST', '/subscriptions/' + id, { cancel_at_period_end: true });
    return { sub: subInfo(sub) };
  },
};

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const send = (res, status, obj) => { res.writeHead(status, Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, cors)); res.end(JSON.stringify(obj)); };
const page = (res, title, text) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:18px system-ui;background:#101113;color:#eee;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h1>${title}</h1><p style="color:#aaa">${text}</p></div>`); };
const hits = new Map();
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 60000); a.push(now); hits.set(ip, a); return a.length > 60; };

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const url = new URL(req.url, 'http://x'), ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (url.pathname === '/' || url.pathname === '/health') return send(res, 200, { ok: true, app: 'cine-payments', stripe: !!KEY, mode: KEY.startsWith('sk_live') ? 'live' : KEY ? 'test' : 'none' });
  if (url.pathname === '/done') return page(res, 'Payment received', 'You can close this tab and go back to Cine/Figure OS. Your purchase appears in a few seconds.');
  if (url.pathname === '/cancelled') return page(res, 'Checkout cancelled', 'Nothing was charged. You can close this tab and go back to Cine/Figure OS.');
  const fn = routes[req.method + ' ' + url.pathname];
  if (!fn) return send(res, 404, { error: 'Not found' });
  if (limited(ip)) return send(res, 429, { error: 'Slow down a little' });
  let raw = ''; req.on('data', c => { raw += c; if (raw.length > 20000) req.destroy(); });
  req.on('end', async () => {
    let body = {}; try { body = req.method === 'GET' ? Object.fromEntries(url.searchParams) : raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'Bad request' }); }
    try { send(res, 200, await fn(body)); } catch (e) { if (e.status) send(res, e.status, { error: e.message }); else { console.error(e); send(res, 500, { error: 'Server error' }); } }
  });
}).listen(PORT, () => console.log(`Cine payments server on port ${PORT} (${KEY ? (KEY.startsWith('sk_live') ? 'LIVE' : 'test') + ' mode' : 'NO STRIPE KEY SET'})`));
