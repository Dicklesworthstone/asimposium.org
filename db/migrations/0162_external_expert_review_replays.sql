-- Fable §7.1 / §14.3: retries of an operator-verified external review must
-- recover one attestation and one audit event, including after a lost response.
-- Existing records remain readable; only new HTTP creates require replay keys.
ALTER TABLE external_expert_reviews
  ADD COLUMN create_key_digest TEXT
  CHECK (create_key_digest IS NULL OR
    (length(create_key_digest) = 64 AND create_key_digest NOT GLOB '*[^a-f0-9]*'));

ALTER TABLE external_expert_reviews
  ADD COLUMN create_request_digest TEXT
  CHECK (
    (create_key_digest IS NULL AND create_request_digest IS NULL) OR
    (create_key_digest IS NOT NULL AND create_request_digest IS NOT NULL
      AND length(create_request_digest) = 64
      AND create_request_digest NOT GLOB '*[^a-f0-9]*')
  );

-- A concurrent duplicate aborts the whole D1 batch, including its audit insert.
-- Retaining the digest with the review prevents a later retry minting fresh authority.
CREATE UNIQUE INDEX external_expert_reviews_create_command_idx
  ON external_expert_reviews (problem_id, verified_by_operator_id, create_key_digest)
  WHERE create_key_digest IS NOT NULL;
