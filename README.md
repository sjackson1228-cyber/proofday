# Proofday — Website Launch Check ($149)

- `site/` — static landing page (deployed to Vercel). Stripe Payment Link placeholder: search `STRIPE_PAYMENT_LINK` in `site/index.html`.
- `engine/launchcheck.js` — delivery engine (Playwright, Chromium headless).

## Run the engine
```
cd engine && npm i && npx playwright install chromium
node launchcheck.js https://client-site.com --note "What visitors should be able to do" --client "Agency name" --out reports/client
# -> reports/client/report.html, report.pdf, data.json, shots/
```
Checks (desktop 1366x768 + mobile 390x844, up to 10 same-origin pages): HTTP status, internal/external link status, screenshots, mobile horizontal overflow (+ offending elements), viewport meta, console/JS errors, failed resources & broken images, load timing (TTFB/DOMContentLoaded/load, >3s flagged), title, meta description, H1 count, image alt, html lang.

## v2 (2026-10-14)
- Report: page 1 Owner Summary (Pass / Needs fixes / Fail + top 5 in plain English), then Developer section of copy-ready tickets (title, severity, pages, steps, expected vs actual, fix), full-page screenshots (capped at 8000px, JPEG q50).
- Noise reduction: issues deduped across pages/viewports; 401/403/405/429/503/999 and timeouts/TLS resets = "Check manually"; transient failures retried once; highlighted screenshot evidence on every High issue.
- `site/api/scan.js` + `site/scan.html`: free one-page quick preview (fetch-based, no browser). SSRF guard (DNS + private IP block per redirect hop), 8s timeout, 1.5MB cap, origin check, honeypot, browser proof-of-work, best-effort per-instance IP rate limit. Optional email is not stored.
