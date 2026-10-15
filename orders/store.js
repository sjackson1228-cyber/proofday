// Durable file store. Idempotency via exclusive-create (O_EXCL) files; updates via write-temp+rename (atomic).
const fs = require('fs'), path = require('path'), cfg = require('./config');
const dir = (...p) => { const d = path.join(cfg.storeDir, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
const safe = s => String(s).replace(/[^a-zA-Z0-9_\-]/g, '_');
function createOnce(kind, id, obj) { // returns true if created, false if it already existed
  try { const fd = fs.openSync(path.join(dir(kind), safe(id) + '.json'), 'wx'); fs.writeSync(fd, JSON.stringify(obj, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}
function read(kind, id) { try { return JSON.parse(fs.readFileSync(path.join(dir(kind), safe(id) + '.json'), 'utf8')); } catch { return null; } }
function write(kind, id, obj) { const f = path.join(dir(kind), safe(id) + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2)); fs.renameSync(f + '.tmp', f); }
function list(kind) { return fs.readdirSync(dir(kind)).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir(kind), f), 'utf8'))); }
function log(msg, extra) { const line = `${new Date().toISOString()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`; console.log(line); fs.appendFileSync(path.join(dir('logs'), 'pipeline.log'), line + '\n'); }
module.exports = { createOnce, read, write, list, log, dir, safe };
