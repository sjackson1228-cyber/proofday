# Proofday order pipeline (test mode)
- `server.js` — POST /webhooks/stripe: verifies Stripe signature, idempotent on event id AND session id (exclusive-create files), creates order + queued job.
- `worker.js` — runs ../engine/launchcheck.js (Playwright), stores PDF, emails report once per (order, kind). 3 attempts, backoff base*4^(n-1), then failed + customer apology/refund-pending + owner alert. Recovers jobs stuck in `running` on restart.
- `mailer.js` — MAIL_TRANSPORT=file (writes .eml to store/outbox) or smtp (e.g. Resend SMTP).
- `test-e2e.js` — builds checkout.session.completed events and signs them with stripe.webhooks.generateTestHeaderString.
- `daily-report.js` — orders/revenue/delivered/failed/pending.
Go live: set STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, MAIL_TRANSPORT=smtp + SMTP_*, MAIL_FROM, OWNER_EMAIL; Payment Link custom fields keys `site_url` and `visitor_goal`.
