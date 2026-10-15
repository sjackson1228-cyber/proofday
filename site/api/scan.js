// Proofday free quick preview — lightweight fetch-based HTML check (NOT the full browser-based Launch Check)
const dns = require('dns').promises;
const crypto = require('crypto');
const POW_PREFIX = '0000'; // ~65k hashes avg in the browser (<1s); makes bulk abuse costly
const net = require('net');

const RL = new Map(); // fallback per-instance rate limit: ip -> [timestamps]
const PER_MIN = 4, PER_DAY = 25, GLOBAL_PER_MIN = 60;
let globalHits = [];
const UA = 'Mozilla/5.0 (compatible; Proofday-QuickPreview/1.0; +https://getproofday.com/scan)';

function memLimited(ip, now) {
  const h = (RL.get(ip) || []).filter(t => now - t < 86400e3);
  if (h.filter(t => now - t < 60e3).length >= PER_MIN || h.length >= PER_DAY) return true;
  h.push(now); RL.set(ip, h); if (RL.size > 5000) RL.clear();
  return false;
}
// Shared per-IP limit across instances: one private Vercel Blob per IP hash, updated with ETag compare-and-swap.
// Contention that can't be resolved => deny (fail closed). Storage unavailable/erroring => per-instance memory limit.
const BLOB_TOKEN = process.env.PRIV_READ_WRITE_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
// IPv6 clients often rotate addresses within their /64, so count per /64 prefix.
function rlKey(ip) {
  if (net.isIPv6(ip) && !ip.toLowerCase().startsWith('::ffff:')) {
    const [head, tail = ''] = ip.toLowerCase().split('::'); const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
    const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t]; return full.slice(0, 4).map(x => x || '0').join(':') + '::/64';
  }
  return ip;
}
async function sharedLimited(ip, now) {
  const { get, put } = require('@vercel/blob');
  const key = 'ratelimit/scan/' + crypto.createHash('sha256').update('pd-rl|' + rlKey(ip)).digest('hex').slice(0, 32) + '.json';
  const opt = { token: BLOB_TOKEN };
  for (let i = 0; i < 8; i++) {
    let etag = null, h = [];
    const r = await get(key, { access: 'private', useCache: false, ...opt });
    if (r && r.statusCode === 200) { etag = r.blob.etag; try { h = JSON.parse(await new Response(r.stream).text()); } catch { h = []; } }
    h = (Array.isArray(h) ? h : []).filter(t => now - t < 86400e3);
    if (h.filter(t => now - t < 60e3).length >= PER_MIN || h.length >= PER_DAY) return true;
    h.push(now);
    try {
      await put(key, JSON.stringify(h), { access: 'private', contentType: 'application/json', addRandomSuffix: false, cacheControlMaxAge: 60, ...(etag ? { ifMatch: etag } : { allowOverwrite: false }), ...opt });
      return false;
    } catch (e) {
      if (/precondition|already exists|conflicting operation|conditional request|412|409/i.test(e.message || '') || /Precondition|AlreadyExists/i.test(e.name || '')) { await new Promise(r => setTimeout(r, 30 + Math.random() * 120)); continue; }
      throw e;
    }
  }
  return true; // heavy contention on one IP = burst; deny
}
async function rateLimited(ip) {
  const now = Date.now();
  globalHits = globalHits.filter(t => now - t < 60e3);
  if (globalHits.length >= GLOBAL_PER_MIN) return true;
  ip = rlKey(ip); let limited;
  if (BLOB_TOKEN) { try { limited = await sharedLimited(ip, now); memLimited(ip, now); } catch (e) { console.error('ratelimit storage error, using memory', e.message); limited = memLimited(ip, now); } }
  else limited = memLimited(ip, now);
  if (!limited) globalHits.push(now);
  return limited;
}
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && privateIp(l.slice(7)));
}
async function safeUrl(u) {
  let x; try { x = new URL(u); } catch { throw new Error('That does not look like a valid URL.'); }
  if (!/^https?:$/.test(x.protocol)) throw new Error('Only http(s) URLs can be checked.');
  if (x.port && !['80', '443'].includes(x.port)) throw new Error('Only standard ports (80/443) are allowed.');
  if (x.username || x.password) throw new Error('URLs with credentials are not allowed.');
  const host = x.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error('Private addresses cannot be checked.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error('Could not find that domain (DNS lookup failed).'); });
  if (!addrs.length || addrs.some(a => privateIp(a.address))) throw new Error('Private addresses cannot be checked.');
  return x;
}
async function safeFetch(u, { method = 'GET', timeout = 8000, maxBytes = 1_500_000 } = {}) {
  let url = u;
  for (let hop = 0; hop < 5; hop++) {
    await safeUrl(url);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    const t0 = Date.now();
    try {
      const r = await fetch(url, { method, redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
      const ms = Date.now() - t0;
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), url).href; continue; }
      let body = '';
      if (method === 'GET' && /html/i.test(r.headers.get('content-type') || '')) {
        const reader = r.body.getReader(); const chunks = []; let n = 0;
        while (true) { const { done, value } = await reader.read(); if (done) break; n += value.length; chunks.push(value); if (n > maxBytes) { ctl.abort(); break; } }
        body = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
      } else { try { r.body?.cancel(); } catch {} }
      return { status: r.status, url, ms, body, ctype: r.headers.get('content-type') || '' };
    } finally { clearTimeout(t); }
  }
  throw new Error('Too many redirects.');
}
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null; };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(JSON.stringify({ error: 'Use POST.' })); }
  const origin = req.headers.origin || '';
  if (origin && !/^https:\/\/(www\.)?getproofday\.com$/.test(origin) && !/^https:\/\/proofday(-[a-z0-9-]+)?(-beaver16)?\.vercel\.app$/.test(origin) && origin !== 'https://proofday-stripe-test.vercel.app' && !/^http:\/\/localhost(:\d+)?$/.test(origin)) { res.statusCode = 403; return res.end(JSON.stringify({ error: 'Forbidden origin.' })); }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};
  if (body.website) { res.statusCode = 200; return res.end(JSON.stringify({ error: 'Thanks.' })); } // honeypot
  const pow = body.pow || {};
  const ts = Number(pow.ts) || 0;
  const powHash = crypto.createHash('sha256').update(`${String(body.url || '')}|${ts}|${pow.nonce}`).digest('hex');
  if (Math.abs(Date.now() - ts) > 300e3 || !powHash.startsWith(POW_PREFIX)) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Verification failed — please reload the page and try again.' })); }
  if (await rateLimited(ip)) { res.statusCode = 429; return res.end(JSON.stringify({ error: 'Too many previews right now — please wait a minute and try again.' })); }
  let input = String(body.url || '').trim().slice(0, 500);
  if (input && !/^https?:\/\//i.test(input)) input = 'https://' + input;
  // NOTE: body.email (optional) is intentionally NOT stored or sent anywhere in v1.
  try {
    const target = await safeUrl(input);
    const r = await safeFetch(target.href);
    const html = r.body;
    const findings = []; // {w, title}
    const add = (w, title) => findings.push({ w, title });
    if (r.status >= 400) add(40, `The page returns an error (HTTP ${r.status}).`);
    if (!/html/i.test(r.ctype)) add(30, 'The URL did not return an HTML page.');
    if (new URL(r.url).protocol !== 'https:') add(10, 'The page is not served over HTTPS.');
    const head = html.slice(0, 200000);
    const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '';
    const metaTags = head.match(/<meta\b[^>]*>/gi) || [];
    const desc = metaTags.find(t => /name\s*=\s*["']?description/i.test(t));
    const viewport = metaTags.some(t => /name\s*=\s*["']?viewport/i.test(t));
    const h1 = (html.match(/<h1\b/gi) || []).length;
    const imgs = html.match(/<img\b[^>]*>/gi) || [];
    const noAlt = imgs.filter(t => attr(t, 'alt') === null).length;
    const lang = attr((html.match(/<html\b[^>]*>/i) || [''])[0], 'lang');
    if (html) {
      if (!viewport) add(15, 'No mobile viewport tag — phones will show a shrunken desktop page.');
      if (!title) add(10, 'The page has no title.');
      if (!desc || !attr(desc, 'content')) add(8, 'Missing meta description (search results show random text).');
      if (h1 !== 1) add(6, h1 ? `${h1} H1 headings (should be one).` : 'No H1 main heading.');
      if (noAlt) add(Math.min(10, noAlt * 2), `${noAlt} image(s) missing alt text.`);
      if (!lang) add(4, 'The page language (html lang) is not declared.');
    }
    if (r.ms > 3000) add(15, `Slow server response (${(r.ms / 1000).toFixed(1)}s for the HTML).`);
    else if (r.ms > 1500) add(8, `Server response is a bit slow (${(r.ms / 1000).toFixed(1)}s for the HTML).`);
    // sample links
    const hrefs = [...new Set((html.match(/<a\b[^>]*>/gi) || []).map(t => attr(t, 'href')).filter(Boolean)
      .map(h => { try { const x = new URL(h, r.url); x.hash = ''; return x.href; } catch { return null; } }).filter(h => h && /^https?:/.test(h)))];
    const sample = hrefs.slice(0, 8);
    const linkRes = await Promise.all(sample.map(async u => {
      try { let x = await safeFetch(u, { method: 'HEAD', timeout: 5000 }); if (x.status >= 400) x = await safeFetch(u, { timeout: 5000, maxBytes: 50000 }); return { u, s: x.status }; }
      catch (e) { return { u, s: 0 }; }
    }));
    const broken = linkRes.filter(l => [404, 410].includes(l.s) || l.s >= 500 && l.s !== 503);
    if (broken.length) add(Math.min(24, broken.length * 8), `${broken.length} of ${sample.length} sampled links look broken (e.g. ${broken[0].u.slice(0, 80)}).`);
    findings.sort((a, b) => b.w - a.w);
    const score = Math.max(0, 100 - findings.reduce((a, f) => a + f.w, 0));
    res.statusCode = 200;
    res.end(JSON.stringify({
      url: r.url, status: r.status, responseMs: r.ms, score,
      issueCount: findings.length, top: findings.slice(0, 3).map(f => f.title),
      checked: { title: !!title, metaDescription: !!(desc && attr(desc, "content")), viewport, h1, images: imgs.length, imagesMissingAlt: noAlt, linksSampled: sample.length, brokenLinks: broken.length },
      note: 'Quick preview: one page, raw HTML only, no browser. The $149 Launch Check renders up to 10 pages on desktop + mobile with screenshots.',
    }));
  } catch (e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: e.name === 'AbortError' ? 'The site took too long to respond (8s limit).' : (e.message || 'Could not check that URL.') }));
  }
};
