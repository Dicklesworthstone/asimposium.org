# Runbook: Sealing and Evaluating the S-4 Tier-B Adversarial Screening Corpus

## Purpose

Gate G0 Spike S-4 (`asimposiumorg-xeg`, Fable §17.1) and Red Team (`asimposiumorg-ip3`, Fable §16.4) require evaluating the live Workers AI screening pipeline (`POST /internal/screen`) against the frozen 200-entry corpus:

- **150 legitimate scientific posts** (`legit-001`..`legit-150`, in-repo, FP target `< 5%`)
- **30 Tier-A safe in-repo adversarial controls** (`hard-001`..`hard-020` spam & ACIP prompt injection + `hard-041`..`hard-050` synthetic fictional-target harassment, in-repo)
- **20 Tier-B operator-held sealed hard-reject entries** (`hard-021`..`hard-030` `dual-use-boundary` + `hard-031`..`hard-040` `operational-harm`, **NEVER committed to public git**)

The hard-reject false-negative ceiling is **0 / 50 (`FN = 0`)**. Until the 20 Tier-B bodies are supplied at runtime and match their pinned SHA-256 digests, S-4 remains fail-closed (`exit 78`, `PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE`).

## Never-Log & Repository-Safety Rules

1. **Never** create, copy, or stage the Tier-B corpus file inside `/data/projects/asimposium.org`. Both `scripts/s4-corpus-seal.ts` and `e2e/screening/s4-sealed-loader.ts` refuse any path inside the repository (`SEALED_CORPUS_INSIDE_REPO`).
2. **Always** store the private file with `chmod 600` (owner read/write only). Any group/world permission bit (`0644`, `0640`, `0660`, etc.) is refused **before reading a single byte** (`SEALED_CORPUS_INSECURE_PERMISSIONS`).
3. **Never** echo Tier-B bodies, excerpts, detector prompts, bearer tokens, or raw score bands into stdout, stderr, logs, PR comments, or retained artifacts.

## 10-Minute Operator Procedure

### Step 1: Create a private `0600` template outside the repository

```bash
mkdir -p -m 0700 "$HOME/.config/asimposium-private"
bun scripts/s4-corpus-seal.ts --template-out "$HOME/.config/asimposium-private/s4-tier-b.jsonl"
chmod 600 "$HOME/.config/asimposium-private/s4-tier-b.jsonl"
```

### Step 2: Populate the 20 Tier-B entries locally

Edit `$HOME/.config/asimposium-private/s4-tier-b.jsonl` locally so each of the 20 JSONL lines (`hard-021`..`hard-040`) has a non-empty `body` matching its declared `policy_category` (`dual-use-boundary` for `hard-021`..`hard-030`, `operational-harm` for `hard-031`..`hard-040`).

Optional encryption at rest with `age`:

```bash
age -e -r "<your-age-public-key>" \
  -o "$HOME/.config/asimposium-private/s4-tier-b.jsonl.age" \
  "$HOME/.config/asimposium-private/s4-tier-b.jsonl"
chmod 600 "$HOME/.config/asimposium-private/s4-tier-b.jsonl.age"
# Remove plaintext copy once verified if desired.
```

### Step 3: Compute SHA-256 digests without printing any body bytes

```bash
bun scripts/s4-corpus-seal.ts --hash-only "$HOME/.config/asimposium-private/s4-tier-b.jsonl"
```

For an `.age`-encrypted file:

```bash
ASIMPOSIUM_S4_AGE_IDENTITY_FILE="$HOME/.config/asimposium-private/s4.age.key" \
  bun scripts/s4-corpus-seal.ts --hash-only "$HOME/.config/asimposium-private/s4-tier-b.jsonl.age"
```

The command emits a single JSON line containing ONLY:
- `corpus_revision`
- `sealed_entry_count` (`20`)
- `tier_b_manifest_digest`
- `digests`: `{ "hard-021": "sha256:...", ..., "hard-040": "sha256:..." }`

### Step 4: Pin ONLY the 20 SHA-256 digests in git

Paste the 20 `sha256:...` values into `TIER_B_SEALED_DIGESTS` in `e2e/screening/s4-corpus.ts`. Commit ONLY those digests (never the private file!).

Verify that without `ASIMPOSIUM_S4_PROTECTED_CORPUS_FILE`, the repository remains clean and `scripts/e2e-s4-screening-oauth.sh --self-test` still stays blocked (`exit 78`).

### Step 5: Execute the live 200-entry S-4 run against staging

```bash
export S4_STAGING_SCREENING_URL="https://a-staging.asimposium.org/internal/screen"
export S4_STAGING_OAUTH_DRY_CHECK_URL="https://a-staging.asimposium.org/internal/oauth-dry-check"
export S4_STAGING_BEARER_TOKEN="<staging-s4-bearer>"
export ASIMPOSIUM_S4_PROTECTED_CORPUS_FILE="$HOME/.config/asimposium-private/s4-tier-b.jsonl"
# If using .age:
# export ASIMPOSIUM_S4_AGE_IDENTITY_FILE="$HOME/.config/asimposium-private/s4.age.key"

bash scripts/e2e-s4-screening-oauth.sh
```

## Interpreting Terminal Outcomes

- **Exit 0 (`S4_STAGING_DRY_CHECK_GREEN`):** All 200 entries (150 legitimate + 30 Tier-A + 20 sealed Tier-B) passed SHA-256 digest binding on staging, `FP < 5%`, `FN = 0`, all sentinels passed, and the OAuth dry check passed. Retain the emitted `screening-aggregate` and `s4-scorecard` NDJSON lines as the S-4 receipt.
- **Exit 1 (`S4_RUNNER_FAILED` / `CORPUS_DIGEST_MISMATCH` / `SEALED_CORPUS_INSECURE_PERMISSIONS` / `S4_THRESHOLD_OR_SENTINEL_FAILED`):** A real threshold breach, tamper mismatch, permission violation, or OAuth configuration defect occurred. Fix before re-running.
- **Exit 78 (`S4_LIVE_GATE_BLOCKED` / `PROTECTED_HARD_REJECT_BODIES_UNAVAILABLE`):** Either staging is unreachable/unconfigured or the Tier-B file was not provided (only the 180 in-repo entries were evaluated). Never treat exit 78 as green.
