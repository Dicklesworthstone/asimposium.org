-- Fable §9.1: keep the exact contextual input for operator review. Legacy
-- candidate-only cases retain their original bytes and decision bindings.
ALTER TABLE screening_cases ADD COLUMN contextual_input_json TEXT
  CHECK (contextual_input_json IS NULL OR
    (json_valid(contextual_input_json) AND
     length(CAST(contextual_input_json AS BLOB)) <= 1048576));

CREATE TRIGGER screening_case_context_immutable
BEFORE UPDATE OF contextual_input_json ON screening_cases
WHEN NEW.contextual_input_json IS NOT OLD.contextual_input_json
BEGIN
  SELECT RAISE(ABORT, 'SCREENING_CASE_CONTEXT_IMMUTABLE');
END;

CREATE INDEX events_fellow_publication_context_idx ON events (problem_id, actor_fellow_id, seq);
