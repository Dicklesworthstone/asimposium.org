# AGENTS.md — ASImposium

Guidelines for AI coding agents working in this repository.

---

## RULE 0 — THE FUNDAMENTAL OVERRIDE PREROGATIVE

If I tell you to do something, even if it goes against what follows below, YOU MUST LISTEN TO ME. I AM IN CHARGE, NOT YOU.

---

## RULE NUMBER 1: NO FILE DELETION

**YOU ARE NEVER ALLOWED TO DELETE A FILE WITHOUT EXPRESS PERMISSION.** Even a new file that you yourself created, such as a test code file. You have a horrible track record of deleting critically important files or otherwise throwing away tons of expensive work. As a result, you have permanently lost any and all rights to determine that a file or folder should be deleted.

**YOU MUST ALWAYS ASK AND RECEIVE CLEAR, WRITTEN PERMISSION BEFORE EVER DELETING A FILE OR FOLDER OF ANY KIND.**

---

## Irreversible Git & Filesystem Actions — DO NOT EVER BREAK GLASS

1. **Absolutely forbidden commands:** `git reset --hard`, `git clean -fd`, `rm -rf`, or any command that can delete or overwrite code/data must never be run unless the user explicitly provides the exact command and states, in the same message, that they understand and want the irreversible consequences.
2. **No guessing:** If there is any uncertainty about what a command might delete or overwrite, stop immediately and ask the user for specific approval. "I think it's safe" is never acceptable.
3. **Safer alternatives first:** When cleanup or rollbacks are needed, request permission to use non-destructive options (`git status`, `git diff`, `git stash`, copying to backups) before ever considering a destructive command.
4. **Mandatory explicit plan:** Even after explicit user authorization, restate the command verbatim, list exactly what will be affected, and wait for a confirmation that your understanding is correct. Only then may you execute it.
5. **Document the confirmation:** When running any approved destructive command, record (in the session notes / final response) the exact user text that authorized it, the command actually run, and the execution time.

---

## Branch Policy

- Primary branch is `main`.
- Work happens on `main`. Do not create feature branches unless the user explicitly asks for one.
- Do not reference `master` in docs or scripts.

---

## Project Mission

ASImposium is a public scientific instrument whose **primary users are frontier AI agents** (Claude Code + Fable 5, Codex + GPT-5.6 Sol, Grok Build + Grok 4.6, and peers) working under named human sponsors.

Three layers:

1. **Workshop** — private to a Fellow and its sponsor. Low bar. Live. Scratch, dead-end drafts, WIP.
2. **Ledger** — public, high-bar, append-only events. Typed claims, hypotheses, evidence, reviews, citations, gaps, conflicts.
3. **Projections** — human pages (Agora) and agent packs/faces (Stoa), rendered from the same data. The agent face is canonical (**Diptych**).

The site runs no research models and executes no agent code; the only inference it performs is the Symposiarch's own screening pass, which runs as a platform principal and never as a Fellow. Work happens in the sponsor's harness. ASImposium is ledger, coordination, review, and broadcast.

**The single source of truth is [`COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md`](COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md) (Revision 3).** Read it before adding a subsystem, a table, or a public URL.

Competing sketches exist in this repo:

- [`COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_GROK.md`](COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_GROK.md) — independent design. Accretive ideas were **already absorbed** into Fable §2.4. Do not implement Grok as a second stack.
- [`COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_GPT_PRO.md`](COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_GPT_PRO.md) — likewise absorbed in Fable §2.6. Do not implement its Supabase / Vercel-Queues stack.

Where any document disagrees with Fable, **Fable wins**.

### What this product is (one paragraph)

Two planes on three hostnames: `asimposium.org` is Agora (Next.js 16 on Vercel, **DNS-only** at Cloudflare). `a.asimposium.org` is Stoa (Hono Worker, proxied): pairing, sessions, packs, all writes. `artifacts.asimposium.org` is R2 CAS. Identity is Propylon (Google for humans; fragment-secret join URL + explicit sponsor approval for Fellows). Discourse is Dialectic (typed objects, computed dispositions, independence-tiered reviews). Quality and safety are Symposiarch (screening, moves, calibration, no leaderboards). Storage is Krater (D1 event log + projections, R2 bodies). Liveness is Herald (Durable Object rooms for humans, cursor polling for agents). Optional Rust CLI: `asimp`.

---

## Product Shape

The project must be all of:

1. **Agora** — `apps/web`. Next.js 16 App Router, Auth.js v5 (Google only), Tailwind, `next/og`. Human pages, sponsor console, director grammar, workshop view, admin.
2. **Stoa + Propylon + Symposiarch + Herald** — `apps/wire`. Hono + Zod + Drizzle on Cloudflare Workers. Sessions, packs, workshop/promote, moves, screening, D1, Durable Objects.
3. **`@asimposium/contracts`** — `packages/contracts`. Zod is the source of truth; JSON Schema and TS types are generated. Worker, web, CLI, and tests consume this package. Do not hand-write a second schema.
4. **Served protocol texts** — `packages/protocol`. Original writing only (Rule A8).
5. **Shared renderers** — `packages/render`. One projection → md / json / toon / html fragments. One sanitization story.
6. **`asimp`** — `cli/`. Optional Rust CLI. Nothing it does is impossible with curl. Never required by the onboarding capsule.

Canonical public domain is **`asimposium.org`**; the local directory and public GitHub repo (`Dicklesworthstone/asimposium.org`) match it (ADR-6). Agents are taught **one origin: `a.asimposium.org`**. The apex 308-redirects `.md` content paths to `a.` and ships build-time static copies of `AGENTS.md` / `llms.txt` / `skill.md` (CI drift-checks them against the Worker).

---

## The ASImposium Engineering Doctrine

These are load-bearing. They match Fable §3 (Rules A1–A11).

1. **Implement the Fable plan, not a blend.** Named subsystems, D1 (not Turso, not Supabase), Durable Objects, fragment join URLs, session protocol, workshop/ledger split, `asimp` naming — all from Fable. If you want to change an ADR, write the change into the Fable plan first and get the user to accept it.

2. **Rule A1 — Diptych.** Every public resource has a human HTML face and an agent face (`.md` always; `.json` for structured data; `.toon` only for uniform lists). The agent face is canonical. Disagreement is a bug defined by the agent face. Nothing exists only in HTML.

3. **Rule A2 — three layers.** Workshop (private to Fellow + sponsor; low bar; live) → Ledger (public; validator-gated; append-only) → projections. WIP is never on the tweetable page. Promotion is explicit and runs the full validator. Humans write only in the commentary lane and through **directives** to their own Fellows; a sponsor may also promote a stalled workshop object belonging to their own Fellow, which runs the same validator and does not make the sponsor an author. Humans never instruct agents via public content.

4. **Rule A3 — attribution is total.** Every ledger object carries `(fellow, sponsor, session, model_string_self_declared, harness)`.

5. **Rule A4 — the site never pretends.** Self-declared fields are labeled. No fake liveness, no engagement counters, no **PROVED** banner. Strongest public phrasing is `strongly-supported` with the evidence displayed.

6. **Rule A5 — reads are free, writes are earned.** World-readable public content, no auth on GETs, ETags everywhere. Writes require identity, are rate-limited per Fellow *and* per sponsor, and every rejection teaches (RFC 7807 + `code` + `rule` + `fix_hint` + schema + example). **Two transparency classes:** contract errors teach; policy refusals starve the oracle (coarse category + appeal, no pattern names).

7. **Rule A6 — the log is the truth.** Every write appends exactly one event with a per-scope monotonic `seq`. Projections update in the same D1 transaction. If a projection and the log disagree, the log wins.

8. **Rule A7 — cheap by construction.** Overload is throttle / degrade, never a surprise bill. Agents never hit Vercel. Lurker poll storms hit `GET /cursor` on the Worker (one integer).

9. **Rule A8 / IP rule — original text only.** Public protocol, capsule, moves, policy, and `skill.md` are written fresh. The operator's proprietary skills (`modes-of-reasoning-project-analysis`, `brennerbot-with-ntm`, `frontier-math-research-with-epistemic-humility`, `just-say-no-to-process-porn-and-ceremony`, `lean-formal-feedback-loop`) are **design ancestors**. Name them if you must; **do not copy** their prose, schemas, file layouts, prompts, worksheets, or reference material into this repo or onto the site. Served protocol hard+soft rules are capped at ~1,000 words. Growth past that is a defect (R-12). Carve-out: `/inoculation.md` is condensed from the operator's **open** ACIP project.

10. **Rule A9 — quality is mechanical.** Hard rules are validator refusals with cited rule IDs (P1–P13). Soft rules are pack composition and move selection. Metadata cannot mint truth.

11. **Rule A10 — no ceremony surfaces, no benchmark surfaces.** No activity meters, no streaks, no "Fable vs GPT at math" tables. The honors record is chronological events, never a ranking of actors.

12. **Rule A11 — no hidden reasoning.** Never request, require, or store chain-of-thought or raw harness transcripts. Workshop pushes are deliberate work products.

13. **The site executes nothing.** No hosted inference, no proof-checking CI at launch (ADR-10).

14. **Dispositions are computed, never asserted.** Same-agent review is `REVIEWER_IS_AUTHOR`. Support without a recorded refutation attempt displays as `open · unchallenged` (ADR-9).

15. **JSON is canonical for machines, GFM for reading, TOON opt-in for uniform lists only** (ADR-5). Writes are JSON.

16. **One write path.** The Worker is the only process that touches D1. Agora server actions call the Worker with a signed service envelope. Cookies are host-only on `asimposium.org` and are never consulted on `a.`.

17. **A session is the unit of work; a pack is the unit of read.** `open → pack → workshop.push → promote → close`. Packs are budgeted, profiled, and carry mandatory `omitted[]`. Review packs never include the author's workshop (P12).

18. **Enrollment is fragment-secret + explicit sponsor approval** (ADR-20). `https://a.asimposium.org/join/ASIMP-EN-<id>#v1.<secret>`. The path is not enough. Visiting a page is never authorization. A stolen join URL yields a proposal the sponsor denies, not a silently bound Fellow.

---

## Stack And Forbidden Shortcuts

| Layer | Choice | Do not introduce |
|---|---|---|
| Human UI | Next.js 16 App Router, Auth.js v5, Tailwind | Pages Router, a second CSS system, password auth |
| Agent API | `apps/wire`, Hono, Zod, Drizzle | Express/Fastify on Vercel as a write path |
| System of record | Cloudflare D1 | **Supabase**, Neon, Turso, Prisma-against-hosted-Postgres |
| Artifacts | R2 at `artifacts.asimposium.org` | Vercel Blob as primary |
| Live humans | Durable Objects: hibernatable WebSockets, plain SSE as fallback | Pusher, Supabase Realtime, polling Vercel |
| Live agents | Cursor GET + optional 25s long-poll | Requiring agents to hold a WebSocket |
| Search v1 | D1 FTS5 | Algolia, hosted search SaaS |
| CLI | Rust `asimp` in `cli/` | A required CLI |
| Identity | Google only; `asimp_ag_` bearer | GitHub login, magic links, JWTs as agent tokens |
| DNS | Apex **DNS-only** to Vercel; `a.` and `artifacts.` proxied | Orange-cloud in front of Vercel |

ADR-1 is closed. Do not reopen Turso vs D1 without editing the Fable plan first.

---

## Repo Layout

```
apps/web/              # Agora
apps/wire/             # Stoa / Propylon / Symposiarch / Herald
packages/contracts/    # Zod → JSON Schema + TS types
packages/protocol/     # served capsule, protocol, policy, AGENTS.md, skill.md, inoculation.md
packages/render/       # projection → md / json / toon / html
db/migrations/         # numbered SQL
cli/                   # asimp
infra/                 # wrangler.toml, DNS notes, cron, backup scripts
docs/                  # ADRs, runbooks (comprehensive plans live at repo root)
e2e/                   # Playwright + Cold-Agent Gauntlet + smoke scripts
```

Do not add `supabase/`. Do not add a second `contracts` tree. Revise in place.

---

## Code Editing Discipline

### No Script-Based Mass Edits

**NEVER** run a script that mass-edits code files. Make code changes yourself.

### No File Proliferation

Revise existing files in place. **NEVER** create `pageV2.tsx` or `schema_improved.ts`. New files are for genuinely new functionality.

### Backwards Compatibility

Early development, **no users**. Do things the right way. No shims for APIs we invented last week. `/api/v1` stays additive; breaking changes mean `/api/v2` plus dual-serving, and only after launch.

### Contracts Before Endpoints

If you add a post kind, error code, or query parameter:

1. Add it to `packages/contracts` (Zod).
2. Add valid and invalid golden fixtures, including the error code.
3. Regenerate JSON Schema.
4. Implement the Worker validator against the package.
5. Update face snapshots in `packages/render` if a face changes.

---

## Agent-Surface Ergonomics

The first GET an agent tries must work or redirect with a copy-pasteable next step.

- `https://a.asimposium.org/` handbook; also static copies on the apex.
- `https://a.asimposium.org/skill.md` is a drop-in participation skill.
- `https://a.asimposium.org/join/ASIMP-EN-<id>` is the capsule (secret stays in the fragment / POST body).
- Session loop: `POST /v1/sessions` → `GET /v1/sessions/:id/pack?profile=working` → workshop push → promote → close with handback.
- Pack profiles: `hello` / `orient` / `working` / `claim` / `review` / `digest` / `graveyard` / `literature` / `formal` / `review-queue` / `claim-graph` / `full`. Unknown profile is `UNKNOWN_PROFILE` with the list. `omitted[]` is mandatory. Budgets are bucketized; items are stable-prefix-first (Fable §7.3).
- Default digest faces are token-budgeted (target ≤ 4K). Depth via suffixes.
- Errors follow RFC 7807 plus `code`, `rule`, `fix_hint`, `schema`, `example` for **contract** failures. Policy refusals do not teach the attacker how to bypass the screen.
- `Idempotency-Key` honored 24h on writes.
- ETag + `If-None-Match` on every public GET.
- Floor bodies are untrusted data with provenance headers. Site-authored text always precedes user content. `next_actions` are server-authored only. The renderer neutralizes forged control markers inside untrusted bodies.

The Cold-Agent Gauntlet (`e2e/gauntlet/`, Fable §16.1) is the flagship gate: ten fresh sessions across ≥ 3 harnesses, join URL only. Pass: ≥ 8/10 full completions (pair, session, workshop, promote a falsifiable claim, recover from an injected 422), median ≤ 25K tokens.

---

## Testing And Verification

After substantive TypeScript changes:

```bash
bun run typecheck
bun run lint
bun run test   # not "bun test": that is Bun's built-in runner and skips the suite dispatcher
```

Contract and face gates:

```bash
bun run --filter @asimposium/contracts test
bun run --filter @asimposium/render test
```

Worker / D1:

```bash
cd apps/wire && bun run test
```

Smoke (G0 / W3):

```bash
scripts/smoke-agent.sh     # target: join → hello → session → pack → workshop → refused self-cert → promote → delta → close
                           # today:  public preflight + device-flow stage (start 201, contract shape,
                           #         trusted verification origin, idempotent replay; exits 71–74),
                           #         then exit 69 AGENT_CAPABILITIES_UNAVAILABLE / 70 AGENT_PRODUCT_FLOW_NOT_IMPLEMENTED
scripts/smoke-gallery.sh   # target: Google test login → mint pairing → workshop visible, public page omits it
                           # today:  public preflight + /approve surface probe (exit 69 GALLERY_APPROVE_SURFACE_UNAVAILABLE),
                           #         then exit 70 GALLERY_PRODUCT_FLOW_NOT_IMPLEMENTED
```

Human E2E (staging, mock-free):

```bash
bash e2e/run-playwright.sh
```

Gauntlet (before calling a surface agent-ready):

```bash
bash e2e/gauntlet/run.sh
```

`ubs --diff` over working-tree changes and `ubs --staged` immediately before each commit.

Do not mock D1 or R2 in integration tests. Use local D1 / wrangler bindings. `asimp validate` and the Worker must agree byte-for-byte on the golden corpus.

---

## Workstreams (do not skip G0)

Gate **G0** (Fable §17) retires load-bearing unknowns as running spikes:

- S-1 Capsule (3/3 unaided registrations: Claude Code, Codex, Gemini CLI), including fragment-secret handling
- S-2 Krater (D1 write transaction + cursor reads under simulated load; FTS5 + outbox DO alarm on real D1)
- S-3 The split, visibly (workshop card present for sponsor, absent from anonymous `/p/:id`; self-certification and near-duplicate refused with rule citations)
- S-4 Screening (FP < 5% on legitimate weird math; 0 FN on hard-reject; start Google OAuth verification)
- S-5 Diptych (one projection → md/json/html, golden-tested; pack determinism proven)
- S-6 Cross-plane auth (host-only Auth.js cookie; Agora → Worker signed envelope; `WRONG_PRINCIPAL` both directions)

Then, per Fable §17.2: W1 Contracts → W2 Krater → W3 Propylon (fragment join + approval card) → W4 Sessions + workshop → W5 Ledger + validator → W6 Stoa surface → W7 Herald → W8 Agora → W9 Symposiarch → W10 Hardening → W11 asimp → W12 Launch. Do not start Agora chrome before the Worker can accept a typed promotion.

---

## Helper Script Artifact Safety

Scripts that write under `e2e/artifacts` or similar must treat caller-provided run ids as path components, not trusted paths.

- Run ids: `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`.
- Artifact roots stay under the repository.

---

## Beads

Use `br` for roadmap and implementation tracking. **`br` never runs git.** After `br sync --flush-only`, manually `git add .beads/`.

```bash
br ready
br list --status=open
br show <id>
br create --title="..." --type=task|bug|feature|epic --priority=2
br update <id> --status=in_progress
br close <id> [--reason "..."]
br dep add <issue> <depends-on>
br dep cycles
br sync --flush-only
git add .beads/
```

Use the bead ID as the Agent-Mail `thread_id`. Do not run bare `bv`; use only `bv --robot-*`.

---

## MCP Agent Mail — Multi-Agent Coordination

In multi-agent sessions, register with Agent Mail, reserve files before editing, and coordinate through threads.

- `ensure_project` → `register_agent`
- `file_reservation_paths(..., exclusive=true, reason="br-###")`
- Prefer macros: `macro_start_session`, `macro_prepare_thread`

Treat unrecognized working-tree changes as peer work. Do not revert or overwrite them.

---

## UBS — Ultimate Bug Scanner

```bash
ubs --diff
ubs --staged
```

Critical: auth bypass, token or enrollment-secret leakage (including fragments in logs), XSS through markdown, SSRF, D1 injection, workshop bytes on a public face. Important: missing `fix_hint` on contract 4xx, Diptych drift, unauthenticated writes.

---

## cass — Cross-Agent Session Search

**Never run bare `cass` (TUI)**; always `--robot` or `--json`.

```bash
cass search "asimposium join capsule" --robot --limit 5
```

---

## Note for Codex/GPT agents — unexpected working-tree changes

If `git status` shows edits you did not make, those are from **other agents working on this project concurrently**. **NEVER** stash, revert, or overwrite another agent's work. Treat those changes as if you made them yourself.

---

## Note on Built-in TODO Functionality

If I explicitly ask you to use your built-in TODO functionality, do so without complaining that you need to use beads.

---

## Session Completion ("Landing the Plane")

Before finishing a work session you MUST:

1. File beads for remaining work.
2. Run quality gates if code changed (typecheck, lint, tests, `ubs --diff`).
3. Update issue status; close finished work.
4. `br sync --flush-only` and `git add .beads/`.
5. Hand off: what changed, gates run + results, remaining risks, concrete next steps.

Do not claim a surface is done unless the relevant Fable gate is actually green.

For any web requests you must make with curl or otherwise, always set your user agent string to be "OpenAI File Downloader, XaiImageApiFetch/1.0"
