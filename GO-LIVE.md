# Proofday go-live checklist (NOT executed)
Run from /workspace/pdrepo/site (linked to beaver16/proofday). Scope: --scope beaver16.

1. Git without surprise prod deploys
   - Production branch stays `main`; main == what's live today, so connecting cannot change prod by itself.
   - Before connecting, add an Ignored Build Step so only intended pushes build:
       vercel api "/v9/projects/proofday?teamId=team_Nof7WWXHVLMCtTGxMAbNoXf5" --method PATCH --input <(echo '{"rootDirectory":"site","commandForIgnoringBuildStep":"[ \"$VERCEL_GIT_COMMIT_REF\" = \"main\" ] && exit 1 || exit 0"}')
     (= build main only; previews still via `vercel deploy`). Optionally keep `exit 0` for all until launch day.
   - Connect: vercel git connect https://github.com/sjackson1228-cyber/proofday --yes
   - Verify: vercel api "/v9/projects/proofday?teamId=team_Nof7WWXHVLMCtTGxMAbNoXf5" | jq '.link,.rootDirectory'
2. Stripe LIVE (needs owner approval; account must be activated for live payments)
   - Live product + $149 price + Payment Link (same custom fields site_url, visitor_goal; redirect https://getproofday.com/thanks.html?session_id={CHECKOUT_SESSION_ID}).
   - Live webhook: https://getproofday.com/api/stripe-webhook, event checkout.session.completed (no bypass needed: custom domain is not behind protection).
3. Production storage + env (values piped, never pasted):
   - vercel blob create-store proofday-orders-prod --access private --environment production --region iad1 --yes
     (if BLOB_READ_WRITE_TOKEN name conflicts, connect with prefix PRIV like preview; code reads PRIV_READ_WRITE_TOKEN first)
   - printf %s "$WHSEC_LIVE"   | vercel env add STRIPE_WEBHOOK_SECRET production
   - printf true               | vercel env add STRIPE_LIVEMODE production
   - printf %s "$RESEND_KEY"   | vercel env add RESEND_API_KEY production   (new sending-only key, domain getproofday.com)
   - printf %s https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar | vercel env add CHROMIUM_PACK_URL production
   - openssl rand -hex 24 | tr -d '\n' | vercel env add CRON_SECRET production
4. Site: add Buy button on index.html -> live Payment Link (owner approval), fix canonical URLs getproofday.com -> getproofday.com.
5. Ship: open PR stripe-test-checkout -> main, review, merge (or `vercel deploy --prod` from the branch). Crons run on production deployments only:
   /api/cron-orders every 10 min (vercel.json); Vercel sends Authorization: Bearer $CRON_SECRET automatically.
6. Verify: vercel crons ls (or Project > Settings > Cron Jobs); one real $149 live purchase + refund via Dashboard; check Resend delivery + PDF.
7. Cleanup: delete preview test webhook we_1UQtJGA4w4czuN99cuQFOmP3 and old public store proofday-orders-test; consider rotating the automation bypass secret.
