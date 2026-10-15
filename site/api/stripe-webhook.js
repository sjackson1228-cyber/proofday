// Stripe webhook (checkout.session.completed). Verifies signature, refuses livemode mismatch, dedupes by session id, runs scan in background.
const Stripe = require('stripe'); const { waitUntil } = require('@vercel/functions'); const { createOnce, process1 } = require('../lib/orders');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks);
  let ev; try { ev = Stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); } catch (e) { return res.status(400).send('bad signature'); }
  if (ev.livemode !== (process.env.STRIPE_LIVEMODE === 'true')) return res.status(200).json({ ignored: 'livemode mismatch' });
  if (ev.type !== 'checkout.session.completed') return res.status(200).json({ ignored: ev.type });
  const s = ev.data.object; if (s.payment_status !== 'paid') return res.status(200).json({ ignored: 'unpaid' });
  const f = k => ((s.custom_fields || []).find(x => x.key === k) || {}).text?.value || '';
  let siteUrl = f('site_url').trim(); if (siteUrl && !/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;
  const o = { orderId: 'ord_' + s.id.slice(-16), sessionId: s.id, eventId: ev.id, email: s.customer_details?.email, siteUrl, goal: f('visitor_goal'), status: 'pending', attempts: 0, createdAt: Date.now() };
  if (!o.email || !siteUrl) return res.status(200).json({ ignored: 'missing email/url', session: s.id });
  if (!(await createOnce(o))) return res.status(200).json({ duplicate: true, session: s.id });
  waitUntil(process1(o).catch(() => {}));
  res.status(200).json({ received: true, orderId: o.orderId });
};
module.exports.config = { api: { bodyParser: false } };
