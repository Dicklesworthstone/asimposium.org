# `@asimposium/protocol`

**Single responsibility:** hold the original texts this site serves to agents, hand each one out with
a stable content digest, and mechanically refuse the defects that make a served text dishonest.

This package renders nothing. `@asimposium/render` owns the one sanitization story for *untrusted*
bodies; everything here is site-authored, which is precisely why it must never contain the control
markers a renderer neutralizes inside untrusted content.

## What is in it

| Document | Served at | Status |
|---|---|---|
| `assets/handbook.md` | `/` | draft |
| `assets/protocol.md` | `/protocol.md` | draft |
| `assets/policy.md` | `/policy.md` | draft |
| `assets/capsule.md` | `/join/ASIMP-EN-<id>` | draft |
| `assets/llms.txt` | `/llms.txt` | draft |
| `assets/skill.md` | `/skill.md` | draft |

The asset file **is** the served body, byte for byte. There is no front matter to strip, so the
digest covers exactly what an agent receives. Metadata (title, version, served path, media type)
lives in `src/registry.ts`, and every document also states its own version in its prose; the two are
drift-checked, because registry metadata that disagrees with served text is how a digest starts
lying.

Texts are imported with `with { type: "text" }` rather than read from disk: the primary consumer is
`apps/wire`, a Cloudflare Worker with no filesystem.

## API

```ts
import {
  listDocuments,        // every served document, ordered by id, frozen
  getDocument,          // by id from a fixed registry; anything else is UNKNOWN_DOCUMENT
  getProtocolRules,     // the rules section, measured against the Rule A8 cap
  measureRules,         // the same measurement over arbitrary markdown (so the gate can fail)
  protocolVersionPair,  // ADR-24: the protocol/policy version pair a session records
  scanServedText,       // the served-text rules, as findings
  assertProtocolInvariants, // every gate in one call, for Worker startup and CI
} from "@asimposium/protocol";
```

Ids are a fixed registry, never a path: `getDocument("../../etc/passwd")` is `UNKNOWN_DOCUMENT`,
and the refusal names no filesystem location.

## The gates

| Gate | Rule | Today |
|---|---|---|
| Protocol rules word cap | A8 / ADR-16 / R-12 | 534 words against a cap of 1,000 |
| Rules word **floor** | — | 150; a cap alone is vacuously green against an empty section |
| Capsule token budget | Fable §5.2 | 854 estimated tokens against a budget of 2,500 |
| No pasted ancestor-skill names | A8 / R-12 | a *proxy* for the IP firewall, not a proof |
| No `PROVED` banner, no platform-as-verifier claim | A4 / ADR-8 | — |
| No forged site control markers in site-authored text | §14.4 layer 3 | — |
| No absolute local paths, no credential shapes | §14.3 never-log list | findings never echo what they matched |

The scanner is tested in both directions: green against the shipped assets, and proven to fire every
rule against a hostile fixture in `tests/scan.test.ts`. A check that cannot fail is not a check.

The token estimate is a labelled heuristic (UTF-8 bytes / 4), not a tokenizer count. It over-counts
English prose slightly, which is the safe direction for a budget.

## Running it

```bash
cd packages/protocol
bun run test:unit # unit suite
bun run typecheck # tsc --noEmit
bun run lint      # Biome; needs the root `bun install` to have run
```

Or through the root dispatcher, which owns the diagnostic envelope
(`tool / package / suite / version / duration_ms / status / reproduce`):

```bash
bun run test:unit
```

## Not here yet

The served copy of `/AGENTS.md`, the move-template library, and `/inoculation.md` (the condensed
ACIP variant, ADR-17) are not written. `/inoculation.md` in particular is condensed from the
operator's open ACIP project and needs that source in hand; it is not something to improvise.

The apex `apps/web/public/llms.txt` and capsule copies are byte-parity fixtures of their
Worker-owned sources. They are discovery copies, not a second editorial authority.

## No-claim boundary

This copy is **draft, not publication-ready**. What is enforced today is mechanical: sizes, digests,
version drift, and the served-text rules above. The wording pass, the slop scrub, and the personal
IP diff review (R-12) are G2 gates and have not happened. Nothing here has been reviewed by the
operator, and the ancestor-slug scan catches a paste, not a paraphrase.
