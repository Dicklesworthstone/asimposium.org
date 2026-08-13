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
