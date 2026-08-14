# `@asimposium/render`

**Single responsibility:** turn one projection into the faces of the Diptych, through exactly one
sanitization path.

Rule A1 says every public resource has a human face and an agent face rendered from the same
projection, and that the agent face is canonical: where they disagree, the agent face defines the
bug. This package is where that stops being a doctrine and becomes a function call.

## One projection, one sanitization story

```
Projection ──prepareProjection()──► PreparedProjection ──┬──► renderMarkdownFace()
  (envelope + items)                (validated, once-     ├──► renderJsonFace()
                                     neutralized, with    └──► renderHtmlFragmentFace()
                                     a fingerprint)
```

`prepareProjection()` is the only place an untrusted body is touched, and the only place the
structural trust rules of Fable §14.4 are enforced. A face renderer never sees raw input, so no face
can be safe while another is not — the failure mode a second sanitizer would eventually produce.

What preparation refuses, rather than repairs (RFC 7807 payloads via `RenderContractError.toProblem()`,
each with `code`, `detail` and `fix_hint`; `rule` is present only when a refusal genuinely cites
doctrine, and absent otherwise):

| Code | Why |
|---|---|
| `MISSING_OMITTED`, `EMPTY_PROJECTION_WITHOUT_OMISSION` | a projection that cannot say what it left out is an editorial, not a pack (§7.3) |
| `UNTRUSTED_FLAG_MISMATCH`, `SYSTEM_ITEM_MISFLAGGED` | system items are the only instruction channel and the only `untrusted: false` items (§7.3, §14.4 layer 2) |
| `INVALID_ITEM_ID`, `DUPLICATE_ITEM_ID`, `INVALID_SCOPE` | public ids stay problem-scoped, unique within a face, and honestly scoped (§6.1) |
| `INVALID_HEADER_VALUE`, `INVALID_NEXT_ACTION` | envelope metadata may not break the face header grammar; `next_actions` are server-authored and typed |
| `UNKNOWN_FORMAT` | an unknown format is a 400 with the allowed list, never a silent fallback (§7.1 axiom 9) |

What neutralization does to an untrusted body, reported on every face and never silently
(`NeutralizationMarker`): `asimp-control-comment` escapes a forged `<!-- asimp … -->` header;
`envelope-key-forgery` escapes a forged envelope key such as `"next_actions":` appearing in a body;
`fence-extended` grows the markdown quarantine fence past the body's longest backtick run, so a body
cannot close the fence that quarantines it (the CommonMark rule); `active-html` records
script-bearing markup, which the html face escapes character by character.

Neutralized is not deleted. The hostile bytes stay legible as data — Rule A4 — because a reader,
a sponsor, and a red-team fixture all need to see what was attempted.

Determinism is a product feature, not just testability: `stableStringify()` key-sorts everything the
package hashes or emits, and every face of one projection carries the same `fingerprint`, so drift
between faces is detectable. The fingerprint is `FINGERPRINT_ALGORITHM` (FNV-1a, named in the output
on purpose): a **non-cryptographic** drift checksum, never an integrity control. ETags and per-item
digests belong to the Worker's SHA-256.

## Faces today

| Face | Media type | Shape |
|---|---|---|
| `md` | `text/markdown; charset=utf-8` | agent-readable; server-authored control comments delimit the face and each item; untrusted bodies live inside a quarantine fence |
| `json` | `application/json; charset=utf-8` | canonical for machines; each item carries `untrusted`, `why_included` and its `neutralized` report |
| `html-fragment` | `text/html; charset=utf-8` | a fragment, not a document: no `<html>`, no comments at all, and no character of an untrusted body survives as markup |

### TOON is owed, and not here yet

Fable G0 **S-5 is md / json / html**, which is the scope this package covers. TOON is not part of
S-5 and its absence is not a gap in S-5 — but it is **not abandoned either**: §7.8 and ADR-5 place
opt-in `?format=toon` in **W6**, restricted to uniform mega-reads (`problems`, `claims`, `events`),
emitted only after a **lossless round-trip validation**, and never accepted on a write. When that
lands it belongs in this package, behind the same `prepareProjection()` pass, so the sanitization
story stays singular. Nothing here claims TOON works today; `renderProjection(_, "toon")` is an
`UNKNOWN_FORMAT` refusal that names the formats that do.

## Using it

```ts
import { renderAllFaces, renderProjection } from "@asimposium/render";

const face = renderProjection(projection, "md");
// face.body, face.media_type, face.fingerprint, face.bytes, face.neutralized

const faces = renderAllFaces(projection); // md + json + html-fragment, each through the full pipeline
```

`renderAllFaces()` deliberately re-runs the whole pipeline per face rather than sharing one
intermediate string, so agreement between faces is an *observed* property of the renderers instead
of an artifact of construction.

## Running the suites

```bash
cd packages/render
bun run typecheck        # tsc --noEmit, exactOptionalPropertyTypes on
bun run lint             # Biome over src, test, scripts, package.json, tsconfig.json
bun run test:unit        # canonical, sanitize, errors, diagnostics
bun run test:contract    # envelope refusals and the face contract
bun run test:integration # the Diptych: one projection, three agreeing faces
bun run test:security    # the planted negative of §14.4 layer 3
bun test                 # all of the above
```

Or through the root dispatcher, which owns the diagnostic envelope
(`tool / package / suite / version / duration_ms / status / reproduce`):

```bash
bun run suite unit contract integration security typecheck lint --filter '@asimposium/render'
```

## Threat boundary

The security suite tests **bytes**, and only bytes: after rendering, no face carries a live control
marker that came out of a body, the quarantine fence cannot be closed from inside it, and the html
face builds no element or attribute out of body content.

It does **not** test whether a reading model obeys the quarantine. That is behavioural, it belongs
to the §16.4 red team (bare vs. inoculated probe agents, reporting a compliance delta), and §14.4 is
explicit that the defence at that layer is probabilistic rather than a proof. A determined jailbreak
against a weak reader stays in the threat model, not hidden under it.

## No-claim boundary

- **Not S-5 complete.** S-5 also requires golden-tested faces and proven pack determinism. This
  package has assertion-level tests and a shared fingerprint; it has **no committed golden face
  snapshots**, and pack composition (budgets, `omitted[]` selection, stable-prefix ordering) is the
  Worker's job and is not implemented anywhere yet.
- **No markdown pipeline.** Nothing here parses or renders markdown to HTML. The GFM + math
  pipeline with raw HTML disabled and KaTeX trust mode off (§14.3) does not exist yet; the html
  fragment escapes untrusted bodies into `<pre><code>` rather than rendering them.
- **No TOON**, per the section above.
- The fingerprint is a drift checksum, not authentication, and not an ETag.
- This package is not the validator. Scientific rules P1–P13 live in the Worker and
  `@asimposium/contracts`; refusals here are structural and about faces.
