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
