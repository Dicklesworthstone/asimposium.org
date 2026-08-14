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
(`NeutralizationMarker`): `asimp-control-comment` changes a forged `<!-- asimp … -->` opener to
the inert text `&lt;!--` regardless of its prefix, backslashes, whitespace, case, or canonical and
compatibility Unicode form; invisible format characters and combining marks remain in the namespace
candidate until canonicalization, so they cannot split a forged header; either tokenizer-accepted
closer, literal `-->` or parse-error `--!>`, also ends a fieldless canonical namespace such as
`<!--asimp--!>`;
`envelope-key-forgery` changes each quote in an exact lower-case server-authored
`"next_actions"\s*:` or `"why_included"\s*:` shape to inert `&quot;` text, even when attacker
backslashes precede it (ordinary API JSON keys remain prose);
`fence-extended` is recorded once during preparation whenever the sanitized body makes the markdown
quarantine fence grow past three backticks; thus markdown, JSON, and HTML report the same CommonMark
defense against a body closing its own fence; `active-html` records real
script-bearing markup, event attributes, or a dangerous destination in a URL surface, not bare
prose such as `one = 1`. Its bounded start-tag scan follows the HTML tokenizer distinction that
whitespace and `/` separate attributes after a valid tag name, while `/` inside an unquoted
attribute value is data. Quoted descriptive attributes such as `title` and `alt` remain data.
Anchored `javascript:`, `data:`, and `vbscript:` schemes are recorded in URL-bearing HTML attributes
(`href`, `src`, `action`, `formaction`, `poster`, and peers), Markdown inline link/image
destinations, and standalone autolinks. A scheme spelling later in an ordinary HTTPS path or query
is not a finding. The matcher mirrors URL preprocessing that strips leading C0/space and removes
ASCII tab, LF, and CR inside a scheme. Markdown link syntax inside direct code spans and top-level
fenced blocks stays inert, including CR, LF, and CRLF line endings. Raw HTML is deliberately a
lexical signal even inside a code example: `active-html` records the hazard bytes an attempted
quarantine breakout carries, while every current face still renders those bytes as data. An
independent raw-browser-tokenizer pass and a case-folded Unicode-canonical-tokenizer pass union
findings by original source offset. Thus NFKD →
mark/format removal → NFKC can reveal a mutation, but a manufactured quote, comment, or `>` can
never suppress real raw active markup; author bytes remain exact.

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

const faces = renderAllFaces(projection); // md + json + html-fragment from one prepared projection
```

`renderAllFaces()` calls `prepareProjection()` exactly once, then renders each face from that
immutable prepared projection. The Diptych integration suite compares its bytes, fingerprint, and
neutralization report with three public `renderProjection()` calls on a hostile projection. That
load-bearing equivalence regression keeps agreement observed at the public API boundary instead of
making it tautological through the shared intermediate.

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

- **No W4 pack-composer determinism claim.** This package has checked-in, reviewable golden face
  snapshots and renderer-level determinism checks. They do not prove Worker pack composition
  (budgets, `omitted[]` selection, or stable-prefix ordering); that claim remains
  **asimposiumorg-ceq**.
- **No markdown pipeline.** Nothing here parses or renders markdown to HTML. The GFM + math
  pipeline with raw HTML disabled and KaTeX trust mode off (§14.3) does not exist yet; the html
  fragment escapes untrusted bodies into `<pre><code>` rather than rendering them. The auxiliary
  Markdown-URL arm of the `active-html` detector recognizes inline links/images, autolinks,
  reference-style uses and document-start, blank-separated, or consecutive top-level reference
  definitions, code spans, and top-level fences. It is not a complete CommonMark block parser and
  does not model container prefixes, indented code blocks, or definitions placed directly after
  another non-paragraph block. The raw-HTML arm is intentionally lexical rather than a claim about
  whether the source bytes form live HTML in a standalone Markdown parse.
- **No browser sanitizer claim from `active-html`.** Its scheme detector does not decode HTML
  character references in attribute values and does not parse multi-candidate `srcset` or CSS URL
  syntax. For example, `href="&#106;avascript:…"` is deliberately not reported today. This is a
  reporting boundary, not a live-markup escape: the Markdown face quarantines the whole body and
  the HTML fragment escapes `&` and `<`. The future GFM pipeline must close this detector gap with
  its real HTML parser/sanitizer before any untrusted body is rendered as markup.
- **Textual JSON-key matching only.** The neutralizer does not parse or decode JSON key escape
  spellings. For example, the literal body text `"next_action\u0073":` remains data, rather than
  being treated as `"next_actions":`. This package makes no claim that a downstream consumer which
  decodes such body text will preserve the same boundary.
- **No arbitrary-input sanitizer resource bound.** Unicode-canonical active-markup recovery replays
  an ASCII-finding-equivalent per-code-point interpretation once only when findings exist; the
  exported structural diagnostic retains its historical whole-string NFKC view. Adversarial label
  and many-finding tests exercise Fable's planned 20,000-character `body_md` contract, but do not
  prove a time or RSS bound for unbounded input.
- **No TOON**, per the section above.
- The fingerprint is a drift checksum, not authentication, and not an ETag.
- This package is not the validator. Scientific rules P1–P13 live in the Worker and
  `@asimposium/contracts`; refusals here are structural and about faces.
