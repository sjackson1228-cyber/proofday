// Daily metrics from the order store (visitors/scans need analytics wiring; see README).
const store = require('./store'); const since = Date.now() - 86400e3;
const jobs = store.list('jobs'), orders = store.list('orders');
const recent = o => Date.parse(o.createdAt) >= since;
const r = { date: new Date().toISOString().slice(0, 10), orders24h: orders.filter(recent).length, ordersTotal: orders.length,
  revenueUsd24h: orders.filter(recent).reduce((a, o) => a + (o.amount || 0), 0) / 100,
  delivered: jobs.filter(j => j.status === 'delivered').length, failed: jobs.filter(j => j.status === 'failed').length,
  pending: jobs.filter(j => ['queued', 'retry', 'running'].includes(j.status)).length,
  visitors: 'n/a (Vercel Web Analytics not enabled)', scans: 'n/a (add counter to /api/scan)', costsUsd: 0 };
console.log(JSON.stringify(r, null, 2));
