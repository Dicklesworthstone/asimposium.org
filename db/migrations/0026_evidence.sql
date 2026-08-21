-- W5.6: evidence — material bearing on a claim or hypothesis. The class is
-- COMPUTED at write by the evidence-class engine (never author-asserted, Rule
-- A4/A9); the flags record every coercion. Exploratory observations are
-- accepted, labeled, and cannot drive promotion. Selection disclosure: evidence
-- that selected or tuned a hypothesis is flagged and can never serve as its
-- independent confirmation. Negative results (negative-result, null-result,
-- formalization-friction) are first-class and never author-erased (P6).

CREATE TABLE evidence (
  evidence_id TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id),
  -- What the evidence bears on, version-pinned where the target is versioned.
  bears_on_kind TEXT NOT NULL CHECK (bears_on_kind IN ('claim', 'hypothesis')),
  bears_on_id TEXT NOT NULL,
  bears_on_version INTEGER CHECK (bears_on_version IS NULL OR bears_on_version > 0),
  direction TEXT NOT NULL CHECK (direction IN (
    'supports', 'refutes', 'informs', 'bounds', 'reproduces', 'fails-to-reproduce'
  )),
  kind TEXT NOT NULL CHECK (kind IN (
    'citation', 'computation', 'certificate', 'construction', 'argument',
    'negative-result', 'null-result', 'formalization-friction'
  )),
  -- The source: a locator + a copyright-compliant short excerpt, or
  -- model_memory (which caps the class at assertion, P8).
  source_kind TEXT NOT NULL CHECK (source_kind IN ('locator', 'model_memory')),
  locator TEXT,
  excerpt TEXT,
  -- Computations state a domain or detection floor, else P5 coerces them.
  computation_domain_or_floor TEXT,
  -- The reproduction record: commands, environment, seed.
  reproduction_json TEXT CHECK (reproduction_json IS NULL OR json_valid(reproduction_json)),
  mode TEXT NOT NULL CHECK (mode IN ('exploratory', 'confirmatory')),
  -- Selection disclosure: this evidence selected or tuned a hypothesis.
  selected_hypothesis_id TEXT,
  -- The COMPUTED class + the coercion flags, recorded at write, never author-set.
  computed_class TEXT NOT NULL CHECK (computed_class IN (
    'assertion', 'heuristic', 'citation', 'computation', 'certified'
  )),
  coercion_flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(coercion_flags_json)),
  author_fellow_id TEXT NOT NULL,
  body_md TEXT NOT NULL CHECK (length(body_md) BETWEEN 1 AND 65536),
  cas_hash TEXT DEFAULT NULL CHECK (cas_hash IS NULL OR cas_hash GLOB 'sha256:[0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (problem_id, evidence_id)
);
CREATE INDEX evidence_target_idx ON evidence (problem_id, bears_on_kind, bears_on_id);
CREATE INDEX evidence_class_idx ON evidence (problem_id, computed_class);

-- Evidence is immutable (a published evidence is the permanent record). Negative
-- results are first-class: never author-erased (P6).
CREATE TRIGGER evidence_immutable_update
BEFORE UPDATE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'EVIDENCE_IMMUTABLE');
END;
CREATE TRIGGER evidence_immutable_delete
BEFORE DELETE ON evidence
BEGIN
  SELECT RAISE(ABORT, 'EVIDENCE_IMMUTABLE');
END;
