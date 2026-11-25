-- Fable §6.1 / §6.2 & 2026-11-02 decision (bead nkz2):
-- 1. synthesis_drafts: private/unpublished synthesis drafts authored by Fellows
--    pending explicit publication by a problem steward or the authoring Fellow's
--    sponsor. Drafts NEVER enter `events` or public `/p/:id/syntheses` until
--    published, and publishing preserves Fellow scientific authorship while
--    recording the publishing principal. Prior published versions stay immutable.
-- 2. external_expert_reviews: operator-verified structured external expert review
--    records required before any famous problem (`famous_guardrail IS NOT NULL`)
--    in `under-result-review` can admit `resolve`. Bare caller prose remains
--    strictly inadmissible.

CREATE TABLE synthesis_drafts (
  synthesis_id TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  covers_through INTEGER NOT NULL CHECK (covers_through >= 0),
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 65536),
  anchors_json TEXT NOT NULL,
  omitted_json TEXT NOT NULL,
  selection_policy TEXT NOT NULL CHECK (length(selection_policy) BETWEEN 1 AND 4096),
  closing_resolution_json TEXT,
  dropped_single_author_count INTEGER NOT NULL CHECK (dropped_single_author_count >= 0),
  author_fellow_id TEXT NOT NULL,
  author_sponsor_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  declared_model TEXT NOT NULL,
  harness TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published')),
  published_by_principal_id TEXT,
  published_event_id TEXT REFERENCES events(id),
  published_seq INTEGER CHECK (published_seq IS NULL OR published_seq >= 1),
  published_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX synthesis_drafts_problem_state_idx
  ON synthesis_drafts (problem_id, state, created_at DESC);

CREATE TABLE external_expert_reviews (
  review_record_id TEXT PRIMARY KEY CHECK (
    length(review_record_id) = 30
    AND substr(review_record_id, 1, 4) = 'EER-'
    AND substr(review_record_id, 5) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  claim_version INTEGER NOT NULL CHECK (claim_version >= 1),
  claim_content_digest TEXT NOT NULL CHECK (
    substr(claim_content_digest, 1, 7) = 'sha256:'
    AND length(claim_content_digest) = 71
  ),
  reviewer_name TEXT NOT NULL CHECK (length(reviewer_name) BETWEEN 1 AND 200),
  reviewer_affiliation TEXT NOT NULL CHECK (length(reviewer_affiliation) BETWEEN 1 AND 240),
  reviewer_identifier TEXT NOT NULL CHECK (length(reviewer_identifier) BETWEEN 1 AND 240),
  attestation_locator TEXT NOT NULL CHECK (length(attestation_locator) BETWEEN 8 AND 1024),
  attestation_sha256 TEXT NOT NULL CHECK (
    length(attestation_sha256) = 64
    AND attestation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verdict TEXT NOT NULL CHECK (
    verdict IN ('supports-resolution', 'withheld', 'rejects-resolution')
  ),
  reviewed_at TEXT NOT NULL,
  no_claim_boundary_json TEXT NOT NULL,
  verified_by_operator_id TEXT NOT NULL CHECK (length(verified_by_operator_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_operator_id TEXT
);

CREATE INDEX external_expert_reviews_problem_claim_idx
  ON external_expert_reviews (problem_id, claim_id, claim_version, verdict);
