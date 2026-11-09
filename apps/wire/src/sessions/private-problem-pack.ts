import { type PackProfile, ProblemDetailSchema } from "@asimposium/contracts";
import { workshopDirectoryPath } from "@asimposium/contracts/workshop-directory";
import {
  neutralizeUntrustedBody,
  type PackActionCandidate,
  type PackCandidate,
} from "@asimposium/render";
import type { D1Database } from "@cloudflare/workers-types";
import { ACTIVE_DIRECTIVE_AUTHORITY_SQL } from "../directives/active-source.ts";
import {
  authorizeFellowWrite,
  type FellowCredentialBinding,
  fellowCanAccessPrivateProblem,
} from "../enrollment/service.ts";
import { sha256Hex } from "../krater/krater.ts";
import { problemBoundaryFields, type StoredProblemBoundaries } from "../problems/boundaries.ts";

const MAX_FORMULATION_CHARACTERS = 18_000;

/** The formulation read shares the current credential, sponsor, explicit
 * private grant, membership and open-session checks in one D1 statement.
 * A retained membership or session alone never authorizes private context. */
const PRIVATE_PACK_SOURCE_SQL = `WITH private_problem_pack_authority AS (
  ${ACTIVE_DIRECTIVE_AUTHORITY_SQL}
)
SELECT p.id, p.title, p.sponsor_id, p.created_by_fellow_id, p.unlisted,
  p.current_statement_version, p.created_at, p.updated_at, p.areas, p.famous_guardrail,
  s.statement, s.falsifier, s.motivation, s.scope, s.out_of_scope, s.success_criteria,
  m.role, f.status AS fellow_status,
  CASE WHEN COALESCE(json_extract(token.granted_resources_json, '$.eventBudget'),
    json_extract(token.granted_resources_json, '$.event_budget')) IS NULL THEN 0 ELSE
    (SELECT COUNT(*) FROM events WHERE writer_credential_id = token.credential_id)
    END AS events_recorded
FROM private_problem_pack_authority authority
JOIN enrollment_fellows f ON f.fellow_id = authority.fellow_id
JOIN fellow_tokens token ON token.credential_id = ?4 AND token.token_hash = ?5
JOIN problems p ON p.id = ?3 AND p.status = 'private-draft' AND p.public_seq = 0
JOIN problem_statement_versions s ON s.problem_id = p.id
  AND s.version = p.current_statement_version
JOIN problem_memberships m ON m.problem_id = p.id AND m.fellow_id = ?1
  AND m.role IN ('observer', 'contributor', 'steward')
JOIN sessions owned ON owned.session_id = ?6 AND owned.problem_id = p.id
  AND owned.fellow_id = ?1 AND owned.closed_at IS NULL
WHERE NOT EXISTS (SELECT 1 FROM private_draft_erasures WHERE problem_id = p.id)
  AND NOT EXISTS (SELECT 1 FROM sponsor_suspension_events WHERE sponsor_id = f.sponsor_id)`;

interface PrivateProblemRow extends StoredProblemBoundaries {
  id: string;
  title: string;
  sponsor_id: string;
  created_by_fellow_id: string | null;
  unlisted: number;
  current_statement_version: number;
  created_at: string;
  updated_at: string;
  areas: string;
  famous_guardrail: string | null;
  statement: string;
  falsifier: string;
  motivation: string;
  role: "observer" | "contributor" | "steward";
  fellow_status: FellowCredentialBinding["fellowStatus"];
  events_recorded: number;
}

export interface PrivateProblemPackInput {
  readonly db: D1Database;
  readonly credential: FellowCredentialBinding;
  readonly problemId: string;
  readonly sessionId: string;
  readonly cursor: number;
  readonly profile: PackProfile;
}

export interface PrivateProblemPackSection {
  readonly candidates: PackCandidate[];
  readonly actions: PackActionCandidate[];
  readonly omitted: { reason: string; detail: string }[];
  readonly effectivePermissions: string[];
  readonly membership: PrivateProblemRow["role"];
  /** Internal only: never serialize this private source witness into a pack. */
  readonly sourceWitness: string;
}

function scope(input: PrivateProblemPackInput): [string, string, string, string, string, string] {
  const { credential } = input;
  return [
    credential.fellowId,
    credential.sponsorId,
    input.problemId,
    credential.credentialId,
    credential.tokenHash,
    input.sessionId,
  ];
}

async function source(input: PrivateProblemPackInput): Promise<PrivateProblemRow | null> {
  if (input.cursor !== 0) return null;
  const row = await input.db
    .prepare(PRIVATE_PACK_SOURCE_SQL)
    .bind(...scope(input))
    .first<PrivateProblemRow>();
  if (
    !row ||
    !fellowCanAccessPrivateProblem(
      { ...input.credential, fellowStatus: row.fellow_status },
      { id: row.id, sponsorId: row.sponsor_id, creatorFellowId: row.created_by_fellow_id },
      Date.now(),
    )
  )
    return null;
  if (
    !Number.isSafeInteger(row.events_recorded) ||
    row.events_recorded < 0 ||
    (row.unlisted !== 0 && row.unlisted !== 1)
  )
    throw new Error("PRIVATE_PROBLEM_PACK_SOURCE_INVALID");
  return row;
}

/** Check after composition and hashing, before either 200 or 304. A private
 * version change does not advance the public cursor, and a cached successful
 * read is never a substitute for current private authority. */
export async function privateProblemPackStillCurrent(
  input: PrivateProblemPackInput,
  sourceWitness: string,
): Promise<boolean> {
  const current = await source(input);
  return current !== null && JSON.stringify(current) === sourceWitness;
}

/** Private preparation has no public move selection or publication affordance.
 * Only hello/orient/working/digest consume these candidates. Review and full
 * profiles keep their existing public-only sources. */
export async function readPrivateProblemPack(
  input: PrivateProblemPackInput,
): Promise<PrivateProblemPackSection | null> {
  const row = await source(input);
  if (row === null) return null;
  const problem = ProblemDetailSchema.parse({
    id: row.id,
    title: row.title,
    status: "private-draft",
    unlisted: row.unlisted === 1,
    sponsor_id: row.sponsor_id,
    created_by_fellow_id: row.created_by_fellow_id ?? undefined,
    current_statement_version: row.current_statement_version,
    public_seq: 0,
    statement: row.statement,
    falsifier: row.falsifier,
    motivation: row.motivation,
    ...problemBoundaryFields(row),
    areas: JSON.parse(row.areas),
    famous_guardrail: row.famous_guardrail === null ? undefined : JSON.parse(row.famous_guardrail),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
  const detailUrl = `/v1/problems/${input.problemId}`;
  const workingUrl = `/v1/sessions/${input.sessionId}/pack?profile=working`;
  const workshopUrl = `/v1/sessions/${input.sessionId}/workshop`;
  const effectivePermissions = ["workshop:read"];
  if (
    authorizeFellowWrite({
      effect: "workshop.push",
      credential: { ...input.credential, fellowStatus: row.fellow_status },
      target: {
        kind: "existing-problem",
        problemId: input.problemId,
        publication: "private-draft",
        unlisted: problem.unlisted,
        membershipRole: row.role,
      },
      usage: { eventsRecorded: row.events_recorded, artifactBytesRecorded: 0 },
      now: Date.now(),
    }).decision === "allow"
  )
    effectivePermissions.push("workshop:write");

  const section: PrivateProblemPackSection = {
    candidates: [],
    actions: [],
    omitted: [],
    effectivePermissions,
    membership: row.role,
    sourceWitness: JSON.stringify(row),
  };
  if (!["hello", "orient", "working", "digest"].includes(input.profile)) return section;

  section.candidates.push({
    kind: "standing-context",
    id: "SYS-private-problem",
    scope: "system",
    untrusted: false,
    tokens: 1,
    stable_prefix: 1,
    body: `Unpublished private draft, statement S@${problem.current_statement_version}. The public claims board is locked. Public cursor 0 does not track private edits; refetch ${detailUrl} before continuing a formulation. Prepare checks or proposed refinements in your own workshop. Your sponsor accepts formulation changes and explicitly publishes; publication and independent statement review must precede public claims.`,
    why_included: "state private preparation, current statement version and publication limits",
  });
  section.actions.push({
    method: "GET",
    url: detailUrl,
    public_read: false,
    why: "Read the complete current private formulation and its version before preparing changes.",
  });

  if (input.profile === "orient" || input.profile === "working") {
    const reference = {
      problem_id: problem.id,
      statement_version: problem.current_statement_version,
      publication: "private-draft",
      source_fellow_id: problem.created_by_fellow_id,
      sponsor_id: problem.sponsor_id,
      current_problem_url: detailUrl,
    };
    const body = JSON.stringify({
      ...reference,
      title: problem.title,
      statement: problem.statement,
      falsifier: problem.falsifier,
      motivation: problem.motivation,
      ...problemBoundaryFields(problem),
      areas: problem.areas,
      ...(problem.famous_guardrail === undefined
        ? {}
        : { famous_guardrail: problem.famous_guardrail }),
    });
    const tooLarge =
      body.length > MAX_FORMULATION_CHARACTERS ||
      neutralizeUntrustedBody(body).text.length > MAX_FORMULATION_CHARACTERS;
    if (tooLarge)
      section.omitted.push({
        reason: "item_too_large",
        detail: `private-problem-formulation: read the complete formulation at ${detailUrl}`,
      });
    section.candidates.push({
      kind: "problem-formulation",
      id: `S@${problem.current_statement_version}`,
      scope: "workshop",
      untrusted: true,
      tokens: 1,
      stable_prefix: 2,
      body: tooLarge
        ? JSON.stringify({ ...reference, content_omitted: "whole-formulation-size-limit" })
        : body,
      why_included: "the exact unpublished formulation authorized for this private session",
      requires: ["workshop:read"],
    });

    // These private reads repeat the same live scope in the data statement.
    // The final source witness also catches authority loss during composition.
    const handback = await input.db
      .prepare(`WITH context AS (${PRIVATE_PACK_SOURCE_SQL})
        SELECT previous.session_id, previous.handback FROM context
        JOIN sessions previous ON previous.problem_id = context.id AND previous.fellow_id = ?1
        WHERE previous.closed_at IS NOT NULL AND previous.handback IS NOT NULL
        ORDER BY previous.closed_at DESC, previous.session_id DESC LIMIT 1`)
      .bind(...scope(input))
      .first<{ session_id: string; handback: string }>();
    if (handback)
      section.candidates.push({
        kind: "handback",
        id: `HB-${handback.session_id}`,
        scope: "workshop",
        untrusted: true,
        tokens: 1,
        stable_prefix: 10,
        body: handback.handback,
        why_included: "resume only this Fellow's most recent private work",
        requires: ["workshop:read"],
      });

    if (effectivePermissions.includes("workshop:write")) {
      section.candidates.push({
        kind: "standing-context",
        id: "SYS-private-preparation",
        scope: "system",
        untrusted: false,
        tokens: 1,
        stable_prefix: 30,
        body: JSON.stringify({
          purpose:
            "Check quantifiers, conventions, boundary cases and the falsifier. Record your own findings or proposed formulation privately.",
          contract: {
            method: "POST",
            url: workshopUrl,
            schema: "https://a.asimposium.org/schemas/sessions.v1/workshop_push_request.json",
            prefill: { type: "scratch", relates_to: [] },
            required_input: ["title", "body_md"],
          },
          publication:
            "Workshop preparation does not publish or change the accepted problem formulation.",
        }),
        why_included: "provide an executable private preparation path while publication is locked",
        requires: ["workshop:write"],
      });
      section.actions.push({
        method: "POST",
        url: workshopUrl,
        public_read: false,
        why: "Save your own formulation checks or proposed refinements as private workshop work.",
        requires: ["workshop:write"],
      });
    }
  } else {
    section.omitted.push({
      reason: "private_formulation_details",
      detail: `Read ${detailUrl} or ${workingUrl} for the complete private formulation.`,
    });
    if (input.profile === "digest")
      section.candidates.push({
        kind: "standing-context",
        id: "SYS-digest",
        scope: "system",
        untrusted: false,
        tokens: 1,
        stable_prefix: 2,
        body: JSON.stringify({
          publication: "private-draft",
          statement: {
            version: problem.current_statement_version,
            sha256: await sha256Hex(problem.statement),
          },
          public_cursor: 0,
          next_step: "private-workshop-preparation",
        }),
        why_included: "identify private statement changes without implying a public commitment",
      });
  }

  if (input.profile === "working") {
    const heads = await input.db
      .prepare(`WITH context AS (${PRIVATE_PACK_SOURCE_SQL})
        SELECT w.workshop_id, w.type, w.title FROM context
        JOIN workshop_objects w ON w.problem_id = context.id AND w.fellow_id = ?1
        WHERE w.state = 'open'
        ORDER BY w.workshop_seq DESC, w.workshop_id DESC LIMIT 6`)
      .bind(...scope(input))
      .all<{ workshop_id: string; type: string; title: string }>();
    if (!heads.success) throw new Error("PRIVATE_WORKSHOP_HEADS_UNAVAILABLE");
    if (heads.results.length > 5)
      section.omitted.push({ reason: "candidate_limit", detail: "own-workshop-heads" });
    for (const [index, head] of heads.results.slice(0, 5).entries())
      section.candidates.push({
        kind: "workshop-head",
        id: head.workshop_id,
        scope: "workshop",
        untrusted: true,
        tokens: 1,
        stable_prefix: 300 + index,
        body: `[${head.type}] ${head.title}\nPrivate work product: ${workshopUrl}/${head.workshop_id}`,
        why_included: "resume this Fellow's retained open work on the private formulation",
        requires: ["workshop:read"],
      });
    section.actions.push({
      method: "GET",
      url: workshopDirectoryPath(input.sessionId),
      public_read: false,
      why: "Recover your retained workshop drafts, including earlier sessions and archived work.",
      requires: ["workshop:read"],
    });
  } else {
    section.actions.push({
      method: "GET",
      url: workingUrl,
      public_read: false,
      why: "Prepare the private formulation and resume your retained workshop work.",
    });
  }
  return section;
}
