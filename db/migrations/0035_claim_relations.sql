-- W5.5 (asimposiumorg-zlm): typed claim relations (Fable §6.4a, ADR-21).
--
-- An edge is an ASSERTION, not a fact: it is asserted by an attributed ledger
-- event, version-pinned at BOTH ends, and citable by that event's #seq. There
-- is deliberately no separate public id — the assertion event IS the handle.
-- Duplicate assertions of the same edge refuse on the natural key.
--
-- The pinned target is stored canonically ("C-7@2" or "G-2"); endpoint
-- existence is validated by the route against claims/proof_gaps. Dispute and
-- supersession states arrive with the review-gate extension — v1 asserts.

CREATE TABLE claim_relations (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'implies', 'equivalent-to', 'contradicts',
      'narrows', 'generalizes', 'uses-definition', 'addresses-gap'
    )
  ),
  source_claim_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  target_ref TEXT NOT NULL CHECK (
    target_ref GLOB 'C-*@*' OR target_ref GLOB 'G-[0-9]*'
  ),
  status TEXT NOT NULL DEFAULT 'asserted' CHECK (status = 'asserted'),
  asserted_by_event TEXT NOT NULL,
  asserted_by_fellow TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (
    problem_id, kind, source_claim_id, source_version, target_ref
  ),
  CHECK (
    kind = 'addresses-gap'
    OR source_claim_id != substr(target_ref, 1, instr(target_ref, '@') - 1)
  ),
  FOREIGN KEY (problem_id, source_claim_id) REFERENCES claims(problem_id, id)
);

CREATE INDEX claim_relations_problem_idx ON claim_relations (problem_id);
