# Repository Clutter Disposition Report (Read-Only, Rule 1 Compliant)

**Date:** 2026-11-21  
**Bead:** `asimposiumorg-rc-artifact-archival-e2e-shims-luqx` (related: `asimposiumorg-0oi3`)  
**Policy:** Per `AGENTS.md` Rule 1 (**NO FILE DELETION WITHOUT EXPRESS WRITTEN PERMISSION**), **zero files were moved or deleted** in compiling this report. All figures below come from read-only filesystem and Git inspection on `main`.

---

## 1. Host Disk & `e2e/artifacts/` Pressure Summary

| Location | Observed Count | Notes |
|---|---:|---|
| `/dev/md3` (`/`, `/data`) | 98% full (~24 GiB free of 878 GiB) | Operator action tracked under `asimposiumorg-0oi3` |
| `e2e/artifacts/` | 5,773 top-level run directories | Includes `.sbh-protect` retained caches (e.g., Chromium 1254 under `e2e/artifacts/dae7-repair-20261104/3soe-pw1254-retained-QwBtPc`) |
| `e2e/.artifact-writer-leases/` | 38,949 lease entries | Epoch-scoped append-only writer leases |

### Safe Operator Archival Workflow (Zero Auto-Deletion)

Use the race-safe POSIX `openat`/`O_NOFOLLOW` archival tool added in `scripts/archive-e2e-artifacts.ts` (backed by `scripts/lib/archive-e2e-artifacts-safe.py`):

```bash
# 1. Read-only dry-run (acquires e2e/.artifact-maintenance fence, checks zero open leases, scans via O_NOFOLLOW)
bun scripts/archive-e2e-artifacts.ts --dry-run --older-than-days 7

# 2. Produce SHA-256-verified archive strictly outside e2e/artifacts (skips .sbh-protect dirs by default)
bun scripts/archive-e2e-artifacts.ts \
  --dest /data/release-work/e2e-artifacts-archive-2026-11-21.tar.gz \
  --older-than-days 7
```

Only **after** the operator inspects `/data/release-work/e2e-artifacts-archive-2026-11-21.tar.gz.sha256.json` and verifies zero `open_leases` should the operator explicitly approve and execute any removal of archived top-level run directories listed in `selected_runs`.

---

## 2. Stray Tracked & Untracked Clutter Inventory

All active source references were checked with `rg` across `apps/`, `packages/`, `scripts/`, `e2e/` (excluding historical `e2e/artifacts/` snapshots), `infra/`, and `cli/`.

| Path | Kind | Git Tracked | File Count | Bytes | SHA-256 Prefix | Active Code References | Recommended Operator Disposition |
|---|---|---|---:|---:|---|---|---|
| `scripts/.s6-cand.sh` | File | Yes | 1 | 199,762 | `9919e3806c1bbfc1` | **0** active references (obsolete drifted copy of finished `scripts/e2e-s6-cross-plane-auth.sh`) | `git rm scripts/.s6-cand.sh` after operator approval |
| `site/` (9 legacy files below) | Dir | Yes | 9 | 776,230 | see breakdown | **0** runtime references (only historical comment in `apps/web/next.config.ts:44` & `docs/README.md:3584`; superseded by `apps/web` + `packages/protocol`) | `git rm -r site/` after operator approval |
| `apps/wire/src/krater/.wrangler/cache/cf.json` | File (in dir) | No | 1 | 1,940 | `7e9c5e4554b4a037` | **0** references (stray Wrangler local cache inside source tree) | Remove untracked `.wrangler` cache dir after operator approval; ensure `.gitignore` covers `**/.wrangler/` |
| `infra/draft-0051_synthesize_replay_scope.sql` | File | Yes | 1 | 1,521 | `1f39f37cd2d1ad50` | **0** migration/runtime references (superseded by numbered `db/migrations/`) | `git rm infra/draft-0051_synthesize_replay_scope.sql` after operator approval |
| `s2-diag.log` | File | Yes | 1 | 212 | `fa9394d779fa7f77` | **0** active references (stray Sep diagnostic log at repo root) | `git rm s2-diag.log` after operator approval |
| `=` | File | No | 1 | 0 | `e3b0c44298fc1c14` | **0** references (empty stray file from shell redirection typo) | Remove untracked root stray `=` after operator approval |
| `write` | File | No | 1 | 30 | `f62e085be6076883` | **0** references (stray 30-byte root artifact) | Remove untracked root stray `write` after operator approval |
| `.DS_Store` | File | No | 1 | 10,244 | `a94163a0fba0709c` | **0** references (macOS Finder metadata) | Remove untracked `.DS_Store` after operator approval |
| `infra/.DS_Store` | File | No | 1 | 6,148 | `a51c68fba1c80976` | **0** references (macOS Finder metadata) | Remove untracked `infra/.DS_Store` after operator approval |

### Detailed `site/` Breakdown (9 Tracked Files, 776,230 Bytes Total)

| File | Bytes | SHA-256 Prefix |
|---|---:|---|
| `site/asimposium_illustration.webp` | 292,510 | `fef519b9947cd969` |
| `site/capsule.md` | 3,703 | `f9cfdd10f43b4d68` |
| `site/design.html` | 97,763 | `8089a76ce40a1cd0` |
| `site/index.html` | 14,817 | `0236818a57b0e32e` |
| `site/llms.txt` | 3,135 | `b5dcd55327282618` |
| `site/og.jpg` | 181,755 | `7ccd210de4195256` |
| `site/policy.md` | 3,295 | `88465b79a7ea65a6` |
| `site/protocol.md` | 4,959 | `cb8f42aef58ecb4e` |
| `site/twitter.jpg` | 174,293 | `1506dce30f2c121a` |

---

## 3. Explicit Operator Approval Commands (Do Not Run Without Written Approval)

Per `AGENTS.md` Rule 1, agents will **not** execute any of the commands below until the user replies with explicit written authorization restating the exact paths:

```bash
# Tracked clutter (reversible via git history)
git rm scripts/.s6-cand.sh infra/draft-0051_synthesize_replay_scope.sql s2-diag.log
git rm -r site/

# Untracked local strays (irreversible)
rm -r apps/wire/src/krater/.wrangler
rm -- ./= ./write ./.DS_Store ./infra/.DS_Store
```
