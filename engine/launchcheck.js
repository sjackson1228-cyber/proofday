#!/usr/bin/env node
// LaunchCheck delivery engine v1
// Usage: node launchcheck.js <url> [--out dir] [--max 10] [--note "what visitors should do"] [--client "Name"]
const { chromium, request } = require('playwright');
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const START = args[0];
if (!START || !/^https?:\/\//.test(START)) { console.error('Usage: node launchcheck.js <https://url> [--out dir] [--max 10] [--note ".."]'); process.exit(1); }
const MAX = Math.min(parseInt(opt('max', '10')), 10);
const NOTE = opt('note', '');
const CLIENT = opt('client', '');
const OUT = opt('out', path.join('reports', new URL(START).hostname + '-' + new Date().toISOString().slice(0, 10)));
const SLOW_MS = 3000, LINK_CAP = 200;
const VIEWPORTS = {
  desktop: { viewport: { width: 1366, height: 768 } },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
};
const UA_NOTE = 'LaunchCheck/1.0 (+website launch QA)';
const SKIP_EXT = /\.(pdf|zip|jpe?g|png|gif|webp|svg|mp4|mp3|docx?|xlsx?|pptx?|css|js|xml|json|ico|txt|rss)(\?|$)/i;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = u => { const x = new URL(u); x.hash = ''; return x.href; };

(async () => {
  fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
  const origin = new URL(START).origin;
  const browser = await chromium.launch();
  const ctxs = {};
  for (const [k, v] of Object.entries(VIEWPORTS)) ctxs[k] = await browser.newContext({ ...v, ignoreHTTPSErrors: false });
  const queue = [norm(START)], seen = new Set(queue), pages = [], allLinks = new Map(); // link -> Set(sourcePages)
  while (queue.length && pages.length < MAX) {
    const url = queue.shift();
    const rec = { url, views: {} };
    for (const vp of Object.keys(VIEWPORTS)) {
      const page = await ctxs[vp].newPage();
      const consoleErrors = [], failed = [];
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
      page.on('pageerror', e => consoleErrors.push('Uncaught: ' + String(e.message).slice(0, 300)));
      page.on('requestfailed', r => failed.push(`${r.url().slice(0, 150)} (${r.failure()?.errorText})`));
      page.on('response', r => { if (r.status() >= 400 && r.request().resourceType() !== 'document') failed.push(`${r.url().slice(0, 150)} (HTTP ${r.status()})`); });
      const v = { consoleErrors, failed };
      const t0 = Date.now();
      try {
        const resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
        v.status = resp ? resp.status() : null;
        v.finalUrl = page.url(); v.ctype = resp ? (resp.headers()['content-type'] || '') : '';
        if (v.ctype && !/html/i.test(v.ctype)) { v.nonHtml = true; }
        v.wallMs = Date.now() - t0;
        await page.waitForTimeout(800);
        Object.assign(v, await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] || {};
          const d = document.documentElement;
          const vw = window.innerWidth;
          const over = [];
          if (d.scrollWidth > vw + 1) {
            for (const el of document.querySelectorAll('body *')) {
              const r = el.getBoundingClientRect();
              if (r.right > vw + 1 && r.width > 0 && getComputedStyle(el).position !== 'fixed') {
                const p = el.parentElement; const pr = p && p.getBoundingClientRect();
                if (!pr || pr.right <= vw + 1) over.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ` (right edge ${Math.round(r.right)}px)`);
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
            imgsNoAlt: imgs.filter(i => !i.hasAttribute('alt')).map(i => i.currentSrc || i.src).slice(0, 10),
            imgsNoAltCount: imgs.filter(i => !i.hasAttribute('alt')).length,
            brokenImgs: imgs.filter(i => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map(i => i.currentSrc || i.src).slice(0, 10),
            scrollWidth: d.scrollWidth, innerWidth: vw, overflowEls: over,
            ttfb: Math.round(nav.responseStart || 0), dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0),
            bytes: Math.round(performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0) + (nav.transferSize || 0)),
            links: [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^https?:/.test(h)),
            emptyLinks: [...document.querySelectorAll('a')].filter(a => !a.getAttribute('href') || a.getAttribute('href') === '#').length,
          };
        }));
        const idx = pages.length + 1;
        const shot = `shots/p${idx}-${vp}.jpg`;
        await page.screenshot({ path: path.join(OUT, shot), type: 'jpeg', quality: 60, fullPage: vp === 'mobile' ? false : false });
        v.shot = shot;
        if (vp === 'desktop') for (const l of v.links) {
          const n = norm(l);
          if (!allLinks.has(n)) allLinks.set(n, new Set()); allLinks.get(n).add(url);
          if (new URL(n).origin === origin && !seen.has(n) && !SKIP_EXT.test(n)) { seen.add(n); queue.push(n); }
        }
      } catch (e) { v.error = String(e.message).split('\n')[0]; v.wallMs = Date.now() - t0; }
      rec.views[vp] = v;
      await page.close();
    }
    pages.push(rec);
    console.log(`[${pages.length}/${MAX}] ${url} desktop=${rec.views.desktop.status} mobile=${rec.views.mobile.status}`);
  }
  // Link checks
  const api = await request.newContext({ extraHTTPHeaders: { 'User-Agent': UA_NOTE }, ignoreHTTPSErrors: false });
  const linkList = [...allLinks.keys()].slice(0, LINK_CAP);
  const linkResults = [];
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < linkList.length) {
      const u = linkList[i++]; let status, err;
      try {
        let r = await api.fetch(u, { method: 'HEAD', timeout: 15000, maxRedirects: 5 });
        if ([403, 405, 501].includes(r.status()) || r.status() >= 400) r = await api.get(u, { timeout: 15000, maxRedirects: 5 });
        status = r.status();
      } catch (e) { err = String(e.message).split('\n')[0].slice(0, 120); }
      linkResults.push({ url: u, status, err, from: [...allLinks.get(u)], internal: new URL(u).origin === origin });
    }
  }));
  await api.dispose();
  // Build issues
  const issues = [];
  const add = (sev, cat, pageUrl, title, repro, fix) => issues.push({ sev, cat, pageUrl, title, repro, fix });
  for (const p of pages) {
    const d = p.views.desktop, m = p.views.mobile;
    for (const [vp, v] of Object.entries(p.views)) {
      const size = vp === 'mobile' ? '390×844 (mobile)' : '1366×768 (desktop)';
      if (v.error) { add('High', 'Availability', p.url, `Page failed to load on ${vp}`, `Open ${p.url} at ${size}. Error: ${v.error}`, 'Confirm the page is published, publicly reachable, and responds within 30s.'); continue; }
      if (v.status >= 400) add('High', 'Availability', p.url, `Page returns HTTP ${v.status}`, `Open ${p.url} — server responds ${v.status}.`, 'Publish the page or remove/redirect links pointing to it (301 to the correct URL).');
      if (v.consoleErrors.length) add('Medium', 'Functionality', p.url, `${v.consoleErrors.length} JavaScript console error(s) on ${vp}`, `Open ${p.url} at ${size}, open DevTools → Console. Seen: ${v.consoleErrors.slice(0, 3).map(esc).join(' | ')}`, 'Fix or remove the failing script; errors can break menus, forms and tracking.');
      const fl = [...new Set(v.failed)];
      if (fl.length) add('Medium', 'Missing content', p.url, `${fl.length} page resource(s) failed to load on ${vp}`, `Open ${p.url} at ${size}, DevTools → Network. Failed: ${fl.slice(0, 4).map(esc).join(' | ')}`, 'Restore or correct the asset paths (images, scripts, fonts, styles) or remove references.');
      if (v.brokenImgs.length) add('Medium', 'Missing content', p.url, `${v.brokenImgs.length} broken image(s)`, `Open ${p.url}; these images do not render: ${v.brokenImgs.slice(0, 3).map(esc).join(', ')}`, 'Re-upload the images or fix their src URLs.');
      const loadMs = Math.max(v.load, v.wallMs || 0);
      if (v.load > SLOW_MS) add(v.load > 6000 ? 'High' : 'Low', 'Performance', p.url, `Slow full page load on ${vp}: ${(v.load / 1000).toFixed(1)}s`, `Load ${p.url} at ${size} (from US datacenter). TTFB ${v.ttfb}ms, DOMContentLoaded ${v.dcl}ms, load ${v.load}ms, ~${Math.round(v.bytes / 1024)} KB transferred.`, 'Compress/resize images (WebP/AVIF), lazy-load below-the-fold media, defer non-critical scripts, enable caching/CDN.');
    }
    if (!m.error && !m.nonHtml && m.scrollWidth > m.innerWidth + 1) add('High', 'Mobile display', p.url, `Horizontal scrolling on mobile (page is ${m.scrollWidth}px wide on a ${m.innerWidth}px screen)`, `Open ${p.url} on a 390px-wide phone and swipe sideways. Elements overflowing: ${m.overflowEls.map(esc).join('; ') || 'n/a'}`, 'Set max-width:100% on media, allow long words/URLs to wrap (overflow-wrap:anywhere), and fix fixed-width containers with responsive CSS.');
    if (!d.error && !d.nonHtml) {
      if (!d.viewportMeta) add('High', 'Mobile display', p.url, 'No mobile viewport meta tag', `View source of ${p.url}: no <meta name="viewport">. Phones render a zoomed-out desktop page.`, 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to <head>.');
      if (!d.title) add('Medium', 'SEO basics', p.url, 'Missing page title', `View source of ${p.url}: <title> empty or absent.`, 'Add a unique, descriptive <title> (50–60 chars).');
      if (!d.metaDesc) add('Low', 'SEO basics', p.url, 'Missing meta description', `View source of ${p.url}: no <meta name="description">.`, 'Add a 120–160 character description summarising the page.');
      if (d.h1 !== 1) add('Low', 'SEO basics', p.url, d.h1 === 0 ? 'No H1 heading' : `${d.h1} H1 headings`, `Inspect ${p.url}: found ${d.h1} <h1> elements.`, 'Use exactly one H1 describing the page’s main topic.');
      if (d.imgsNoAltCount) add('Low', 'Accessibility', p.url, `${d.imgsNoAltCount} image(s) missing alt text`, `Inspect images on ${p.url}, e.g. ${d.imgsNoAlt.slice(0, 3).map(esc).join(', ')}`, 'Add descriptive alt="" text (or alt="" for purely decorative images).');
      if (!d.lang) add('Low', 'Accessibility', p.url, 'Missing html lang attribute', `View source of ${p.url}: <html> has no lang.`, 'Add lang="en" (or the site language) to <html>.');
    }
  }
  for (const l of linkResults) {
    if (l.err || l.status >= 400) {
      const sev = l.internal ? 'High' : 'Medium';
      add(sev, 'Broken links', l.from[0], `${l.internal ? 'Internal' : 'External'} link broken: ${l.err ? 'no response' : 'HTTP ' + l.status}`, `On ${l.from.slice(0, 2).join(', ')}${l.from.length > 2 ? ` (+${l.from.length - 2} more pages)` : ''}, click the link to ${esc(l.url)} → ${l.err ? esc(l.err) : 'HTTP ' + l.status}.`, l.internal ? 'Fix the link target or add a 301 redirect to the correct page.' : 'Update or remove the external link (it may have moved).');
    }
  }
  const order = { High: 0, Medium: 1, Low: 2 };
  issues.sort((a, b) => order[a.sev] - order[b.sev]);
  // Dedupe identical titles across many pages (sitewide issues)
  const groups = new Map();
  for (const is of issues) { const vm = is.title.match(/ on (desktop|mobile)$/); const t = is.title.replace(/ on (desktop|mobile)$/, ''); const k = is.sev + '|' + t + '|' + is.fix; if (!groups.has(k)) groups.set(k, { ...is, title: t, pages: [], vps: new Set() }); const g = groups.get(k); if (!g.pages.includes(is.pageUrl)) g.pages.push(is.pageUrl); if (vm) g.vps.add(vm[1]); }
  for (const g of groups.values()) { if (g.vps.size) g.title += ' (' + [...g.vps].join(' + ') + ')'; delete g.vps; }
  const grouped = [...groups.values()];
  const counts = { High: 0, Medium: 0, Low: 0 }; grouped.forEach(g => counts[g.sev]++);
  const data = { start: START, client: CLIENT, note: NOTE, date: new Date().toISOString(), pages, linkResults, issues: grouped, counts, linksChecked: linkList.length, linksTotal: allLinks.size };
  fs.writeFileSync(path.join(OUT, 'data.json'), JSON.stringify(data, null, 2));
  // HTML report
  const img = f => `data:image/jpeg;base64,${fs.readFileSync(path.join(OUT, f)).toString('base64')}`;
  const sevColor = { High: '#c62828', Medium: '#ef6c00', Low: '#546e7a' };
  const dateCT = new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) + ' CT';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LaunchCheck report — ${esc(new URL(START).hostname)}</title>
<style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d2433;max-width:960px;margin:0 auto;padding:32px}
h1{font-size:26px;margin:0}h2{font-size:19px;border-bottom:2px solid #e6e9ef;padding-bottom:4px;margin-top:32px}h3{font-size:15px;margin:0 0 4px}
.brand{color:#2f5bea;font-weight:700;letter-spacing:.5px}.muted{color:#667085}.cards{display:flex;gap:12px;margin:16px 0}.card{flex:1;border:1px solid #e6e9ef;border-radius:8px;padding:12px;text-align:center}.card b{font-size:24px;display:block}
.issue{border:1px solid #e6e9ef;border-left:5px solid;border-radius:6px;padding:10px 14px;margin:10px 0;page-break-inside:avoid}.tag{display:inline-block;color:#fff;border-radius:4px;padding:0 6px;font-size:12px;margin-right:6px}
.page{page-break-inside:avoid;margin:18px 0;border:1px solid #e6e9ef;border-radius:8px;padding:12px}.shots{display:flex;gap:12px;align-items:flex-start}.shots figure{margin:0}.shots img{border:1px solid #ccc;border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:12.5px}td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;vertical-align:top}code{font-size:12px;word-break:break-all}.wrap{word-break:break-all}</style></head><body>
<div class="brand">LAUNCHCHECK</div><h1>Website Launch Check report</h1>
<p class="muted">Site: <b>${esc(START)}</b>${CLIENT ? ' · Client: ' + esc(CLIENT) : ''}<br>Tested: ${dateCT} · ${pages.length} page(s) · Desktop 1366×768 + Mobile 390×844 (Chromium) · ${linkList.length} unique links checked${allLinks.size > linkList.length ? ` (of ${allLinks.size})` : ''}</p>
<div class="cards"><div class="card"><b style="color:${sevColor.High}">${counts.High}</b>High</div><div class="card"><b style="color:${sevColor.Medium}">${counts.Medium}</b>Medium</div><div class="card"><b style="color:${sevColor.Low}">${counts.Low}</b>Low</div><div class="card"><b>${pages.length}</b>Pages tested</div></div>
${NOTE ? `<h2>What visitors should be able to do</h2><p>${esc(NOTE)}</p><p class="muted">Automated checks confirm pages, links and assets load and display. Interactive goals such as form submission, checkout, login, booking or email delivery are <b>not tested</b> unless listed as an issue below — please verify them manually.</p>` : ''}
<h2>Issues to fix (${grouped.length})</h2>
${grouped.length ? grouped.map((g, n) => `<div class="issue" style="border-left-color:${sevColor[g.sev]}"><h3>${n + 1}. <span class="tag" style="background:${sevColor[g.sev]}">${g.sev}</span>${esc(g.title)} <span class="muted" style="font-weight:400">· ${g.cat}</span></h3>
<div class="wrap"><b>Where:</b> ${g.pages.length > 1 ? g.pages.length + ' pages — ' : ''}${g.pages.slice(0, 4).map(esc).join(', ')}${g.pages.length > 4 ? '…' : ''}</div><div class="wrap"><b>Reproduce:</b> ${g.repro}</div><div><b>How to fix:</b> ${esc(g.fix)}</div></div>`).join('') : '<p>No issues detected by the automated checks.</p>'}
<h2>Page-by-page results</h2>
${pages.map((p, n) => { const d = p.views.desktop, m = p.views.mobile; return `<div class="page"><h3 class="wrap">${n + 1}. ${esc(d.title || '(no title)')}</h3><div class="muted wrap">${esc(p.url)}</div>
<table><tr><th></th><th>Desktop</th><th>Mobile</th></tr>
<tr><td>HTTP status</td><td>${d.status ?? esc(d.error)}</td><td>${m.status ?? esc(m.error)}</td></tr>
<tr><td>Load (TTFB / DOM ready / full)</td><td>${d.ttfb ?? '-'} / ${d.dcl ?? '-'} / ${d.load ?? '-'} ms</td><td>${m.ttfb ?? '-'} / ${m.dcl ?? '-'} / ${m.load ?? '-'} ms</td></tr>
<tr><td>Console errors / failed resources</td><td>${d.consoleErrors.length} / ${new Set(d.failed).size}</td><td>${m.consoleErrors.length} / ${new Set(m.failed).size}</td></tr>
<tr><td>Horizontal overflow</td><td>${d.scrollWidth > d.innerWidth + 1 ? 'Yes' : 'No'}</td><td>${m.scrollWidth > m.innerWidth + 1 ? `Yes (${m.scrollWidth}px)` : 'No'}</td></tr>
<tr><td>Meta description / H1s / imgs w/o alt</td><td colspan="2">${d.metaDesc ? 'Yes' : 'Missing'} / ${d.h1 ?? '-'} / ${d.imgsNoAltCount ?? '-'}</td></tr></table>
<div class="shots">${d.shot ? `<figure><img src="${img(d.shot)}" width="560"><figcaption class="muted">Desktop (above the fold)</figcaption></figure>` : ''}${m.shot ? `<figure><img src="${img(m.shot)}" width="180"><figcaption class="muted">Mobile</figcaption></figure>` : ''}</div></div>`; }).join('')}
<h2>Scope &amp; limitations</h2><ul>
<li>Tested up to 10 public pages reachable from the submitted URL on the same domain, in headless Chromium, from a US datacenter. Timings vary by network and location.</li>
<li><b>Not tested:</b> anything behind login, form submissions, payments/checkout, email delivery, third-party embeds' internal behavior, Safari/Firefox-specific rendering, and real-device quirks.</li>
<li>This is not a security audit or accessibility certification, and no automated check finds every issue. Repairs and hosting are not included.</li>
<li>One retest is included: reply after fixing and we will re-run this exact check.</li></ul>
<p class="muted">Generated by LaunchCheck engine v1.</p></body></html>`;
  fs.writeFileSync(path.join(OUT, 'report.html'), html);
  const pg = await (await browser.newContext()).newPage();
  await pg.setContent(html, { waitUntil: 'load' });
  await pg.pdf({ path: path.join(OUT, 'report.pdf'), format: 'Letter', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' } });
  await browser.close();
  console.log(`Done: ${grouped.length} issues (H${counts.High}/M${counts.Medium}/L${counts.Low}) → ${OUT}/report.pdf`);
})().catch(e => { console.error(e); process.exit(1); });
