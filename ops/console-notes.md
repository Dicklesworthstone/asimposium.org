# Console session notes

Append-only log written by the computer-use agent during browser-console
sessions, per `INSTRUCTIONS_FOR_COMPUTER_USE.md` §0.6 and §5. Each entry:
date/time, tasks attempted, IDs/URLs/record values produced (never secret
values), screenshot filenames, skips, and any console-UI divergence from the
instructions.

No sessions logged yet.

2026-08-13 14:35:00 EDT — Task 1.1: created and selected Google Cloud project `asimposium` under No organization; project ID `asimposium`, project number `789731362661`; checkpoint `asimposium-gcp-project-created-20260813.png`; no UI divergence or skipped step.

2026-08-13 14:41:30 EDT — Task 1.2 (initial OAuth configuration): configured Google Auth Platform for app `ASImposium`, External audience, signed-in operator account as support/developer contact, publishing status Testing; operator manually accepted the Google API Services User Data Policy and completed the wizard; checkpoint `asimposium-oauth-config-created-20260813.png`; Google used the four-step Project configuration wizard.

2026-08-13 14:42:51 EDT — Task 1.2 (branding): set application home page `https://asimposium.org`, authorized domain `asimposium.org`, and intentionally skipped the app logo; checkpoint `asimposium-oauth-branding-saved-20260813.png`; privacy/terms links left blank during Testing.

2026-08-13 14:43:55 EDT — Task 1.2 (data access): configured only the non-sensitive scopes `openid`, `https://www.googleapis.com/auth/userinfo.email`, and `https://www.googleapis.com/auth/userinfo.profile`; no sensitive or restricted scopes; checkpoint `asimposium-oauth-scopes-saved-20260813.png`.

2026-08-13 14:45:47 EDT — Task 1.2 (audience): kept publishing status Testing and added the signed-in operator account as the sole test user with operator confirmation; checkpoint `asimposium-oauth-test-user-saved-20260813.png`; Google displayed an inconsistent summary (`0 users (1 test, -1 other)`) while the test-user table correctly showed one entry.

2026-08-13 14:51:39 EDT — Task 1.3: created Web application OAuth client `asimposium-agora`; Client ID `789731362661-ae5lhhh6gbbfvp8ag6d46vvmfi3v6p5h.apps.googleusercontent.com`; configured production, staging, and localhost origins plus matching `/api/auth/callback/google` redirects; stored the ID and secret directly as sensitive Vercel environment variables for Production and Preview, verified four hidden entries, and retained no secret value in notes or repository files; checkpoint `asimposium-oauth-client-created-20260813.png`.

2026-08-13 14:51:39 EDT — Task 3.1 (terminal prerequisite): `vercel link --yes` created `dicklesworthstones-projects/asimposium.org`, detected `site` as the output directory with no framework, and connected `https://github.com/Dicklesworthstone/asimposium.org`; deployment URL still pending.

2026-08-13 15:00:15 EDT — Task 3.1: deployed clean committed `HEAD` to Vercel Production as deployment `dpl_FsxB4CMQNYSE14LPNaGX4wxUXoxY`; production URL `https://asimposium-3tgyh0bwr-dicklesworthstones-projects.vercel.app`, alias `https://asimposiumorg.vercel.app`, status READY, and HTTP verification returned 200 with title `ASImposium`.

2026-08-13 15:00:15 EDT — Task 3.2 (partial): attached `asimposium.org` to Production and configured `www.asimposium.org` as a 308 redirect to the apex; both remain Invalid Configuration pending Cloudflare DNS. Vercel's current dashboard recommends DNS-only CNAME records `@` and `www` to `ab090f49594b2df7.vercel-dns-016.com.`; its CLI legacy inspection also mentioned `76.76.21.21`, but the dashboard explicitly identifies the CNAME target as the current recommendation. Checkpoint `asimposium-vercel-domains-configured-20260813.png`.

2026-08-13 15:12:52 EDT — Task 2.1: verified the account is already on Workers Paid (`$5/month + usage`, Current plan), so no subscription or payment action was needed; checkpoint `asimposium-cloudflare-workers-paid-current-20260813.png`.

2026-08-13 15:12:52 EDT — Task 2.2: verified R2 is already enabled and its dashboard offers `Create bucket`; no terms prompt appeared and no bucket was created; checkpoint `asimposium-cloudflare-r2-enabled-20260813.png`.

2026-08-13 15:12:52 EDT — Task 2.4: created DNS-only CNAME records `@` and `www` to `ab090f49594b2df7.vercel-dns-016.com.` and changed SSL/TLS from Full to Full (strict), with operator confirmation immediately before the network changes; DNSSEC was left unchanged and the zone had no pre-existing DNS records. Checkpoints `asimposium-cloudflare-dns-configured-20260813.png` and `asimposium-cloudflare-ssl-strict-20260813.png`; public DNS has begun resolving, while Vercel certificate issuance/HTTPS propagation is still pending.

2026-08-13 15:12:52 EDT — Task 3.3: verified Vercel Authentication is enabled only as Standard Protection (preview/deployment URLs), while the production deployment URL remains publicly accessible; password and trusted-IP protection are off, Git auto-deploy remains connected, and no Vercel plan change was made.

2026-08-13 15:12:52 EDT — Task 4 (verification): GitHub reports `Dicklesworthstone/asimposium.org` is Public and its custom license is detected as Other, consistent with the requested custom MIT + rider presentation; a ready 1280×640 `gh_og_share_image.png` exists, but social-preview upload remains pending explicit upload confirmation.

2026-08-13 15:24:26 EDT — Task 2.3: created active scoped Cloudflare API token named `asimposium-wrangler-ci` with Account D1 Edit, Workers R2 Storage Edit, Workers AI Read, and Zone DNS Edit limited to this account and `asimposium.org`; stored the one-time value directly as GitHub repository secret `CLOUDFLARE_API_TOKEN`, then cleared all transient secret-bearing variables without logging or saving the value locally. Checkpoint `asimposium-cloudflare-token-created-20260813.png`.

2026-08-13 15:24:26 EDT — Deployment-path adjustment: the operator reported GitHub Actions is unavailable due usage limits, so no workflow will consume the repository secret. Vercel's native Git integration remains the Agora deployment path; Cloudflare Workers Builds native Git integration is the chosen future Stoa deployment path and will be configured only after Worker code and a Wrangler configuration exist. The repository currently contains neither GitHub workflows nor Worker/Wrangler code; the active token and inert GitHub secret were left in place, not deleted.

2026-08-13 15:24:26 EDT — Task 2.5: verified the account's auto-created `Billing Budget Alert` is already enabled with email delivery, so no new notification was needed; checkpoint `asimposium-cloudflare-billing-alert-enabled-20260813.png`.

2026-08-13 15:24:26 EDT — Task 3.2 (complete): Vercel now reports Valid Configuration for both custom domains; `https://asimposium.org` returns HTTPS 200 from Vercel and `https://www.asimposium.org` returns HTTPS 308 to the apex. Checkpoint `asimposium-vercel-domains-verified-20260813.png`.

2026-08-13 15:24:26 EDT — Task 4 (complete): the operator manually selected and uploaded the preferred composed branded share card (headline/copy plus ASImposium illustration) as the GitHub repository social preview; verified it renders in Settings → General. Checkpoint `asimposium-github-social-preview-configured-20260813.png`.

2026-08-13 15:24:26 EDT — Intentional deferrals: Task 1.4 remains skipped because the placeholder has not reached launch gate G2, so Google OAuth remains Testing; Cloudflare Workers Builds, D1/R2 resource creation, Worker/R2 custom domains (`a` and `artifacts`), migrations, and Cron-backed operational jobs remain deferred until their source/configuration exists. No existing DNS record or DNSSEC setting was deleted or disabled.
