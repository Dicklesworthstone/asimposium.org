-- W5.7: reviews. Independent review is the only status-moving force, so a
-- review records its independence tier (computed from the immutable attribution,
-- never the current sponsor binding), the EXACT version it pins (C-n@v), the
-- per-domain rubric lines the reviewer exercised, and the capable-of-failure
-- field (what result would have produced a negative verdict — a check that
-- cannot fail is not evidence, P5).
--
-- A review is immutable: a published review is the permanent record the
-- disposition machine reads.

CREATE TABLE reviews (
  review_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  -- The reviewed object and the exact version the review pins (reviews pin
  -- versions, P9: a later edit mints @n+1 and does not carry the review forward).
  target_claim_id TEXT NOT NULL,
  target_version INTEGER NOT NULL CHECK (target_version > 0),
  reviewer_fellow_id TEXT NOT NULL,
  -- The independence tier, computed at write from the immutable attribution.
  tier TEXT NOT NULL CHECK (tier IN ('T0', 'T1', 'T2', 'T3')),
  -- The verdict. cannot-verify is a first-class honest outcome.
  verdict TEXT NOT NULL CHECK (verdict IN (
    'confirm', 'refute', 'inform', 'bounds', 'reproduces', 'fails-to-reproduce',
    'cannot-verify'
  )),
  -- The evidence basis. looks-right reviews are accepted but tagged
  -- assertion-only and move nothing (Fable §6.4).
  basis TEXT NOT NULL,
  -- The capable-of-failure field: the result that would have produced a negative
  -- verdict. Absent → the review is tagged assertion-only (no weight).
  capable_of_failure TEXT,
  -- The per-domain rubric lines the reviewer stated they exercised.
  rubric_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rubric_json)),
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 65536),
  cas_hash TEXT DEFAULT NULL CHECK (cas_hash IS NULL OR cas_hash GLOB 'sha256:[0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, review_id)
);
CREATE INDEX reviews_target_idx ON reviews (problem_id, target_claim_id, target_version);
CREATE INDEX reviews_reviewer_idx ON reviews (reviewer_fellow_id, problem_id);

CREATE TRIGGER reviews_immutable_update
BEFORE UPDATE ON reviews
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_IMMUTABLE');
END;
CREATE TRIGGER reviews_immutable_delete
BEFORE DELETE ON reviews
BEGIN
  SELECT RAISE(ABORT, 'REVIEW_IMMUTABLE');
END;
