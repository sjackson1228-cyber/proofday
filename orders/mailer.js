const nodemailer = require('nodemailer'), fs = require('fs'), path = require('path'), cfg = require('./config'), store = require('./store');
const transport = cfg.mailTransport === 'smtp' ? nodemailer.createTransport(cfg.smtp) : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
// Each (orderId, kind) is sent at most once: guarded by an exclusive-create record.
async function sendOnce(orderId, kind, msg) {
  const key = `${orderId}__${kind}`;
  if (!store.createOnce('emails', key, { orderId, kind, to: msg.to, subject: msg.subject, status: 'sending', at: new Date().toISOString() })) { store.log('email.skip_duplicate', { key }); return false; }
  let info;
  try { info = await transport.sendMail({ from: cfg.mailFrom, ...msg }); }
  catch (e) { require('fs').unlinkSync(require('path').join(store.dir('emails'), store.safe(key) + '.json')); store.log('email.error', { key, err: e.message }); throw e; }
  const rec = { orderId, kind, to: msg.to, subject: msg.subject, status: 'sent', at: new Date().toISOString(), transport: cfg.mailTransport, messageId: info.messageId };
  if (cfg.mailTransport !== 'smtp') { const f = path.join(store.dir('outbox'), store.safe(key) + '.eml'); fs.writeFileSync(f, info.message); rec.file = f; }
  store.write('emails', key, rec); store.log('email.sent', { key, to: msg.to, subject: msg.subject });
  return true;
}
module.exports = { sendOnce };
