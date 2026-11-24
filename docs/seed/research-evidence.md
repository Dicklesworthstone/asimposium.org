# Evidence for the research seed drafts

These results come from the two revision-pinned local research checkouts. The [intake file](research-intake.json) holds the exact problem proposals. Fellows can adopt those formulations through the ordinary sponsor and statement-review flow. The archive digests let reviewers check the bytes they receive before replay.

## Replay the archived results

Run these commands from the ASImposium checkout, passing the path to each local research project. Use Python 3.11 or newer and install NumPy for the Hebbian bootstrap.

```sh
python3 scripts/replay-research-seed.py hebbian-binding-controls ~/projects/bio_inspired_nanochat
python3 scripts/replay-research-seed.py hebbian-reward-timing ~/projects/bio_inspired_nanochat
python3 scripts/replay-research-seed.py checked-group-catalog ~/projects/model_guided_research
```

Each command reads the report and archive pinned in the intake file, checks both SHA-256 digests, and prints the recomputed result as JSON. The group replay checks the catalog's comparisons and fallback traces against the archived actions. The Hebbian replay recomputes the scoring decision from the archived losses. Reconstructing the hidden group actions independently or rerunning GPU checkpoints requires the upstream experiment materials.

## Held-out Hebbian pairing decision

A replay from the loss archive matched all four reported means, lower bounds, and per-seed effects within 0.000000000001 bits per byte. The input covers 1,536 rows from 128 documents, four training seeds and three checkpoint states per seed. Each state uses the same 220,244-byte denominator.

| Registered contrast | Improvement in bits per byte | One-sided lower bound | Seeds favoring the hypothesis | Passed |
| --- | ---: | ---: | ---: | :---: |
| Paired read over shuffled ensemble | 0.004676 | 0.004286 | 4/4 | No |
| Paired read over frozen read | 0.000560 | 0.000332 | 1/4 | No |
| Pairing advantage gained since initialization | 0.004784 | 0.004337 | 4/4 | No |
| Pairing advantage gained over shuffle training | 0.012030 | 0.011243 | 4/4 | Yes |

The registered decision required all four contrasts to reach 0.005 bits per byte, show a positive effect in each seed and have a positive lower bound. One of four passed. The study conditions its document bootstrap on these four seeds. The reported advantage over shuffle training was concentrated in seed 6313, which contributed about 82% of the pooled effect.

| Source at `bea83c505f6c19f9837b0ab8491729ab3bf5bd94` | SHA-256 |
| --- | --- |
| `results/trained_hebbian_binding_2026-11-23.json` | `c7e65ebc23cec33e0a802daa36a85ccf43ada8cef06645761d403c537557acf7` |
| `results/trained_hebbian_binding_2026-11-23.jsonl.gz` | `58496a9aa1547c808b9e3156674976ff28e72fa5efec57f67787cebd0cc0c69c` |

## Follow-up on reward timing

The follow-up tests a separate hypothesis about when feedback reaches a
Hebbian write in a synthetic copy task. The replay checks 48 runs, reconstructs
6,144 recorded feedback gains, verifies 24,576 recorded writes and checks the
240 held-out scores used in the decision. All eight supervised starts meet the
0.10 competence floor. Effects compare the average expected reward over updates
32, 64, 96 and 128 on the same held-out set for each cohort.

| Starting condition | Control for same-episode feedback | Improvement in percentage points | Positive seeds | Paired sign-flip p | Passed |
| --- | --- | ---: | ---: | ---: | :---: |
| Cold | Neutral | 0.001949 | 6/8 | 0.144531 | No |
| Cold | One episode late | 0.000530 | 6/8 | 0.027344 | No |
| Supervised | Neutral | 0.358337 | 7/8 | 0.019531 | No |
| Supervised | One episode late | 0.246096 | 6/8 | 0.039063 | No |

Each contrast required at least one percentage point of improvement, six
positive seeds and a one-sided paired p-value at most 0.025. No contrast met
the effect threshold. These are archived outcomes from the two-layer,
width-64 model after 128 synthetic policy updates. The replay checks the
recorded experiment and decision without running training.

## Exact group acquisition from checked catalog proposals

The replay evaluated each archived certificate comparison against its recorded baseline action, matched fallback edges for all twelve misses, and checked 3,456 archived word evaluations. It recomputed the query counts by family from selection queries, certificate checks and fallback calls.

| Population in the frozen panel | Certified | Cancellation calls | Catalog proposal, checking and fallback calls |
| --- | ---: | ---: | ---: |
| Catalog hits | 6/6 | 7,992 | 754 |
| Outside the catalog | 0/12 | 7,387 | 7,483 |

On this panel, the six hits used 90.57% fewer equality queries. The twelve misses recovered by fallback and used 96 extra calls, or 1.30%. These are oracle-query counts for the frozen panel. Independent scientific review can use the archived verifier and the preregistered source to reconstruct the hidden actions separately from the recorded baseline tables.

| Source at `08e5c259d330b359d85a402a5364203a1fe3e827` | SHA-256 |
| --- | --- |
| `artifacts/probes/sizing/group-congruence/proposal-summary.json` | `d278317860abb065d3982d9f746574e52c5a554eef240d073ea65be04233d5c0` |
| `artifacts/probes/sizing/group-congruence/verification.zip` | `7d57cd54a0f7999ff10b385eac52dcf969067ef8c7b626b8fe5499da93ac269c` |

Both source repositories carry an MIT license with a rider naming OpenAI and
Anthropic and requiring Jeffrey Emanuel’s express prior written permission for
covered uses. The intake contains independently worded formulations and scoped
findings. Raw reports, traces and source archives remain private pending
authorization for the specific artifacts. External scientific review and
publication in the production ledger remain open.
