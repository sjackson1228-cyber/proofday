// Job worker: runs the Playwright engine, stores the PDF, emails the report. Retries with backoff, then fails gracefully.
const { execFile } = require('child_process'), fs = require('fs'), path = require('path');
const cfg = require('./config'), store = require('./store'), { sendOnce } = require('./mailer');
function runEngine(order, outDir) {
  return new Promise((resolve, reject) => {
    execFile('node', [cfg.enginePath, order.siteUrl, '--out', outDir, '--note', order.goal || '', '--client', order.email], { timeout: cfg.engineTimeoutMs, cwd: path.dirname(cfg.enginePath) }, (err, stdout, stderr) => {
      if (err) return reject(new Error('engine error: ' + (stderr || err.message).toString().slice(-400)));
      const data = JSON.parse(fs.readFileSync(path.join(outDir, 'data.json'), 'utf8'));
      const first = data.pages[0];
      // If the submitted URL itself could not be loaded at all, there is nothing to report on: treat as a failure (retry).
      if (!first || (first.views.desktop.error && first.views.mobile.error)) return reject(new Error('start URL unreachable: ' + (first?.views.desktop.error || 'no pages')));
      resolve({ data, stdout: stdout.trim().split('\n').pop() });
    });
  });
}
async function processJob(job) {
  const order = store.read('orders', job.sessionId);
  job.status = 'running'; job.attempts += 1; job.history.push({ attempt: job.attempts, startedAt: new Date().toISOString() }); store.write('jobs', job.orderId, job);
  store.log('job.start', { orderId: job.orderId, attempt: job.attempts, url: order.siteUrl });
  const outDir = path.join(store.dir('reports'), job.orderId, 'attempt' + job.attempts);
  try {
    const { data, stdout } = await runEngine(order, outDir);
    const pdf = path.join(store.dir('reports'), job.orderId, 'report.pdf');
    fs.copyFileSync(path.join(outDir, 'report.pdf'), pdf);
    job.pdf = pdf; job.verdict = data.verdict; job.counts = data.counts;
    await sendOnce(job.orderId, 'report', { to: order.email, subject: `Your Proofday Launch Check: ${data.verdict} — ${new URL(order.siteUrl).hostname} (${job.orderId})`,
      text: `Hi,\n\nYour Website Launch Check for ${order.siteUrl} is attached.\n\nVerdict: ${data.verdict} (High ${data.counts.High} / Medium ${data.counts.Medium} / Low ${data.counts.Low}).\nPage 1 is the owner summary; the developer section has copy-ready tickets.\n\nOne retest is included: reply to this email with "RETEST" after fixing and we'll re-run the same check.\nNot tested: form submissions, payments, logins, email delivery.\n\nOrder: ${job.orderId}\n— Proofday`,
      attachments: [{ filename: `proofday-report-${job.orderId}.pdf`, path: pdf }] });
    job.status = 'delivered'; job.deliveredAt = new Date().toISOString(); job.history.at(-1).result = 'ok: ' + stdout;
    store.write('jobs', job.orderId, job); store.log('job.delivered', { orderId: job.orderId, verdict: data.verdict });
  } catch (e) {
    job.history.at(-1).result = 'error: ' + e.message.slice(0, 300);
    if (job.attempts < cfg.maxAttempts) {
      const wait = cfg.backoffBaseMs * Math.pow(4, job.attempts - 1);
      job.status = 'retry'; job.nextRunAt = Date.now() + wait; store.write('jobs', job.orderId, job);
      store.log('job.retry_scheduled', { orderId: job.orderId, attempt: job.attempts, waitMs: wait, err: e.message.slice(0, 160) });
    } else {
      job.status = 'failed'; job.failedAt = new Date().toISOString(); store.write('jobs', job.orderId, job);
      store.log('job.failed', { orderId: job.orderId, attempts: job.attempts, err: e.message.slice(0, 160) });
      await sendOnce(job.orderId, 'failure_customer', { to: order.email, subject: `Sorry — we couldn't complete your Proofday Launch Check (${job.orderId})`,
        text: `Hi,\n\nWe tried ${job.attempts} times to check ${order.siteUrl} but couldn't load it (last error: ${e.message.slice(0, 160)}).\n\nYour refund is pending and will be issued in full to your original payment method — no action needed. If the site was offline or password-protected, you're welcome to order again once it is public.\n\nOrder: ${job.orderId}\nApologies,\n— Proofday` });
      await sendOnce(job.orderId, 'failure_owner', { to: cfg.ownerEmail, subject: `[Proofday ALERT] Job failed after ${job.attempts} attempts — refund needed (${job.orderId})`,
        text: `Order ${job.orderId} (session ${job.sessionId}) failed.\nURL: ${order.siteUrl}\nCustomer: ${order.email}\nAmount: ${order.amount} ${order.currency}\n\nHistory:\n${job.history.map(h => `#${h.attempt} ${h.startedAt} ${h.result}`).join('\n')}\n\nAction: refund in Stripe (automatable via STRIPE_SECRET_KEY + refunds.create once approved).` });
    }
  }
}
async function tick() {
  const due = store.list('jobs').filter(j => (j.status === 'queued' || j.status === 'retry') && j.nextRunAt <= Date.now());
  for (const j of due) await processJob(j); // sequential: one browser at a time
  return due.length;
}
async function loop({ untilIdle = false } = {}) {
  while (true) {
    await tick();
    if (untilIdle && !store.list('jobs').some(j => ['queued', 'retry', 'running'].includes(j.status))) return;
    await new Promise(r => setTimeout(r, cfg.pollMs));
  }
}
function recover() { for (const j of store.list('jobs')) if (j.status === 'running') { j.status = 'retry'; j.nextRunAt = Date.now(); store.write('jobs', j.orderId, j); store.log('job.recovered_after_crash', { orderId: j.orderId }); } }
if (require.main === module) recover(), loop({ untilIdle: process.argv.includes('--until-idle') });
module.exports = { tick, loop };
