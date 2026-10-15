// Order intake: POST /webhooks/stripe  (Stripe checkout.session.completed)
const http = require('http'), cfg = require('./config'), store = require('./store');
const stripe = require('stripe')(cfg.stripeSecretKey);
function field(session, key) { const f = (session.custom_fields || []).find(f => f.key === key); return f ? (f.text?.value || f.dropdown?.value || f.numeric?.value || null) : null; }
function handle(raw, sig) {
  let event;
  try { event = stripe.webhooks.constructEvent(raw, sig, cfg.webhookSecret); }
  catch (e) { store.log('webhook.bad_signature', { err: e.message }); return [400, { error: 'bad signature' }]; }
  if (event.type !== 'checkout.session.completed') return [200, { ignored: event.type }];
  const s = event.data.object;
  if (s.payment_status !== 'paid') return [200, { ignored: 'unpaid' }];
  // idempotency layer 1: event id
  if (!store.createOnce('events', event.id, { id: event.id, type: event.type, session: s.id, livemode: event.livemode, receivedAt: new Date().toISOString() })) {
    store.log('webhook.duplicate_event', { event: event.id }); return [200, { duplicate: 'event' }];
  }
  const orderId = 'ord_' + s.id.replace(/^cs_(test_|live_)?/, '').slice(0, 24);
  const order = { orderId, sessionId: s.id, eventId: event.id, livemode: event.livemode, email: s.customer_details?.email, amount: s.amount_total, currency: s.currency,
    siteUrl: field(s, cfg.fieldUrl), goal: field(s, cfg.fieldGoal) || '', createdAt: new Date().toISOString() };
  if (!order.email || !order.siteUrl) { store.log('order.invalid', order); return [200, { error: 'missing email or site_url; flagged for review' }]; }
  // idempotency layer 2: session id (same purchase re-sent under a different event id)
  if (!store.createOnce('orders', s.id, order)) { store.log('webhook.duplicate_session', { session: s.id, event: event.id }); return [200, { duplicate: 'session' }]; }
  store.createOnce('jobs', orderId, { orderId, sessionId: s.id, status: 'queued', attempts: 0, nextRunAt: Date.now(), history: [] });
  store.log('order.created', { orderId, session: s.id, event: event.id, url: order.siteUrl, email: order.email });
  return [200, { received: true, orderId }];
}
if (require.main === module) {
  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/webhooks/stripe') {
      const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
        const [code, body] = handle(Buffer.concat(chunks), req.headers['stripe-signature']);
        res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
      });
    } else if (req.url === '/health') { res.end('ok'); } else { res.writeHead(404); res.end(); }
  }).listen(cfg.port, () => store.log('server.listening', { port: cfg.port }));
}
module.exports = { handle };
