# W10.4 Auth Race Matrix on Real Local Workerd/D1 Stack (`asimposiumorg-ana`)

**Test Script:** `apps/wire/test/integration/auth-race-matrix-real-bindings.mjs`  
**Run Command:** `node apps/wire/test/integration/auth-race-matrix-real-bindings.mjs`

## Why This Suite Exists

One-time exchange semantics and the two-plane Agora/Stoa auth boundary are where quiet security bugs live. Every test in this matrix runs against the **real compiled Worker inside local Workerd with real migrated Cloudflare D1 bindings** (`runLocalWorkerJourney`), logging structured interleaving traces per race and asserting **zero mocks** and **zero secret leakage** into D1 rows or Worker logs.

## Matrix Covered

| Race / Invariant | Real HTTP / D1 Verification |
|---|---|
| 1. Simultaneous double-exchange of one join URL | Concurrent `POST /v1/fellows` with distinct idempotency keys -> **exactly one** `202` claim wins; loser fails closed; plaintext `secret` absent from `enrollment_records` (SHA-256 at rest) |
| 2. Enrollment expiry vs approval + 30m join-secret TTL vs 24h proposal TTL | Expired join secret refuses new claim; already-claimed proposal remains approvable after join-secret expiry; expired 24h proposal refuses approval (`POST /v1/enrollments/:id/decision`) and mints 0 credentials |
| 3. Sponsor revocation racing in-flight Fellow write | Concurrent `POST /v1/fellows/credentials/revoke` + Fellow write + immediate post-revoke `GET /v1/hello` & write -> immediate `401 FELLOW_TOKEN_INVALID`, zero grace window |
| 4. Approval-page double-POST & cross-sponsor refusal | Concurrent `POST /v1/enrollments/:id/decision` (both same & distinct idempotency keys) + wrong-sponsor approval attempt (`403 WRONG_PRINCIPAL`) -> exactly one credential row in `fellow_tokens` |
| 5. Device flow `slow_down` + body-only enforcement | Back-to-back `POST /v1/device-token` faster than interval -> `status: "slow_down"` with `retry_after_seconds`; bare proposal/enrollment ID rejected; query-string credentials return `400 BODY_ONLY_REQUIRED` |
| 6. One-time response-loss / concurrent `POST /v1/fellows/flow` issuance | Two simultaneous polls with distinct idempotency keys after approval -> **exactly one** receives plaintext `asimp_ag_*` bearer token; second never reconstructs a secret; D1 stores only bearer hash (0 plaintext token bytes across D1) |
| 7. Bidirectional `WRONG_PRINCIPAL` | Fellow bearer on sponsor route (`POST /v1/enrollments`) refused; browser `Cookie` on Stoa (`GET /v1/hello`) never authenticates (`401`/`403`) |
| 8. Zero secret leakage in Worker logs | Entire captured Workerd log pipeline checked for every minted fragment secret and issued `asimp_ag_*` token |
