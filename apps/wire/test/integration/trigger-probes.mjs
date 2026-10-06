import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * W2.1 (asimposiumorg-jfi): ledger immutability triggers proven by behaviour on
 * real local D1, not by name.
 *
 * A guard trigger is a BEFORE UPDATE/DELETE trigger whose whole body is
 * `SELECT RAISE(ABORT, '...')`. It is probed when its WHEN is absent, constant
 * (a neutering `WHEN 0` guards nothing, so it is probed as unconditional) or
 * reads only OLD (the probe picks a row the condition covers). A WHEN that
 * reads NEW is a transition rule, not immutability, and is not probed here;
 * the events envelope trigger is the exception (its probe moves seq).
 *
 * Probe ids: a DELETE or plain UPDATE trigger is probed as `name`; an
 * `UPDATE OF a, b` trigger once per guarded column, as `name:a`, `name:b`, so
 * a trigger cut down to fewer columns leaves the others writable and fails.
 * Every probe must be refused with the trigger's own RAISE message.
 *
 * trigger-probe-coverage.json lists, per lane, the probe ids that lane must
 * reach, so a trigger that silently stops being probed (an unsatisfiable WHEN,
 * a lane that no longer writes the row) fails that lane. Ids may be added
 * freely; removing one needs a stated reason in the same commit.
 */

const PURE_RAISE_BODY =
  /\bBEGIN\s+SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*'([^']+)'\s*\)\s*;\s*END\s*;?\s*$/i;

/** How a trigger is probed, or why it is not ({ kind: "skip", reason }). */
export function classifyGuardTrigger(name, table, sql) {
  const operation = /\bBEFORE\s+(UPDATE|DELETE)\b/i.exec(sql)?.[1]?.toUpperCase();
  if (operation === undefined) return { kind: "skip", reason: "not-before-update-or-delete" };
  const message = PURE_RAISE_BODY.exec(sql)?.[1];
  if (message === undefined) return { kind: "skip", reason: "conditional-body" };
  const clause = /\bWHEN\b([\s\S]*?)\bBEGIN\b/i.exec(sql)?.[1];
  const readsRow = clause !== undefined && /\b(OLD|NEW)\./.test(clause);
  if (readsRow && /\bNEW\./.test(clause) && table !== "events") {
    return { kind: "skip", reason: "transition-rule" };
  }
  const filter = readsRow && table !== "events" ? clause.replace(/\bOLD\./g, "probe_row.") : "1";
  if (operation === "DELETE") return { kind: "delete", name, table, message, filter, ids: [name] };
  if (table === "events") {
    return { kind: "events-update", name, table, message, filter, ids: [name] };
  }
  const of = /\bUPDATE\s+OF\s+([\s\S]*?)\s+ON\b/i.exec(sql)?.[1];
  const columns = of === undefined ? null : of.split(",").map((column) => column.trim());
  return {
    kind: "update",
    name,
    table,
    message,
    filter,
    columns,
    ids: columns === null ? [name] : columns.map((column) => `${name}:${column}`),
  };
}

/**
 * Refusing BEFORE UPDATE/DELETE triggers (transition rules included), each
 * digested over its SQL with comments and whitespace normalized. The unit test
 * compares these with the reviewed pins in trigger-probe-coverage.json.
 */
export function refusingTriggerDigests(triggers) {
  return Object.fromEntries(
    triggers
      .filter(
        (trigger) =>
          /\bBEFORE\s+(UPDATE|DELETE)\b/i.test(trigger.sql) && /\bRAISE\s*\(/i.test(trigger.sql),
      )
      .map((trigger) => [
        trigger.name,
        createHash("sha256")
          .update(
            trigger.sql
              .replace(/--[^\n]*/g, "")
              .replace(/\s+/g, " ")
              .trim(),
          )
          .digest("hex"),
      ])
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

const COVERAGE = JSON.parse(
  readFileSync(new URL("./trigger-probe-coverage.json", import.meta.url), "utf8"),
);

export async function assertLedgerTriggersRefuse(db, lane) {
  const triggers = (
    await db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
      .all()
  ).results;
  const probed = [];
  const accepted = [];
  const refusedOtherwise = [];
  let skippedTransitionRules = 0;
  const attempt = async (id, statement, message) => {
    probed.push(id);
    try {
      await statement.run();
      accepted.push(id);
    } catch (error) {
      // Refused, but by this trigger? A foreign key or another trigger can
      // refuse the same statement (every event has dependent rows), which would
      // hide a neutered trigger. The refusal must carry its own RAISE message.
      if (!String(error?.message ?? error).includes(message)) refusedOtherwise.push(id);
    }
  };
  for (const { name, tbl_name: table, sql } of triggers) {
    const probe = classifyGuardTrigger(name, table, sql);
    if (probe.kind === "skip") {
      if (probe.reason === "transition-rule") skippedTransitionRules += 1;
      continue;
    }
    const row = await db
      .prepare(`SELECT rowid AS rid, * FROM ${table} AS probe_row WHERE ${probe.filter} LIMIT 1`)
      .first();
    if (row === null) continue;
    if (probe.kind === "delete") {
      await attempt(
        name,
        db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).bind(row.rid),
        probe.message,
      );
    } else if (probe.kind === "events-update") {
      await attempt(
        name,
        db.prepare("UPDATE events SET seq = seq + 1000000 WHERE rowid = ?").bind(row.rid),
        probe.message,
      );
    } else {
      const columns = probe.columns ?? [Object.keys(row).find((key) => key !== "rid")];
      for (const column of columns) {
        await attempt(
          probe.columns === null ? name : `${name}:${column}`,
          db.prepare(`UPDATE ${table} SET ${column} = ${column} WHERE rowid = ?`).bind(row.rid),
          probe.message,
        );
      }
    }
  }
  const required = COVERAGE.lanes[lane];
  const missing = required === undefined ? [] : required.filter((id) => !probed.includes(id));
  console.log(
    JSON.stringify({
      stage: "ledger-trigger-probes",
      lane,
      probed,
      accepted,
      refused_otherwise: refusedOtherwise,
      coverage_missing: missing,
      coverage_known: required !== undefined,
      skipped_transition_rules: skippedTransitionRules,
    }),
  );
  assert.deepEqual(accepted, [], "every guard trigger refuses its probe");
  assert.deepEqual(refusedOtherwise, [], "each probe is refused by its own trigger");
  assert.deepEqual(missing, [], "this lane still probes every trigger its coverage lists");
}
