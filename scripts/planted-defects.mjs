#!/usr/bin/env node
/**
 * Planted-defect registry and runner (beads codz, wty4, lu59, p4b, 10lz,
 * ncnw, kqz5, f37v, kw85). Each plant re-introduces one real defect that a
 * real-bindings lane (or unit test) must catch.
 *
 *   node scripts/planted-defects.mjs --check
 *       Every plant's `find` snippet still matches its file exactly once in
 *       this checkout (run by scripts/suite/planted-defects.test.ts), so plants
 *       cannot silently rot.
 *   node scripts/planted-defects.mjs --run <git-worktree> [--only <id,...>]
 *       In a CLEAN git worktree of this repo (with its own `bun install`),
 *       apply each plant, run its lane, REQUIRE a non-zero exit, and write the
 *       original bytes back. Never run against the primary working tree: the
 *       runner refuses a dirty tree and never creates or removes directories.
 *
 * Exit: 0 every plant caught; 1 a plant survived, was inconclusive (timeout,
 * kill, build error), had no passing control, or a restore failed; 2 usage.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LANE = (name) => ["node", `apps/wire/test/integration/${name}-real-bindings.mjs`];
const UNIT = (file) => ["bun", "test", "--timeout=120000", file];

export const PLANTS = [
  {
    id: "conflict-sql-pre-0054",
    bead: "codz",
    file: "apps/wire/src/mega-commands/conflict-moves.ts",
    find: "AND ((c.claim_a_id = cr.source_claim_id AND c.claim_a_version = cr.source_version",
    replace: "AND ((c.object_a = cr.source_claim_id AND c.claim_a_version = cr.source_version",
    command: LANE("moves"),
  },
  {
    id: "inverted-move-ranking",
    bead: "codz",
    file: "apps/wire/src/mega-commands/live-provider.ts",
    find: "  if (tierA !== tierB) return tierA - tierB;",
    replace: "  if (tierA !== tierB) return tierB - tierA;",
    command: LANE("moves"),
  },
  {
    id: "roster-slot-over-allocation",
    bead: "codz",
    file: "apps/wire/src/sessions/router-core.ts",
    find: "                       ) >= p.writer_cap THEN 'observer'",
    replace: "                       ) >= p.writer_cap + 1 THEN 'observer'",
    command: LANE("roster-race"),
  },
  {
    id: "matching-without-sponsor-exclusion",
    bead: "codz",
    file: "apps/wire/src/review-requests/matching-sql.ts",
    find: "  AND f.sponsor_id NOT IN (json_extract(j, '$.author_sponsor'), json_extract(j, '$.sender_sponsor'))\n",
    replace: "",
    command: LANE("matchmaking"),
  },
  {
    id: "honors-ignores-computed-disposition",
    bead: "codz",
    file: "apps/wire/src/discovery/honors-service.ts",
    find: 'const isStronglySupported = fold?.disposition === "strongly-supported";',
    replace:
      'const isStronglySupported = fold?.disposition === "strongly-supported" || (fold?.disposition === "corroborated" || fold?.disposition === "open");',
    command: LANE("honors"),
  },
  {
    id: "transfer-cancel-unguarded",
    bead: "wty4",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: "            SET status = 'cancelled', resolved_at = ?\n          WHERE transfer_id = ? AND status = 'pending'`,",
    replace:
      "            SET status = 'cancelled', resolved_at = ?\n          WHERE transfer_id = ?`,",
    // The read-side pending check refuses a sequential cancel, so the SQL
    // guard matters only under interleaving: also delay the cancel's commit
    // (the 2nd such batch in the file) so the racing accept lands first. The
    // delay is a scheduling condition, not a defect.
    also: [
      {
        find: "    try {\n      const results = await this.#db.batch(statements);\n      if ((results[0]?.meta.changes ?? 0) !== 1) {\n        // Only a still-pending offer can be resolved",
        replace:
          "    try {\n      await new Promise((resolve) => setTimeout(resolve, 300));\n      const results = await this.#db.batch(statements);\n      if ((results[0]?.meta.changes ?? 0) !== 1) {\n        // Only a still-pending offer can be resolved",
        nth: 2,
      },
    ],
    command: LANE("identity-lifecycle"),
  },
  {
    id: "transfer-double-accept",
    bead: "wty4",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: "          WHERE transfer_id = ? AND status = 'pending' AND expires_at > ?",
    replace: "          WHERE transfer_id = ? AND expires_at > ?",
    command: LANE("identity-lifecycle"),
  },
  {
    id: "account-deletion-orphans-active-fellows",
    bead: "wty4",
    file: "apps/wire/src/krater/retention.ts",
    find: "          WHERE sponsor_id = ? AND status != 'revoked'`,",
    replace: "          WHERE sponsor_id = ? AND status NOT IN ('revoked', 'active')`,",
    command: LANE("identity-lifecycle"),
  },
  {
    id: "nonce-expiry-in-milliseconds",
    bead: "p4b",
    file: "apps/wire/src/krater/retention.ts",
    find: 'WHERE expires_at <= ?").bind(nowSeconds)',
    replace: 'WHERE expires_at <= ?").bind(nowMs)',
    command: LANE("security-retention"),
  },
  {
    id: "deletion-journal-replay-skips-drafts",
    bead: "p4b",
    file: "apps/wire/src/krater/retention.ts",
    find: '      if (exists && exists.status === "private-draft" && exists.public_seq === 0) {',
    replace: '      if (exists && exists.status === "PLANTED-never" && exists.public_seq === 0) {',
    command: LANE("deletion-journal"),
  },
  {
    id: "credential-replay-skipped",
    bead: "p4b",
    file: "apps/wire/src/krater/retention.ts",
    find: "      if (live) {\n        if (revokeCredential === undefined) {",
    replace: "      if (false as boolean) {\n        if (revokeCredential === undefined) {",
    command: LANE("deletion-journal"),
  },
  {
    id: "fellow-revoke-not-journaled",
    bead: "p4b",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: '        attempt.toStatus === "revoked"\n          ? await this.revocationJournal(',
    replace:
      '        (attempt.toStatus as string) === "PLANTED-never"\n          ? await this.revocationJournal(',
    command: LANE("deletion-journal"),
  },
  {
    id: "panic-not-journaled",
    bead: "p4b",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: "        await this.revocationJournal({ sponsorId: attempt.sponsorId }, effectiveAt),",
    replace: "        [],",
    command: LANE("deletion-journal"),
  },
  {
    id: "denial-not-journaled",
    bead: "p4b",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: "          ...(idempotency === undefined ? [] : [this.idempotencyStatement(idempotency)]),\n          denialJournal,\n        ];",
    replace:
      '          ...(idempotency === undefined ? [] : [this.idempotencyStatement(idempotency)]),\n          sql(this.#db, "SELECT ?", denialJournal === undefined ? 0 : 1),\n        ];',
    command: LANE("deletion-journal"),
  },
  {
    id: "transfer-accept-not-journaled",
    bead: "p4b",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: "        { sql: acceptedByThisAttempt, bindings: [attempt.transferId, attempt.now] },",
    replace: '        { sql: "0 AND ? AND ?", bindings: [attempt.transferId, attempt.now] },',
    command: LANE("deletion-journal"),
  },
  {
    id: "transfer-replay-skipped",
    bead: "p4b",
    file: "apps/wire/src/krater/retention.ts",
    find: "          \"UPDATE sponsor_fellow_transfers SET status = ?, resolved_at = ? WHERE transfer_id = ? AND status = 'pending'\",",
    replace:
      "          \"UPDATE sponsor_fellow_transfers SET status = ?, resolved_at = ? WHERE transfer_id = ? AND status = 'PLANTED-never'\",",
    command: LANE("deletion-journal"),
  },
  {
    id: "artifact-binds-unverified-bytes",
    bead: "y2t7",
    file: "apps/wire/src/krater/artifact-store.ts",
    find: "    const inspected = await inspectArtifact(bytes, row.encoding, row.sha256);",
    replace:
      "    const inspected = await inspectArtifact(bytes, row.encoding, await artifactSha256(bytes));",
    // R2's own sha256 checksum on the CAS put is a second, independent check
    // (independent verification 3 found the single-edit plant survived), so
    // the defect "bind bytes that are not the declared object" removes both.
    also: [
      {
        find: "    await putVerifiedBytes(bucket, casKey(row.sha256), bytes, row.sha256, inspected.contentType);",
        replace:
          "    await putVerifiedBytes(bucket, casKey(row.sha256), bytes, await artifactSha256(bytes), inspected.contentType);",
      },
    ],
    command: LANE("artifact"),
  },
  {
    id: "restore-skips-chain-verification",
    bead: "p4b",
    file: "apps/wire/src/krater/restore.ts",
    find: "  if (!verification.intact) {",
    replace: "  if (false && !verification.intact) {",
    command: LANE("export-restore"),
  },
  {
    id: "safe-restore-ignores-journal",
    bead: "p4b",
    file: "apps/wire/src/krater/retention.ts",
    find: "  const records = await verifiedJournalRecords(options.deletionJournalNdjson, options.verifyKeys);\n\n  const parsedSnapshot",
    replace: "  const records: RetentionControlRecord[] = [];\n\n  const parsedSnapshot",
    command: LANE("export-restore"),
  },
  {
    id: "backup-omits-signed-checkpoints",
    bead: "10lz",
    file: "apps/wire/src/krater/backup.ts",
    find: "  if (options.checkpointVerifyKeys !== undefined) {",
    replace: "  if ((options.checkpointVerifyKeys as unknown) === 'PLANTED-never') {",
    command: LANE("export-restore"),
  },
  {
    id: "backup-resume-repeats-boundary",
    bead: "p4b",
    file: "apps/wire/src/krater/backup.ts",
    find: "\"SELECT id, title FROM problems WHERE status <> 'private-draft' AND id > ? ORDER BY id LIMIT ?\"",
    replace:
      "\"SELECT id, title FROM problems WHERE status <> 'private-draft' AND id >= ? ORDER BY id LIMIT ?\"",
    command: LANE("export-restore"),
  },
  {
    id: "hypothesis-id-digits-only",
    bead: "qvzk",
    // The defect that made every public hypotheses face fail for real
    // (Crockford-minted) hypothesis ids.
    file: "packages/contracts/src/hypotheses.ts",
    find: "  .regex(/^H-[0-9A-HJKMNP-TV-Z]{1,78}$/);",
    replace: "  .regex(/^H-[0-9]{1,78}$/);",
    command: LANE("hypotheses-evidence"),
  },
  {
    id: "hypothesis-item-face-unrouted",
    bead: "qvzk",
    file: "apps/wire/src/ledger/hypotheses-router.ts",
    find: 'app.on(["GET", "HEAD"], "/p/:id/hypotheses/:target", async (c) => {',
    replace: 'app.on(["GET", "HEAD"], "/p/:id/hypotheses-planted/:target", async (c) => {',
    command: LANE("hypotheses-evidence"),
  },
  {
    id: "item-face-keeps-sibling-records",
    bead: "qvzk",
    file: "apps/wire/src/ledger-face.ts",
    find: '      .filter((item) => focus === undefined || item.kind === "claim-detail" || item.id === focus)',
    replace: '      .filter((item) => focus === undefined || item.kind !== "PLANTED-never")',
    command: LANE("reviews"),
  },
  {
    id: "evidence-item-face-blocked-by-guard",
    bead: "qvzk",
    file: "apps/wire/src/app.ts",
    find: '        (segments[3] === "evidence" &&',
    replace: '        (segments[3] === "evidence-planted" &&',
    command: LANE("hypotheses-evidence"),
  },
  {
    id: "relation-face-ignores-seq",
    bead: "qvzk",
    file: "apps/wire/src/sessions/ledger-pack.ts",
    find: "      WHERE r.problem_id = ? AND e.seq <= ? AND (? IS NULL OR e.seq = ?)",
    replace: "      WHERE r.problem_id = ? AND e.seq <= ? AND (? IS NULL OR ? IS NOT NULL)",
    command: LANE("relations-gaps"),
  },
  {
    id: "export-verifier-trusts-header",
    bead: "10lz",
    file: "scripts/verify-export.ts",
    find: "  if (last !== undefined && !signedRoots.has(last.seq)) {",
    replace: "  if (false && last !== undefined && !signedRoots.has(last.seq)) {",
    command: UNIT("scripts/suite/verify-export.test.ts"),
  },
  {
    id: "novelty-counts-same-sponsor",
    bead: "ncnw",
    file: "apps/wire/src/ledger-face.ts",
    find: '        review.tier !== "T0" &&',
    replace: "        true &&",
    command: LANE("novelty"),
  },
  {
    id: "publish-not-screened",
    bead: "kqz5",
    file: "apps/wire/src/problems/router.ts",
    find: 'if (action.action === "publish" || action.action === "revise-statement") {',
    replace: "if (false as boolean) {",
    command: LANE("problem-screening"),
  },
  {
    id: "malformed-provider-output-passes",
    bead: "kqz5",
    // A parser that fails open: unparseable model output becomes a complete,
    // well-formed pass. The route has further independent layers
    // (assertProviderResponse, the public-action check, the SCREENED
    // attestation), so the plant must yield a result every layer accepts;
    // adapter- and partial-parser plants survived for that reason.
    file: "apps/wire/src/screening/workers-ai.ts",
    find: '    throw new TypeError("Workers AI completion is not parseable JSON.");',
    replace:
      '    return { decision: "pass", coarse_category: "benign-context", category_score_bands: Object.fromEntries(POLICY_CATEGORIES.map((c) => [c, undefined])) } as never;',
    command: [
      "node",
      "apps/wire/test/integration/discovery-real-bindings.mjs",
      "malformed-provider",
    ],
  },
  {
    id: "herald-refresh-silent",
    bead: "f37v",
    file: "apps/wire/src/herald/room-core.ts",
    find: "      this.send(socket, a, Math.max(head.seq, a.acknowledged), now);\n    }\n  }",
    replace: "      void now;\n    }\n  }",
    command: LANE("herald-room"),
  },
  {
    id: "herald-room-ignores-missing-0078",
    bead: "f37v",
    file: "apps/wire/src/herald/runtime.ts",
    find: "    if (!(await heraldRoomSchemaReady(env.DB))) {",
    replace: "    if (false as boolean) {",
    command: LANE("herald-room"),
  },
  {
    id: "herald-wrangler-dev-ignores-missing-0078",
    bead: "f37v",
    file: "apps/wire/src/herald/runtime.ts",
    find: "    if (!(await heraldRoomSchemaReady(env.DB))) {",
    replace: "    if (false as boolean) {",
    command: ["bash", "scripts/e2e-herald-wrangler-dev.sh"],
  },
  {
    id: "event-tail-cursor-duplicates",
    bead: "lu59",
    file: "apps/wire/src/ledger/event-tail-read.ts",
    find: "  ON e.problem_id = p.id AND e.seq > ? AND e.seq <= p.through AND e.seq <= p.public_seq",
    replace:
      "  ON e.problem_id = p.id AND e.seq >= ? AND e.seq <= p.through AND e.seq <= p.public_seq",
    command: LANE("stoa-surface"),
  },
  {
    id: "notice-producer-drops-reviews",
    bead: "lu59",
    file: "apps/wire/src/inbox/event-delivery.ts",
    find: '  const isReview = job.type === "review.created" && job.object_kind === "review";',
    replace: "  const isReview = false as boolean;",
    command: LANE("stoa-surface"),
  },
  {
    id: "revision-notices-ignore-follows",
    bead: "lu59",
    // Two producers can reach a follower: the synchronous revision producer
    // (FOLLOW_RECIPIENTS_SQL) and the async delivery candidates; the defect
    // "follows are ignored" disables both (the one-edit plant survived).
    file: "apps/wire/src/inbox/follow-access.ts",
    find: "    SELECT f.principal_id FROM problem_follows f JOIN target p ON p.id = f.problem_id",
    replace:
      "    SELECT f.principal_id FROM problem_follows f JOIN target p ON p.id = f.problem_id WHERE 0",
    also: [
      {
        file: "apps/wire/src/inbox/event-delivery.ts",
        find: "          SELECT pf.principal_id FROM source e JOIN problem_follows pf ON pf.problem_id = e.problem_id",
        replace:
          "          SELECT pf.principal_id FROM source e JOIN problem_follows pf ON 0 AND pf.problem_id = e.problem_id",
      },
    ],
    command: LANE("stoa-surface"),
  },
  {
    id: "paused-fellow-credential-accepted",
    bead: "lu59",
    file: "apps/wire/src/enrollment/d1-store.ts",
    find: "AND fellow.status IN ('active', 'suspicious_review')",
    replace: "AND fellow.status IN ('active', 'suspicious_review', 'paused')",
    command: LANE("stoa-surface"),
  },
  {
    id: "membership-read-promotes-observers",
    bead: "lu59",
    file: "apps/wire/src/sessions/router-core.ts",
    find: "    return row?.role;",
    replace: '    return row?.role === "observer" ? "contributor" : row?.role;',
    command: LANE("roster-race"),
  },
  {
    id: "public-face-license-dropped",
    bead: "lu59",
    file: "apps/wire/src/app.ts",
    find: "      isPublicResourceFace(new URL(c.req.url).pathname)",
    replace: "      (false as boolean)",
    command: LANE("face-census"),
  },
  {
    id: "next-membership-read-promotes-observers",
    bead: "lu59",
    file: "apps/wire/src/mega-commands/router.ts",
    find: "      if (membershipRow?.role) {\n        role = membershipRow.role;\n      }",
    replace:
      '      if (membershipRow?.role) {\n        role = membershipRow.role === "observer" ? "contributor" : membershipRow.role;\n      }',
    command: LANE("roster-race"),
  },
  {
    id: "markdown-face-states-wrong-cursor",
    bead: "lu59",
    // A renderer defect: the hypotheses Markdown face states a cursor other
    // than its JSON face (independent verification 4's surviving plant).
    file: "packages/render/src/hypotheses.ts",
    find: "    `Public cursor: ${face.cursor}. Admissions after: ${face.after}.`,",
    replace: "    `Public cursor: ${face.cursor + 7}. Admissions after: ${face.after}.`,",
    command: LANE("face-census"),
  },
  {
    id: "events-markdown-face-missing",
    bead: "lu59",
    file: "apps/wire/src/ledger/event-tail-router.ts",
    find: 'for (const format of ["json", "ndjson", "toon", "md"] as const) {',
    replace: 'for (const format of ["json", "ndjson", "toon"] as const) {',
    command: LANE("face-census"),
  },
  {
    id: "formal-records-unwired",
    bead: "kw85",
    file: "apps/wire/src/sessions/router-core.ts",
    find: '    const formalRecords =\n      profile === "formal"',
    replace: '    const formalRecords =\n      (profile as string) === "PLANTED-never"',
    command: LANE("packs"),
  },
  {
    id: "nonmember-told-it-cannot-join",
    bead: "bbx",
    file: "apps/wire/src/mega-commands/live-provider.ts",
    find: "effectivePermissions: { ...NO_PERMISSIONS, session_open: joinable?.joinable === 1 },",
    replace: "effectivePermissions: { ...NO_PERMISSIONS },",
    command: LANE("stoa-surface"),
  },
  {
    id: "question-refs-unscreened",
    bead: "kqz5",
    file: "apps/wire/src/sessions/router-core.ts",
    find: "        statement: JSON.stringify({\n          body_md: parsed.data.body_md,\n          target_refs: parsed.data.target_refs,\n          blocking: parsed.data.blocking ?? null,\n        }),",
    replace: "        statement: parsed.data.body_md,",
    command: ["node", "apps/wire/test/integration/discovery-real-bindings.mjs", "reject"],
  },
  {
    id: "famous-guardrail-unscreened",
    bead: "kqz5",
    file: "apps/wire/src/problems/router.ts",
    find: 'action.action === "publish" ? (problem.famous_guardrail ?? "") : "",',
    replace: '"",',
    command: LANE("problem-screening"),
  },
  {
    id: "proposed-areas-unscreened",
    bead: "kqz5",
    file: "apps/wire/src/problems/router.ts",
    find: '          action.action === "publish" ? problem.areas : "",',
    replace: '          "",',
    command: LANE("problem-screening"),
  },
  {
    id: "directive-guard-abort-is-500",
    bead: "1e7",
    file: "apps/wire/src/directives/router.ts",
    find: "      if (!isDirectiveNotCommitted(error)) throw error;",
    replace: "      throw error;",
    command: LANE("stoa-surface"),
  },
  {
    id: "inbox-redelivery-duplicates",
    bead: "1e7",
    file: "apps/wire/src/inbox/event-delivery.ts",
    find: "    const id = await inboxNoticeId(input);",
    replace: "    const id = `${await inboxNoticeId(input)}-${crypto.randomUUID()}`.slice(0, 80);",
    also: [
      {
        find: "          WHERE n.fellow_id = f.fellow_id AND n.problem_id = e.problem_id\n            AND n.notice_type = ? AND n.caused_by_event_id = e.id",
        replace:
          "          WHERE 0 AND n.fellow_id = f.fellow_id AND n.problem_id = e.problem_id\n            AND n.notice_type = ? AND n.caused_by_event_id = e.id",
      },
    ],
    command: LANE("stoa-surface"),
  },
  {
    id: "gap-closed-echo-missing",
    bead: "1e7",
    file: "db/migrations/0081_gap_closed_impact_echo.sql",
    find: "WHEN NEW.type = 'gap.closed-by' AND NEW.object_kind = 'gap'",
    replace: "WHEN NEW.type = 'gap.never' AND NEW.object_kind = 'gap'",
    command: LANE("relations-gaps"),
  },
  {
    id: "gap-closed-echo-on-self-closure",
    bead: "1e7",
    file: "db/migrations/0081_gap_closed_impact_echo.sql",
    find: "    AND g.author_fellow_id <> NEW.actor_fellow_id\n",
    replace: "",
    command: LANE("relations-gaps"),
  },
  {
    id: "lease-warning-repeats-per-sweep",
    bead: "1e7",
    file: "apps/wire/src/sessions/lease-warnings.ts",
    find: "  SELECT 'N-lease-expiry-' || l.lease_id || '-' || l.leased_until, l.fellow_id, l.problem_id,",
    replace:
      "  SELECT 'N-lease-expiry-' || l.lease_id || '-' || l.leased_until || '-' || ?, l.fellow_id, l.problem_id,",
    also: [
      {
        find: ".bind(now, lease.lease_id, lease.leased_until, from, until),",
        replace: ".bind(now, now, lease.lease_id, lease.leased_until, from, until),",
      },
    ],
    command: LANE("session-presence"),
  },
  {
    id: "decline-typed-as-request",
    bead: "1e7",
    file: "apps/wire/src/review-requests/store.ts",
    find: '        c.action === "decline" ? "review_decline" : "review_request",',
    replace: '        "review_request",',
    command: LANE("matchmaking"),
  },
  {
    id: "archive-expansion-unbounded",
    bead: "rhg",
    file: "apps/wire/src/krater/cas.ts",
    find: "export const MAX_ARCHIVE_EXPANSION_RATIO = 100;",
    replace: "export const MAX_ARCHIVE_EXPANSION_RATIO = 1_000_000;",
    command: LANE("artifact"),
  },
];

function occurrences(text, snippet) {
  return text.split(snippet).length - 1;
}

/** Replace the nth (1-based) occurrence of `find`. */
function replaceNth(text, find, replace, nth) {
  let index = -1;
  for (let i = 0; i < nth; i++) {
    index = text.indexOf(find, index + 1);
    if (index === -1) throw new Error("plant snippet occurrence missing");
  }
  return text.slice(0, index) + replace + text.slice(index + find.length);
}

/** Every file a plant touches, mapped to its planted text. An `also` edit may
 * name another `file` when one defect spans two code paths. */
function plantedFiles(plant, read) {
  const files = new Map([[plant.file, read(plant.file).replace(plant.find, plant.replace)]]);
  for (const edit of plant.also ?? []) {
    const file = edit.file ?? plant.file;
    const text = files.get(file) ?? read(file);
    files.set(file, replaceNth(text, edit.find, edit.replace, edit.nth ?? 1));
  }
  return files;
}

export function checkPlants(root) {
  const problems = [];
  for (const plant of PLANTS) {
    let text;
    try {
      text = readFileSync(resolve(root, plant.file), "utf8");
    } catch {
      problems.push(`${plant.id}: ${plant.file} is missing`);
      continue;
    }
    const count = occurrences(text, plant.find);
    if (count !== 1) problems.push(`${plant.id}: snippet matches ${count} times in ${plant.file}`);
    for (const edit of plant.also ?? []) {
      let editText = text;
      if (edit.file !== undefined && edit.file !== plant.file) {
        try {
          editText = readFileSync(resolve(root, edit.file), "utf8");
        } catch {
          problems.push(`${plant.id}: ${edit.file} is missing`);
          continue;
        }
      }
      const found = occurrences(editText, edit.find);
      if (found < (edit.nth ?? 1))
        problems.push(
          `${plant.id}: extra edit matches ${found} times, needs occurrence ${edit.nth ?? 1}`,
        );
    }
  }
  return problems;
}

/**
 * A planted run counts as caught only when the proof itself failed: a node
 * assertion or a bun test failure. A timeout, kill, missing module or syntax
 * error means the plant was never judged, so it is "inconclusive", never
 * "caught" (independent verification 3, 2026-09-26).
 */
export function classifyPlantRun({ status, signal, output }) {
  if (status === 0) return "survived";
  if (status === null || signal) return "inconclusive";
  if (
    /Cannot find (module|package)|SyntaxError|ERR_MODULE_NOT_FOUND|error: script .* exited/.test(
      output,
    )
  )
    return "inconclusive";
  // Gate scripts report a typed JSON failure line instead of an assertion.
  if (
    /AssertionError|ERR_ASSERTION|^\(fail\) |^\s*[1-9]\d* fail$|^\{"suite":"[^"]+","status":"fail"/m.test(
      output,
    )
  )
    return "caught";
  return "inconclusive";
}

function runCommand(worktree, command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20 * 60_000,
  });
  // Only the verdict is kept; lane output is classified, never printed.
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function git(worktree, args) {
  return spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
}

function run(worktree, only) {
  const status = git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (status.status !== 0 || status.stdout.trim() !== "") {
    console.error("refusing: the worktree is not a clean git checkout");
    return 2;
  }
  const problems = checkPlants(worktree);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    return 1;
  }
  let notCaught = 0;
  // Control: each proof must pass unplanted in this worktree first, so a
  // planted failure is attributable to the plant and not to the host.
  const controls = new Map();
  for (const plant of PLANTS.filter((p) => only === null || only.includes(p.id))) {
    const key = plant.command.join("\u0000");
    if (!controls.has(key)) {
      const control = runCommand(worktree, plant.command);
      controls.set(key, control.status === 0);
      console.log(
        JSON.stringify({ control: plant.command.slice(1).join(" "), pass: control.status === 0 }),
      );
    }
    if (!controls.get(key)) {
      notCaught += 1;
      console.log(JSON.stringify({ plant: plant.id, bead: plant.bead, verdict: "no-control" }));
      continue;
    }
    const read = (file) => readFileSync(resolve(worktree, file), "utf8");
    const planted = plantedFiles(plant, read);
    const originals = new Map([...planted.keys()].map((file) => [file, read(file)]));
    let run;
    try {
      for (const [file, text] of planted) writeFileSync(resolve(worktree, file), text);
      run = runCommand(worktree, plant.command);
    } finally {
      for (const [file, text] of originals) writeFileSync(resolve(worktree, file), text);
    }
    const verdict = classifyPlantRun(run);
    if (verdict !== "caught") notCaught += 1;
    console.log(JSON.stringify({ plant: plant.id, bead: plant.bead, verdict, exit: run.status }));
  }
  const after = git(worktree, ["status", "--porcelain", "--untracked-files=no"]);
  if (after.stdout.trim() !== "") {
    console.error("restore failed: the worktree is dirty after the run");
    return 1;
  }
  return notCaught === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (args[0] === "--check") {
    const problems = checkPlants(root);
    console.log(JSON.stringify({ plants: PLANTS.length, problems }));
    process.exit(problems.length === 0 ? 0 : 1);
  }
  if (args[0] === "--run" && args[1]) {
    const onlyIndex = args.indexOf("--only");
    const only = onlyIndex > -1 ? (args[onlyIndex + 1] ?? "").split(",") : null;
    if (resolve(args[1]) === root) {
      console.error("refusing: pass a separate git worktree, never the primary checkout");
      process.exit(2);
    }
    process.exit(run(resolve(args[1]), only));
  }
  console.error(
    "usage: node scripts/planted-defects.mjs --check | --run <git-worktree> [--only id,...]",
  );
  process.exit(2);
}
