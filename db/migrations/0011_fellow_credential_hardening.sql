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

-- Enrollment records are the credential gate before a proposal exists.
-- INTEGER affinity alone accepts TEXT/BLOB/REAL values; SQLite then orders a
-- text deadline after every integer while JavaScript numeric comparison treats
-- it as NaN. Refuse that split-brain state before stronger behavior is live.
INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_records record
     WHERE typeof(record.enrollment_id) <> 'text'
        OR instr(record.enrollment_id, char(0)) > 0
        OR length(record.enrollment_id) NOT BETWEEN 19 AND 41
        OR substr(record.enrollment_id, 1, 9) <> 'ASIMP-EN-'
        OR substr(record.enrollment_id, 10) GLOB '*[^A-HJKMNP-TV-Z0-9]*'
        OR typeof(record.sponsor_id) <> 'text'
        OR instr(record.sponsor_id, char(0)) > 0
        OR (record.kind = 'join-url' AND length(record.sponsor_id) = 0)
        OR (
          length(record.sponsor_id) > 0
          AND (
            length(record.sponsor_id) NOT BETWEEN 5 AND 64
            OR substr(record.sponsor_id, 1, 4) <> 'usr_'
            OR substr(record.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
          )
        )
        OR typeof(record.secret_hash) <> 'text'
        OR instr(record.secret_hash, char(0)) > 0
        OR length(record.secret_hash) <> 64
        OR record.secret_hash GLOB '*[^0-9a-f]*'
        OR typeof(record.created_at) <> 'integer'
        OR record.created_at NOT BETWEEN 1 AND 9007199254740991
        OR typeof(record.secret_expires_at) <> 'integer'
        OR record.secret_expires_at NOT BETWEEN 1 AND 9007199254740991
        OR (
          record.kind = 'join-url'
          AND record.secret_expires_at NOT BETWEEN record.created_at + 1
                                                   AND record.created_at + 1800000
        )
        OR (record.kind = 'device' AND record.secret_expires_at <> record.created_at)
        OR typeof(record.invalidated) <> 'integer'
        OR record.invalidated NOT IN (0, 1)
        OR (
          record.secret_consumed_at IS NOT NULL
          AND (
            typeof(record.secret_consumed_at) <> 'integer'
            OR record.secret_consumed_at NOT BETWEEN record.created_at
                                                 AND record.secret_expires_at - 1
          )
        )
        OR (
          record.device_expires_at IS NOT NULL
          AND (
            typeof(record.device_expires_at) <> 'integer'
            OR record.device_expires_at <> record.created_at + 1800000
          )
        )
        OR (
          record.device_mapping_reclaimed_at IS NOT NULL
          AND (
            typeof(record.device_mapping_reclaimed_at) <> 'integer'
            OR record.device_mapping_reclaimed_at NOT BETWEEN record.device_expires_at
                                                          AND 9007199254740991
          )
        )
  );

-- Requested authority is sponsor-visible before approval and becomes the
-- ceiling for every durable grant. Older schemas required only json_valid(),
-- which admits arrays of unknown scopes and objects whose values cannot be
-- parsed by the Worker. Refuse to deploy over any such retained row: otherwise
-- one bad pending record can make the entire sponsor-card response unavailable.
INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_records record
     WHERE typeof(record.requested_scopes_json) <> 'text'
        OR typeof(record.requested_resources_json) <> 'text'
        OR json_type(record.requested_scopes_json) <> 'array'
        OR json_array_length(record.requested_scopes_json) NOT BETWEEN 1 AND 4
        OR EXISTS (
          SELECT 1
            FROM json_each(record.requested_scopes_json) scope
           WHERE scope.type <> 'text'
              OR scope.value NOT IN (
                'promote', 'review', 'propose-problems', 'upload-artifacts'
              )
        )
        OR (
          SELECT COUNT(*) FROM json_each(record.requested_scopes_json)
        ) <> (
          SELECT COUNT(DISTINCT scope.value)
            FROM json_each(record.requested_scopes_json) scope
        )
        OR json_type(record.requested_resources_json) <> 'object'
        OR EXISTS (
          SELECT 1
            FROM json_each(record.requested_resources_json) resource
           WHERE resource.key NOT IN (
             'problemBinding', 'firstDirective', 'eventBudget',
             'artifactBudgetBytes', 'fellowGrantExpiresAt'
           )
        )
        OR (
          SELECT COUNT(*) FROM json_each(record.requested_resources_json)
        ) <> (
          SELECT COUNT(DISTINCT resource.key)
            FROM json_each(record.requested_resources_json) resource
        )
        OR (
          json_type(record.requested_resources_json, '$.problemBinding') IS NOT NULL
          AND (
            json_type(record.requested_resources_json, '$.problemBinding') <> 'text'
            OR instr(json_extract(
              record.requested_resources_json,
              '$.problemBinding'
            ), char(0)) > 0
            OR length(json_extract(
              record.requested_resources_json,
              '$.problemBinding'
            )) NOT BETWEEN 6 AND 28
            OR substr(json_extract(
              record.requested_resources_json,
              '$.problemBinding'
            ), 1, 2) <> 'P-'
            OR substr(json_extract(
              record.requested_resources_json,
              '$.problemBinding'
            ), 3) GLOB '*[^A-Z0-9]*'
          )
        )
        OR (
          json_type(record.requested_resources_json, '$.firstDirective') IS NOT NULL
          AND (
            json_type(record.requested_resources_json, '$.firstDirective') <> 'text'
            OR instr(json_extract(
              record.requested_resources_json,
              '$.firstDirective'
            ), char(0)) > 0
            OR length(trim(
              json_extract(record.requested_resources_json, '$.firstDirective'),
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
                  json_extract(record.requested_resources_json, '$.firstDirective'),
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
          json_type(record.requested_resources_json, '$.eventBudget') IS NOT NULL
          AND (
            json_type(record.requested_resources_json, '$.eventBudget') <> 'integer'
            OR json_extract(
              record.requested_resources_json,
              '$.eventBudget'
            ) NOT BETWEEN 1 AND 10000
          )
        )
        OR (
          json_type(record.requested_resources_json, '$.artifactBudgetBytes') IS NOT NULL
          AND (
            json_type(record.requested_resources_json, '$.artifactBudgetBytes') <> 'integer'
            OR json_extract(
              record.requested_resources_json,
              '$.artifactBudgetBytes'
            ) NOT BETWEEN 0 AND 1073741824
          )
        )
        OR (
          json_type(record.requested_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
          AND (
            json_type(record.requested_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
            OR json_extract(
              record.requested_resources_json,
              '$.fellowGrantExpiresAt'
            ) NOT BETWEEN 1 AND 9007199254740991
            OR json_extract(
              record.requested_resources_json,
              '$.fellowGrantExpiresAt'
            ) NOT BETWEEN record.created_at + 1
                              AND record.created_at + 31536000000
          )
        )
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
          AND grant_row.granted_at >= grant_proposal.created_at
          AND grant_row.granted_at < grant_proposal.expires_at
          AND credential.issued_at >= grant_row.granted_at
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
              AND json_extract(
                grant_row.granted_resources_json,
                '$.fellowGrantExpiresAt'
              ) <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
            )
          )
          AND proposal.granted_scopes_json = grant_row.granted_scopes_json
          AND proposal.granted_resources_json = grant_row.granted_resources_json
          AND grant_row.granted_at >= proposal.created_at
          AND grant_row.granted_at < proposal.expires_at
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
     WHERE typeof(grant_row.granted_scopes_json) <> 'text'
        OR typeof(grant_row.granted_resources_json) <> 'text'
        OR json_type(grant_row.granted_scopes_json) <> 'array'
        OR json_array_length(grant_row.granted_scopes_json) NOT BETWEEN 1 AND 4
        OR EXISTS (
          SELECT 1
            FROM json_each(grant_row.granted_scopes_json) scope
           WHERE scope.type <> 'text'
              OR scope.value NOT IN (
                'promote', 'review', 'propose-problems', 'upload-artifacts'
              )
        )
        OR (
          SELECT COUNT(*) FROM json_each(grant_row.granted_scopes_json)
        ) <> (
          SELECT COUNT(DISTINCT scope.value)
            FROM json_each(grant_row.granted_scopes_json) scope
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
            OR instr(json_extract(
              grant_row.granted_resources_json,
              '$.problemBinding'
            ), char(0)) > 0
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
            OR instr(json_extract(
              grant_row.granted_resources_json,
              '$.firstDirective'
            ), char(0)) > 0
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

-- A proposal/grant may never mint authority beyond the immutable enrollment
-- request. Approved copies are semantically exact; reduced copies are a
-- nonempty scope subset plus resource values that are equal or stricter.
INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
   SELECT 1
     FROM enrollment_proposals proposal
     JOIN enrollment_records enrollment
       ON enrollment.enrollment_id = proposal.enrollment_id
     JOIN enrollment_grants grant_row
       ON grant_row.proposal_id = proposal.proposal_id
    WHERE proposal.status IN ('approved', 'reduced')
      AND (
        EXISTS (
          SELECT 1
            FROM json_each(grant_row.granted_scopes_json) granted_scope
           WHERE NOT EXISTS (
             SELECT 1
               FROM json_each(enrollment.requested_scopes_json) requested_scope
              WHERE requested_scope.value = granted_scope.value
           )
        )
        OR EXISTS (
          SELECT 1
            FROM json_each(grant_row.granted_resources_json) granted_resource
           WHERE (
             granted_resource.key IN ('problemBinding', 'firstDirective')
             AND (
               json_type(
                 enrollment.requested_resources_json,
                 '$.' || granted_resource.key
               ) IS NULL
               OR json_extract(
                 enrollment.requested_resources_json,
                 '$.' || granted_resource.key
               ) IS NOT granted_resource.value
             )
           )
              OR (
                granted_resource.key IN (
                  'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
                )
                AND json_type(
                  enrollment.requested_resources_json,
                  '$.' || granted_resource.key
                ) IS NOT NULL
                AND granted_resource.value > json_extract(
                  enrollment.requested_resources_json,
                  '$.' || granted_resource.key
                )
              )
        )
        OR (
          proposal.status = 'approved'
          AND (
            json_array_length(grant_row.granted_scopes_json)
              <> json_array_length(enrollment.requested_scopes_json)
            OR (
              SELECT COUNT(*) FROM json_each(grant_row.granted_resources_json)
            ) <> (
              SELECT COUNT(*) FROM json_each(enrollment.requested_resources_json)
            )
            OR EXISTS (
              SELECT 1
                FROM json_each(grant_row.granted_resources_json) granted_resource
               WHERE json_type(
                 enrollment.requested_resources_json,
                 '$.' || granted_resource.key
               ) IS NOT granted_resource.type
                  OR json_extract(
                    enrollment.requested_resources_json,
                    '$.' || granted_resource.key
                  ) IS NOT granted_resource.value
            )
          )
        )
      )
 );

-- Approval authority and one-time issuance facts form a one-way state
-- machine. Reject retained rows whose status does not explain their nullable
-- authority/token shape before installing transition guards.
INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
   SELECT 1
     FROM enrollment_proposals proposal
    WHERE proposal.status NOT IN ('pending', 'approved', 'reduced', 'denied', 'expired')
       OR (
         proposal.status IN ('pending', 'denied')
         AND (
           proposal.granted_scopes_json IS NOT NULL
           OR proposal.granted_resources_json IS NOT NULL
           OR proposal.token_hash IS NOT NULL
           OR proposal.token_issued_at IS NOT NULL
         )
       )
       OR (
         proposal.status IN ('approved', 'reduced')
         AND (
           proposal.granted_scopes_json IS NULL
           OR proposal.granted_resources_json IS NULL
         )
       )
       OR (
         proposal.status = 'expired'
         AND (
           proposal.token_hash IS NOT NULL
           OR proposal.token_issued_at IS NOT NULL
           OR (proposal.granted_scopes_json IS NULL) <> (proposal.granted_resources_json IS NULL)
         )
       )
       OR (proposal.token_hash IS NULL) <> (proposal.token_issued_at IS NULL)
       OR (
         proposal.token_hash IS NOT NULL
         AND proposal.status NOT IN ('approved', 'reduced')
       )
 );

INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
     FROM enrollment_fellows fellow
     WHERE fellow.fellow_id IS NULL
        OR typeof(fellow.fellow_id) <> 'text'
        OR typeof(fellow.sponsor_id) <> 'text'
        OR typeof(fellow.name) <> 'text'
        OR typeof(fellow.model) <> 'text'
        OR typeof(fellow.harness) <> 'text'
        OR instr(fellow.fellow_id, char(0)) > 0
        OR instr(fellow.sponsor_id, char(0)) > 0
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
        OR instr(fellow.name, char(0)) > 0
        OR length(fellow.name) NOT BETWEEN 3 AND 32
        OR fellow.name NOT GLOB '[a-z]*'
        OR fellow.name GLOB '*[^a-z0-9-]*'
        OR instr(fellow.model, char(0)) > 0
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
        OR instr(fellow.harness, char(0)) > 0
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
        OR typeof(credential.credential_id) <> 'text'
        OR instr(credential.credential_id, char(0)) > 0
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
        OR credential.expires_at > credential.issued_at + 31536000000
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

-- Proposal timing and pacing fields cross the D1/JSON boundary on sponsor
-- cards and agent polls. SQLite's INTEGER affinity still accepts BLOBs, REALs,
-- and unsafe integers, so validate every proposal, including pending proposals
-- that do not yet have a Fellow or durable grant.
INSERT INTO fellow_credential_migration_guard (valid)
SELECT 0
 WHERE EXISTS (
    SELECT 1
      FROM enrollment_proposals proposal
     WHERE proposal.proposal_id IS NULL
        OR typeof(proposal.proposal_id) <> 'text'
        OR instr(proposal.proposal_id, char(0)) > 0
        OR (
          WITH RECURSIVE proposal_id_units(rest, units) AS (
            SELECT proposal.proposal_id, 0
            UNION ALL
            SELECT substr(rest, 2),
                   units + CASE
                     WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                     ELSE 1
                   END
              FROM proposal_id_units
             WHERE rest <> ''
          )
          SELECT units FROM proposal_id_units WHERE rest = ''
        ) NOT BETWEEN 1 AND 80
        OR typeof(proposal.enrollment_id) <> 'text'
        OR instr(proposal.enrollment_id, char(0)) > 0
        OR typeof(proposal.fellow_id) <> 'text'
        OR instr(proposal.fellow_id, char(0)) > 0
        OR (
          WITH RECURSIVE fellow_id_units(rest, units) AS (
            SELECT proposal.fellow_id, 0
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
        OR typeof(proposal.flow_handle_hash) <> 'text'
        OR instr(proposal.flow_handle_hash, char(0)) > 0
        OR length(proposal.flow_handle_hash) NOT BETWEEN 1 AND 160
        OR typeof(proposal.name) <> 'text'
        OR instr(proposal.name, char(0)) > 0
        OR length(proposal.name) NOT BETWEEN 3 AND 32
        OR proposal.name NOT GLOB '[a-z]*'
        OR proposal.name GLOB '*[^a-z0-9-]*'
        OR typeof(proposal.model) <> 'text'
        OR instr(proposal.model, char(0)) > 0
        OR length(trim(
          proposal.model,
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
            SELECT proposal.model, 0
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
        OR typeof(proposal.harness) <> 'text'
        OR instr(proposal.harness, char(0)) > 0
        OR length(trim(
          proposal.harness,
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
            SELECT proposal.harness, 0
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
        OR (
          proposal.reasoning_effort IS NOT NULL
          AND (
            typeof(proposal.reasoning_effort) <> 'text'
            OR instr(proposal.reasoning_effort, char(0)) > 0
            OR (
              WITH RECURSIVE reasoning_units(rest, units) AS (
                SELECT proposal.reasoning_effort, 0
                UNION ALL
                SELECT substr(rest, 2),
                       units + CASE
                         WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                         ELSE 1
                       END
                  FROM reasoning_units
                 WHERE rest <> ''
              )
              SELECT units FROM reasoning_units WHERE rest = ''
            ) NOT BETWEEN 1 AND 80
          )
        )
        OR (
          proposal.tools_note IS NOT NULL
          AND (
            typeof(proposal.tools_note) <> 'text'
            OR instr(proposal.tools_note, char(0)) > 0
            OR (
              WITH RECURSIVE tools_units(rest, units) AS (
                SELECT proposal.tools_note, 0
                UNION ALL
                SELECT substr(rest, 2),
                       units + CASE
                         WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                         ELSE 1
                       END
                  FROM tools_units
                 WHERE rest <> ''
              )
              SELECT units FROM tools_units WHERE rest = ''
            ) NOT BETWEEN 1 AND 1000
          )
        )
        OR typeof(proposal.created_at) <> 'integer'
        OR proposal.created_at NOT BETWEEN 1 AND 9007199254740991
        OR typeof(proposal.expires_at) <> 'integer'
        OR proposal.expires_at NOT BETWEEN 1 AND 9007199254740991
        OR proposal.expires_at <> proposal.created_at + 86400000
        OR typeof(proposal.poll_interval_seconds) <> 'integer'
        OR proposal.poll_interval_seconds NOT BETWEEN 5 AND 30
        OR (
          proposal.last_poll_at IS NOT NULL
          AND (
            typeof(proposal.last_poll_at) <> 'integer'
            OR proposal.last_poll_at NOT BETWEEN proposal.created_at AND 9007199254740991
          )
        )
        OR (
          proposal.token_issued_at IS NOT NULL
          AND (
            typeof(proposal.token_issued_at) <> 'integer'
            OR proposal.token_issued_at NOT BETWEEN proposal.created_at AND 9007199254740991
          )
        )
  );
DROP TABLE fellow_credential_migration_guard;

-- The durable grant must be the exact approval result, and every credential
-- must in turn copy that exact grant. These inserts run after the proposal
-- state change inside the same D1 batch, so there is no permissive bootstrap
-- interval to preserve.
CREATE TRIGGER enrollment_records_evidence_schema_insert
BEFORE INSERT ON enrollment_records
WHEN typeof(NEW.enrollment_id) <> 'text'
  OR instr(NEW.enrollment_id, char(0)) > 0
  OR length(NEW.enrollment_id) NOT BETWEEN 19 AND 41
  OR substr(NEW.enrollment_id, 1, 9) <> 'ASIMP-EN-'
  OR substr(NEW.enrollment_id, 10) GLOB '*[^A-HJKMNP-TV-Z0-9]*'
  OR typeof(NEW.sponsor_id) <> 'text'
  OR instr(NEW.sponsor_id, char(0)) > 0
  OR (NEW.kind = 'join-url' AND length(NEW.sponsor_id) = 0)
  OR (
    length(NEW.sponsor_id) > 0
    AND (
      length(NEW.sponsor_id) NOT BETWEEN 5 AND 64
      OR substr(NEW.sponsor_id, 1, 4) <> 'usr_'
      OR substr(NEW.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
    )
  )
  OR typeof(NEW.secret_hash) <> 'text'
  OR instr(NEW.secret_hash, char(0)) > 0
  OR length(NEW.secret_hash) <> 64
  OR NEW.secret_hash GLOB '*[^0-9a-f]*'
  OR typeof(NEW.created_at) <> 'integer'
  OR NEW.created_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.secret_expires_at) <> 'integer'
  OR NEW.secret_expires_at NOT BETWEEN 1 AND 9007199254740991
  OR (
    NEW.kind = 'join-url'
    AND NEW.secret_expires_at NOT BETWEEN NEW.created_at + 1 AND NEW.created_at + 1800000
  )
  OR (NEW.kind = 'device' AND NEW.secret_expires_at <> NEW.created_at)
  OR typeof(NEW.invalidated) <> 'integer'
  OR NEW.invalidated NOT IN (0, 1)
  OR (
    NEW.secret_consumed_at IS NOT NULL
    AND (
      typeof(NEW.secret_consumed_at) <> 'integer'
      OR NEW.secret_consumed_at NOT BETWEEN NEW.created_at AND NEW.secret_expires_at - 1
    )
  )
  OR (
    NEW.device_expires_at IS NOT NULL
    AND (
      typeof(NEW.device_expires_at) <> 'integer'
      OR NEW.device_expires_at <> NEW.created_at + 1800000
    )
  )
  OR (
    NEW.device_mapping_reclaimed_at IS NOT NULL
    AND (
      typeof(NEW.device_mapping_reclaimed_at) <> 'integer'
      OR NEW.device_mapping_reclaimed_at NOT BETWEEN NEW.device_expires_at
                                                 AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record evidence schema invalid');
END;

CREATE TRIGGER enrollment_records_authority_schema_insert
BEFORE INSERT ON enrollment_records
WHEN typeof(NEW.requested_scopes_json) <> 'text'
  OR typeof(NEW.requested_resources_json) <> 'text'
  OR json_type(NEW.requested_scopes_json) <> 'array'
  OR json_array_length(NEW.requested_scopes_json) NOT BETWEEN 1 AND 4
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.requested_scopes_json) scope
     WHERE scope.type <> 'text'
        OR scope.value NOT IN (
          'promote', 'review', 'propose-problems', 'upload-artifacts'
        )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.requested_scopes_json)
  ) <> (
    SELECT COUNT(DISTINCT scope.value)
      FROM json_each(NEW.requested_scopes_json) scope
  )
  OR json_type(NEW.requested_resources_json) <> 'object'
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.requested_resources_json) resource
     WHERE resource.key NOT IN (
       'problemBinding', 'firstDirective', 'eventBudget',
       'artifactBudgetBytes', 'fellowGrantExpiresAt'
     )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.requested_resources_json)
  ) <> (
    SELECT COUNT(DISTINCT resource.key)
      FROM json_each(NEW.requested_resources_json) resource
  )
  OR (
    json_type(NEW.requested_resources_json, '$.problemBinding') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.problemBinding') <> 'text'
      OR instr(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      ), char(0)) > 0
      OR length(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      )) NOT BETWEEN 6 AND 28
      OR substr(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      ), 1, 2) <> 'P-'
      OR substr(json_extract(
        NEW.requested_resources_json,
        '$.problemBinding'
      ), 3) GLOB '*[^A-Z0-9]*'
    )
  )
  OR (
    json_type(NEW.requested_resources_json, '$.firstDirective') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.firstDirective') <> 'text'
      OR instr(json_extract(
        NEW.requested_resources_json,
        '$.firstDirective'
      ), char(0)) > 0
      OR length(trim(
        json_extract(NEW.requested_resources_json, '$.firstDirective'),
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
            json_extract(NEW.requested_resources_json, '$.firstDirective'),
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
    json_type(NEW.requested_resources_json, '$.eventBudget') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.eventBudget') <> 'integer'
      OR json_extract(
        NEW.requested_resources_json,
        '$.eventBudget'
      ) NOT BETWEEN 1 AND 10000
    )
  )
  OR (
    json_type(NEW.requested_resources_json, '$.artifactBudgetBytes') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.artifactBudgetBytes') <> 'integer'
      OR json_extract(
        NEW.requested_resources_json,
        '$.artifactBudgetBytes'
      ) NOT BETWEEN 0 AND 1073741824
    )
  )
  OR (
    json_type(NEW.requested_resources_json, '$.fellowGrantExpiresAt') IS NOT NULL
    AND (
      json_type(NEW.requested_resources_json, '$.fellowGrantExpiresAt') <> 'integer'
      OR json_extract(
        NEW.requested_resources_json,
        '$.fellowGrantExpiresAt'
      ) NOT BETWEEN 1 AND 9007199254740991
      OR json_extract(
        NEW.requested_resources_json,
        '$.fellowGrantExpiresAt'
      ) NOT BETWEEN NEW.created_at + 1 AND NEW.created_at + 31536000000
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record authority schema invalid');
END;

CREATE TRIGGER enrollment_records_state_schema_update
BEFORE UPDATE OF sponsor_id, invalidated, secret_consumed_at ON enrollment_records
WHEN typeof(NEW.sponsor_id) <> 'text'
  OR instr(NEW.sponsor_id, char(0)) > 0
  OR (NEW.kind = 'join-url' AND length(NEW.sponsor_id) = 0)
  OR (
    length(NEW.sponsor_id) > 0
    AND (
      length(NEW.sponsor_id) NOT BETWEEN 5 AND 64
      OR substr(NEW.sponsor_id, 1, 4) <> 'usr_'
      OR substr(NEW.sponsor_id, 5) GLOB '*[^A-Za-z0-9_-]*'
    )
  )
  OR typeof(NEW.invalidated) <> 'integer'
  OR NEW.invalidated NOT IN (0, 1)
  OR (
    NEW.secret_consumed_at IS NOT NULL
    AND (
      typeof(NEW.secret_consumed_at) <> 'integer'
      OR NEW.secret_consumed_at NOT BETWEEN NEW.created_at AND NEW.secret_expires_at - 1
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record state schema invalid');
END;

CREATE TRIGGER enrollment_records_state_transition
BEFORE UPDATE OF sponsor_id, invalidated, secret_consumed_at ON enrollment_records
WHEN (OLD.invalidated = 1 AND NEW.invalidated <> 1)
  OR (OLD.secret_consumed_at IS NOT NULL AND NEW.secret_consumed_at IS NOT OLD.secret_consumed_at)
  OR (
    NEW.sponsor_id IS NOT OLD.sponsor_id
    AND NOT (OLD.kind = 'device' AND OLD.sponsor_id = '' AND length(NEW.sponsor_id) > 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'enrollment record state transition invalid');
END;

CREATE TRIGGER enrollment_records_authority_immutable
BEFORE UPDATE OF
  enrollment_id, secret_hash, secret_expires_at, requested_scopes_json,
  requested_resources_json, created_at
ON enrollment_records
BEGIN
  SELECT RAISE(ABORT, 'enrollment record authority is immutable');
END;

-- REPLACE is a DELETE followed by an INSERT and would otherwise bypass the
-- update-only authority guards. Enrollment identity/history is append-only.
CREATE TRIGGER enrollment_records_no_duplicate_id_insert
BEFORE INSERT ON enrollment_records
WHEN EXISTS (
  SELECT 1 FROM enrollment_records existing
   WHERE existing.enrollment_id = NEW.enrollment_id
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment record already exists');
END;

CREATE TRIGGER enrollment_records_no_delete
BEFORE DELETE ON enrollment_records
BEGIN
  SELECT RAISE(ABORT, 'enrollment record deletion forbidden');
END;

CREATE TRIGGER enrollment_proposals_evidence_schema_insert
BEFORE INSERT ON enrollment_proposals
WHEN NEW.proposal_id IS NULL
  OR typeof(NEW.proposal_id) <> 'text'
  OR instr(NEW.proposal_id, char(0)) > 0
  OR (
    WITH RECURSIVE proposal_id_units(rest, units) AS (
      SELECT NEW.proposal_id, 0
      UNION ALL
      SELECT substr(rest, 2),
             units + CASE
               WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
               ELSE 1
             END
        FROM proposal_id_units
       WHERE rest <> ''
    )
    SELECT units FROM proposal_id_units WHERE rest = ''
  ) NOT BETWEEN 1 AND 80
  OR typeof(NEW.enrollment_id) <> 'text'
  OR instr(NEW.enrollment_id, char(0)) > 0
  OR typeof(NEW.fellow_id) <> 'text'
  OR instr(NEW.fellow_id, char(0)) > 0
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
  OR typeof(NEW.flow_handle_hash) <> 'text'
  OR instr(NEW.flow_handle_hash, char(0)) > 0
  OR length(NEW.flow_handle_hash) NOT BETWEEN 1 AND 160
  OR typeof(NEW.name) <> 'text'
  OR instr(NEW.name, char(0)) > 0
  OR length(NEW.name) NOT BETWEEN 3 AND 32
  OR NEW.name NOT GLOB '[a-z]*'
  OR NEW.name GLOB '*[^a-z0-9-]*'
  OR typeof(NEW.model) <> 'text'
  OR instr(NEW.model, char(0)) > 0
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
  OR typeof(NEW.harness) <> 'text'
  OR instr(NEW.harness, char(0)) > 0
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
  OR (
    NEW.reasoning_effort IS NOT NULL
    AND (
      typeof(NEW.reasoning_effort) <> 'text'
      OR instr(NEW.reasoning_effort, char(0)) > 0
      OR (
        WITH RECURSIVE reasoning_units(rest, units) AS (
          SELECT NEW.reasoning_effort, 0
          UNION ALL
          SELECT substr(rest, 2),
                 units + CASE
                   WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                   ELSE 1
                 END
            FROM reasoning_units
           WHERE rest <> ''
        )
        SELECT units FROM reasoning_units WHERE rest = ''
      ) NOT BETWEEN 1 AND 80
    )
  )
  OR (
    NEW.tools_note IS NOT NULL
    AND (
      typeof(NEW.tools_note) <> 'text'
      OR instr(NEW.tools_note, char(0)) > 0
      OR (
        WITH RECURSIVE tools_units(rest, units) AS (
          SELECT NEW.tools_note, 0
          UNION ALL
          SELECT substr(rest, 2),
                 units + CASE
                   WHEN unicode(substr(rest, 1, 1)) > 65535 THEN 2
                   ELSE 1
                 END
            FROM tools_units
           WHERE rest <> ''
        )
        SELECT units FROM tools_units WHERE rest = ''
      ) NOT BETWEEN 1 AND 1000
    )
  )
  OR typeof(NEW.created_at) <> 'integer'
  OR NEW.created_at NOT BETWEEN 1 AND 9007199254740991
  OR typeof(NEW.expires_at) <> 'integer'
  OR NEW.expires_at NOT BETWEEN 1 AND 9007199254740991
  OR NEW.expires_at <> NEW.created_at + 86400000
  OR typeof(NEW.poll_interval_seconds) <> 'integer'
  OR NEW.poll_interval_seconds NOT BETWEEN 5 AND 30
  OR (
    NEW.last_poll_at IS NOT NULL
    AND (
      typeof(NEW.last_poll_at) <> 'integer'
      OR NEW.last_poll_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
  OR (
    NEW.token_issued_at IS NOT NULL
    AND (
      typeof(NEW.token_issued_at) <> 'integer'
      OR NEW.token_issued_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal evidence schema invalid');
END;

CREATE TRIGGER enrollment_proposals_state_schema_insert
BEFORE INSERT ON enrollment_proposals
WHEN NEW.status <> 'pending'
  OR NEW.granted_scopes_json IS NOT NULL
  OR NEW.granted_resources_json IS NOT NULL
  OR NEW.token_hash IS NOT NULL
  OR NEW.token_issued_at IS NOT NULL
  OR NEW.last_poll_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'proposal must begin pending');
END;

CREATE TRIGGER enrollment_proposals_evidence_schema_update
BEFORE UPDATE OF poll_interval_seconds, last_poll_at, token_issued_at
ON enrollment_proposals
WHEN typeof(NEW.poll_interval_seconds) <> 'integer'
  OR NEW.poll_interval_seconds NOT BETWEEN 5 AND 30
  OR (
    NEW.last_poll_at IS NOT NULL
    AND (
      typeof(NEW.last_poll_at) <> 'integer'
      OR NEW.last_poll_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
  OR (
    NEW.token_issued_at IS NOT NULL
    AND (
      typeof(NEW.token_issued_at) <> 'integer'
      OR NEW.token_issued_at NOT BETWEEN NEW.created_at AND 9007199254740991
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal evidence schema invalid');
END;

CREATE TRIGGER enrollment_proposals_deadline_immutable
BEFORE UPDATE OF created_at, expires_at ON enrollment_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposal timing is immutable');
END;

CREATE TRIGGER enrollment_proposals_identity_immutable
BEFORE UPDATE OF
  proposal_id, enrollment_id, fellow_id, flow_handle_hash, name, model,
  harness, reasoning_effort, tools_note
ON enrollment_proposals
BEGIN
  SELECT RAISE(ABORT, 'proposal identity is immutable');
END;

CREATE TRIGGER enrollment_proposals_state_transition
BEFORE UPDATE OF
  status, granted_scopes_json, granted_resources_json, token_hash, token_issued_at
ON enrollment_proposals
WHEN (
    OLD.status = 'pending'
    AND NEW.status NOT IN ('pending', 'approved', 'reduced', 'denied', 'expired')
  )
  OR (
    OLD.status IN ('approved', 'reduced')
    AND NEW.status NOT IN (OLD.status, 'expired')
  )
  OR (OLD.status IN ('denied', 'expired') AND NEW.status <> OLD.status)
  OR (
    OLD.granted_scopes_json IS NOT NULL
    AND (
      OLD.granted_scopes_json IS NOT NEW.granted_scopes_json
      OR OLD.granted_resources_json IS NOT NEW.granted_resources_json
    )
  )
  OR (
    OLD.granted_scopes_json IS NULL
    AND NEW.granted_scopes_json IS NOT NULL
    AND NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'reduced'))
  )
  OR (NEW.granted_scopes_json IS NULL) <> (NEW.granted_resources_json IS NULL)
  OR (
    OLD.token_hash IS NOT NULL
    AND (
      OLD.token_hash IS NOT NEW.token_hash
      OR OLD.token_issued_at IS NOT NEW.token_issued_at
    )
  )
  OR (NEW.token_hash IS NULL) <> (NEW.token_issued_at IS NULL)
  OR (NEW.token_hash IS NOT NULL AND NEW.status NOT IN ('approved', 'reduced'))
  OR (
    NEW.status IN ('pending', 'denied')
    AND (
      NEW.granted_scopes_json IS NOT NULL
      OR NEW.granted_resources_json IS NOT NULL
      OR NEW.token_hash IS NOT NULL
      OR NEW.token_issued_at IS NOT NULL
    )
  )
  OR (
    NEW.status IN ('approved', 'reduced')
    AND (NEW.granted_scopes_json IS NULL OR NEW.granted_resources_json IS NULL)
  )
  OR (
    NEW.status = 'expired'
    AND (
      NEW.token_hash IS NOT NULL
      OR NEW.token_issued_at IS NOT NULL
      OR (NEW.granted_scopes_json IS NULL) <> (NEW.granted_resources_json IS NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'proposal state transition invalid');
END;

CREATE TRIGGER enrollment_proposals_no_duplicate_identity_insert
BEFORE INSERT ON enrollment_proposals
WHEN EXISTS (
  SELECT 1 FROM enrollment_proposals existing
   WHERE existing.proposal_id = NEW.proposal_id
      OR existing.enrollment_id = NEW.enrollment_id
      OR existing.fellow_id = NEW.fellow_id
      OR existing.flow_handle_hash = NEW.flow_handle_hash
      OR (
        NEW.token_hash IS NOT NULL
        AND existing.token_hash = NEW.token_hash
      )
)
BEGIN
  SELECT RAISE(ABORT, 'enrollment proposal already exists');
END;

CREATE TRIGGER enrollment_proposals_no_delete
BEFORE DELETE ON enrollment_proposals
BEGIN
  SELECT RAISE(ABORT, 'enrollment proposal deletion forbidden');
END;

CREATE TRIGGER enrollment_fellows_identity_schema_insert
BEFORE INSERT ON enrollment_fellows
WHEN NEW.fellow_id IS NULL
  OR typeof(NEW.fellow_id) <> 'text'
  OR typeof(NEW.sponsor_id) <> 'text'
  OR typeof(NEW.name) <> 'text'
  OR typeof(NEW.model) <> 'text'
  OR typeof(NEW.harness) <> 'text'
  OR instr(NEW.fellow_id, char(0)) > 0
  OR instr(NEW.sponsor_id, char(0)) > 0
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
  OR instr(NEW.name, char(0)) > 0
  OR length(NEW.name) NOT BETWEEN 3 AND 32
  OR NEW.name NOT GLOB '[a-z]*'
  OR NEW.name GLOB '*[^a-z0-9-]*'
  OR instr(NEW.model, char(0)) > 0
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
  OR instr(NEW.harness, char(0)) > 0
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

-- SQLite REPLACE resolves uniqueness conflicts as delete-plus-insert and can
-- otherwise reset a terminal Fellow to the INSERT default status. Lifecycle
-- history is append-preserving: a Fellow identity is never replaced or deleted.
CREATE TRIGGER enrollment_fellows_no_duplicate_id_insert
BEFORE INSERT ON enrollment_fellows
WHEN EXISTS (
  SELECT 1
    FROM enrollment_fellows existing
   WHERE existing.fellow_id = NEW.fellow_id
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity already exists');
END;

CREATE TRIGGER enrollment_fellows_no_duplicate_name_insert
BEFORE INSERT ON enrollment_fellows
WHEN NOT EXISTS (
  SELECT 1
    FROM enrollment_fellows existing
   WHERE existing.fellow_id = NEW.fellow_id
)
 AND EXISTS (
  SELECT 1
    FROM enrollment_fellows existing
   WHERE existing.name = NEW.name COLLATE NOCASE
)
BEGIN
  SELECT RAISE(ABORT, 'Fellow name already exists');
END;

CREATE TRIGGER enrollment_fellows_no_delete
BEFORE DELETE ON enrollment_fellows
BEGIN
  SELECT RAISE(ABORT, 'Fellow identity cannot be deleted');
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
WHEN typeof(NEW.granted_scopes_json) <> 'text'
  OR typeof(NEW.granted_resources_json) <> 'text'
  OR json_type(NEW.granted_scopes_json) <> 'array'
  OR json_array_length(NEW.granted_scopes_json) NOT BETWEEN 1 AND 4
  OR EXISTS (
    SELECT 1
      FROM json_each(NEW.granted_scopes_json) scope
     WHERE scope.type <> 'text'
        OR scope.value NOT IN (
          'promote', 'review', 'propose-problems', 'upload-artifacts'
        )
  )
  OR (
    SELECT COUNT(*) FROM json_each(NEW.granted_scopes_json)
  ) <> (
    SELECT COUNT(DISTINCT scope.value)
      FROM json_each(NEW.granted_scopes_json) scope
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
      OR instr(json_extract(
        NEW.granted_resources_json,
        '$.problemBinding'
      ), char(0)) > 0
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
      OR instr(json_extract(
        NEW.granted_resources_json,
        '$.firstDirective'
      ), char(0)) > 0
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
     AND NEW.granted_at >= proposal.created_at
     AND NEW.granted_at < proposal.expires_at
     AND proposal.granted_scopes_json = NEW.granted_scopes_json
     AND proposal.granted_resources_json = NEW.granted_resources_json
     AND NOT EXISTS (
       SELECT 1
         FROM json_each(NEW.granted_scopes_json) granted_scope
        WHERE NOT EXISTS (
          SELECT 1
            FROM json_each(enrollment.requested_scopes_json) requested_scope
           WHERE requested_scope.value = granted_scope.value
        )
     )
     AND NOT EXISTS (
       SELECT 1
         FROM json_each(NEW.granted_resources_json) granted_resource
        WHERE (
          granted_resource.key IN ('problemBinding', 'firstDirective')
          AND (
            json_type(
              enrollment.requested_resources_json,
              '$.' || granted_resource.key
            ) IS NULL
            OR json_extract(
              enrollment.requested_resources_json,
              '$.' || granted_resource.key
            ) IS NOT granted_resource.value
          )
        )
           OR (
             granted_resource.key IN (
               'eventBudget', 'artifactBudgetBytes', 'fellowGrantExpiresAt'
             )
             AND json_type(
               enrollment.requested_resources_json,
               '$.' || granted_resource.key
             ) IS NOT NULL
             AND granted_resource.value > json_extract(
               enrollment.requested_resources_json,
               '$.' || granted_resource.key
             )
           )
     )
     AND (
       proposal.status <> 'approved'
       OR (
         json_array_length(NEW.granted_scopes_json)
           = json_array_length(enrollment.requested_scopes_json)
         AND (
           SELECT COUNT(*) FROM json_each(NEW.granted_resources_json)
         ) = (
           SELECT COUNT(*) FROM json_each(enrollment.requested_resources_json)
         )
         AND NOT EXISTS (
           SELECT 1
             FROM json_each(NEW.granted_resources_json) granted_resource
            WHERE json_type(
              enrollment.requested_resources_json,
              '$.' || granted_resource.key
            ) IS NOT granted_resource.type
               OR json_extract(
                 enrollment.requested_resources_json,
                 '$.' || granted_resource.key
               ) IS NOT granted_resource.value
         )
       )
     )
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
     AND NEW.issued_at >= grant_row.granted_at
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
  OR typeof(NEW.credential_id) <> 'text'
  OR instr(NEW.credential_id, char(0)) > 0
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
  OR NEW.expires_at > NEW.issued_at + 31536000000
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

-- Authentication is the only normal writer of last-used evidence, but the
-- database must keep the audit fact parseable even under maintenance SQL.
-- The inherited monotonic trigger governs ordering; this one closes SQLite's
-- dynamic-type hole for fractional or unsafe-integer updates.
CREATE TRIGGER enrollment_credentials_last_used_schema_update
BEFORE UPDATE OF last_used_at ON fellow_tokens
WHEN NEW.last_used_at IS NOT NULL
 AND (
   typeof(NEW.last_used_at) <> 'integer'
   OR NEW.last_used_at NOT BETWEEN 0 AND 9007199254740991
 )
BEGIN
  SELECT RAISE(ABORT, 'credential last-used evidence schema invalid');
END;

CREATE TRIGGER enrollment_credentials_revoked_schema_update
BEFORE UPDATE OF revoked_at ON fellow_tokens
WHEN NEW.revoked_at IS NOT NULL
 AND (
   typeof(NEW.revoked_at) <> 'integer'
   OR NEW.revoked_at NOT BETWEEN 0 AND 9007199254740991
 )
BEGIN
  SELECT RAISE(ABORT, 'credential revocation evidence schema invalid');
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
