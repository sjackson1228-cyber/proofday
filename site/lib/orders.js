// Order store on Vercel Blob (no KV add-on needed). Dedupe: one blob per checkout session, created with allowOverwrite:false.
const { put, head, list } = require('@vercel/blob');
const { execFile } = require('child_process'); const fs = require('fs'), path = require('path'), os = require('os');
const MAX = 3;
const key = s => `orders/${s}.json`;
async function getJson(pathname) { try { const h = await head(pathname); return await (await fetch(h.url + '?t=' + Date.now())).json(); } catch { return null; } }
async function save(o) { await put(key(o.sessionId), JSON.stringify(o), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true }); }
async function createOnce(o) {
  try { await put(key(o.sessionId), JSON.stringify(o), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false }); return true; }
  catch (e) { if (/already exists/i.test(e.message)) return false; throw e; }
}
function runEngine(o, out) { return new Promise((res, rej) => execFile(process.execPath, [path.join(process.cwd(), 'lib', 'engine.js'), o.siteUrl, '--out', out, '--note', o.goal || '', '--client', o.email], { timeout: 700e3 }, (err, so, se) => err ? rej(new Error((se || err.message).slice(-500))) : res())); }
async function sendResend(o, pdfBuf, verdict, counts) {
  const host = new URL(o.siteUrl).hostname;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `${o.orderId}__report` },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Proofday <reports@getproofday.com>', reply_to: process.env.MAIL_REPLY_TO || 'proofday.connect@gmail.com', to: [o.email],
      subject: `Your Proofday Launch Check: ${verdict} — ${host} (${o.orderId})`,
      text: `Hi,\n\nYour Website Launch Check for ${o.siteUrl} is attached.\n\nVerdict: ${verdict} (High ${counts.high||0} / Medium ${counts.medium||0} / Low ${counts.low||0}).\n\nOne retest is included: reply with "RETEST" after fixing.\nNot tested: form submissions, payments, logins, email delivery.\n\nOrder: ${o.orderId}\n— Proofday`,
      attachments: [{ filename: `proofday-report-${o.orderId}.pdf`, content: pdfBuf.toString('base64') }] }) });
  const j = await r.json(); if (!r.ok) throw new Error('resend ' + r.status + ' ' + JSON.stringify(j)); return j.id;
}
async function process1(o) {
  if (o.status === 'delivered' || o.status === 'failed') return o;
  if (o.status === 'running' && Date.now() - o.startedAt < 15 * 60e3) return o;
  o.status = 'running'; o.attempts = (o.attempts || 0) + 1; o.startedAt = Date.now(); await save(o);
  try {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-')); await runEngine(o, out);
    const data = JSON.parse(fs.readFileSync(path.join(out, 'data.json'))); const pdf = fs.readFileSync(path.join(out, 'report.pdf'));
    if (!data.pages || !data.pages.length) throw new Error('site unreachable');
    const b = await put(`reports/${o.orderId}.pdf`, pdf, { access: 'public', contentType: 'application/pdf', addRandomSuffix: true });
    o.pdfUrl = b.url; o.verdict = data.verdict; o.emailId = await sendResend(o, pdf, data.verdict, data.counts || {}); o.status = 'delivered';
  } catch (e) { o.lastError = e.message; o.status = o.attempts >= MAX ? 'failed' : 'pending'; }
  await save(o); return o;
}
async function pending() { const { blobs } = await list({ prefix: 'orders/' }); const out = []; for (const b of blobs) { const o = await getJson(b.pathname); if (o && (o.status === 'pending' || o.status === 'running')) out.push(o); } return out; }
module.exports = { createOnce, process1, pending };
