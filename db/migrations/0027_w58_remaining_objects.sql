-- W5.8: the remaining first-class ledger objects that complete the scientific
-- record. Each is immutable (the published record is permanent); negative
-- knowledge is never author-erased (P6).

-- Dead ends: the preserved negative results — the problem's negative-evidence
-- ledger. A closed entry is a predicate waiting to fire, not a tombstone: the
-- structured retry_when trigger the Symposiarch evaluates on ledger events.
CREATE TABLE dead_ends (
  dead_end_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  approach TEXT NOT NULL CHECK (length(approach) BETWEEN 1 AND 2000),
  why_it_fails TEXT NOT NULL CHECK (length(why_it_fails) BETWEEN 1 AND 4000),
  retry_predicate TEXT NOT NULL CHECK (length(retry_predicate) BETWEEN 1 AND 1000),
  -- The structured trigger: {claim, reaches} | statement_revised | gap_closed.
  retry_when_json TEXT CHECK (retry_when_json IS NULL OR json_valid(retry_when_json)),
  author_fellow_id TEXT NOT NULL,
  cas_hash TEXT DEFAULT NULL CHECK (cas_hash IS NULL OR cas_hash GLOB 'sha256:[0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, dead_end_id)
);

-- Citations: the first-class literature objects (L-n) claims/evidence point at.
-- retrieved-or-model_memory stops cite-from-memory masquerading as retrieval.
CREATE TABLE citations (
  citation_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
  year INTEGER CHECK (year IS NULL OR (year >= 1500 AND year <= 2200)),
  locator_kind TEXT NOT NULL CHECK (locator_kind IN ('doi', 'arxiv', 'url', 'model_memory')),
  locator TEXT,
  retrieved_at TEXT,
  author_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, citation_id)
);

-- Proof gaps: the open gaps (G-n) in the record — what is not yet proven.
CREATE TABLE proof_gaps (
  gap_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  statement TEXT NOT NULL CHECK (length(statement) BETWEEN 1 AND 2000),
  -- What closing this gap would establish.
  closes_what TEXT NOT NULL CHECK (length(closes_what) BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by_evidence_id TEXT,
  author_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (problem_id, gap_id)
);

-- Conflicts: the normalized genuine disagreements (CF-n) between ledger objects.
CREATE TABLE conflicts (
  conflict_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  -- The two object references in genuine disagreement.
  object_a TEXT NOT NULL,
  object_b TEXT NOT NULL,
  -- The smallest real disagreement, stated precisely.
  crux TEXT NOT NULL CHECK (length(crux) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution TEXT,
  author_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (problem_id, conflict_id)
);

-- Syntheses: the periodic state-of-the-problem digest, generated from a frozen
-- cursor, anchored per P13 (every assertion references the ledger objects it
-- summarizes) with the mandatory omitted + selection policy.
CREATE TABLE syntheses (
  synthesis_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  covers_through INTEGER NOT NULL CHECK (covers_through >= 0),
  -- The digest body; assertions reference exact ledger object versions (P13).
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 65536),
  -- The anchoring: the ledger objects the synthesis's assertions reference.
  anchors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(anchors_json)),
  -- The mandatory omitted + selection policy, including the dropped
  -- single-author-finding count (minority signal is visible, not homogenized).
  omitted_json TEXT NOT NULL CHECK (json_valid(omitted_json)),
  dropped_single_author_count INTEGER NOT NULL DEFAULT 0 CHECK (dropped_single_author_count >= 0),
  -- The authoring principal + declared model (A3: attribution is total).
  authoring_principal TEXT NOT NULL,
  declared_model TEXT NOT NULL,
  cas_hash TEXT DEFAULT NULL CHECK (cas_hash IS NULL OR cas_hash GLOB 'sha256:[0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, synthesis_id)
);

-- Questions: precise asks, leasable so a help request becomes claimable work.
CREATE TABLE questions (
  question_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  target_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_refs_json)),
  blocking TEXT,
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 4000),
  author_fellow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'leased', 'resolved')),
  leased_by TEXT,
  resolved_by_object TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, question_id)
);

-- Retractions: an author strike-through that preserves history (the retracted
-- object stays; the retraction updates calibration without deleting).
CREATE TABLE retractions (
  retraction_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  -- The retracted object reference (claim/version, evidence, etc.).
  target_object TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  author_fellow_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, retraction_id)
);

-- Every W5.8 object is immutable once written — the published record is the
-- permanent scientific record, and negative knowledge is never author-erased.
CREATE TRIGGER dead_ends_immutable_delete BEFORE DELETE ON dead_ends BEGIN SELECT RAISE(ABORT, 'DEAD_END_IMMUTABLE'); END;
CREATE TRIGGER citations_immutable_delete BEFORE DELETE ON citations BEGIN SELECT RAISE(ABORT, 'CITATION_IMMUTABLE'); END;
CREATE TRIGGER proof_gaps_immutable_delete BEFORE DELETE ON proof_gaps BEGIN SELECT RAISE(ABORT, 'PROOF_GAP_IMMUTABLE'); END;
CREATE TRIGGER conflicts_immutable_delete BEFORE DELETE ON conflicts BEGIN SELECT RAISE(ABORT, 'CONFLICT_IMMUTABLE'); END;
CREATE TRIGGER syntheses_immutable_delete BEFORE DELETE ON syntheses BEGIN SELECT RAISE(ABORT, 'SYNTHESIS_IMMUTABLE'); END;
CREATE TRIGGER questions_immutable_delete BEFORE DELETE ON questions BEGIN SELECT RAISE(ABORT, 'QUESTION_IMMUTABLE'); END;
CREATE TRIGGER retractions_immutable_delete BEFORE DELETE ON retractions BEGIN SELECT RAISE(ABORT, 'RETRACTION_IMMUTABLE'); END;
