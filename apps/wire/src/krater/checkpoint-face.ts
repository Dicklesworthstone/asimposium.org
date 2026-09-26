/**
 * Public signed-checkpoint faces (Fable §10, ADR-23; bead asimposiumorg-10lz):
 * GET /p/:id/checkpoints.json and .md. Reads are free: no auth, strong ETags,
 * 304 on If-None-Match. Private drafts are not public. The face lists the
 * configured verification keys, the stored signatures (paged, 500 at a time),
 * and how many published checkpoints have no signature yet, so an unsigned
 * state is disclosed rather than implied away.
 */
import {
  CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
  type CheckpointSignaturesResponse,
  CheckpointSignaturesResponseSchema,
} from "@asimposium/contracts";
import { type Context, Hono } from "hono";
import type { Env } from "../env";
import { checkpointVerifyKeys } from "./checkpoint-signing.ts";

const PAGE = 500;
const PROBLEM = /^P-[A-Z0-9][A-Z0-9-]{1,40}$/;

async function strongEtag(face: string, body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${face}\n${body}`),
  );
  return `"${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function matches(header: string | null, etag: string): boolean {
  return (
    header?.split(",").some((candidate) => {
      const value = candidate.trim();
      return value === "*" || value === etag || value === `W/${etag}`;
    }) ?? false
  );
}

function readFace(
  env: Env,
  problemId: string,
  after: number,
): Promise<CheckpointSignaturesResponse | null> {
  return readCheckpointSignatures(env.DB, env.CHECKPOINT_VERIFY_KEYS, problemId, after);
}

/** One page of the public checkpoint-signature face; null for a missing or
 * private problem. Shared by the HTTP face and the backup writer. */
export async function readCheckpointSignatures(
  db: Env["DB"],
  verifyKeysRaw: string | undefined,
  problemId: string,
  after: number,
): Promise<CheckpointSignaturesResponse | null> {
  const problem = await db
    .prepare("SELECT status FROM problems WHERE id = ?")
    .bind(problemId)
    .first<{ status: string }>();
  if (problem === null || problem.status === "private-draft") return null;
  const keys = checkpointVerifyKeys(verifyKeysRaw);
  const rows = await db
    .prepare(
      `SELECT s.checkpoint_seq, c.root_chain_digest, c.checkpoint_digest, s.key_id, s.signature, s.signed_at
       FROM checkpoint_signatures s
       JOIN checkpoint_chain_v2 c ON c.problem_id = s.problem_id AND c.checkpoint_seq = s.checkpoint_seq
      WHERE s.problem_id = ? AND s.checkpoint_seq > ?
      ORDER BY s.checkpoint_seq, s.key_id LIMIT ?`,
    )
    .bind(problemId, after, PAGE + 1)
    .all<{
      checkpoint_seq: number;
      root_chain_digest: string;
      checkpoint_digest: string;
      key_id: string;
      signature: string;
      signed_at: string;
    }>();
  const page = (rows.results ?? []).slice(0, PAGE);
  const unsigned = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM checkpoint_chain_v2 c
      WHERE c.problem_id = ? AND NOT EXISTS (
        SELECT 1 FROM checkpoint_signatures s
         WHERE s.problem_id = c.problem_id AND s.checkpoint_seq = c.checkpoint_seq)`,
    )
    .bind(problemId)
    .first<{ n: number }>();
  return CheckpointSignaturesResponseSchema.parse({
    problem_id: problemId,
    message_format: CHECKPOINT_SIGNATURE_MESSAGE_FORMAT,
    keys: keys.map((key) => ({
      key_id: key.kid,
      algorithm: "Ed25519",
      public_key: key.publicKeyHex,
    })),
    signatures: page.map((row) => ({ ...row, algorithm: "Ed25519" })),
    unsigned: Number(unsigned?.n ?? 0),
    next_after:
      (rows.results ?? []).length > PAGE ? (page[page.length - 1]?.checkpoint_seq ?? null) : null,
  });
}

/** Every signature page merged into one face (next_after null), as a mirror
 * or backup stores it beside an export for offline verification. */
export async function readAllCheckpointSignatures(
  db: Env["DB"],
  verifyKeysRaw: string | undefined,
  problemId: string,
): Promise<CheckpointSignaturesResponse | null> {
  const first = await readCheckpointSignatures(db, verifyKeysRaw, problemId, 0);
  if (first === null) return null;
  const signatures = [...first.signatures];
  let next = first.next_after;
  while (next !== null) {
    const page = await readCheckpointSignatures(db, verifyKeysRaw, problemId, next);
    if (page === null) return null;
    signatures.push(...page.signatures);
    next = page.next_after;
  }
  return CheckpointSignaturesResponseSchema.parse({ ...first, signatures, next_after: null });
}

function markdown(face: CheckpointSignaturesResponse): string {
  const lines = [
    `# Signed integrity checkpoints for ${face.problem_id}`,
    "",
    `Each signature is Ed25519 over \`${face.message_format}\`, problem, sequence, root chain digest and checkpoint digest, joined by newlines.`,
    `Checkpoints without a signature: ${face.unsigned}.`,
    "",
    "## Verification keys",
    ...(face.keys.length === 0
      ? ["No verification keys are configured on this deployment."]
      : face.keys.map((key) => `- ${key.key_id}: ${key.algorithm} ${key.public_key}`)),
    "",
    "## Signatures",
    ...(face.signatures.length === 0
      ? ["None yet."]
      : face.signatures.map(
          (s) =>
            `- seq ${s.checkpoint_seq} key ${s.key_id}: root ${s.root_chain_digest} checkpoint ${s.checkpoint_digest} signature ${s.signature}`,
        )),
    ...(face.next_after === null
      ? []
      : ["", `More: /p/${face.problem_id}/checkpoints.md?after=${face.next_after}`]),
    "",
  ];
  return lines.join("\n");
}

export function createCheckpointFaceRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const serve = (format: "json" | "md") => async (c: Context<{ Bindings: Env }>) => {
    const problemId = c.req.param("id") ?? "";
    const afterRaw = new URL(c.req.url).searchParams.get("after");
    const after = afterRaw === null ? 0 : Number(afterRaw);
    if (!PROBLEM.test(problemId) || !Number.isSafeInteger(after) || after < 0) {
      return c.json(
        {
          type: "https://asimposium.org/errors/SCHEMA_INVALID",
          title: "Invalid checkpoint face request",
          status: 400,
          code: "SCHEMA_INVALID",
          detail: "Use a problem id and an optional nonnegative integer `after`.",
          fix_hint: `GET /p/P-4DSP/checkpoints.${format}?after=0`,
        },
        400,
      );
    }
    const face = await readFace(c.env, problemId, after);
    if (face === null) {
      return c.json(
        {
          type: "https://asimposium.org/errors/PROBLEM_NOT_FOUND",
          title: "No such public problem",
          status: 404,
          code: "PROBLEM_NOT_FOUND",
          detail: "No public problem has this id.",
          fix_hint: "Find public problems at /problems.json.",
        },
        404,
      );
    }
    const body = format === "json" ? `${JSON.stringify(face, null, 2)}\n` : markdown(face);
    const etag = await strongEtag(format, body);
    const headers = {
      etag,
      "cache-control": "public, max-age=0, must-revalidate",
      "content-type":
        format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
    };
    if (matches(c.req.header("if-none-match") ?? null, etag)) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": headers["cache-control"] },
      });
    }
    return new Response(body, { status: 200, headers });
  };
  app.get("/p/:id/checkpoints.json", serve("json"));
  app.get("/p/:id/checkpoints.md", serve("md"));
  return app;
}
