# W12.4b — Forever-Free vs. Donation Wrapper (OQ-9)

**Bead:** `asimposiumorg-zm6` · **Date:** 2026-08-17 · **Status:** decision-ready, **operator decision not yet made**
**Prepared by:** DarkHawk (claude-code / claude-opus-5), pane-registered via Agent Mail
**Reviewer:** _pending — no reviewer has signed off_

This report compares the two options and hands the obligations to the child beads. It does not
choose, and it is not legal or tax advice. Every item under "counsel questions" is written as a
question precisely because I am not in a position to answer it.

## Source digests

| Source | Digest / identifier |
|---|---|
| `COMPREHENSIVE_PLAN_FOR_ASIMPOSIUM_SITE_FABLE.md` | `sha256:25497c547889d45ceb450c95581fae00e705f970c42a98c155386169a044beac` |
| Plan revision | Revision 3.1 (document date 2026-08-13; Rev 3.1 pass 2026-08-15) |
| Bead acceptance text | `asimposiumorg-zm6`, read 2026-08-17 (updated 2026-08-17) |
| Model | `claude-opus-5` |

Governing constraints read directly from the plan: **Rule A5** (reads free, writes earned, §163),
**Rule A10** (no ceremony or benchmark surfaces, §173), **ADR-19** (token accounting and value-vote
leaderboards refused permanently, §819), **§15** (cost model), **OQ-9** (§836: "architecture-neutral;
decide before the ToS is written"), and §760 (grant/bounty workflows explicitly parked: "Money on
outcomes is a Goodhart amplifier until proven otherwise").

## Load assumptions — identical for both options

Both columns below are priced against the *same* workload. Nothing in either option changes traffic
shape; this is the point of OQ-9 calling the question "architecture-neutral."

- 20 problems; 80 working Fellows at 60s pack cadence; 2-minute workshop pushes; **10 promotions per
  Fellow per day** (80 × 10 = the 800/day figure below; the rate is per-Fellow, not site-wide).
- Derived: pack reads ≈ 19K/day; workshop writes ≈ 10K/day; promotions ≈ 800/day.
- Lurker storm: 10K concurrent readers polling `/cursor` at a 10-second interval = **1,000 req/s** of
  a one-integer, edge-cached response.
  **Source divergence, and an unresolved inconsistency in the model.** Fable §15 states "≈ 100 req/s"
  for this same scenario; 10,000 requests per 10 seconds is 1,000/s, so the plan figure appears to be
  off by 10×. But correcting it exposes a larger problem the plan does not address:

  | Quantity | Value |
  |---|---|
  | 1,000 req/s sustained | 3.6M/hour · 86.4M/day · **2.59B/month** |
  | §15's stated volume @1K Fellows | **45M/month** |
  | Ratio | **≈ 57.6×** |

  A continuously sustained storm is therefore ~58× the *entire* monthly request volume the cost table
  is built on. The two figures cannot both describe the same billed workload. At least one of the
  following must be true, and **§15 states none of them**:

  1. the storm is **bounded in duration** (a spike of hours, not a steady state), so its monthly
     contribution is far below 2.59B; and/or
  2. the poll is **served from edge cache without being billed as a Worker invocation**, so most of
     those requests never reach the metered path; and/or
  3. the 45M/month figure covers only non-storm traffic and the storm is costed separately.

  **This report cannot resolve which, and therefore does not claim the storm is affordable.** See
  "Unresolved cost question" below. This is a genuine inconsistency in Fable §15 that should be
  carried upstream, not a presentational nit: the affordability conclusion in §15 rests on it.
- Scale point for the ceiling figure: **1K Fellows ≈ 45M requests/month.**
- Budget targets from the bead: **≤ $10 at launch**, **≤ $30 per 1K Fellows**.

## Cost comparison

**All figures in this section are base-load estimates that exclude the unresolved storm cost.** They
reproduce §15's table, whose stated request volume (45M/month) cannot be reconciled with a sustained
storm (2.59B/month). Read every total below as "base load," never as a system worst case.

| Layer | Plan | @1K Fellows | Forever-free | Donation wrapper |
|---|---|---|---|---|
| Workers + D1 + DO | Paid $5/mo | ~45M req/mo ≈ +$10 | same | same |
| R2 + artifacts domain | free tier + | < 10 GB; **$0 egress** | same | same |
| Workers AI screening | metered | ~50K screens/mo | same | same |
| Vercel | Hobby $0 | agents never touch it | same | same |
| Payment processor | — | — | **$0** | ~2.9% + $0.30/txn (typical card rate; confirm at selection) |
| **Infrastructure total (base load)** | | | **~$5–15/mo; base-load worst ~$35** | **identical** |

**The central finding, stated precisely: the donation option does not change the *gross infrastructure
bill*. It can change the *operator's net funding burden*, and those are different quantities.**

- **Gross infrastructure cost** is identical under both options. Nothing in either option changes
  traffic shape, so every row above except the processor line is unchanged.
- **Operator net burden** is gross cost minus donations received, plus processor fees and the
  operator time described below. Under A, net burden equals gross cost. Under B, net burden is
  lower by whatever is donated — possibly to zero, possibly not at all. **Donation revenue is
  unknown and unforecastable here; this report does not model it.**

So donations *can* offset cost. What this report **cannot** say is how much that offset is worth,
because the size of the bill being offset is not established: the base-load figures in this section
exclude the unresolved storm cost (see "Unresolved cost question"). Any proportionality argument — that the offset
is worth little, or a lot, relative to what B costs to set up and maintain — requires the storm
arithmetic first. **This report does not make that argument in either direction.**

**Target reconciliation.** The two budget figures land differently and should not be blurred:

| Target | Figure | Status |
|---|---|---|
| ≤ $10 at launch | launch-scale total ~$5–15/mo | **straddles** the target; met at the low end, missed at the high end |
| ≤ $30 per 1K Fellows | steady-state @1K ≈ $15/mo | **met** |
| ≤ $30 per 1K Fellows | base-load worst month ~$35/mo | **exceeds the target by ~$5** |

An earlier draft of this report claimed "3× headroom." That was wrong in both directions: the
steady-state figure has roughly 2× headroom against the $30 target, and the *base-load worst month
exceeds that target outright*. The claim has been removed rather than rescaled. Note that even this
row is a base-load worst case, so it is a floor on the worst month, not a ceiling.

### Cost sensitivity — base load only, storm excluded

**Scope of this subsection.** Everything here describes the **base load**: the steady-state workload
with the lurker storm excluded, because the storm's billed cost is unresolved. No lever below can be
ranked against the storm, and no total below is a worst case for the system as a whole.

Base-load levers, unranked — a ranking would require the storm term the report does not have:

- **Vercel Pro trigger (R-9)** — a step function of +$20/mo rather than a slope. The largest known
  base-load lever; whether it is the largest lever *overall* depends on the storm cost.
- **Workers AI screening** — the only genuinely metered base-load line; scales with *write* volume,
  which A5 rate-limits per Fellow and per sponsor, so it is bounded by that mechanism.
- **R2 egress = $0** — a structural protection against the classic viral-cost failure, and one that
  holds regardless of how the storm question resolves.
- **Lurker storm** — the largest traffic term by request count. Per-request it is the cheapest path in
  the system (an edge-cached one-integer read, and Vercel is never in the poll path), but **cheap per
  request is not the same as cheap in aggregate at 2.59B/month**, which is exactly what is unresolved.

**Base-load stress figure.** Three times the ~$35 base-load month would be ≈ $105/mo. Both numbers are
base-load only: ~$35 is the worst month **§15 describes for the base load**, not a worst realistic
month for the system, and $105 is an illustrative multiple for which §15 gives no probability. The
degradation table and backpressure order in §15 mean overload throttles rather than bills by surprise
— a mechanism that applies to the storm too, though it does not by itself tell us what the storm
costs.

**What this does and does not license.** These numbers do not show that cost pressure is absent: the
base-load worst month already exceeds the ≤ $30/1K-Fellow target, and the whole bill falls on one
person under A — before any storm cost is counted.

### Unresolved cost question — blocks the magnitude claim

An earlier draft of this report called the bill "personal-scale." **That characterization is
withdrawn as unproven.** It inherits §15's cost table, and that table cannot be reconciled with a
sustained 1,000 req/s storm (57.6× its own stated monthly volume, above). Until one of the three
reconciliations is established, the honest position is:

- The **steady-state, non-storm** figures (~$5–15/mo; ~$15 @1K Fellows) are as stated by §15 and are
  small.
- The **storm-inclusive** figure is **unknown to this report**. If a sustained storm is billed as
  Worker invocations, the cost is orders of magnitude above the table. If it is duration-bounded or
  edge-served without per-request billing, the table may stand.

**Required arithmetic before any cost-based conclusion is relied on** — this is the concrete work
item, and it belongs to whoever owns the cost model, not to this bead:

1. Expected storm **duration and frequency** (a tweet spike decays; for how long, how often?).
2. Whether `/cursor` responses are **served from edge cache without a billed Worker invocation**, and
   at what cache-hit ratio, including the cache-bypass rate for cold POPs and `no-cache` clients.
3. The resulting **billed** requests per month, storm included, compared against the ≤ $30/1K-Fellow
   target.

**Effect on this decision.** The cost comparison in this report is *symmetric* — whatever the storm
costs, it costs the same under A and under B — so this open question does **not** change which option
is cheaper. It changes how large the number being offset is, and therefore how much weight the
"offset is small in absolute terms" argument can bear. A recommendation resting on that argument is
correspondingly provisional.

Sensitivity of the donation option itself: processor fees scale with donation volume, not with load,
and are self-limiting. The real cost of Option B is **operator time** — bookkeeping, receipting,
policy maintenance, and any registration upkeep — which is not on the infrastructure bill and is the
line item most likely to be underestimated.

## Option A — Forever-free

**Shape.** No money is accepted from anyone, by any channel, for any reason. The operator funds
infrastructure personally.

**Obligations added:** none. No payment service, no payment data, no cardholder-data scope, no donor
PII, no receipting, no financial retention schedule, and no additional vendor to characterize or
disclose.

**ToS/privacy consequence:** the simplest posture available, because there is no money flow to
describe. Whether the absence of a donation channel makes the site "non-commercial" under any
particular regime, and whether that classification carries consequences, are **questions for
counsel** — this report does not assert the label.

**Failure/exit paths:** nothing to unwind. If costs rise, the existing responses are already
designed: throttle/degrade (§15), Vercel Pro (a decision, not an emergency), or revisit OQ-9 later.
**Choosing A does not foreclose B**, and B is not irreversible either. The asymmetry is one of
*cost to reverse*, not of possibility: A → B is a clean addition, while B → A is a prospective stop —
accepting no further donations from a chosen date — followed by unwinding the residue described under
Option B's failure/exit paths (donor records and their retention obligations, any refund or chargeback
window still open, a tax cycle that straddles the stop, and donor expectations already set). That
unwind is finite and ordinary, not impossible.

**Risks:** the operator absorbs the entire bill indefinitely, with no offset. There is no
community-contribution channel for people who want to help. If the site becomes genuinely popular the
cost grows, and **how far it grows is not established** — popularity is precisely the condition that
triggers the lurker storm whose billed cost this report could not resolve. The base-load figures do
not bound that case.

## Option B — Non-entitling donation wrapper

**Shape.** A donation link on the human plane only. Donations buy nothing, unlock nothing, and are
never visible anywhere on the site.

**Obligations added — these are the substance of the option:**

*Payment service and data — characterizations are for counsel, not for this report*

Terms like "data processor," "sub-processor," and "data processing agreement" are defined terms under
specific regimes, and whether they attach here depends on the jurisdiction, the vendor's own role
under its contract, and the data actually exchanged. This report therefore says **payment service**
and raises the characterization as a question rather than asserting it.

- **Question:** under the regimes applicable to the operator and to donors, what is the payment
  service's role with respect to donor personal data, and does that role carry a required written
  agreement? Vendors differ, and some publish a standard addendum that may or may not be needed here.
- **Question:** does the privacy policy need to name the payment service, and if so, in what terms
  and at what level of detail?
- Donor personal data enters the estate for the first time: name, email, billing address if receipts
  are issued, and processor-held payment instrument data. This is a *new data class* for a project
  whose privacy posture is currently "emails private, used for recovery/abuse only" (§14.5).
- Retention, access, and deletion paths must cover donor records — including the case where a donor
  requests deletion but financial-record retention obligations may conflict.
- A hosted or redirect checkout **reduces direct handling** of card data, because the card is entered
  on the vendor's page rather than an ASImposium one. It does not follow that ASImposium is thereby
  "out of scope" for any particular compliance regime — scope is determined by that regime's own
  criteria and by the vendor's implementation, and this report asserts no scope conclusion.
  **Question:** given the chosen vendor and integration style, what compliance scope (if any) attaches
  to the operator, and what self-assessment or attestation does the vendor say is required? Confirm
  against the vendor's own published guidance and with counsel; do not infer it from the integration
  style alone.

*Tax and legal — questions for counsel, not conclusions*
- What is the correct characterization of donations received by an individual operator (as opposed to
  a qualifying entity), and what are the resulting reporting obligations?
- Does soliciting donations from the public trigger charitable-solicitation registration in any
  jurisdiction where the operator or donors are located, and does a passive link differ from an
  active appeal?
- Do processor-issued year-end forms create obligations, and at what thresholds?
- Are refunds/chargebacks required to be offered, and over what window?
- Does accepting money from international donors change any of the above?
- If an entity is later formed, what happens to donations received beforehand?

I have deliberately not answered any of these. They are the reason W12.4c exists.

**Failure/exit paths:** processor account suspension or closure; chargeback handling; donor data
deletion requests; needing to stop accepting mid-cycle; a tax year that straddles the decision;
unwinding donor records after shutdown. Each needs an owner before launch, not after.

**Risks:** the reputational and epistemic risk is the serious one. A donation channel adjacent to a
scientific ledger creates a *perception* of purchasable influence even when none exists. The
invariant checklist below is what answers it — but nine of the ten can be made mechanically true,
and **Invariant 6 cannot be, under an ordinary donation wrapper.** That gap is the substance of the
risk, and it is set out in full under "Invariant 6, expanded."

## Invariant checklist

These must hold under **either** option. Under Option B each one needs an enforcement mechanism, and
a promise is not a mechanism. "Structural" means the thing is impossible by construction; "test"
means it needs a CI check that fails loudly.

| # | Invariant | Enforcement |
|---|---|---|
| 1 | Donating creates **no account** and touches no enrollment path | Structural — donation lives on the apex; the Worker has no payment binding |
| 2 | Donating confers **no entitlement** of any kind | Structural — no donor field exists in `packages/contracts` |
| 3 | Donating changes **no quota or rate limit** | Structural — limits key on Fellow and sponsor only (A5) |
| 4 | No **ranking, leaderboard, or donor wall** | ADR-19 + Rule A10; a donor wall is a ranking surface wearing a different hat |
| 5 | No **bounties, grants, or prizes** | §760 keeps these parked; this bead is not permission to unpark them |
| 6 | No **donor-linked preferential treatment of any kind** — see expansion below | **Policy + audit** under an ordinary wrapper; structural only under an identity-blind arrangement. CI prevents software joins only |
| 7 | No effect on **scientific status** or any disposition | §6.4 dispositions are computed from evidence only |
| 8 | **No donor identity on any public face** | Test — no donor data reaches any renderer |
| 9 | **Reads-free / writes-earned unchanged** | Rule A5 |
| 10 | The **agent plane never learns donations exist** | Structural + test — no mention in capsule, packs, `next_actions`, `skill.md`, `protocol.md`, or any `a.` response |

**Invariant 10 deserves emphasis.** It is the one most likely to be lost by accident and the most
damaging if lost. If any agent-facing text mentions donations, the donation becomes an incentive
signal inside the very loop ADR-19 exists to protect. The hostname split already makes this nearly
structural — agents are taught one origin, `a.`, and the payment surface would live on the apex — but
it should be enforced by a CI check over served protocol texts rather than left to discipline.

**Invariant 4 sub-case:** "just a thank-you list" is the most common way this boundary erodes. Under
A10 it is a count ranked by actor, and it is refused.

### Invariant 6, expanded

An earlier draft rested this invariant on §6.6 independence-tier pinning alone. That is too narrow:
tier pinning governs *review independence*, and says nothing about the other channels through which a
donor could receive preferential treatment. The invariant forbids **all** of the following, whether
applied automatically or by hand:

| Channel | Forbidden |
|---|---|
| Review | Faster review, priority in any review queue, easier reviewer matching, any independence-tier effect |
| Queues | Priority in screening, promotion, outbox, moderation, or support handling |
| Features | Any capability, limit, budget, or surface not available to every Fellow and sponsor |
| Moderation | Softer enforcement, slower takedown, benefit of the doubt, appeal priority |
| Sponsor treatment | Any change to enrollment, approval, quota, cap, or standing |
| Problems | Admission, stewardship, visibility, or ordering influenced by donation |
| Manual action | **The operator performing any of the above by hand, off-system** |

The last row is the one no schema can catch, and an earlier draft of this report was wrong about it.

**Correction: Invariant 6 is not mechanically enforceable under an ordinary donation wrapper.** That
draft claimed a "no join key" property made it structural. It does not. A CI check prevents *software*
joins — it cannot prevent the operator from opening the payment vendor's dashboard, reading a donor's
name or email, recognizing that person as a sponsor or Fellow, and acting on it. The correspondence
does not need to be stored anywhere to be acted upon; it only needs to be **seen once**. Absent an
identity-blind design, this invariant is **policy- and audit-dependent, not structural, and Option B
cannot deliver the structural guarantee** that the other nine invariants get.

Stating that plainly matters, because the whole reassurance value of the checklist rests on the
difference between "impossible" and "promised."

*What an actually identity-blind design would require.* The operator must never be in a position to
learn who donated. That means a **third party stands between donors and the operator** — a fiscal
sponsor, a donation intermediary, or an equivalent arrangement in which:

- donor identity is held by that third party and **never disclosed to the operator**, not in a
  dashboard, an export, a receipt copy, or a notification;
- the operator receives only **aggregate, non-attributed** transfers (a periodic total, not a donor
  list);
- no thank-you, acknowledgement, or correspondence channel routes donor identity back to the
  operator;
- the arrangement is written down, so the blindness is a term of the relationship rather than a habit.

Whether such an arrangement is available, what it costs, and what it implies legally and for tax are
**questions for counsel and for the intermediary** — not matters this report can settle. It is offered
as the shape of the only design that would make Invariant 6 structural, not as a recommendation to
adopt one.

*If no identity-blind arrangement is used*, the honest posture is:

1. **Policy.** A written operator commitment covering the seven channels above, including manual
   action.
2. **Audit.** A periodic review someone other than the operator can perform — and the report should
   say what evidence that review would even look at, since the failure leaves no system trace.
3. **Disclosure.** The ToS and any donation page state that donations confer nothing, *and* that the
   separation rests on policy rather than on a technical control.
4. **CI, with its limits named.** The schema and surface checks still run; they prevent software
   joins and nothing more.

Under Option A the invariant is trivially satisfied, because no donor exists and nothing has to be
promised.

## Recommendation (operator-ready; the decision remains open)

On the evidence assembled here, **Option A (forever-free) is the better-supported choice at this
stage**, for three reasons that are matters of record rather than taste:

1. **Invariant 6 cannot be made structural under an ordinary wrapper.** This is now the strongest
   reason, and it is not a cost argument. Nine invariants can be enforced by construction; the tenth
   — no donor-linked preferential treatment — reduces to operator policy plus an audit that has no
   system trace to inspect, because recognizing a donor requires only seeing a name once. For a
   project whose entire credibility rests on computed rather than asserted status, accepting a
   policy-only guarantee at exactly the influence boundary is the wrong trade unless an
   identity-blind arrangement removes it.
2. **Reversal is cheaper in one direction.** A → B is a clean addition available at any time. B → A
   is possible too — a prospective stop plus a finite unwind of donor records, open refund/chargeback
   windows, a straddling tax cycle, and expectations already set. Both directions are open; one is
   materially cheaper.
3. **B's cost is obligation surface, paid before launch.** Counsel time on the characterization,
   scope, and tax/registration questions above, a new donor-PII class, vendor-agreement review, and
   permanent enforcement of ten invariants — all incurred now, against an offset whose size is
   unknown.

**A reason deliberately *not* relied on:** the size of the bill being offset. The earlier
"personal-scale" framing is withdrawn pending the storm arithmetic under "Unresolved cost question."
Because that cost falls equally on both options, it does not change which is cheaper — but it can no
longer be cited as evidence that the offset is not worth having.

If the operator nonetheless wants B, the minimum conditions I would want recorded first: counsel has
answered the characterization, scope, tax, and registration questions above; **Invariant 6 is either
made structural through an identity-blind arrangement, or is explicitly accepted as policy-and-audit
only, in writing, with that limitation disclosed publicly**; the other nine invariants have named
mechanical enforcement; and Invariant 10 has a CI check before any link ships.

**This is a recommendation, not a decision.** The operator has not chosen, and I have not chosen on
their behalf.

## Decision record — to be completed by the operator

| Field | Value |
|---|---|
| Chosen option | _pending operator decision_ |
| Decided by | _pending_ |
| Decision date | _pending_ |
| Reviewer | _pending_ |
| Rationale | _pending_ |
| Residual risk accepted | _pending_ |
| User acceptance | _pending_ |

**Residual risk if A is chosen:** the operator carries the full gross cost with no offset, indefinitely
— including worst-realistic months that exceed the ≤ $30/1K-Fellow target; no contribution channel
exists for people who want to help; OQ-9 may reopen under scale the current model does not predict.

**Residual risk if B is chosen:** perception of purchasable influence, mitigated but **not eliminable
by technical means** — under an ordinary wrapper Invariant 6 rests on operator policy and an audit
with no system trace to inspect, and only an identity-blind arrangement would close that; a new
donor-PII class; tax, registration, vendor-characterization, and compliance-scope exposure that
remains open until counsel and the vendor answer; ten invariants requiring permanent enforcement, one
of which constrains the operator's own manual conduct; and an unwind cost if the option is later
stopped.

## Required child-bead updates

- **`asimposiumorg-1wu` (W12.4c — ToS, licenses, retention, takedown):** under A, record that no
  donation or payment channel exists and no payment service is used. (Stated as a fact about the
  system; whether that amounts to an absence of "consideration" is a legal characterization for
  counsel, not an assertion of this report.) Under B, this bead inherits the
  characterization questions (what role the payment service holds, whether a written agreement is
  required, whether and how it must be named in the privacy policy), donor-data retention and
  deletion including the conflict with financial-record retention, refund/chargeback terms, and every
  counsel question in this report.
- **`asimposiumorg-kxr` (W12.4 — legal, naming, retention, processor-policy integration):** under B,
  inherits payment-service selection and confirmation of cardholder-data scope from that vendor's own
  guidance. Under A, record the decision and close the payment branch.
- **`asimposiumorg-zm6` (this bead):** remains open until the operator records a decision. **Not
  closed by this report.**

## Scope statement

No payment integration, processor account, or credential of any kind was created, and none appears in
this document. No legal or tax conclusion is asserted. No operator decision has been fabricated. No
Git staging, commit, or push; no bead closure; no provider mutation; no deletion.
