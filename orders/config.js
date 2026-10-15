// All environment-specific settings. Going live = change env vars only.
const path = require('path');
module.exports = {
  port: +process.env.PORT || 8787,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_not_a_real_key', // only used for SDK init; webhook verification needs only the signing secret
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || 'whsec_local_test_secret_proofday',
  storeDir: process.env.STORE_DIR || path.join(__dirname, 'store'),
  enginePath: process.env.ENGINE_PATH || path.join(__dirname, '..', 'engine', 'launchcheck.js'),
  engineTimeoutMs: +process.env.ENGINE_TIMEOUT_MS || 10 * 60e3,
  maxAttempts: +process.env.MAX_ATTEMPTS || 3,
  backoffBaseMs: +process.env.BACKOFF_BASE_MS || 60e3, // attempt n waits base * 4^(n-1): 1m, 4m (prod); set small for tests
  pollMs: +process.env.POLL_MS || 2000,
  // Mail: MAIL_TRANSPORT=file (test sink, writes .eml) | smtp (e.g. Resend SMTP: smtp.resend.com:465, user "resend", pass = API key)
  mailTransport: process.env.MAIL_TRANSPORT || 'file',
  smtp: { host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 465, secure: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } },
  mailFrom: process.env.MAIL_FROM || 'Proofday <proofday-test@mail.grokbot.com>',
  ownerEmail: process.env.OWNER_EMAIL || 'proofday-test@mail.grokbot.com',
  // Stripe Payment Link custom field keys (set these exact keys when creating the Payment Link)
  fieldUrl: 'site_url', fieldGoal: 'visitor_goal',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://getproofday.com',
};
