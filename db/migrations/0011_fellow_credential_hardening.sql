PRAGMA foreign_keys = ON;

-- W3.7 forward hardening (asimposiumorg-9p4).
--
-- 0006 copied the original credential table before its new authority trigger
-- existed. Refuse to install stronger lifecycle behavior over any legacy row
-- that does not exactly match the durable approval grant and identity. The
-- Worker independently repeats this binding check on every authentication so
-- a migration that has not run yet cannot turn a bad legacy row into usable
-- authority.
CREATE TABLE fellow_credential_migration_guard (
  valid INTEGER NOT NULL
    CONSTRAINT fellow_credential_hardening_guard CHECK (valid = 1)
);
INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM fellow_tokens credential
     WHERE NOT EXISTS (
       SELECT 1
         FROM enrollment_fellows fellow
         JOIN enrollment_grants grant_row
           ON grant_row.fellow_id = fellow.fellow_id
          AND grant_row.sponsor_id = fellow.sponsor_id
         JOIN enrollment_proposals grant_proposal
           ON grant_proposal.proposal_id = grant_row.proposal_id
         JOIN enrollment_records grant_enrollment
           ON grant_enrollment.enrollment_id = grant_proposal.enrollment_id
        WHERE fellow.fellow_id = credential.fellow_id
          AND fellow.sponsor_id = credential.sponsor_id
          AND grant_proposal.fellow_id = fellow.fellow_id
          AND grant_enrollment.sponsor_id = fellow.sponsor_id
          AND fellow.name COLLATE BINARY = grant_proposal.name COLLATE BINARY
          AND fellow.model = grant_proposal.model
          AND fellow.harness = grant_proposal.harness
          AND grant_proposal.status IN ('approved', 'reduced')
          AND grant_proposal.granted_scopes_json = grant_row.granted_scopes_json
          AND grant_proposal.granted_resources_json = grant_row.granted_resources_json
          AND grant_row.granted_scopes_json = credential.granted_scopes_json
          AND grant_row.granted_resources_json = credential.granted_resources_json
          AND (
            (credential.proposal_id IS NULL
              AND credential.credential_origin = 'harness-migration')
            OR (
              credential.proposal_id = grant_proposal.proposal_id
              AND credential.credential_origin = 'enrollment'
              AND grant_proposal.token_hash = credential.token_hash
              AND grant_proposal.token_issued_at = credential.issued_at
            )
          )
     )
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_grants grant_row
     WHERE NOT EXISTS (
       SELECT 1
         FROM enrollment_proposals proposal
         JOIN enrollment_records enrollment
           ON enrollment.enrollment_id = proposal.enrollment_id
         JOIN enrollment_fellows fellow
           ON fellow.fellow_id = grant_row.fellow_id
          AND fellow.sponsor_id = grant_row.sponsor_id
        WHERE proposal.proposal_id = grant_row.proposal_id
          AND proposal.fellow_id = grant_row.fellow_id
          AND enrollment.sponsor_id = grant_row.sponsor_id
          AND fellow.name COLLATE BINARY = proposal.name COLLATE BINARY
          AND fellow.model = proposal.model
          AND fellow.harness = proposal.harness
          AND (
            (
              proposal.status IN ('approved', 'reduced')
              AND (
                (proposal.token_hash IS NULL AND proposal.token_issued_at IS NULL)
                OR (
                  proposal.token_hash IS NOT NULL
                  AND proposal.token_issued_at IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                      FROM fellow_tokens issued_credential
                     WHERE issued_credential.proposal_id = proposal.proposal_id
                       AND issued_credential.fellow_id = grant_row.fellow_id
                       AND issued_credential.sponsor_id = grant_row.sponsor_id
                       AND issued_credential.token_hash = proposal.token_hash
                       AND issued_credential.issued_at = proposal.token_issued_at
                       AND issued_credential.credential_origin = 'enrollment'
                  )
                )
              )
            )
            OR (
              proposal.status = 'expired'
              AND proposal.token_hash IS NULL
              AND proposal.token_issued_at IS NULL
              AND json_type(
                grant_row.granted_resources_json,
                '$.fellowGrantExpiresAt'
              ) = 'integer'
            )
          )
          AND proposal.granted_scopes_json = grant_row.granted_scopes_json
          AND proposal.granted_resources_json = grant_row.granted_resources_json
     )
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_grants grant_row
     WHERE json_type(grant_row.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
       AND (
         json_type(grant_row.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
         OR json_extract(grant_row.granted_resources_json, '$.fellowGrantExpiresAt')
              <= grant_row.granted_at
       )
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_grants grant_row
     WHERE json_type(grant_row.granted_scopes_json) <> 'array'
        OR json_array_length(grant_row.granted_scopes_json) NOT BETWEEN 1 AND 4
        OR EXISTS (
          SELECT 1
            FROM json_each(grant_row.granted_scopes_json) scope
           WHERE scope.type <> 'text'
              OR scope.value NOT IN (
                'promote', 'review', 'propose-problems', 'upload-artifacts'
              )
        )
        OR json_type(grant_row.granted_resources_json) <> 'object'
        OR EXISTS (
          SELECT 1
            FROM json_each(grant_row.granted_resources_json) resource
           WHERE resource.key NOT IN (
             'problemBinding', 'firstDirective', 'eventBudget',
             'artifactBudgetBytes', 'fellowGrantExpiresAt'
           )
        )
        OR (
          SELECT COUNT(*) FROM json_each(grant_row.granted_resources_json)
        ) <> (
          SELECT COUNT(DISTINCT resource.key)
            FROM json_each(grant_row.granted_resources_json) resource
        )
        OR (
          json_type(grant_row.granted_resources_json, '$.problemBinding') IS NOT NULL
          AND (
            json_type(grant_row.granted_resources_json, '$.problemBinding') <> 'text'
            OR length(json_extract(
              grant_row.granted_resources_json,
              '$.problemBinding'
            )) NOT BETWEEN 6 AND 28
            OR substr(json_extract(
              grant_row.granted_resources_json,
              '$.problemBinding'
            ), 1, 2) <> 'P-'
            OR substr(json_extract(
              grant_row.granted_resources_json,
              '$.problemBinding'
            ), 3) GLOB '*[^A-Z0-9]*'
          )
        )
        OR (
          json_type(grant_row.granted_resources_json, '$.firstDirective') IS NOT NULL
          AND (
            json_type(grant_row.granted_resources_json, '$.firstDirective') <> 'text'
            OR length(trim(
              json_extract(grant_row.granted_resources_json, '$.firstDirective'),
              char(9) || char(10) || char(11) || char(12) || char(13)
                || char(32) || char(160) || char(5760)
                || char(8192) || char(8193) || char(8194) || char(8195)
                || char(8196) || char(8197) || char(8198) || char(8199)
                || char(8200) || char(8201) || char(8202)
                || char(8232) || char(8233) || char(8239)
                || char(8287) || char(12288) || char(65279)
            )) = 0
            OR (
              WITH RECURSIVE directive_units(rest, units) AS (
                SELECT trim(
                  json_extract(grant_row.granted_resources_json, '$.firstDirective'),
                  char(9) || char(10) || char(11) || char(12) || char(13)
                    || char(32) || char(160) || char(5760)
                    || char(8192) || char(8193) || char(8194) || char(8195)
                    || char(8196) || char(8197) || char(8198) || char(8199)
                    || char(8200) || char(8201) || char(8202)
                    || char(8232) || char(8233) || char(8239)
                    || char(8287) || char(12288) || char(65279)
                ), 0
                UNION ALL
                SELECT substr(rest, 2),
                       units + CASE
                         WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                         ELSE 1
                       END
                  FROM directive_units
                 WHERE rest <> ''
              )
              SELECT units FROM directive_units WHERE rest = ''
            ) > 2000
          )
        )
        OR (
          json_type(grant_row.granted_resources_json, '$.eventBudget') IS NOT NULL
          AND (
            json_type(grant_row.granted_resources_json, '$.eventBudget') <> 'integer'
            OR json_extract(grant_row.granted_resources_json, '$.eventBudget') NOT BETWEEN 1 AND 10000
          )
        )
        OR (
          json_type(grant_row.granted_resources_json, '$.artifactBudgetBytes') IS NOT NULL
          AND (
            json_type(grant_row.granted_resources_json, '$.artifactBudgetBytes') <> 'integer'
            OR json_extract(
              grant_row.granted_resources_json,
              '$.artifactBudgetBytes'
            ) NOT BETWEEN 0 AND 1073741824
          )
        )
        OR (
          json_type(grant_row.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
          AND (
            json_type(grant_row.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
            OR json_extract(
              grant_row.granted_resources_json,
              '$.fellowGrantExpiresAt'
            ) NOT BETWEEN 1 AND 9007199254740991
          )
        )
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_proposals proposal
     WHERE proposal.status IN ('approved', 'reduced')
       AND NOT EXISTS (
         SELECT 1
           FROM enrollment_records enrollment
           JOIN enrollment_fellows fellow
             ON fellow.fellow_id = proposal.fellow_id
           JOIN enrollment_grants grant_row
             ON grant_row.proposal_id = proposal.proposal_id
            AND grant_row.fellow_id = fellow.fellow_id
            AND grant_row.sponsor_id = fellow.sponsor_id
          WHERE enrollment.enrollment_id = proposal.enrollment_id
            AND enrollment.sponsor_id = fellow.sponsor_id
            AND fellow.name COLLATE BINARY = proposal.name COLLATE BINARY
            AND fellow.model = proposal.model
            AND fellow.harness = proposal.harness
            AND proposal.granted_scopes_json = grant_row.granted_scopes_json
            AND proposal.granted_resources_json = grant_row.granted_resources_json
        )
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_fellows fellow
     WHERE fellow.fellow_id IS NULL
        OR (
          WITH RECURSIVE fellow_id_units(rest, units) AS (
            SELECT fellow.fellow_id, 0
            UNION ALL
            SELECT substr(rest, 2),
                   units + CASE
                     WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                     ELSE 1
                   END
              FROM fellow_id_units
             WHERE rest <> ''
          )
          SELECT units FROM fellow_id_units WHERE rest = ''
        ) NOT BETWEEN 1 AND 80
        OR (
          WITH RECURSIVE sponsor_id_units(rest, units) AS (
            SELECT fellow.sponsor_id, 0
            UNION ALL
            SELECT substr(rest, 2),
                   units + CASE
                     WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                     ELSE 1
                   END
              FROM sponsor_id_units
             WHERE rest <> ''
          )
          SELECT units FROM sponsor_id_units WHERE rest = ''
        ) NOT BETWEEN 1 AND 160
        OR length(fellow.name) NOT BETWEEN 3 AND 32
        OR fellow.name NOT GLOB '[a-z]*'
        OR fellow.name GLOB '*[^a-z0-9-]*'
        OR length(trim(
          fellow.model,
          char(9) || char(10) || char(11) || char(12) || char(13)
            || char(32) || char(160) || char(5760)
            || char(8192) || char(8193) || char(8194) || char(8195)
            || char(8196) || char(8197) || char(8198) || char(8199)
            || char(8200) || char(8201) || char(8202)
            || char(8232) || char(8233) || char(8239)
            || char(8287) || char(12288) || char(65279)
        )) = 0
        OR (
          WITH RECURSIVE model_units(rest, units) AS (
            SELECT fellow.model, 0
            UNION ALL
            SELECT substr(rest, 2),
                   units + CASE
                     WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                     ELSE 1
                   END
              FROM model_units
             WHERE rest <> ''
          )
          SELECT units FROM model_units WHERE rest = ''
        ) > 160
        OR length(trim(
          fellow.harness,
          char(9) || char(10) || char(11) || char(12) || char(13)
            || char(32) || char(160) || char(5760)
            || char(8192) || char(8193) || char(8194) || char(8195)
            || char(8196) || char(8197) || char(8198) || char(8199)
            || char(8200) || char(8201) || char(8202)
            || char(8232) || char(8233) || char(8239)
            || char(8287) || char(12288) || char(65279)
        )) = 0
        OR (
          WITH RECURSIVE harness_units(rest, units) AS (
            SELECT fellow.harness, 0
            UNION ALL
            SELECT substr(rest, 2),
                   units + CASE
                     WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                     ELSE 1
                   END
              FROM harness_units
             WHERE rest <> ''
          )
          SELECT units FROM harness_units WHERE rest = ''
        ) > 160
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_grants grant_row
     WHERE typeof(grant_row.granted_at) <> 'integer'
        OR grant_row.granted_at NOT BETWEEN 1 AND 9007199254740991
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM fellow_tokens credential
     WHERE credential.credential_id IS NULL
        OR (
         WITH RECURSIVE credential_id_units(rest, units) AS (
           SELECT credential.credential_id, 0
           UNION ALL
           SELECT substr(rest, 2),
                  units + CASE
                    WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                    ELSE 1
                  END
             FROM credential_id_units
            WHERE rest <> ''
         )
         SELECT units FROM credential_id_units WHERE rest = ''
       ) NOT BETWEEN 1 AND 160
        OR typeof(credential.issued_at) <> 'integer'
        OR credential.issued_at NOT BETWEEN 0 AND 9007199254740991
        OR typeof(credential.expires_at) <> 'integer'
        OR credential.expires_at NOT BETWEEN 1 AND 9007199254740991
        OR (
          credential.last_used_at IS NOT NULL
          AND (
            typeof(credential.last_used_at) <> 'integer'
            OR credential.last_used_at NOT BETWEEN 0 AND 9007199254740991
          )
        )
        OR (
          credential.revoked_at IS NOT NULL
          AND (
            typeof(credential.revoked_at) <> 'integer'
            OR credential.revoked_at NOT BETWEEN 0 AND 9007199254740991
          )
        )
        OR (
          json_type(credential.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
          AND (
            json_type(credential.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
            OR json_extract(credential.granted_resources_json, '$.fellowGrantExpiresAt') <= 0
            OR json_extract(credential.granted_resources_json, '$.fellowGrantExpiresAt')
                 <= credential.issued_at
          )
        )
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM fellow_tokens candidate
     WHERE candidate.revoked_at IS NULL
       AND candidate.issued_at > COALESCE((
         SELECT panic_at
           FROM enrollment_sponsor_security
          WHERE sponsor_id = candidate.sponsor_id
       ), -1)
       AND (
         SELECT COUNT(*)
           FROM fellow_tokens concurrent
          WHERE concurrent.fellow_id = candidate.fellow_id
            AND concurrent.revoked_at IS NULL
            AND concurrent.issued_at <= candidate.issued_at
            AND concurrent.expires_at > candidate.issued_at
            AND (
              json_type(
                concurrent.granted_resources_json,
                '$.fellowGrantExpiresAt'
              ) IS NULL
              OR json_extract(
                concurrent.granted_resources_json,
                '$.fellowGrantExpiresAt'
              ) > candidate.issued_at
            )
            AND concurrent.issued_at > COALESCE((
              SELECT panic_at
                FROM enrollment_sponsor_security
               WHERE sponsor_id = concurrent.sponsor_id
            ), -1)
       ) > 3
  );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_fellows fellow
     WHERE fellow.status = 'compromised'
       AND EXISTS (
         SELECT 1
           FROM fellow_tokens credential
          WHERE credential.fellow_id = fellow.fellow_id
            AND credential.revoked_at IS NULL
       )
  );
DROP TABLE fellow_credential_migration_guard;

-- The durable grant must be the exact approval result, and every credential
-- must in turn copy that exact grant. These inserts run after the proposal
-- state change inside the same D1 batch, so there is no permissive bootstrap
-- interval to preserve.
CREATE TRIGGER enrollment_fellows_identity_schema_insert
BEFORE INSERT ON enrollment_fellows
WHEN NEW.fellow_id IS NULL
  OR (
    WITH RECURSIVE fellow_id_units(rest, units) AS (
      SELECT NEW.fellow_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM fellow_id_units
       WHERE rest <> ''
    )
    SELECT units FROM fellow_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 80
  OR (
    WITH RECURSIVE sponsor_id_units(rest, units) AS (
      SELECT NEW.sponsor_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM sponsor_id_units
       WHERE rest <> ''
    )
    SELECT units FROM sponsor_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 160
  OR length(NEW.name) NOT BETWEEN 3 AND 32
  OR NEW.name NOT GLOB '[a-z]*'
  OR NEW.name GLOB '*[^a-z0-9-]*'
  OR length(trim(
    NEW.model,
    char(9) || char(10) || char(11) || char(12) || char(13)
      || char(32) || char(160) || char(5760)
      || char(8192) || char(8193) || char(8194) || char(8195)
      || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202)
      || char(8232) || char(8233) || char(8239)
      || char(8287) || char(12288) || char(65279)
  )) = 0
  OR (
    WITH RECURSIVE model_units(rest, units) AS (
      SELECT NEW.model, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM model_units
       WHERE rest <> ''
    )
    SELECT units FROM model_units WHERE rest = ''
  ) > 160
  OR length(trim(
    NEW.harness,
    char(9) || char(10) || char(11) || char(12) || char(13)
      || char(32) || char(160) || char(5760)
      || char(8192) || char(8193) || char(8194) || char(8195)
      || char(8196) || char(8197) || char(8198) || char(8199)
      || char(8200) || char(8201) || char(8202)
      || char(8232) || char(8233) || char(8239)
      || char(8287) || char(12288) || char(65279)
  )) = 0
  OR (
    WITH RECURSIVE harness_units(rest, units) AS (
      SELECT NEW.harness, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM harness_units
       WHERE rest <> ''
    )
    SELECT units FROM harness_units WHERE rest = ''
  ) > 160
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity schema invalid');
END;

-- Fellow attribution is durable identity. Lifecycle posture has its own
-- transition machine below; no status update may rewrite who the Fellow was.
CREATE TRIGGER enrollment_fellows_identity_immutable
BEFORE UPDATE OF fellow_id, sponsor_id, name, model, harness, created_at
ON enrollment_fellows
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity is immutable');
END;

CREATE TRIGGER enrollment_grants_evidence_schema_insert
BEFORE INSERT ON enrollment_grants
WHEN typeof(NEW.granted_at) <> 'integer'
  OR NEW.granted_at NOT BETWEEN 1 AND 9007199254740991
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant evidence schema invalid');
END;

CREATE TRIGGER enrollment_grants_authority_schema_insert
BEFORE INSERT ON enrollment_grants
WHEN json_type(NEW.granted_scopes_json) <> 'array'
  OR json_array_length(NEW.granted_scopes_json) NOT BETWEEN 1 AND 4
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.granted_scopes_json) scope
     WHERE scope.type <> 'text'
        OR scope.value NOT IN (
          'promote', 'review', 'propose-problems', 'upload-artifacts'
        )
  )
  OR json_type(NEW.granted_resources_json) <> 'object'
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.granted_resources_json) resource
     WHERE resource.key NOT IN (
       'problemBinding', 'firstDirective', 'eventBudget',
       'artifactBudgetBytes', 'fellowGrantExpiresAt'
     )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.granted_resources_json)
  ) <> (
    SELECT COUNT(DISTINCT resource.key)
      FROM json_each(NEW.granted_resources_json) resource
  )
  OR (
    json_type(NEW.granted_resources_json, '$.problemBinding') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.problemBinding') <> 'text'
      OR length(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      )) NOT BETWEEN 6 AND 28
      OR substr(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      ), 1, 2) <> 'P-'
      OR substr(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      ), 3) GLOB '*[^A-Z0-9]*'
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.firstDirective') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.firstDirective') <> 'text'
      OR length(trim(
        json_extract(NEW.granted_resources_json, '$.firstDirective'),
        char(9) || char(10) || char(11) || char(12) || char(13)
          || char(32) || char(160) || char(5760)
          || char(8192) || char(8193) || char(8194) || char(8195)
          || char(8196) || char(8197) || char(8198) || char(8199)
          || char(8200) || char(8201) || char(8202)
          || char(8232) || char(8233) || char(8239)
          || char(8287) || char(12288) || char(65279)
      )) = 0
      OR (
        WITH RECURSIVE directive_units(rest, units) AS (
          SELECT trim(
            json_extract(NEW.granted_resources_json, '$.firstDirective'),
            char(9) || char(10) || char(11) || char(12) || char(13)
              || char(32) || char(160) || char(5760)
              || char(8192) || char(8193) || char(8194) || char(8195)
              || char(8196) || char(8197) || char(8198) || char(8199)
              || char(8200) || char(8201) || char(8202)
              || char(8232) || char(8233) || char(8239)
              || char(8287) || char(12288) || char(65279)
          ), 0
          UNION ALL
          SELECT substr(rest, 2),
                 units + CASE
                   WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                   ELSE 1
                 END
            FROM directive_units
           WHERE rest <> ''
        )
        SELECT units FROM directive_units WHERE rest = ''
      ) > 2000
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.eventBudget') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.eventBudget') <> 'integer'
      OR json_extract(NEW.granted_resources_json, '$.eventBudget') NOT BETWEEN 1 AND 10000
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.artifactBudgetBytes') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.artifactBudgetBytes') <> 'integer'
      OR json_extract(
        NEW.granted_resources_json,
        '$.artifactBudgetBytes'
      ) NOT BETWEEN 0 AND 1073741824
    )
  )
  OR (
    json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
    AND (
      json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
      OR json_extract(
        NEW.granted_resources_json,
        '$.fellowGrantExpiresAt'
      ) NOT BETWEEN 1 AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant authority schema invalid');
END;

CREATE TRIGGER enrollment_grants_approval_binding_insert
BEFORE INSERT ON enrollment_grants
WHEN NOT EXISTS (
  SELECT 1 FROM enrollment_grants
   WHERE proposal_id = NEW.proposal_id OR fellow_id = NEW.fellow_id
)
 AND NOT EXISTS (
  SELECT 1
    FROM enrollment_proposals proposal
    JOIN enrollment_records enrollment
      ON enrollment.enrollment_id = proposal.enrollment_id
    JOIN enrollment_fellows fellow
      ON fellow.fellow_id = NEW.fellow_id
     AND fellow.sponsor_id = NEW.sponsor_id
   WHERE proposal.proposal_id = NEW.proposal_id
     AND proposal.fellow_id = NEW.fellow_id
     AND enrollment.sponsor_id = NEW.sponsor_id
     AND fellow.name COLLATE BINARY = proposal.name COLLATE BINARY
     AND fellow.model = proposal.model
     AND fellow.harness = proposal.harness
     AND proposal.status IN ('approved', 'reduced')
     AND proposal.token_hash IS NULL
     AND proposal.token_issued_at IS NULL
     AND proposal.granted_scopes_json = NEW.granted_scopes_json
     AND proposal.granted_resources_json = NEW.granted_resources_json
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant approval binding mismatch');
END;

CREATE TRIGGER enrollment_credentials_durable_authority_insert
BEFORE INSERT ON fellow_tokens
WHEN NOT EXISTS (
  SELECT 1 FROM fellow_tokens existing
   WHERE existing.credential_id = NEW.credential_id
      OR existing.token_hash = NEW.token_hash
      OR (NEW.proposal_id IS NOT NULL AND existing.proposal_id = NEW.proposal_id)
)
 AND NOT EXISTS (
  SELECT 1
    FROM enrollment_fellows fellow
    JOIN enrollment_grants grant_row
      ON grant_row.fellow_id = fellow.fellow_id
     AND grant_row.sponsor_id = fellow.sponsor_id
    JOIN enrollment_proposals grant_proposal
      ON grant_proposal.proposal_id = grant_row.proposal_id
    JOIN enrollment_records grant_enrollment
      ON grant_enrollment.enrollment_id = grant_proposal.enrollment_id
   WHERE fellow.fellow_id = NEW.fellow_id
     AND fellow.sponsor_id = NEW.sponsor_id
     AND grant_proposal.fellow_id = fellow.fellow_id
     AND grant_enrollment.sponsor_id = fellow.sponsor_id
     AND fellow.name COLLATE BINARY = grant_proposal.name COLLATE BINARY
     AND fellow.model = grant_proposal.model
     AND fellow.harness = grant_proposal.harness
     AND grant_proposal.status IN ('approved', 'reduced')
     AND grant_proposal.granted_scopes_json = grant_row.granted_scopes_json
     AND grant_proposal.granted_resources_json = grant_row.granted_resources_json
     AND grant_row.granted_scopes_json = NEW.granted_scopes_json
     AND grant_row.granted_resources_json = NEW.granted_resources_json
     AND (
       (NEW.proposal_id IS NULL AND NEW.credential_origin = 'harness-migration')
       OR (
         NEW.proposal_id = grant_proposal.proposal_id
         AND NEW.credential_origin = 'enrollment'
         AND grant_proposal.token_hash = NEW.token_hash
         AND grant_proposal.token_issued_at = NEW.issued_at
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'credential durable authority mismatch');
END;

CREATE TRIGGER enrollment_credentials_output_schema_insert
BEFORE INSERT ON fellow_tokens
WHEN NEW.credential_id IS NULL
  OR (
    WITH RECURSIVE credential_id_units(rest, units) AS (
      SELECT NEW.credential_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM credential_id_units
       WHERE rest <> ''
    )
    SELECT units FROM credential_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 160
  OR typeof(NEW.issued_at) <> 'integer'
  OR NEW.issued_at NOT BETWEEN 0 AND 9007199254740991
  OR typeof(NEW.expires_at) <> 'integer'
  OR NEW.expires_at NOT BETWEEN 1 AND 9007199254740991
  OR (
    NEW.last_used_at IS NOT NULL
    AND (
      typeof(NEW.last_used_at) <> 'integer'
      OR NEW.last_used_at NOT BETWEEN 0 AND 9007199254740991
    )
  )
  OR (
    NEW.revoked_at IS NOT NULL
    AND (
      typeof(NEW.revoked_at) <> 'integer'
      OR NEW.revoked_at NOT BETWEEN 0 AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'credential output schema invalid');
END;

-- JSON syntax alone does not make an expiry usable authority. Keep malformed
-- and already-expired expiry values out of all future credential rows; the
-- Worker still validates the complete contract before recording last-used.
CREATE TRIGGER enrollment_grants_resource_expiry_insert
BEFORE INSERT ON enrollment_grants
WHEN json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
 AND (
   json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
   OR json_extract(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <= NEW.granted_at
 )
BEGIN
  SELECT RAISE(ABORT, 'fellow grant expiry invalid');
END;

CREATE TRIGGER enrollment_credentials_resource_expiry_insert
BEFORE INSERT ON fellow_tokens
WHEN json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
 AND (
   json_type(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
   OR json_extract(NEW.granted_resources_json, '$.fellowGrantExpiresAt') <= NEW.issued_at
 )
BEGIN
  SELECT RAISE(ABORT, 'credential Fellow grant is not live');
END;

CREATE TRIGGER enrollment_credentials_terminal_fellow_insert
BEFORE INSERT ON fellow_tokens
WHEN NEW.revoked_at IS NULL
 AND EXISTS (
   SELECT 1
     FROM enrollment_fellows fellow
    WHERE fellow.fellow_id = NEW.fellow_id
      AND fellow.status IN ('revoked', 'archived', 'compromised')
 )
BEGIN
  SELECT RAISE(ABORT, 'terminal Fellow cannot receive live credential');
END;

-- Issue times are audit facts, not caller-selected backfill slots. Once a
-- Fellow has a newer credential, an older insert is refused. This closes the
-- temporal cap bypass in 0006: with issuance monotonic, every existing token
-- that could overlap a new token has already started, so the cap check at the
-- new issue instant is complete.
CREATE TRIGGER enrollment_credentials_issuance_monotonic
BEFORE INSERT ON fellow_tokens
WHEN EXISTS (
  SELECT 1
    FROM fellow_tokens existing
   WHERE existing.fellow_id = NEW.fellow_id
     AND existing.issued_at > NEW.issued_at
)
BEGIN
  SELECT RAISE(ABORT, 'credential issuance cannot move backward');
END;

DROP TRIGGER enrollment_credentials_active_cap;
CREATE TRIGGER enrollment_credentials_active_cap
BEFORE INSERT ON fellow_tokens
WHEN NEW.revoked_at IS NULL
  AND NEW.expires_at > NEW.issued_at
  AND NEW.issued_at > COALESCE((
    SELECT panic_at FROM enrollment_sponsor_security WHERE sponsor_id = NEW.sponsor_id
  ), -1)
  AND (
    SELECT COUNT(*)
      FROM fellow_tokens AS existing
      LEFT JOIN enrollment_sponsor_security AS security
        ON security.sponsor_id = existing.sponsor_id
     WHERE existing.fellow_id = NEW.fellow_id
       AND existing.revoked_at IS NULL
       AND existing.issued_at <= NEW.issued_at
       AND existing.expires_at > NEW.issued_at
       AND (
         json_type(existing.granted_resources_json, '$.fellowGrantExpiresAt') IS NULL
         OR json_extract(existing.granted_resources_json, '$.fellowGrantExpiresAt') > NEW.issued_at
       )
       AND existing.issued_at > COALESCE(security.panic_at, -1)
  ) >= 3
BEGIN
  SELECT RAISE(ABORT, 'active credential cap reached');
END;

-- The Fable lifecycle is pending -> active <-> paused -> revoked -> archived,
-- with suspicious_review as a reversible active-review posture. Revoked,
-- compromised and archived authority cannot be resurrected. A compromise is
-- stronger than an authentication-status check: every token family must have
-- its monotonic revocation marker before the state transition commits.
CREATE TRIGGER enrollment_fellows_status_transition
BEFORE UPDATE OF status ON enrollment_fellows
WHEN NEW.status IS NOT OLD.status
 AND NOT (
   (OLD.status = 'pending' AND NEW.status = 'active')
   OR (OLD.status = 'active'
       AND NEW.status IN ('paused', 'revoked', 'compromised', 'suspicious_review'))
   OR (OLD.status = 'paused'
       AND NEW.status IN ('active', 'revoked', 'compromised', 'suspicious_review'))
   OR (OLD.status = 'suspicious_review'
       AND NEW.status IN ('active', 'paused', 'revoked', 'compromised'))
   OR (OLD.status IN ('revoked', 'compromised') AND NEW.status = 'archived')
 )
BEGIN
  SELECT RAISE(ABORT, 'fellow lifecycle transition invalid');
END;

CREATE TRIGGER enrollment_fellows_compromise_revokes_credentials
BEFORE UPDATE OF status ON enrollment_fellows
WHEN NEW.status = 'compromised'
 AND OLD.status IS NOT 'compromised'
 AND EXISTS (
   SELECT 1
     FROM fellow_tokens credential
    WHERE credential.fellow_id = NEW.fellow_id
      AND credential.revoked_at IS NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'compromise requires credential family revocation');
END;

-- Sponsor inventory joins one bounded Fellow page to its live credentials.
-- The old sponsor-only token index made every Fellow probe scan the sponsor's
-- full credential history before filtering by Fellow.
CREATE INDEX enrollment_credentials_sponsor_fellow_lifecycle_idx
  ON fellow_tokens (sponsor_id, fellow_id, revoked_at, expires_at, issued_at);
CREATE INDEX enrollment_credentials_fellow_issued_idx
  ON fellow_tokens (fellow_id, issued_at DESC);
CREATE INDEX enrollment_grants_sponsor_page_idx
  ON enrollment_grants (sponsor_id, granted_at DESC, fellow_id);
