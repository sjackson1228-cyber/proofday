// Vercel Cron: retries pending/stuck orders (one at a time to stay inside maxDuration).
const { pending, process1 } = require('../lib/orders');
module.exports = async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).end();
  const p = await pending(); const done = p.length ? await process1(p[0]) : null;
  res.status(200).json({ pending: p.length, processed: done && { orderId: done.orderId, status: done.status } });
};
