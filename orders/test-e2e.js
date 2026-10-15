// End-to-end test in Stripe TEST format. Builds events exactly as Stripe would and signs them with generateTestHeaderString.
const cfg = require('./config'); const stripe = require('stripe')(cfg.stripeSecretKey);
const PORT = cfg.port, CUSTOMER = process.env.TEST_CUSTOMER || 'proofday-test@mail.grokbot.com';
function event(id, sessionId, url, goal) {
  return { id, object: 'event', api_version: '2024-06-20', created: Math.floor(Date.now() / 1000), livemode: false, type: 'checkout.session.completed', pending_webhooks: 1, request: { id: null, idempotency_key: null },
    data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', livemode: false, payment_status: 'paid', status: 'complete', amount_total: 14900, currency: 'usd',
      payment_link: 'plink_test_placeholder', customer_details: { email: CUSTOMER, name: 'Test Agency' },
      custom_fields: [{ key: 'site_url', type: 'text', label: { type: 'custom', custom: 'Site URL' }, text: { value: url } }, { key: 'visitor_goal', type: 'text', label: { type: 'custom', custom: 'What should visitors be able to do?' }, text: { value: goal } }] } } };
}
async function post(ev, { badSig = false } = {}) {
  const payload = JSON.stringify(ev);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: badSig ? 'whsec_wrong' : cfg.webhookSecret });
  const r = await fetch(`http://localhost:${PORT}/webhooks/stripe`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload });
  const out = `${r.status} ${await r.text()}`; console.log(`POST ${ev.id} (${ev.data.object.id})${badSig ? ' [bad sig]' : ''} -> ${out}`); return out;
}
(async () => {
  const A = event('evt_test_happy_proofday', 'cs_test_a1ProofdaySelf0001', 'https://getproofday.com/', 'Read the offer, run the free preview, download the sample report');
  const B = event('evt_test_happy_books', 'cs_test_b1BooksToscrape0001', 'https://books.toscrape.com/', 'Browse categories and open a book detail page');
  const C = event('evt_test_fail_unreachable', 'cs_test_c1Unreachable00001', 'https://no-such-host.proofday-test.invalid/', 'n/a');
  await post(A); await post(B); await post(C);
  console.log('--- replay identical event A (Stripe retry) ---'); await post(A);
  console.log('--- same session A under a new event id ---'); await post({ ...A, id: 'evt_test_happy_proofday_resent' });
  console.log('--- forged signature ---'); await post(event('evt_test_forged', 'cs_test_forged0000000000001', 'https://example.com/', ''), { badSig: true });
})();
