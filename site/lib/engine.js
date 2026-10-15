#!/usr/bin/env node
// Proofday Website Launch Check — delivery engine v2
// Usage: node launchcheck.js <url> [--out dir] [--max 10] [--note "what visitors should do"] [--client "Name"]
const { chromium, request } = require('playwright-core');
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const START = args[0];
if (!START || !/^https?:\/\//.test(START)) { console.error('Usage: node launchcheck.js <https://url> [--out dir] [--max 10] [--note ".."] [--client ".."]'); process.exit(1); }
const MAX = Math.min(parseInt(opt('max', '10')), 10);
const NOTE = opt('note', ''), CLIENT = opt('client', '');
const OUT = opt('out', path.join('reports', new URL(START).hostname + '-' + new Date().toISOString().slice(0, 10)));
const SLOW_MS = 3000, VERY_SLOW_MS = 6000, LINK_CAP = 200, SHOT_MAX_H = 8000, JPEG_Q = 50;
const VIEWPORTS = {
  desktop: { viewport: { width: 1366, height: 768 } },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
};
const LINK_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Proofday-LaunchCheck/2.0';
const SKIP_EXT = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|mp3|docx?|xlsx?|pptx?|css|js|xml|json|ico|txt|rss)(\?|$)/i;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));
const norm = u => { const x = new URL(u); x.hash = ''; return x.href; };
const vpLabel = { desktop: 'desktop (1366×768)', mobile: 'mobile (390×844)' };

// ---------- issue store with dedupe ----------
const issues = new Map();
function add(key, base, pageUrl, vp, evidence) {
  if (!issues.has(key)) issues.set(key, { ...base, pages: new Set(), vps: new Set(), evidence: [] });
  const is = issues.get(key);
  if (pageUrl) is.pages.add(pageUrl); if (vp) is.vps.add(vp);
  if (evidence && is.evidence.length < 2) is.evidence.push(evidence);
}

async function evidenceShot(page, marker, file, label) {
  // highlight element(s) carrying data-lc attr and capture a cropped region in document coordinates
  const box = await page.evaluate(m => {
    const el = document.querySelector(`[data-lc="${m}"]`); if (!el) return null;
    el.style.outline = '4px solid #e53935'; el.style.outlineOffset = '2px'; el.style.boxShadow = '0 0 0 9999px rgba(0,0,0,.08)';
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, dw: document.documentElement.scrollWidth, dh: document.documentElement.scrollHeight };
  }, marker);
  if (!box) return null;
  await page.waitForTimeout(150);
  const pad = 120;
  const y = Math.max(0, box.y - pad), h = Math.min(Math.max(box.h + 2 * pad, 300), 900, box.dh - y);
  const w = Math.min(box.dw, 1500);
  await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 60, fullPage: true, scale: 'css', clip: { x: 0, y, width: w, height: Math.max(h, 50) } });
  return { file, label };
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const origin = new URL(START).origin;
  let browser;
  if (process.env.VERCEL) { process.env.AWS_LAMBDA_JS_RUNTIME = process.env.AWS_LAMBDA_JS_RUNTIME || 'nodejs22.x'; const sc = require('@sparticuz/chromium-min'); browser = await chromium.launch({ args: sc.args, executablePath: await sc.executablePath(process.env.CHROMIUM_PACK_URL), headless: true, env: process.env }); }
  else browser = await chromium.launch();
  const ctxs = {};
  for (const [k, v] of Object.entries(VIEWPORTS)) ctxs[k] = await browser.newContext(v);
  const queue = [norm(START)], seen = new Set(queue), pages = [], allLinks = new Map();
  let evN = 0;
  while (queue.length && pages.length < MAX) {
    const url = queue.shift();
    const idx = pages.length + 1;
    const rec = { url, views: {} };
    for (const vp of Object.keys(VIEWPORTS)) {
      const page = await ctxs[vp].newPage();
      const consoleErrors = [], failed = [];
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
      page.on('pageerror', e => consoleErrors.push('Uncaught: ' + String(e.message).slice(0, 300)));
      page.on('requestfailed', r => failed.push({ url: r.url(), why: r.failure()?.errorText || 'failed' }));
      page.on('response', r => { if (r.status() >= 400 && r.request().resourceType() !== 'document') failed.push({ url: r.url(), why: 'HTTP ' + r.status() }); });
      const v = { consoleErrors, failed };
      const t0 = Date.now();
      try {
        const resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        v.status = resp ? resp.status() : null;
        v.finalUrl = page.url();
        v.ctype = resp ? (resp.headers()['content-type'] || '') : '';
        v.nonHtml = !!(v.ctype && !/html/i.test(v.ctype));
        v.wallMs = Date.now() - t0;
        await page.waitForTimeout(800);
        Object.assign(v, await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          const d = document.documentElement, vw = Math.min(window.innerWidth, screen.width || window.innerWidth), over = [];
          if (d.scrollWidth > vw + 1) {
            for (const el of document.querySelectorAll('body *')) {
              const r = el.getBoundingClientRect();
              if (r.right > vw + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') {
                const p = el.parentElement, pr = p && p.getBoundingClientRect();
                if (!pr || pr.right <= vw + 1) { el.setAttribute('data-lc', 'over' + over.length); over.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ` (extends to ${Math.round(r.right)}px)`); }
                if (over.length >= 5) break;
              }
            }
          }
          const imgs = [...document.images];
          return {
            title: document.title.trim(),
            metaDesc: document.querySelector('meta[name="description"]')?.content?.trim() || '',
            viewportMeta: !!document.querySelector('meta[name="viewport"]'),
            lang: d.getAttribute('lang') || '',
            h1: document.querySelectorAll('h1').length,
            imgsNoAlt: imgs.filter(i => !i.hasAttribute('alt')).map(i => i.currentSrc || i.src),
            brokenImgs: imgs.filter(i => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map(i => i.currentSrc || i.src),
            scrollWidth: d.scrollWidth, scrollHeight: d.scrollHeight, innerWidth: vw, overflowEls: over,
            ttfb: Math.round(nav.responseStart || 0), dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0),
            bytes: Math.round(performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0) + (nav.transferSize || 0)),
            links: [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^https?:/.test(h)),
          };
        }));
        // full-page screenshot (capped height, CSS pixel scale, JPEG)
        const shot = `shots/p${idx}-${vp}.jpg`;
        const fullH = Math.min(v.scrollHeight || 768, SHOT_MAX_H);
        await page.screenshot({ path: path.join(OUT, shot), type: 'jpeg', quality: JPEG_Q, scale: 'css', fullPage: true,
          clip: { x: 0, y: 0, width: Math.min(v.scrollWidth || 1366, 1600), height: fullH } });
        v.shot = shot; v.shotTruncated = (v.scrollHeight || 0) > SHOT_MAX_H;
        // High-issue evidence captured in place
        if (vp === 'mobile' && !v.nonHtml && v.viewportMeta && v.status < 400 && v.overflowEls.length) {
          v.overflowEvidence = await evidenceShot(page, 'over0', `shots/ev${++evN}.jpg`, `Mobile: element highlighted in red runs past the 390px screen edge (${v.overflowEls[0]})`);
        }
        if (vp === 'mobile' && !v.nonHtml && v.status < 400 && !v.viewportMeta) {
          await page.evaluate(() => scrollTo(0, 0));
          const f = `shots/ev${++evN}.jpg`; await page.screenshot({ path: path.join(OUT, f), type: 'jpeg', quality: 60, scale: 'css' });
          v.viewportEvidence = { file: f, label: 'Mobile first screen without a viewport tag (desktop layout shrunk)' };
        }
        if (vp === 'desktop') for (const l of v.links) {
          const n = norm(l);
          if (!allLinks.has(n)) allLinks.set(n, new Set()); allLinks.get(n).add(url);
          if (new URL(n).origin === origin && !seen.has(n) && !SKIP_EXT.test(n)) { seen.add(n); queue.push(n); }
        }
      } catch (e) {
        v.error = String(e.message).split('\n')[0]; v.wallMs = Date.now() - t0;
        try { const f = `shots/p${idx}-${vp}.jpg`; await page.screenshot({ path: path.join(OUT, f), type: 'jpeg', quality: JPEG_Q, scale: 'css' }); v.shot = f; } catch {}
      }
      rec.views[vp] = v;
      await page.close();
    }
    pages.push(rec);
    console.log(`[${pages.length}/${MAX}] ${url} desktop=${rec.views.desktop.status ?? 'ERR'} mobile=${rec.views.mobile.status ?? 'ERR'}`);
  }

  // ---------- link checks ----------
  const api = await request.newContext({ extraHTTPHeaders: { 'User-Agent': LINK_UA, 'Accept': 'text/html,*/*' } });
  const linkList = [...allLinks.keys()].slice(0, LINK_CAP);
  const linkResults = []; let li = 0;
  const MANUAL_STATUS = new Set([401, 403, 405, 406, 429, 503, 999]);
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (li < linkList.length) {
      const u = linkList[li++]; let status, err;
      try {
        let r = await api.fetch(u, { method: 'HEAD', timeout: 15000, maxRedirects: 5 });
        if (r.status() >= 400) r = await api.get(u, { timeout: 15000, maxRedirects: 5 });
        status = r.status();
      } catch (e) { err = String(e.message).split('\n')[0].slice(0, 140); }
      if (err || status >= 500) { // one retry for transient failures
        await new Promise(r => setTimeout(r, 2000));
        try { const r = await api.get(u, { timeout: 20000, maxRedirects: 5 }); status = r.status(); err = undefined; } catch (e) { err = String(e.message).split('\n')[0].slice(0, 140); }
      }
      // crawled pages that rendered fine in the browser are not broken
      const visited = pages.find(p => p.url === u && p.views.desktop.status && p.views.desktop.status < 400);
      if (visited && (err || status >= 400)) { status = visited.views.desktop.status; err = undefined; }
      let cls = 'ok';
      if (err) cls = /timeout|ETIMEDOUT|ECONNRESET|socket hang up|EPROTO|disconnected|TLS|ECONNABORTED|EAI_AGAIN/i.test(err) ? 'manual' : 'broken';
      else if (MANUAL_STATUS.has(status)) cls = 'manual';
      else if (status >= 400) cls = 'broken';
      linkResults.push({ url: u, status, err, cls, from: [...allLinks.get(u)], internal: new URL(u).origin === origin });
    }
  }));
  await api.dispose();

  // evidence for broken internal links: highlight the link on its first source page
  const brokenInternal = linkResults.filter(l => l.cls === 'broken' && l.internal);
  for (const l of brokenInternal.slice(0, 10)) {
    const page = await ctxs.desktop.newPage();
    try {
      await page.goto(l.from[0], { waitUntil: 'load', timeout: 30000 });
      const found = await page.evaluate(t => { const a = [...document.querySelectorAll('a[href]')].find(a => { try { const x = new URL(a.href); x.hash = ''; return x.href === t; } catch { return false; } }); if (a) { a.setAttribute('data-lc', 'link'); return true; } return false; }, l.url);
      if (found) l.evidence = await evidenceShot(page, 'link', `shots/ev${++evN}.jpg`, `Desktop: the broken link highlighted on ${l.from[0]}`);
    } catch {}
    await page.close();
  }

  // ---------- build issues ----------
  const pageCount = pages.length;
  for (const p of pages) {
    const d = p.views.desktop, m = p.views.mobile;
    for (const [vp, v] of Object.entries(p.views)) {
      if (v.error) {
        add('err|' + p.url, { sev: 'High', cat: 'Availability', title: `Page did not finish loading: ${p.url}`,
          plain: 'A page could not be loaded within 30 seconds — visitors may see a blank or broken page.',
          steps: [`Open ${p.url} in a browser.`], expected: 'Page loads within a few seconds.', actual: v.error,
          fix: 'Confirm the page is published and publicly reachable; check server logs for slow or failing responses.' }, p.url, vp, v.shot && { file: v.shot, label: `Screenshot at the time of failure (${vp})` });
        continue;
      }
      if (v.status >= 400 && (p.url === norm(START) || !allLinks.has(p.url))) add('status|' + p.url, { sev: 'High', cat: 'Availability', title: `Page returns HTTP ${v.status}`,
        plain: `A page linked from your site shows an error (HTTP ${v.status}) instead of content.`,
        steps: [`Open ${p.url}.`], expected: 'HTTP 200 with page content.', actual: `Server responds HTTP ${v.status}.`,
        fix: 'Publish the page, or update links pointing to it / add a 301 redirect to the correct URL.' }, p.url, vp, v.shot && { file: v.shot, label: `What visitors see (${vp})` });
      if (v.nonHtml || v.status >= 400) continue;
      const failedUrls = new Set(v.failed.map(f => f.url));
      for (const f of v.failed) {
        const mixed = /mixed-content/i.test(f.why);
        add('res|' + f.url, { sev: 'Medium', cat: 'Missing content', title: mixed ? `Insecure (http://) resource blocked: ${f.url.slice(0, 90)}` : `Resource fails to load (${f.why}): ${f.url.slice(0, 90)}`,
          plain: mixed ? 'Part of the site (a script, style or image) is loaded insecurely and browsers block it, which can break features.' : 'A file the page needs (image, script, style or font) fails to load.',
          steps: ['Open the page below in Chrome.', 'Open DevTools → Network (and Console), reload.', `Look for ${f.url}`],
          expected: 'All page resources load successfully.', actual: `${f.url} → ${f.why}${mixed ? ' (page is HTTPS, resource is HTTP)' : ''}.`,
          fix: mixed ? 'Change the URL to https:// (or a protocol-relative/self-hosted copy) so browsers allow it.' : 'Restore the file, correct its path, or remove the reference.' }, p.url, vp);
      }
      for (const msg of v.consoleErrors) {
        // skip console noise that just repeats a failed resource we already report
        if ([...failedUrls].some(u => msg.includes(u.slice(0, 60))) || /Failed to load resource/i.test(msg)) continue;
        const k = msg.replace(/\d+/g, 'N').slice(0, 160);
        add('con|' + k, { sev: 'Medium', cat: 'Functionality', title: `JavaScript error: ${msg.slice(0, 100)}`,
          plain: 'A script on the site crashes in the browser — menus, sliders, forms or tracking may not work.',
          steps: ['Open the page below in Chrome.', 'Open DevTools → Console and reload.'], expected: 'No errors in the console.', actual: msg,
          fix: 'Fix or remove the failing script; check the file/line shown in the console.' }, p.url, vp);
      }
      for (const src of v.brokenImgs.filter(s => !failedUrls.has(s))) add('img|' + src, { sev: 'Medium', cat: 'Missing content', title: `Broken image: ${src.slice(0, 90)}`,
        plain: 'An image is missing and shows as a blank or broken icon.', steps: ['Open the page below and scroll through it.'],
        expected: 'Image displays.', actual: `${src} does not render.`, fix: 'Re-upload the image or fix its src URL.' }, p.url, vp);
      if (v.load > SLOW_MS) {
        const high = v.load > VERY_SLOW_MS;
        add('slow|' + (high ? 'h' : 'l'), { sev: high ? 'High' : 'Low', cat: 'Performance', title: high ? `Very slow page load (over ${VERY_SLOW_MS / 1000}s)` : `Slow page load (over ${SLOW_MS / 1000}s)`,
          plain: 'Some pages take several seconds to load; many visitors leave before they finish.',
          steps: ['Open the page(s) below with a cleared cache.', 'DevTools → Network → note the Load time.'],
          expected: `Full load under ${SLOW_MS / 1000}s.`, actual: `${p.url} (${vp}): first byte ${v.ttfb}ms, ready ${v.dcl}ms, full load ${v.load}ms, ~${Math.round(v.bytes / 1024)} KB.`,
          fix: 'Compress/resize images (WebP/AVIF), lazy-load below-the-fold media, defer non-critical scripts, enable caching/CDN.' }, p.url, vp, high && v.shot ? { file: v.shot, label: `Slow page (${vp}), full load ${v.load}ms` } : null);
      }
    }
    if (!m.error && !m.nonHtml && m.viewportMeta && !(m.status >= 400) && m.scrollWidth > m.innerWidth + 1) add('over', { sev: 'High', cat: 'Mobile display', title: 'Page scrolls sideways on mobile',
      plain: 'On phones the page is wider than the screen, so visitors can swipe sideways and content looks broken.',
      steps: ['Open the page below on a phone (or Chrome DevTools device mode at 390px wide).', 'Swipe left/right.'],
      expected: 'Page fits the 390px screen; no sideways scrolling.', actual: `${p.url}: page is ${m.scrollWidth}px wide. Overflowing: ${m.overflowEls.join('; ')}`,
      fix: 'Give media max-width:100%, let long words/URLs wrap (overflow-wrap:anywhere), and replace fixed widths with responsive CSS.' }, p.url, 'mobile', m.overflowEvidence);
    if (!d.error && !d.nonHtml && !(d.status >= 400)) {
      if (!d.viewportMeta) add('vpm', { sev: 'High', cat: 'Mobile display', title: 'No mobile viewport tag', plain: 'Phones show a tiny zoomed-out desktop version of the page.',
        steps: ['View source of the page below.', 'Search for name="viewport".'], expected: '<meta name="viewport" content="width=device-width, initial-scale=1"> in <head>.', actual: 'No viewport meta tag.',
        fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.' }, p.url, null, m.viewportEvidence);
      if (!d.title) add('title', { sev: 'Medium', cat: 'SEO basics', title: 'Missing page title', plain: 'Some pages have no title, so browser tabs and Google results show a bare URL.',
        steps: ['View source of the page below.'], expected: 'A unique <title>.', actual: '<title> empty or missing.', fix: 'Add a unique, descriptive <title> (50–60 characters).' }, p.url);
      if (!d.metaDesc) add('desc', { sev: 'Low', cat: 'SEO basics', title: 'Missing or empty meta description', plain: 'Search results will show random page text instead of a written summary.',
        steps: ['View source of the page below.', 'Search for name="description".'], expected: 'A 120–160 character description.', actual: 'Meta description missing or empty.', fix: 'Add <meta name="description" content="…"> summarising each page.' }, p.url);
      if (d.h1 !== 1) add('h1|' + (d.h1 ? 'n' : '0'), { sev: 'Low', cat: 'SEO basics', title: d.h1 ? 'More than one H1 heading' : 'No H1 heading', plain: 'Pages lack a single clear main heading, which helps search engines and screen readers.',
        steps: ['Inspect the page below and count <h1> elements.'], expected: 'Exactly one <h1>.', actual: `Found ${d.h1} <h1> elements.`, fix: 'Use exactly one H1 describing the page’s main topic.' }, p.url);
      if (d.imgsNoAlt.length) add('alt', { sev: 'Low', cat: 'Accessibility', title: 'Images missing alt text', plain: 'Some images have no text description for screen readers and search engines.',
        steps: ['Inspect images on the page below.'], expected: 'Every <img> has an alt attribute.', actual: `e.g. ${d.imgsNoAlt.slice(0, 3).join(', ')}`, fix: 'Add descriptive alt text (alt="" for purely decorative images).' }, p.url);
      if (!d.lang) add('lang', { sev: 'Low', cat: 'Accessibility', title: 'Missing html lang attribute', plain: 'The page language is not declared (affects screen readers and translation).',
        steps: ['View source of the page below.'], expected: '<html lang="en"> (or site language).', actual: '<html> has no lang.', fix: 'Add lang="en" to the <html> tag.' }, p.url);
    }
  }
  for (const l of linkResults.filter(l => l.cls === 'broken')) {
    add('link|' + l.url, { sev: l.internal ? 'High' : 'Medium', cat: 'Broken links', title: `${l.internal ? 'Internal' : 'External'} link is broken (${l.err ? 'no response' : 'HTTP ' + l.status}): ${l.url.slice(0, 90)}`,
      plain: l.internal ? 'A link to another page on your own site leads to an error.' : 'A link to another website leads to an error page.',
      steps: ['Open the page(s) below.', `Click the link to ${l.url}`], expected: 'Link opens a working page.', actual: l.err ? l.err : `HTTP ${l.status}`,
      fix: l.internal ? 'Fix the link target or add a 301 redirect to the correct page.' : 'Update the link to the new address or remove it.' }, null, null, l.evidence);
    const is = issues.get('link|' + l.url); l.from.forEach(f => is.pages.add(f));
  }
  const manual = linkResults.filter(l => l.cls === 'manual');

  // finalize
  const order = { High: 0, Medium: 1, Low: 2 };
  const list = [...issues.values()].map(i => ({ ...i, pages: [...i.pages], vps: [...i.vps] }))
    .sort((a, b) => order[a.sev] - order[b.sev] || b.pages.length - a.pages.length);
  list.forEach((t, n) => t.id = 'PD-' + String(n + 1).padStart(2, '0'));
  const counts = { High: 0, Medium: 0, Low: 0 }; list.forEach(g => counts[g.sev]++);
  const verdict = counts.High ? 'Fail' : counts.Medium ? 'Needs fixes' : 'Pass';
  const verdictText = { Fail: 'Not ready to launch — fix the High-severity issues first.', 'Needs fixes': 'Launchable, but fix the issues below soon — visitors will notice some of them.', Pass: 'No blocking problems found by the automated checks. Minor polish items only.' }[verdict];
  const verdictColor = { Fail: '#c62828', 'Needs fixes': '#ef6c00', Pass: '#1b8a4b' }[verdict];
  const data = { start: START, client: CLIENT, note: NOTE, date: new Date().toISOString(), verdict, counts, pages, linkResults, manual, issues: list, linksChecked: linkList.length, linksTotal: allLinks.size };
  fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data, null, 2));

  // ---------- report ----------
  const b64 = f => `data:image/jpeg;base64,${fs.readFileSync(path.join(OUT, f)).toString('base64')}`;
  const sevColor = { High: '#c62828', Medium: '#ef6c00', Low: '#546e7a' };
  const dateCT = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' CT';
  const pagesList = ps => `${ps.length > 1 ? `${ps.length} pages: ` : ''}${ps.slice(0, 5).map(esc).join(', ')}${ps.length > 5 ? ` … (+${ps.length - 5} more)` : ''}`;
  const where = t => t.vps.length ? ` · ${t.vps.map(v => v).join(' + ')}` : '';
  const host = new URL(START).hostname;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Proofday Website Launch Check — ${esc(host)}</title>
<style>body{font:13.5px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2433;max-width:960px;margin:0 auto;padding:28px}
h1{font-size:25px;margin:0}h2{font-size:19px;border-bottom:2px solid #e6e9ef;padding-bottom:4px;margin-top:26px}h3{font-size:15px;margin:0 0 6px}
.brand{color:#2f5bea;font-weight:800;letter-spacing:.5px}.muted{color:#667085}.verdict{border-radius:10px;padding:16px 18px;color:#fff;margin:16px 0}.verdict b{font-size:26px;display:block}
.cards{display:flex;gap:10px;margin:12px 0}.card{flex:1;border:1px solid #e6e9ef;border-radius:8px;padding:10px;text-align:center}.card b{font-size:22px;display:block}
ol.top li{margin:6px 0}.tag{display:inline-block;color:#fff;border-radius:4px;padding:0 6px;font-size:11.5px;margin-right:6px;vertical-align:1px}
.ticket{border:1px solid #e6e9ef;border-left:5px solid;border-radius:6px;padding:10px 14px;margin:12px 0;page-break-inside:avoid}.ticket dl{display:grid;grid-template-columns:120px 1fr;gap:3px 10px;margin:6px 0 0}.ticket dt{font-weight:600;color:#475467}.ticket dd{margin:0;word-break:break-word}
.ev img{max-width:100%;max-height:420px;border:1px solid #ccc;border-radius:4px;display:block;margin-top:6px}
.page{break-inside:avoid;margin:0 0 16px;border:1px solid #e6e9ef;border-radius:8px;padding:12px}.shots{display:flex;gap:14px;align-items:flex-start}.shots figure{margin:0}
.shots img{border:1px solid #ccc;border-radius:4px;max-height:690px;display:block}.d img{max-width:560px}.m img{max-width:180px}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border-bottom:1px solid #eee;padding:3px 6px;text-align:left;vertical-align:top}.wrap{word-break:break-all}.pb{page-break-before:always}</style></head><body>
<div class="brand">PROOFDAY · WEBSITE LAUNCH CHECK</div>
<h1>Owner summary</h1>
<p class="muted">Site: <b>${esc(START)}</b>${CLIENT ? ' · Prepared for: ' + esc(CLIENT) : ''}<br>Tested ${dateCT} · ${pageCount} page(s) · desktop 1366×768 + mobile 390×844 (Chromium) · ${linkList.length} links checked${allLinks.size > linkList.length ? ` (of ${allLinks.size})` : ''}</p>
<div class="verdict" style="background:${verdictColor}"><b>${verdict}</b>${verdictText}</div>
<div class="cards"><div class="card"><b style="color:${sevColor.High}">${counts.High}</b>High</div><div class="card"><b style="color:${sevColor.Medium}">${counts.Medium}</b>Medium</div><div class="card"><b style="color:${sevColor.Low}">${counts.Low}</b>Low</div><div class="card"><b>${manual.length}</b>Check manually</div></div>
<h3>Top ${Math.min(5, list.length)} things to fix</h3>
${list.length ? `<ol class="top">${list.slice(0, 5).map(t => `<li><span class="tag" style="background:${sevColor[t.sev]}">${t.sev}</span>${esc(t.plain)} <span class="muted">(${t.pages.length} page${t.pages.length === 1 ? '' : 's'} · ticket ${t.id})</span></li>`).join('')}</ol>` : '<p>No issues found by the automated checks.</p>'}
${NOTE ? `<h3>What visitors should be able to do</h3><p>“${esc(NOTE)}”</p><p class="muted">We confirmed the pages, links and files behind this load and display correctly. Interactive steps — form submissions, checkout/payments, logins, bookings and email delivery — were <b>not tested</b>; please try them yourself before launch.</p>` : `<p class="muted">Not tested: form submissions, checkout/payments, logins, bookings and email delivery.</p>`}
${manual.length ? `<p class="muted">${manual.length} link(s) blocked our checker or timed out (common with social networks and bot protection). They are listed as “Check manually”, not as broken.</p>` : ''}
<p class="muted">Your developer section with copy-ready tickets starts on the next page. One retest is included after fixes.</p>

<h1 class="pb">Developer section</h1>
<p class="muted">Each item below is a copy-ready ticket. Issues repeated across pages or screen sizes are merged into one ticket listing every affected page.</p>
${list.map(t => `<div class="ticket" style="border-left-color:${sevColor[t.sev]}"><h3>${t.id} · <span class="tag" style="background:${sevColor[t.sev]}">${t.sev}</span>${esc(t.title)}</h3>
<dl><dt>Category</dt><dd>${t.cat}${where(t)}</dd><dt>Page(s)</dt><dd class="wrap">${pagesList(t.pages)}</dd>
<dt>Steps</dt><dd>${t.steps.map((s, i) => `${i + 1}. ${esc(s)}`).join('<br>')}</dd><dt>Expected</dt><dd>${esc(t.expected)}</dd><dt>Actual</dt><dd class="wrap">${esc(t.actual)}</dd><dt>Fix</dt><dd>${esc(t.fix)}</dd></dl>
${t.evidence.filter(Boolean).map(e => `<div class="ev"><span class="muted">Evidence: ${esc(e.label)}</span><img src="${b64(e.file)}"></div>`).join('')}</div>`).join('')}
${manual.length ? `<h2>Check manually (${manual.length})</h2><p class="muted">These links refused automated checking (HTTP 401/403/405/429/503/999) or timed out. They are probably fine; click each once to confirm.</p>
<table><tr><th>Link</th><th>Result</th><th>Found on</th></tr>${manual.map(l => `<tr><td class="wrap">${esc(l.url)}</td><td>${l.err ? 'timeout / no response' : 'HTTP ' + l.status}</td><td class="wrap">${esc(l.from[0])}${l.from.length > 1 ? ` (+${l.from.length - 1})` : ''}</td></tr>`).join('')}</table>` : ''}
<h2>Page-by-page results & full-page screenshots</h2>
${pages.map((p, n) => { const d = p.views.desktop, m = p.views.mobile; return `<div class="page"><h3 class="wrap">${n + 1}. ${esc(d.title || '(no title)')}</h3><div class="muted wrap">${esc(p.url)}</div>
<table><tr><th></th><th>Desktop</th><th>Mobile</th></tr>
<tr><td>HTTP status</td><td>${d.status ?? esc(d.error)}</td><td>${m.status ?? esc(m.error)}</td></tr>
<tr><td>First byte / ready / full load</td><td>${d.ttfb ?? '-'} / ${d.dcl ?? '-'} / ${d.load ?? '-'} ms</td><td>${m.ttfb ?? '-'} / ${m.dcl ?? '-'} / ${m.load ?? '-'} ms</td></tr>
<tr><td>Console errors / failed files</td><td>${d.consoleErrors.length} / ${d.failed.length}</td><td>${m.consoleErrors.length} / ${m.failed.length}</td></tr>
<tr><td>Sideways scrolling</td><td>${d.scrollWidth > d.innerWidth + 1 ? 'Yes' : 'No'}</td><td>${m.scrollWidth > m.innerWidth + 1 ? `Yes (${m.scrollWidth}px)` : 'No'}</td></tr></table>
<div class="shots">${d.shot ? `<figure class="d"><figcaption class="muted">Desktop, full page${d.shotTruncated ? ' (first 8000px)' : ''}</figcaption><img src="${b64(d.shot)}"></figure>` : ''}${m.shot ? `<figure class="m"><figcaption class="muted">Mobile, full page${m.shotTruncated ? ' (first 8000px)' : ''}</figcaption><img src="${b64(m.shot)}"></figure>` : ''}</div></div>`; }).join('')}
<h2>Scope & limitations</h2><ul>
<li>Up to 10 public pages reachable by links from the submitted URL on the same domain, tested in headless Chromium from a US datacenter. Timings vary by network and location.</li>
<li><b>Not tested:</b> pages behind login, form submissions, payments/checkout, email delivery, third-party embeds' internal behavior, Safari/Firefox-specific rendering, real-device quirks.</li>
<li>Not a security audit or accessibility/legal compliance certification. No automated check finds every issue. Repairs and hosting are not included.</li>
<li>One retest is included: after fixing, request a retest and this exact check is re-run.</li></ul>
<p class="muted">Generated by Proofday engine v2.</p></body></html>`;
  fs.writeFileSync(path.join(OUT, 'report.html'), html);
  const pg = await (await browser.newContext()).newPage();
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.pdf({ path: path.join(OUT, 'report.pdf'), format: 'Letter', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
  await browser.close();
  console.log(`Done: verdict=${verdict} tickets=${list.length} (H${counts.High}/M${counts.Medium}/L${counts.Low}) manual=${manual.length} → ${OUT}/report.pdf`);
})().catch(e => { console.error(e); process.exit(1); });
