# ASImposium naming evidence package — 2026-08-17

**Bead:** `asimposiumorg-ynb` (W12.4a / OQ-12)<br>
**Prepared:** 2026-08-17, 04:42–04:47 UTC<br>
**Status:** `EVIDENCE_COLLECTED — NO CLEARANCE DECISION`<br>
**Approval state:** counsel review not recorded; operator decision pending; no rename authorized or performed.

## Purpose and boundary

This is a dated, source-bound research record for counsel and the operator. It is **not legal advice**, a trademark clearance, an availability opinion, a filing recommendation, or a conclusion that use of any identifier is safe. It deliberately does not infer availability from a domain, a registry miss, an HTTP status, or a search-engine result.

Fable calls `ASImposium` a **working name**, identifies `asimp` as the optional CLI, fixes `.org` plus repository alignment in ADR-6, and makes naming/trademark clearance OQ-12, a launch dependency. Those constraints define the evidence target; they do not settle it. See [Fable Rev 3.1](../../COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md#L1-L15), [ADR-6](../../COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md#L806), and [OQ-12](../../COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md#L839).

## Canonical candidate and search set

| Field | Recorded value | Evidence use |
| --- | --- | --- |
| Display candidate | `ASImposium` | Exact planned public display form; Fable calls it “ASI + symposium.” |
| Spoken form to test | “A-S-I symposium” and “AI symposium” | Pronunciation/aural variants; not a claim that they are equivalent marks. |
| DNS/repository form | `asimposium.org` / `Dicklesworthstone/asimposium.org` | ADR-6 form; lowercase DNS and GitHub normalization do not settle word-mark scope. |
| Product package scope | `asimposium`, `@asimposium/*` | Present workspace package identifiers. |
| Binary/package candidate | `asimp` | Current Cargo package and executable name. |

The dated search strings below should be applied separately to each official registry, with live/pending/registered/inactive filters recorded where the registry offers them:

1. `ASImposium`, `asimposium`, `ASIMposium`, and `ASIMPOSIUM`.
2. `ASI Symposium`, `ASI-Symposium`, `ASI Symposiums`, and `ASISymposium`.
3. `A S I Symposium`, `A-S-I Symposium`, and phonetic/approximate equivalents offered by the registry.
4. `AI Symposium`, `AI-Symposium`, and `Artificial Intelligence Symposium` as a broad false-positive/association screen, not as an assertion of legal similarity.
5. `asimp`, `asimposium`, and `asimposium.org` in owner, goods/services, and mark-literal fields where available.

## Jurisdiction, class, and registry coverage

These are research scopes, not final filing classes. The product presentation supports examining at least Nice 42 (hosted software/SaaS), 9 (downloadable `asimp` companion), and 41 (scientific publication, event, or educational-adjacent activity if actually offered). Class 38 is conditional on whether the eventual service is characterized as telecommunications/communications rather than only software; counsel should determine the final description. No class should be filed or represented as used merely because it appears here.

| Jurisdiction/collection | Why in scope | Registry/source and dated observation | Result state |
| --- | --- | --- | --- |
| United States | Primary public software and scientific-platform risk screen. | [USPTO Trademark Search](https://www.uspto.gov/trademarks/search) and [USPTO federal-search guidance](https://www.uspto.gov/trademarks/search/federal-trademark-searching), retrieved 2026-08-17. The guidance expressly requires exact, expanded, alternative-spelling, and pronunciation searching, and notes related goods need not share a class. | **Method source verified; no record-result export captured.** Do not call this a registry clear. |
| Madrid / WIPO collection | International registrations and participating collections; useful but not complete. | [WIPO Global Brand Database](https://www.wipo.int/en/web/global-brand-database), [coverage/FAQ](https://www.wipo.int/en/web/global-brand-database/faqs_branddb), and [availability guidance](https://www.wipo.int/en/web/madrid-system/check-availability), retrieved 2026-08-17. WIPO states national/regional registers should also be searched. | **Method source verified; no record-result export captured.** Coverage is explicitly incomplete for clearance. |
| European Union | EU trade-mark screen if EU-facing launch/use is contemplated. | [EUIPO eSearch](https://euipo.europa.eu/eSearch/), retrieved 2026-08-17. | **Registry entry point verified; query/result capture pending.** |
| United Kingdom | Separate UK register; relevant if UK use, sales, events, or sponsorship is targeted. | [UK IPO search](https://www.gov.uk/search-for-trademark) and [pre-filing guidance](https://www.gov.uk/how-to-register-a-trade-mark/before-you-apply), retrieved 2026-08-17. | **Registry entry point verified; query/result capture pending.** |
| India | Required by the observed scientific “ASI Symposium” usage, even though that usage is not evidence of a registration. | [IP India public search](https://tmrsearch.ipindia.gov.in/tmrpublicsearch) and [IP India search guidance](https://www.ipindia.gov.in/trade-marks-before-you-apply-search-existing-trademarks), retrieved 2026-08-17. | **Registry entry point verified; word/phonetic query/result capture pending.** |
| Canada | Conditional target-market screen. | [Canadian Trademarks Database](https://ised-isde.canada.ca/cipo/trademark-search/srch?lang=eng&wbdisable=false), retrieved 2026-08-17; the page reported its database update as 2026-07-15. | **Registry entry point verified; query/result capture pending.** |
| Australia | Conditional target-market screen and a useful official similarity-search reference. | [IP Australia search guidance](https://ipaustralia.gov.au/trade-marks/search-existing-trade-marks) and [Australian Trade Mark Search](https://search.ipaustralia.gov.au/trademarks/search/quick), retrieved 2026-08-17. | **Registry entry point verified; query/result capture pending.** |

The absence of a result capture is intentional evidence, not a silent omission: browser- and JavaScript-mediated registries were not treated as having returned “zero results” merely because this collection run could reach their entry pages. A lawyer or instructed search provider should run the recorded strings, preserve the search reports/screenshots, assess live status, goods/services, priority, reputation, and target-market common-law use.

## Observed names and collision signals

| ID | Observation | Source-bound fact | Risk interpretation | Result state |
| --- | --- | --- | --- | --- |
| `USE-ASI-01` | “ASI Symposium” is in active scientific-conference use. | [Astronomical Society of India’s list](https://www.astron-soc.in/list_of_symposium), retrieved 2026-08-17, lists multiple `ASI Symposium` events, including 2024–2026 entries; [IIT Kanpur’s 2026 ASI Symposium page](https://iitk.ac.in/space/DynamicRadioSky/) identifies the Astronomical Society of India context. | Scientific-community association and spelling/spacing risk; this is **not** a registration, ownership, or likelihood-of-confusion conclusion. Indian registry and common-law analysis remain necessary. | `OBSERVED_USE — COUNSEL_REVIEW` |
| `PKG-NPM-01` | npm has historical package identifier `asimp`. | [`https://registry.npmjs.org/asimp`](https://registry.npmjs.org/asimp), GET 200 on 2026-08-17, records versions 1.0.0–1.0.8 created 2016-09-09 and all listed as unpublished 2020-03-09. Response SHA-256: `f27fdcb6195425d5c5e9d2ea72aa87922bcf40aa1530b05f597eb61dfd77135f`. | The exact CLI/package token has prior npm history. Whether it is claimable, protected, or confusingly similar is not established. Do not publish a package under it without a namespace decision. | `OBSERVED_NAMESPACE_HISTORY` |
| `PKG-NPM-02` | npm exact unscoped `asimposium` endpoint returned not found. | [`https://registry.npmjs.org/asimposium`](https://registry.npmjs.org/asimposium), GET 404 on 2026-08-17; response SHA-256: `c8d3eae160a892e32837db3dcae515e843e5383fef52b8141940c8bcf8b6d59f`. | One endpoint response is not package ownership/availability assurance, and says nothing about scoped names. | `NEGATIVE_ENDPOINT_ONLY` |
| `PKG-PYPI-01` | PyPI exact endpoints for `asimp` and `asimposium` returned not found. | [`asimp`](https://pypi.org/pypi/asimp/json) and [`asimposium`](https://pypi.org/pypi/asimposium/json), both GET 404 on 2026-08-17; response SHA-256 each: `b82014934f66beeb9e05a37f65357c4b50db0349d25d68d818ed0319dd4feb40`. | Endpoint-only evidence; it does not clear typos, namespaces, distributions, or marks. | `NEGATIVE_ENDPOINT_ONLY` |
| `PKG-CRATES-01` | crates.io did not provide a query result to this run. | [`https://crates.io/api/v1/crates/asimp`](https://crates.io/api/v1/crates/asimp) and the search endpoint both returned HTTP 403 with a data-access-policy refusal on 2026-08-17. | No positive or negative crate-name claim can be made from the refusal. | `BLOCKED_SOURCE` |
| `REPO-GH-01` | The planned public GitHub repository exists. | [`GitHub repository API`](https://api.github.com/repos/Dicklesworthstone/asimposium.org), GET 200 on 2026-08-17: public, non-archived repository on `main`; response SHA-256: `cafe6e2002f10e098b3d2965269152aed7709123a320ce724cf8c43f51234aac`. Local `origin` matches the same URL. | Supports ADR-6 alignment only; it is not a trademark right. | `CONFIRMED_CURRENT_REPOSITORY` |
| `REPO-GH-02` | GitHub repository search for `asimposium` returned one result: the project repository. | [`GitHub repository search`](https://api.github.com/search/repositories?q=asimposium), GET 200 on 2026-08-17; response SHA-256: `a177d4784e32e4bc13fc970e7922e44caac0f96061e2ff6678570ad1a1bc3a1b`. | Search ranking/indexing are incomplete and time-varying; do not equate this with global repo or name clearance. | `LIMITED_SEARCH_RESULT` |
| `DOMAIN-01` | `asimposium.org` is registered and resolves. | [`RDAP record`](https://rdap.org/domain/asimposium.org), GET 200 on 2026-08-17, reports registration 2026-08-13, expiration 2027-08-13, and Cloudflare nameservers; response SHA-256: `ac87ea04673f808a5a865d518d1823ef0e0810d75dd9ef41fc5b8518238d89ed`. [`DNS-over-HTTPS A query`](https://dns.google/resolve?name=asimposium.org&type=A), GET 200, returned `216.150.1.1` and `216.150.16.1`; response SHA-256: `b7d6c30b3d027f76db733ce0e650fb7caf4d135b9c08233b8f024fa7cd0acb6f`. | Domain control is operational evidence only. It does not establish trademark rights or social-handle control. | `CONFIRMED_CURRENT_DOMAIN` |
| `HANDLE-01` | Exact public-handle probes were inconclusive. | GitHub user [`asimposium`](https://api.github.com/users/asimposium) returned 404; Bluesky [`asimposium.bsky.social`](https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=asimposium.bsky.social) returned `Unable to resolve handle` (response SHA-256 `740e75538c8911d39dbca60d85234dd35c432318be8f7b1a1319a5da220532ba`); `https://x.com/asimposium` returned 404. All retrieved 2026-08-17. | None of these responses proves a handle is available, controllable, unregistered, or free from impersonation. Federated and other social networks were not exhaustively searched. | `INCONCLUSIVE` |

## Current repository impact inventory

The current workspace actively uses the candidate across more surfaces than the domain alone:

| Surface | Current identifier(s) | Local evidence | Rename impact if accepted later |
| --- | --- | --- | --- |
| Public planes | `asimposium.org`, `a.asimposium.org`, `artifacts.asimposium.org` | Fable lines 3–9; environment topology and Worker configuration | **High:** DNS, Vercel, Cloudflare Worker/R2 custom domains, CORS/origin validation, redirection, ETags/caches, and external links. Requires a migration plan, not search/replace. |
| GitHub/repository | `Dicklesworthstone/asimposium.org`; local checkout `asimposium.org` | `origin` and ADR-6 | **High:** ADR-6/Fable amendment with user acceptance; repository rename/redirect implications; badges/links/citation URLs. |
| JavaScript package namespace | root `asimposium`; `@asimposium/{web,wire,contracts,protocol,render,e2e,gauntlet}` | `package.json` files | **High:** workspace imports, lockfile, generated schemas, automation, publishing policy, package scopes. No publish action has been taken here. |
| Rust CLI/binary | Cargo package and executable `asimp` | `cli/Cargo.toml:6`; `cli/src/lib.rs:9` | **Medium–high:** invocation syntax, docs, test snapshots, Cargo package identity, prospective crates.io namespace, release process. The npm history makes this a separate decision even if the public mark stays. |
| Protocol/API serialization | `ASIMP-EN-…`, `asimp_ag_…`, `https://a.asimposium.org/...`, `https://asimposium.org/errors/...` | contracts, tests, served protocol, and deployed-environment configuration | **High:** public contracts, token/enrollment prefixes, schemas, error URIs, examples, fixtures, and compatibility/documentation. Each must be classified as brand-only versus stable protocol identity before any change. |
| Storage/deployment | `asimposium-*` D1/R2/bucket/environment names | `infra/environments.toml` and generated Wrangler configuration | **High:** Cloud provider identifiers, access policy, migration/rollback discipline, and historical operational observability. Do not rename by string replacement. |
| Public writing/search visibility | Fable, protocol text, Agora pages, README/docs, social/reservation candidates | source tree and public repository | **High:** canonicalization, redirects, discoverability, release history, and citations. Preserve historical evidence rather than rewriting it out of existence. |

No row authorizes a change. The matrix is a planning inventory for the operator only.

## Residual-risk register

| ID | Residual risk | Level today | Why it remains | Required disposition |
| --- | --- | --- | --- | --- |
| `RR-01` | Trademark registration and common-law collision | **High** | No counsel-reviewed, class-specific, jurisdiction-specific result set or common-law search is attached. | Counsel/provider runs the recorded variants, retains reports, and evaluates live status, goods/services, priority, reputation, and target markets. |
| `RR-02` | Scientific-sector association with “ASI Symposium” | **Medium–high** | Current observed use in astronomy is close in spelling and scientific context; its legal status and consumer perception are unreviewed. | Indian registry and use investigation; counsel comparison against actual services/territories. |
| `RR-03` | CLI/package namespace `asimp` | **Medium** | npm records a historical unpublished exact package; crates.io was blocked; no OS package-manager survey was completed. | Decide package/publish strategy before release; query crates.io and any target registries through permitted/manual means. |
| `RR-04` | Social/handle impersonation or unavailability | **Medium** | Exact probes are partial, and HTTP errors do not establish ownership. | Operator chooses target networks; obtain/verify handles through approved provider workflows only after brand decision. |
| `RR-05` | Domain/repository over-reliance | **Medium** | Current domain and GitHub alignment are real but do not establish clearance. | Keep ADR-6 as architecture evidence only; do not represent it as legal clearance. |
| `RR-06` | Cost and breakage of a late rename | **High** | The candidate is already embedded in protocols, tooling, domains, provider topology, and public writing. | Resolve before external identity hardens; if a change is accepted, amend Fable/ADR-6 first, then create explicit migration work. |

## Decision and review ledger

| Decision | State | Evidence / guard |
| --- | --- | --- |
| Canonical capitalization/pronunciation | `PENDING_OPERATOR` | Fable has a working display spelling and explains “ASI + symposium,” but no accepted brand decision is recorded. |
| Counsel scope and conclusion | `PENDING_COUNSEL` | This package is a research input only; it contains no privileged communications. |
| Keep or change ASImposium | `PENDING_OPERATOR_AFTER_COUNSEL` | No rename, redirect, package publish, provider action, or identifier mutation was performed. |
| Second-review completeness check | `PENDING` | Reviewer should verify retrieval dates, the collector-recorded source hashes and their non-reproducibility limitation, jurisdiction/class coverage, variants, source access limitations, and that all negative endpoint results retain their limitations. |
| Bead/roadmap status | `UNCHANGED_BY_THIS_REPORT` | No `br` mutation, sync, or Git staging occurred. |

## Minimum next evidence before a decision

1. Ask qualified trademark counsel to define actual launch/use territories and offered goods/services, then run and retain direct registry reports for the full variant set and chosen classes.
2. Add common-law/open-web, company-name, app-store, package-manager, and social-handle searches appropriate to those territories; distinguish uses from registrations.
3. Compare `ASImposium` and the `asimp` CLI separately; a decision to keep one does not automatically decide the other.
4. Record counsel’s non-privileged conclusion and the operator’s explicit accept/rename decision. If a rename is selected, amend Fable/ADR-6 with user acceptance before creating implementation work.
5. Have an independent reviewer mark this package complete only after source dates and the above gaps are checked.

## Integrity notes

- Source hashes above are collector-recorded SHA-256 digests of the cited HTTP response bodies. The response bodies, byte lengths, and per-request timestamps were not retained, so the digests cannot be independently reproduced from this package; they record what the collector observed during the stated retrieval window, not a perpetual state of a third-party service.
- The query/result distinction is deliberate: a registry entry page, blocked request, 404, or dynamic page is not recorded as a “clear” search result.
- No provider state, name, handle, package, domain, registry record, repository, Bead, or Git state was modified while preparing this package.
