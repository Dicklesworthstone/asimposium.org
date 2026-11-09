/** Durable replay for signed operator commands, bound to the current operator.
 * The receipt is the last statement in the decision's transaction. Its unique
 * key aborts a concurrent losing transaction, including all earlier effects.
 * Replaying a receipt never reapplies a control, even after a later restoration.
 */
import { canonicalJson } from "@asimposium/contracts";
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { validatedProblem } from "../http/envelope.ts";

type Operation = "quarantine" | "report" | "content-control";
type Receipt = { readonly ok: true; readonly audit_event_id: string };

export interface OperatorCommand {
  readonly operatorId: string;
  readonly keyDigest: string;
  readonly operation: Operation;
  readonly requestDigest: string;
  readonly receipt: (auditEventId: string, timestamp: string) => Receipt;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function success(body: Receipt): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

function replayConflict(): Response {
  return validatedProblem({
    status: 409,
    code: "IDEMPOTENCY_CONFLICT",
    title: "This replay key already identifies a different operator command",
    detail: "Nothing was changed by this request. The original receipt belongs to another intent.",
    fixHint:
      "Retry the original action, target and reason with the original key. Review the current state before submitting a different decision with a new key.",
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/screening.v1.json",
      example: { headers: { "Idempotency-Key": "admin-original-command" } },
    },
    headers: { "cache-control": "private, no-store" },
  });
}

/** Internal callers without a command keep their existing atomic store path.
 * Mounted operator routes always supply one. Guard against this attempt's
 * audit ID, never an equal timestamp or a different successful operator. */
export function operatorReceiptStatements(
  db: D1Database,
  command: OperatorCommand | undefined,
  auditEventId: string,
  timestamp: string,
): D1PreparedStatement[] {
  if (command === undefined) return [];
  const receipt = command.receipt(auditEventId, timestamp);
  return [
    db
      .prepare(`INSERT INTO operator_command_receipts
        (operator_id, key_digest, operation, request_digest, audit_event_id, receipt_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM operator_audit WHERE event_id = ?)`)
      .bind(
        command.operatorId,
        command.keyDigest,
        command.operation,
        command.requestDigest,
        auditEventId,
        JSON.stringify(receipt),
        timestamp,
        auditEventId,
      ),
  ];
}

/** Authentication and strict request validation happen before this boundary.
 * Each retry must carry a newly verified service envelope; a product receipt
 * cannot stand in for current operator authority. */
export async function runOperatorCommand(
  db: D1Database,
  input: {
    readonly operatorId: string;
    readonly key: string;
    readonly operation: Operation;
    readonly request: unknown;
    readonly receipt: OperatorCommand["receipt"];
    readonly parseReceipt: (value: unknown) => Receipt;
  },
  execute: (command: OperatorCommand) => Promise<Response>,
): Promise<Response> {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(input.key)) throw new Error("OPERATOR_COMMAND_KEY_INVALID");
  const command: OperatorCommand = {
    operatorId: input.operatorId,
    keyDigest: await digest(input.key),
    operation: input.operation,
    requestDigest: await digest(
      canonicalJson({ operation: input.operation, request: input.request }),
    ),
    receipt: input.receipt,
  };
  const read = async (): Promise<Response | null> => {
    const saved = await db
      .prepare(`SELECT operation, request_digest, audit_event_id, receipt_json
        FROM operator_command_receipts WHERE operator_id = ? AND key_digest = ?`)
      .bind(command.operatorId, command.keyDigest)
      .first<{
        operation: string;
        request_digest: string;
        audit_event_id: string;
        receipt_json: string;
      }>();
    if (saved === null) return null;
    if (saved.operation !== command.operation || saved.request_digest !== command.requestDigest)
      return replayConflict();
    const receipt = input.parseReceipt(JSON.parse(saved.receipt_json));
    if (receipt.audit_event_id !== saved.audit_event_id)
      throw new Error("OPERATOR_COMMAND_RECEIPT_INVALID");
    return success(receipt);
  };

  const previous = await read();
  if (previous !== null) return previous;
  try {
    const response = await execute(command);
    // Covers both a lost response and a concurrently won compare-and-swap.
    const committed = await read();
    if (committed !== null) return committed;
    if (response.ok) throw new Error("OPERATOR_COMMAND_RECEIPT_MISSING");
    return response;
  } catch (error) {
    const concurrent = await read();
    if (concurrent !== null) return concurrent;
    throw error;
  }
}
