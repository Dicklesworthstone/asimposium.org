-- Fable §10.2 / §6.3 P11 / §9.2: KraterOutboxDrainer consumer projection tables.
-- STRICT PRIVACY INVARIANT (Rule A2 / Fable §10.3):
--   Every table below stores ONLY derived metadata from public ledger events
--   (`events` joined with public `problems.status <> 'private-draft'`).
--   Private `workshop_objects` and `private-draft` problems are NEVER indexed,
--   embedded, or referenced here.

CREATE TABLE public_claim_embeddings (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  claim_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  event_id TEXT NOT NULL REFERENCES events(id),
  payload_sha256 TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  model_version TEXT NOT NULL CHECK (length(model_version) BETWEEN 1 AND 64),
  dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 4096),
  vector_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, claim_id, version)
);

CREATE INDEX public_claim_embeddings_problem_idx
  ON public_claim_embeddings (problem_id, claim_id, version);

-- Advisory semantic near-duplicate pairs (P11 async companion).
-- Non-blocking discovery hint only; feeds `collapse-duplicate` move with
-- explicit model/version provenance, never mints mathematical equivalence.
CREATE TABLE public_duplicate_advisories (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  source_claim_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  matched_claim_id TEXT NOT NULL,
  matched_version INTEGER NOT NULL CHECK (matched_version >= 1),
  similarity REAL NOT NULL CHECK (similarity >= 0.0 AND similarity <= 1.0001),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 128),
  model_version TEXT NOT NULL CHECK (length(model_version) BETWEEN 1 AND 64),
  source_event_id TEXT NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL,
  CHECK (source_claim_id < matched_claim_id),
  PRIMARY KEY (problem_id, source_claim_id, source_version, matched_claim_id, matched_version)
);

CREATE INDEX public_duplicate_advisories_problem_idx
  ON public_duplicate_advisories (problem_id, similarity DESC);

-- Idempotent staleness markers for published syntheses when newer material
-- ledger events commit past `syntheses.covers_through`.
CREATE TABLE synthesis_staleness_markers (
  problem_id TEXT NOT NULL REFERENCES problems(id),
  synthesis_id TEXT NOT NULL,
  stale_since_seq INTEGER NOT NULL CHECK (stale_since_seq >= 1),
  stale_since_event_id TEXT NOT NULL REFERENCES events(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, synthesis_id)
);

-- Cursor-keyed share-card (OG image) invalidation watermarks per problem.
CREATE TABLE og_invalidation_markers (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id),
  last_invalidated_seq INTEGER NOT NULL CHECK (last_invalidated_seq >= 0),
  last_event_id TEXT NOT NULL REFERENCES events(id),
  updated_at TEXT NOT NULL
);

-- SSRF-safe async metadata/citation enrichment records (never alters L1 screening).
CREATE TABLE screening_enrichment_records (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  problem_id TEXT NOT NULL REFERENCES problems(id),
  object_kind TEXT NOT NULL,
  citation_count INTEGER NOT NULL CHECK (citation_count >= 0),
  locator_count INTEGER NOT NULL CHECK (locator_count >= 0),
  enriched_at TEXT NOT NULL
);
