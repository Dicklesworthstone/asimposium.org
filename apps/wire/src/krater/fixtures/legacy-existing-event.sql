PRAGMA foreign_keys = ON;

INSERT INTO problems (id, public_seq, created_at, updated_at)
VALUES ('P-upgrade-existing', 1, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z');

INSERT INTO claims (id, problem_id, statement, payload_sha256, source_seq, created_at)
VALUES (
  'C-upgrade-existing-001',
  'P-upgrade-existing',
  'Legacy retained claim.',
  '4478d240c1c16feba4147299312ababf59e5b21738913577e967754f8cac2050',
  1,
  '2026-08-14T00:00:00.000Z'
);

INSERT INTO claim_projections
  (claim_id, problem_id, source_seq, projection_version, build_digest, stale, updated_at)
VALUES (
  'C-upgrade-existing-001',
  'P-upgrade-existing',
  1,
  1,
  'b6d6f48fd9aa93bd4d0b3338a2dfc3b703d6bc3a2277858d090d3723c6078561',
  0,
  '2026-08-14T00:00:00.000Z'
);

INSERT INTO events
  (id, problem_id, seq, type, object_kind, object_id, object_version, payload_sha256, created_at)
VALUES (
  'E-upgrade-existing-001',
  'P-upgrade-existing',
  1,
  'claim.created',
  'claim',
  'C-upgrade-existing-001',
  1,
  '4478d240c1c16feba4147299312ababf59e5b21738913577e967754f8cac2050',
  '2026-08-14T00:00:00.000Z'
);

INSERT INTO event_content (event_id, payload_sha256, payload_json)
VALUES (
  'E-upgrade-existing-001',
  '4478d240c1c16feba4147299312ababf59e5b21738913577e967754f8cac2050',
  '{"claim_id":"C-upgrade-existing-001","kind":"claim","statement":"Legacy retained claim."}'
);

INSERT INTO idempotency (problem_id, idempotency_key, request_digest, event_id, event_seq, created_at)
VALUES (
  'P-upgrade-existing',
  'IK-upgrade-existing-001',
  '7bc2baafc06d44d61a497cc80627542e17d7f428b0e06e204093a3231b39fc44',
  'E-upgrade-existing-001',
  1,
  '2026-08-14T00:00:00.000Z'
);

INSERT INTO outbox (event_id, problem_id, kind, dedupe_key, payload_sha256, created_at)
VALUES (
  'E-upgrade-existing-001',
  'P-upgrade-existing',
  'search.index',
  'search.index:E-upgrade-existing-001',
  '4478d240c1c16feba4147299312ababf59e5b21738913577e967754f8cac2050',
  '2026-08-14T00:00:00.000Z'
);

INSERT INTO public_claim_fts (claim_id, problem_id, statement)
VALUES ('C-upgrade-existing-001', 'P-upgrade-existing', 'Legacy retained claim.');
