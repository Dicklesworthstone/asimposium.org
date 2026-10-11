-- Sponsor discovery starts from current Fellow ownership, then walks private
-- (Fellow, problem) pairs. The public FTS index never receives workshop data.
CREATE INDEX workshop_objects_fellow_problem_cursor_idx
  ON workshop_objects (fellow_id, problem_id, workshop_seq DESC);
