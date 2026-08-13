# INSTRUCTIONS_FOR_COMPUTER_USE.md

Guidance for a computer-use agent (Codex app or similar) operating Chrome on the
operator's machine, signed in as the operator, to complete the console tasks that
cannot be done from the terminal with `wrangler`, `vercel`, or `gh`. Everything
that CAN be done from the terminal should be done from the terminal; this file
covers only the browser-manual remainder for the ASImposium launch
(see `COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md`, the canonical plan).

---

## 0. Standing rules (read before every session)

1. **You are acting as the operator in their logged-in Chrome profile.** Never
   sign in to anything fresh, never enter a password or 2FA code, never approve
   a passkey prompt. If a login screen appears, stop and report; the operator
   will authenticate.
2. **Verify the origin in the address bar before typing anything**:
   `console.cloud.google.com`, `dash.cloudflare.com`, `vercel.com`,
   `github.com`. Nothing else gets input. If a page redirects anywhere
   unexpected, stop.
3. **Secrets discipline.** OAuth client secrets, API tokens, and signing keys
   are displayed once by these consoles. Copy them ONLY into the terminal
   commands listed in each task (secret stores), never into a file in the repo,
   never into chat logs, never into a scratch document. If a secret ends up
   anywhere else, report it immediately so it can be rotated.
4. **Spending guardrails.** The only paid enablement authorized by this
   document is the Cloudflare Workers Paid plan (~$5/month) and, only if asked
   for by name later, Vercel Pro. Do not add payment methods, change plans, or
   accept any other charge without stopping to ask.
5. **Destructive-action freeze.** Do not delete DNS records, projects, buckets,
   databases, deployments, or repositories. Do not disable DNSSEC. Do not
   remove existing domains. If a flow seems to require deletion, stop and ask.
6. **Checkpoint discipline.** After each numbered step that changes state, take
   a screenshot and append a one-line note (what changed, any ID/URL produced,
   never a secret value) to `ops/console-notes.md` in the repo.
7. **Scope.** Anything not listed below is out of scope. When a console offers
   an upsell, a "recommended" wizard, an AI assistant, or a survey, decline.

---

## 1. Google Cloud Console — OAuth for "Sign in with Google"

Goal: a Google OAuth client the Agora (Auth.js v5) can use. Plan refs: §5.1.

### 1.1 Project

1. Open `https://console.cloud.google.com/`.
2. Project picker (top bar) → **New project** → name `asimposium` → no
   organization → **Create**. Wait for the notification, then select it.
3. Note the project ID in `ops/console-notes.md`.

### 1.2 OAuth consent screen (branding + audience)

1. Left menu → **APIs & Services → OAuth consent screen** (Google may present
   this as "Google Auth Platform → Branding/Audience"; the fields are the same).
2. User type: **External**. App name: `ASImposium`. User support email: the
   operator's email. App logo: skip for now (adding one triggers stricter
   review).
3. App domain: `https://asimposium.org`. Authorized domain: `asimposium.org`.
   Developer contact: the operator's email.
4. Scopes: add ONLY `openid`, `.../auth/userinfo.email`,
   `.../auth/userinfo.profile`. Nothing marked sensitive or restricted. This
   keeps the app in the lightweight verification tier.
5. Audience/Test users (while unverified): add the operator's email and any
   alpha-tester emails provided.
6. Save through every step. Leave publishing status **Testing** for now;
   Task 1.4 flips it.

### 1.3 OAuth client ID

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**. Name: `asimposium-agora`.
3. Authorized JavaScript origins:
   - `https://asimposium.org`
   - `https://staging.asimposium.org`
   - `http://localhost:3000` (local dev)
4. Authorized redirect URIs:
   - `https://asimposium.org/api/auth/callback/google`
   - `https://staging.asimposium.org/api/auth/callback/google`
   - `http://localhost:3000/api/auth/callback/google`
5. **Create**. A modal shows the Client ID and Client secret. Hand them
   directly to the terminal, nothing else:

   ```bash
   # run these yourself in the repo; paste values when prompted, then clear clipboard
   vercel env add GOOGLE_CLIENT_ID production
   vercel env add GOOGLE_CLIENT_SECRET production
   vercel env add GOOGLE_CLIENT_ID preview
   vercel env add GOOGLE_CLIENT_SECRET preview
   ```

6. Record the Client ID (not the secret) in `ops/console-notes.md`.

### 1.4 Verification (when the site is live at G2)

1. OAuth consent screen → **Publish app** (Testing → In production).
2. If Google requests verification: the app uses only non-sensitive scopes, so
   complete the short form (app name, domain, links to
   `https://asimposium.org/policy` for privacy). No demo video should be
   required at this tier. Record the case ID and stop; the operator watches the
   email thread.

---

## 2. Cloudflare Dashboard — the parts wrangler cannot do

Goal: paid plan + R2 enabled + API token + DNS for Vercel. Plan refs: §13.2,
§10.1, ADR-2. The zone `asimposium.org` already exists on this account.

### 2.1 Workers Paid plan (authorized: ~$5/month)

1. Open `https://dash.cloudflare.com/` → select the account → **Workers &
   Pages → Plans**.
2. Subscribe to **Workers Paid**. Confirm the $5/month charge (authorized).
   Note the confirmation in `ops/console-notes.md`.

### 2.2 Enable R2 (first use requires dashboard acceptance)

1. Left menu → **R2** → accept the terms if prompted (uses the existing
   payment method; the free allotment covers launch scale, Rule A7).
2. Do NOT create buckets here; the terminal does that
   (`wrangler r2 bucket create ...`).

### 2.3 API token for wrangler/CI

1. Top-right avatar → **My Profile → API Tokens → Create Token**.
2. Start from **Edit Cloudflare Workers** template; add permissions:
   Account · D1 · Edit; Account · Workers R2 Storage · Edit;
   Account · Workers AI · Read (screening); Zone · DNS · Edit for zone
   `asimposium.org` (lets `wrangler`/scripts manage records and Worker custom
   domains).
3. Scope: this account, zone `asimposium.org` only. Continue → Create.
4. The token is shown once. Paste it ONLY into the terminal:

   ```bash
   # local dev shell profile or CI secret store — never a repo file
   export CLOUDFLARE_API_TOKEN='<paste>'
   gh secret set CLOUDFLARE_API_TOKEN --repo Dicklesworthstone/asimposium.org
   ```

5. Note the token *name* (not value) in `ops/console-notes.md`.

### 2.4 DNS records for Vercel (values come from the terminal first)

Prerequisite: someone has run `vercel domains inspect asimposium.org` (Task 3.2)
and pasted the required records into `ops/console-notes.md`. Do not guess
record values; Vercel's current requirements are authoritative.

1. Dashboard → zone `asimposium.org` → **DNS → Records**.
2. Create exactly the records Vercel listed, typically an `A` record for the
   apex and a `CNAME` for `www`. Set both to **DNS only** (grey cloud, NOT
   proxied). This is ADR-2: no orange cloud in front of Vercel.
3. Leave `a` and `artifacts` subdomains ALONE; the Worker and R2 custom
   domains attach to them via wrangler and must stay **Proxied** when created.
4. **SSL/TLS → Overview**: set the zone's encryption mode to **Full (strict)**.
5. If DNSSEC is enabled, leave it exactly as is.

### 2.5 Spend guardrails

1. **Manage account → Billing → Notifications** (or Notifications → add): turn
   on billing/usage alert emails if available on this account.

---

## 3. Vercel Dashboard — the parts the CLI cannot do

Goal: project connected to the public repo, domains attached, public access.
Plan refs: §13.2, §13.3.

### 3.1 Import the project

1. Open `https://vercel.com/` (operator's account, Hobby plan).
2. **Add New → Project → Import Git Repository** →
   `Dicklesworthstone/asimposium.org`. If GitHub app permissions block it,
   grant access to ONLY this repository when prompted.
3. Framework preset: **Other** (the placeholder is static). Build command:
   none. Output directory: `site`. Deploy.
4. Confirm the deployment URL loads the placeholder. Note it in
   `ops/console-notes.md`.

### 3.2 Domains

1. Project → **Settings → Domains** → add `asimposium.org`, then
   `www.asimposium.org` with "Redirect to asimposium.org" (308).
2. Vercel now displays the DNS records it requires. Copy them verbatim into
   `ops/console-notes.md` for Task 2.4 (or run `vercel domains inspect
   asimposium.org` in the terminal, which prints the same thing).
3. After the Cloudflare records exist (Task 2.4), click **Refresh** until both
   domains show as verified with valid certificates.

### 3.3 Public access + deploy hygiene

1. **Settings → Deployment Protection**: ensure production is publicly
   accessible (no Vercel Authentication on production). Preview deployments
   may keep protection on.
2. **Settings → Git**: leave auto-deploy ON for now (placeholder phase). When
   the real app lands, the repo's `vercel.json` switches deploys to explicit
   (plan §13.2); do not toggle dashboard settings for that.
3. Do NOT upgrade the plan. Hobby is the decision until R-9 triggers.

---

## 4. GitHub — dashboard-only items

Repo creation/push is done from the terminal with `gh`. Browser-only items:

1. **Social preview**: repo → Settings → General → Social preview → upload the
   OG image once one exists (see `gh_og_share_image` tooling). Skip if the
   image is not ready.
2. Confirm repo visibility shows **Public** and the license is detected as
   "MIT + rider" custom (GitHub will show "View license"; that is fine).

---

## 5. Reporting back

At the end of a console session, ensure `ops/console-notes.md` contains, in
order: date/time, tasks attempted, IDs/URLs produced (project ID, client ID,
token names, record values), screenshots' filenames, anything skipped and why,
and any prompt the consoles showed that this document did not anticipate. The
operator reads that file before the next terminal step.

If ANY step's UI differs materially from what is described here (consoles
change constantly), prefer the step's stated GOAL over its literal click path,
and note the divergence in `ops/console-notes.md`.
