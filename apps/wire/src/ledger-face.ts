import {
  ClaimFaceQuerySchema,
  ClaimFaceResponseSchema,
  EnrollmentDeclaredRuntimeSchema,
  ProblemDetailSchema,
  ProblemFaceResponseSchema,
  ProblemGovernanceEventSchema,
  type ProblemIndexEntry,
  ProblemIndexTimestampSchema,
  ProblemStatementReviewEventSchema,
  type ProblemsIndexResponse,
  ProblemsIndexResponseSchema,
  PublicClaimStateSchema,
  PublicClaimTargetSchema,
  PublicLedgerProblemIdSchema,
} from "@asimposium/contracts";
import {
  type ComposedPack,
  composePack,
  type Projection,
  type RenderedFace,
  renderAllFaces,
  renderProjection,
  safeCodeSpan,
} from "@asimposium/render";
import { Hono } from "hono";

import type { Env } from "./env";
import { validatedProblem as problemDocument } from "./http/envelope";
import { bibtexForClaim, CitationInputError, citeKeyFor, cslForClaim } from "./krater/citation";
import { readEvents, sha256Hex } from "./krater/krater";
import { PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL } from "./krater/public-content";
import { displayClaimDisposition } from "./ledger/dispositions";
import { checkedScientificPayload, ScientificInputError } from "./ledger/scientific-checks";
import { readPublicClaimSnapshot } from "./sessions/ledger-pack";

/**
 * Public ledger read faces. JSON is canonical; Markdown is the reading face.
 * Rows come from Krater's public projections directly, so an empty ledger
 * answers honestly and every bounded digest declares what it omitted.
 */
const OMITTED = [
  "problem statements and scientific details are available through each problem digest",
  "private and unlisted problems are excluded",
];
const INDEX_PREAMBLE =
  "Titles are untrusted Fellow-supplied data. Status records the problem lifecycle, not scientific certainty.";

type ProblemIndexMarkdownFieldDescriptor<K extends keyof ProblemIndexEntry> = Readonly<{
  key: K;
  render: (value: ProblemIndexEntry[K]) => string;
  renderEntry: (entry: ProblemIndexEntry) => string;
}>;

function defineProblemIndexMarkdownField<K extends keyof ProblemIndexEntry>(
  key: K,
  render: (value: ProblemIndexEntry[K]) => string,
): ProblemIndexMarkdownFieldDescriptor<K> {
  return {
    key,
    render,
    renderEntry: (entry) => render(entry[key]),
  };
}

export const PROBLEM_INDEX_MARKDOWN_FIELD_DESCRIPTORS = [
  defineProblemIndexMarkdownField("id", (value) => `- \`${value}\``),
  defineProblemIndexMarkdownField("public_seq", (value) => ` — seq ${value}`),
  defineProblemIndexMarkdownField("created_at", (value) => `, opened ${value}`),
  defineProblemIndexMarkdownField("updated_at", (value) => `, updated ${value}`),
  defineProblemIndexMarkdownField("title", (value) =>
    value === null ? "; title unavailable" : `; title (untrusted) ${safeCodeSpan(value)}`,
  ),
  defineProblemIndexMarkdownField("status", (value) => `; status ${value}`),
] as const;

const PROBLEM_INDEX_SELECT = `SELECT ${PROBLEM_INDEX_MARKDOWN_FIELD_DESCRIPTORS.map(
  ({ key }) => key,
).join(
  ", ",
)} FROM problems WHERE status != 'private-draft' AND unlisted = 0 ORDER BY id ASC LIMIT 201`;

function renderProblemIndexMarkdownRow(problem: ProblemIndexEntry): string {
  return PROBLEM_INDEX_MARKDOWN_FIELD_DESCRIPTORS.map(({ renderEntry }) =>
    renderEntry(problem),
  ).join("");
}

const PUBLIC_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const UNLISTED_NOTICE =
  "Unlisted: this URL is guessable and public, not private. It is excluded from discovery.";

function indexingHeaders(unlisted: boolean): Record<string, string> {
  return unlisted ? { "x-robots-tag": "noindex, nofollow" } : {};
}
const PROBLEM_DIGEST_CANDIDATE_LIMIT = 200;
const PROBLEM_DIGEST_TOKEN_BUDGET = 4_000;
const STATEMENT_REVIEW_LIMIT = 20;
const PROBLEM_DIGEST_SELECT = `SELECT
  p.id AS problem_id,
  p.public_seq AS public_seq,
  p.unlisted AS unlisted,
  p.status AS status,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY claims.source_seq ASC, claims.id ASC) = 1
    AND v.version IS NOT NULL THEN json_object(
      'title', p.title, 'current_statement_version', v.version,
      'statement', v.statement, 'falsifier', v.falsifier, 'motivation', v.motivation
    ) END AS formulation_json,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY claims.source_seq ASC, claims.id ASC) = 1 THEN (
    SELECT json_group_array(json(review_json)) FROM (
      SELECT json_object(
        'version', r.version, 'reviewer', r.reviewer_fellow_id, 'verdict', r.verdict,
        'basis', CASE WHEN length(CAST(r.basis AS BLOB)) <= 32768 THEN r.basis END,
        'created_at', r.created_at, 'event_id', e.id, 'seq', e.seq,
        'fellow', e.actor_fellow_id, 'sponsor', e.actor_sponsor_id,
        'session', e.actor_session_id, 'model', e.model_string_self_declared,
        'harness', e.harness, 'event_created_at', e.created_at,
        'payload_sha256', e.payload_sha256,
        'payload_json', CASE WHEN c.redacted_at IS NULL
          AND c.payload_sha256 = e.payload_sha256
          AND length(CAST(c.payload_json AS BLOB)) <= 65536 THEN c.payload_json END
      ) AS review_json
      FROM problem_statement_reviews r
      LEFT JOIN events e ON e.id = (
        SELECT source.id FROM events source
        WHERE source.problem_id = p.id AND source.object_id = p.id
          AND source.object_kind = 'problem' AND source.type = 'problem.statement-reviewed'
          AND source.object_version = r.version AND source.actor_fellow_id = r.reviewer_fellow_id
          AND source.seq <= p.public_seq
        ORDER BY source.seq ASC LIMIT 1
      )
      LEFT JOIN event_content c ON c.event_id = e.id
      WHERE r.problem_id = p.id
      ORDER BY e.seq IS NULL, e.seq ASC, r.version ASC, r.reviewer_fellow_id ASC
      LIMIT ${STATEMENT_REVIEW_LIMIT + 1}
    )
  ) END AS statement_reviews_json,
  CASE WHEN ROW_NUMBER() OVER (ORDER BY claims.source_seq ASC, claims.id ASC) = 1 THEN (
    SELECT json_object('seq', re.seq, 'sponsor', re.actor_sponsor_id,
      'version', re.object_version, 'created_at', re.created_at,
      'payload_sha256', re.payload_sha256,
      'payload_json', CASE WHEN rc.redacted_at IS NULL
        AND rc.payload_sha256 = re.payload_sha256
        AND length(CAST(rc.payload_json AS BLOB)) <= 65536 THEN rc.payload_json END,
      'target_json', CASE WHEN tc.redacted_at IS NULL AND tc.payload_sha256 = te.payload_sha256
        AND length(CAST(tc.payload_json AS BLOB)) <= 65536 THEN tc.payload_json END,
      'target_id', te.object_id, 'target_version', te.object_version,
      'target_digest', te.payload_sha256, 'target_content_digest', tv.content_digest)
    FROM events re LEFT JOIN event_content rc ON rc.event_id = re.id
    LEFT JOIN events te ON te.id = json_extract(rc.payload_json, '$.problem.result_claim.event_id')
      AND te.problem_id = re.problem_id AND te.object_kind = 'claim'
      AND te.type IN ('claim.created', 'claim.revised') AND te.seq < re.seq
    LEFT JOIN event_content tc ON tc.event_id = te.id
    LEFT JOIN claim_versions tv ON tv.problem_id = te.problem_id AND tv.claim_id = te.object_id
      AND tv.version = te.object_version
    WHERE re.problem_id = p.id AND re.object_id = p.id AND re.object_kind = 'problem'
      AND re.type = 'problem.result-review-started' AND re.seq <= p.public_seq
    ORDER BY re.seq DESC LIMIT 1
  ) END AS result_review_json,
  claims.id AS claim_id,
  CASE WHEN ${PUBLIC_CLAIM_CONTENT_AVAILABLE_SQL} THEN claims.statement END AS statement,
  claims.source_seq AS source_seq
FROM problems p
LEFT JOIN problem_statement_versions v
  ON v.problem_id = p.id AND v.version = p.current_statement_version
LEFT JOIN claims
  ON claims.problem_id = p.id
 AND claims.source_seq <= p.public_seq
WHERE p.id = ? AND p.status != 'private-draft'
ORDER BY claims.source_seq ASC, claims.id ASC
LIMIT ${PROBLEM_DIGEST_CANDIDATE_LIMIT + 1}`;

interface ProblemDigestRow {
  readonly problem_id: string;
  readonly public_seq: number;
  readonly unlisted: number;
  readonly status: string;
  readonly formulation_json: string | null;
  readonly statement_reviews_json: string | null;
  readonly result_review_json: string | null;
  readonly claim_id: string | null;
  readonly statement: string | null;
  readonly source_seq: number | null;
}

interface ProblemFaceFaces {
  readonly json: RenderedFace;
  readonly markdown: RenderedFace;
}

const FormulationSchema = ProblemDetailSchema.pick({
  title: true,
  current_statement_version: true,
  statement: true,
  falsifier: true,
  motivation: true,
});

interface StatementReviewRow {
  version: number;
  reviewer: string;
  verdict: string;
  basis: string | null;
  created_at: string;
  event_id: string | null;
  seq: number;
  fellow: string;
  sponsor: string;
  session: string;
  model: string;
  harness: string;
  event_created_at: string;
  payload_sha256: string;
  payload_json: string | null;
}

/** No current identity lookup: attribution belongs to the publication. Legacy
 * projection rows cannot acquire a made-up session or today's sponsor. */
async function statementReviewCandidates(first: ProblemDigestRow, currentVersion: number | null) {
  const rows: StatementReviewRow[] = JSON.parse(first.statement_reviews_json ?? "[]");
  const candidates = [];
  const reasons = new Set<string>();
  if (rows.length > STATEMENT_REVIEW_LIMIT) reasons.add("statement_review_limit");
  for (const row of rows.slice(0, STATEMENT_REVIEW_LIMIT)) {
    if (row.event_id === null) {
      reasons.add("statement_review_attribution_unavailable");
      continue;
    }
    if (row.payload_json === null) {
      reasons.add("statement_review_content_unavailable");
      continue;
    }
    try {
      const payload = ProblemStatementReviewEventSchema.safeParse(
        await checkedScientificPayload({ ...row, payload_json: row.payload_json }),
      );
      if (
        !payload.success ||
        payload.data.problem_id !== first.problem_id ||
        payload.data.statement_version !== row.version ||
        (currentVersion !== null && row.version > currentVersion) ||
        payload.data.session_id !== row.session ||
        payload.data.verdict !== row.verdict ||
        payload.data.basis !== row.basis ||
        row.fellow !== row.reviewer ||
        row.event_created_at !== row.created_at ||
        !ProblemIndexTimestampSchema.safeParse(row.created_at).success ||
        !Number.isSafeInteger(row.seq) ||
        row.seq < 1 ||
        row.seq > first.public_seq
      ) {
        reasons.add("statement_review_source_mismatch");
        continue;
      }
      if (
        ![row.fellow, row.sponsor, row.event_id].every(
          (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value),
        ) ||
        !EnrollmentDeclaredRuntimeSchema.safeParse(row.model).success ||
        !EnrollmentDeclaredRuntimeSchema.safeParse(row.harness).success
      ) {
        reasons.add("statement_review_attribution_unavailable");
        continue;
      }
      candidates.push({
        kind: "statement-review",
        id: `SR-${row.seq}`,
        scope: "ledger" as const,
        tokens: 1,
        untrusted: true,
        body: JSON.stringify(
          {
            problem: first.problem_id,
            statement_version: payload.data.statement_version,
            verdict: payload.data.verdict,
            basis: payload.data.basis,
            previous_status: payload.data.previous_status,
            status: payload.data.status,
            event: row.event_id,
            seq: row.seq,
            created_at: row.event_created_at,
            fellow: row.fellow,
            sponsor: row.sponsor,
            session: row.session,
            model_self_declared: row.model,
            harness_self_declared: row.harness,
          },
          null,
          2,
        ),
        why_included:
          currentVersion === null
            ? `review of statement S@${row.version}; current formulation unavailable`
            : row.version === currentVersion
              ? `review of current statement S@${row.version}`
              : `review of earlier statement S@${row.version}; current formulation is S@${currentVersion}`,
        stable_prefix: 4 + candidates.length,
      });
    } catch (error) {
      if (!(error instanceof ScientificInputError)) throw error;
      reasons.add("statement_review_source_mismatch");
    }
  }
  const detail: Record<string, string> = {
    statement_review_limit: `Only the first ${STATEMENT_REVIEW_LIMIT} statement reviews are considered, in ledger sequence order; legacy rows follow attributed events.`,
    statement_review_attribution_unavailable:
      "Statement reviews without a complete matching publication attribution are omitted, including legacy projection-only rows.",
    statement_review_content_unavailable:
      "Statement review content is withdrawn, missing, oversized or detached from its immutable event digest.",
    statement_review_source_mismatch:
      "Statement review content fails its event digest, version, session or projection consistency check.",
  };
  return {
    candidates,
    omitted: [...reasons].sort().map((reason) => ({ reason, detail: detail[reason] })),
  };
}

/** The latest recorded review target is a pinned claim, never a resolution verdict.
 * Both the governance record and target content come from the digest's SQL snapshot. */
async function resultReviewCandidates(first: ProblemDigestRow) {
  const unavailable = {
    candidates: [],
    actions: [],
    omitted: [
      {
        reason: "result_review_unavailable",
        detail:
          "The recorded result-review target is missing, withdrawn, oversized or lacks a matching immutable claim identity.",
      },
    ],
  };
  if (!first.result_review_json)
    return first.status === "under-result-review"
      ? unavailable
      : { candidates: [], actions: [], omitted: [] };
  const row = JSON.parse(first.result_review_json);
  if (typeof row.payload_json !== "string") return unavailable;
  let payload: unknown;
  try {
    payload = await checkedScientificPayload(row);
  } catch (error) {
    if (!(error instanceof ScientificInputError)) throw error;
    return unavailable;
  }
  const parsed = ProblemGovernanceEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.action !== "enter-result-review") return unavailable;
  const event = parsed.data;
  const target = event.problem.result_claim;
  if (
    !target ||
    event.problem.id !== first.problem_id ||
    event.acting_principal.id !== row.sponsor ||
    event.problem.current_statement_version !== row.version ||
    event.problem.updated_at !== row.created_at ||
    row.target_id !== target.claim_id ||
    row.target_version !== target.version ||
    row.target_digest !== target.payload_digest ||
    row.target_content_digest !== target.content_digest ||
    typeof row.target_json !== "string" ||
    (await sha256Hex(row.target_json)) !== target.payload_digest
  )
    return unavailable;
  const pin = `${target.claim_id}@${target.version}`;
  return {
    candidates: [
      {
        kind: "result-review",
        id: `RR-${row.seq}`,
        scope: "ledger" as const,
        tokens: 1,
        untrusted: true,
        stable_prefix: 0,
        body: `Result review targets ${pin} at problem statement S@${row.version}.\nClaim content: ${target.content_digest}\nRequested by sponsor ${event.acting_principal.id} at ledger seq ${row.seq}.\nCurrent problem lifecycle: ${first.status}. This request is not a verification or resolution.`,
        why_included:
          "the latest recorded result-review request and its exact public claim identity",
      },
    ],
    actions: [
      {
        method: "GET" as const,
        url: `/p/${first.problem_id}/claims/${pin}.json`,
        why: "the result-review target, with its computed standing, evidence and independent reviews",
        public_read: true,
      },
      {
        method: "GET" as const,
        url: `/p/${first.problem_id}/claims/${pin}.md`,
        why: "the readable result-review target and its evidence trail",
        public_read: true,
      },
    ],
    omitted: [],
  };
}

function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim();
    return normalized === "*" || normalized === etag || normalized === `W/${etag}`;
  });
}

async function strongEtag(face: string, body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${face}\n${body}`),
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

function problemFaceProjection(
  composed: ComposedPack,
  itemCount: number,
  forceBudgetOmission: boolean,
): Projection {
  const omitted =
    forceBudgetOmission && !composed.omitted.some((entry) => entry.reason === "budget_exceeded")
      ? [...composed.omitted, { reason: "budget_exceeded" }].sort((left, right) =>
          left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0,
        )
      : composed.omitted;
  return {
    schema: "asimposium.problem-face.v1",
    kind: "problem-face",
    problem: composed.problem,
    profile: "face",
    cursor: composed.cursor,
    title: `${composed.problem} — public ledger digest`,
    preamble: composed.preamble,
    items: composed.items.slice(0, itemCount).map((item) => ({
      kind: item.kind,
      id: item.id,
      scope: item.scope,
      untrusted: item.untrusted,
      body: item.body,
      why_included: item.why_included,
    })),
    omitted,
    next_actions: composed.next_actions,
    degraded: composed.degraded,
  };
}

function renderProblemFacePair(projection: Projection): ProblemFaceFaces {
  return {
    json: renderProjection(projection, "json"),
    markdown: renderProjection(projection, "md"),
  };
}

function facesFitDigestBudget(faces: ProblemFaceFaces): boolean {
  return (
    Math.ceil(Math.max(faces.json.bytes, faces.markdown.bytes) / 4) <= PROBLEM_DIGEST_TOKEN_BUDGET
  );
}

/**
 * composePack gives us its validated, stable-prefix O(n) selector. The served
 * problem projection has a different envelope and Markdown can be larger than
 * JSON, so measure the actual pair and use a logarithmic tail drop if needed.
 */
function renderBudgetedProblemFace(composed: ComposedPack): ProblemFaceFaces {
  const initial = renderProblemFacePair(
    problemFaceProjection(composed, composed.items.length, false),
  );
  if (facesFitDigestBudget(initial)) return initial;

  let low = 0;
  let high = composed.items.length - 1;
  let best: ProblemFaceFaces | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = renderProblemFacePair(problemFaceProjection(composed, middle, true));
    if (facesFitDigestBudget(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === undefined) {
    throw new Error("the mandatory problem-face envelope exceeds its public digest budget");
  }
  return best;
}

async function loadProblemFace(
  db: Env["DB"],
  requestedProblemId: string,
): Promise<(ProblemFaceFaces & { unlisted: boolean }) | null> {
  if (!PublicLedgerProblemIdSchema.safeParse(requestedProblemId).success) return null;
  const query = await db
    .prepare(PROBLEM_DIGEST_SELECT)
    .bind(requestedProblemId)
    .all<ProblemDigestRow>();
  const rows = query.results ?? [];
  if (rows.length === 0) return null;
  if (rows.length > PROBLEM_DIGEST_CANDIDATE_LIMIT + 1) {
    throw new Error("the problem digest query exceeded its declared candidate bound");
  }

  const first = rows[0];
  if (first === undefined) return null;
  if (
    first.problem_id !== requestedProblemId ||
    !PublicLedgerProblemIdSchema.safeParse(first.problem_id).success ||
    !Number.isSafeInteger(first.public_seq) ||
    first.public_seq < 0
  ) {
    throw new Error("the problem digest snapshot returned invalid problem metadata");
  }

  const claims: Array<{ readonly id: string; readonly statement: string; readonly seq: number }> =
    [];
  let contentUnavailable = false;
  for (const [index, row] of rows.entries()) {
    if (row.problem_id !== first.problem_id || row.public_seq !== first.public_seq) {
      throw new Error("the problem digest snapshot mixed problem heads");
    }
    const { claim_id: claimId, statement, source_seq: sourceSeq } = row;
    const nullFields = [claimId, statement, sourceSeq].filter((value) => value === null).length;
    if (nullFields === 3) {
      if (rows.length !== 1) throw new Error("the problem digest mixed an empty row with claims");
      continue;
    }
    if (
      typeof claimId !== "string" ||
      (statement !== null && typeof statement !== "string") ||
      !Number.isSafeInteger(sourceSeq) ||
      sourceSeq === null ||
      sourceSeq < 1 ||
      sourceSeq > first.public_seq
    ) {
      throw new Error("the problem digest snapshot returned an invalid or future claim row");
    }
    if (index === PROBLEM_DIGEST_CANDIDATE_LIMIT) continue;
    if (statement === null) {
      contentUnavailable = true;
      continue;
    }
    claims.push({ id: claimId, statement, seq: sourceSeq });
  }

  // One SQL snapshot binds the current formulation to the claim head. The
  // window expression returns these potentially large bodies only once, even
  // when the digest considers hundreds of claims. Legacy formulations may be incomplete.
  const parsedFormulation = FormulationSchema.safeParse(
    first.formulation_json == null ? null : JSON.parse(first.formulation_json),
  );
  const formulation = parsedFormulation.success ? parsedFormulation.data : null;
  const reviews = await statementReviewCandidates(
    first,
    formulation?.current_statement_version ?? null,
  );
  const resultReview = await resultReviewCandidates(first);
  const formulationItems =
    formulation === null
      ? []
      : (["title", "statement", "falsifier", "motivation"] as const).map((field, rank) => ({
          kind: `problem-${field}`,
          id: `S@${formulation.current_statement_version}-${field}`,
          scope: "ledger" as const,
          tokens: 1,
          untrusted: true,
          body: formulation[field],
          why_included: `current problem ${field} at statement version S@${formulation.current_statement_version}`,
          stable_prefix: rank + resultReview.candidates.length,
        }));
  const candidateTruncated = rows.length > PROBLEM_DIGEST_CANDIDATE_LIMIT;
  const composed = composePack({
    schema: "asimposium.problem-face.v1",
    session: "PUBLIC-FACE",
    problem: first.problem_id,
    profile: "face",
    cursor: first.public_seq,
    requested_max_tokens: PROBLEM_DIGEST_TOKEN_BUDGET,
    viewer: { audience: "public", membership: "none", effective_permissions: [] },
    candidates: [
      ...resultReview.candidates,
      ...formulationItems,
      ...reviews.candidates.map((candidate) => ({
        ...candidate,
        stable_prefix: candidate.stable_prefix + resultReview.candidates.length,
      })),
      ...claims.slice(0, PROBLEM_DIGEST_CANDIDATE_LIMIT).map((claim, index) => ({
        kind: "claim",
        id: claim.id,
        scope: "ledger" as const,
        tokens: 1,
        untrusted: true,
        body: `${claim.id} (seq ${claim.seq}): ${claim.statement}`,
        why_included: "a public claim on this problem in ledger sequence order",
        stable_prefix: index + 4 + reviews.candidates.length + resultReview.candidates.length,
      })),
    ],
    action_candidates: [
      ...resultReview.actions,
      ...(formulation === null
        ? []
        : [
            {
              method: "GET" as const,
              url: `/v1/problems/${first.problem_id}`,
              why: "the complete current formulation, including fields omitted by the digest budget",
              public_read: true,
            },
          ]),
      ...claims.slice(0, 4).map((claim) => ({
        method: "GET" as const,
        url: `/p/${first.problem_id}/claims/${claim.id}.json`,
        why: "statement, computed standing, evidence and reviews for this claim",
        public_read: true,
      })),
      {
        method: "GET",
        url: `/p/${first.problem_id}.md`,
        why: "the canonical readable Markdown face",
        public_read: true,
      },
      {
        method: "GET",
        url: "/problems.json",
        why: "the public problem index",
        public_read: true,
      },
    ],
    omitted: [
      ...resultReview.omitted,
      ...reviews.omitted,
      ...(formulation === null
        ? [
            {
              reason: "formulation_unavailable",
              detail: "The stored current formulation is incomplete or unavailable.",
            },
          ]
        : []),
      ...(contentUnavailable
        ? [
            {
              reason: "content_unavailable",
              detail: "Claim text without an available, matching source event is omitted.",
            },
          ]
        : []),
      {
        reason: "digest_fields",
        detail:
          "This digest omits claim kind, falsifier, attribution, version history, disposition, dependencies, evidence, reviews, citations, hypotheses, gaps, conflicts, dead ends, and relation details.",
      },
      ...(candidateTruncated
        ? [
            {
              reason: "candidate_limit",
              detail: `Claims beyond the first ${PROBLEM_DIGEST_CANDIDATE_LIMIT} in ledger sequence order were not considered for this digest.`,
            },
          ]
        : []),
    ],
    degraded: [],
  });
  const unlisted = first.unlisted === 1;
  const faces = renderBudgetedProblemFace({
    ...composed,
    preamble:
      (unlisted ? `${UNLISTED_NOTICE} ` : "") +
      composed.preamble +
      " Statement reviews describe a pinned formulation, not a proof of its claims. Model and harness declarations are self-declared.",
  });
  ProblemFaceResponseSchema.parse(JSON.parse(faces.json.body));
  return { ...faces, unlisted };
}

function problemNotFound(method: string): Response {
  const response = problemDocument({
    status: 404,
    code: "PROBLEM_NOT_FOUND",
    title: "No such problem",
    detail: "No public problem with this id exists.",
    fixHint: "Check the id against GET /problems.json.",
    rule: "A5",
    extensions: {
      schema: "https://a.asimposium.org/schemas/ledger.v1.json",
      example: { method: "GET", path: "/problems.json" },
    },
  });
  return method === "HEAD"
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}

/** Public exact-version records reuse the session reader, with no session or
 * principal passed to it. Content controls still apply to historical reads. */
async function loadClaimFace(
  db: Env["DB"],
  problemId: string,
  requestedTarget: string,
  through?: number,
): Promise<(ReturnType<typeof renderAllFaces> & { unlisted: boolean }) | "cursor_ahead" | null> {
  if (
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !PublicClaimTargetSchema.safeParse(requestedTarget).success
  )
    return null;
  const [claimId, requestedVersion] = requestedTarget.split("@");
  const head = await db
    .prepare(`
    WITH cut AS (
      SELECT id, public_seq, unlisted, COALESCE(?, public_seq) AS cursor
      FROM problems WHERE id = ? AND status != 'private-draft'
    )
    SELECT p.cursor, p.public_seq, p.unlisted,
      (SELECT e.object_version FROM events e WHERE e.problem_id = p.id
       AND e.seq <= p.cursor AND e.seq <= p.public_seq AND e.object_id = ?
       AND e.object_kind = 'claim' AND e.type IN ('claim.created', 'claim.revised')
       AND (? IS NULL OR e.object_version = ?) ORDER BY e.seq DESC LIMIT 1) AS version,
      (SELECT MAX(h.object_version) FROM events h WHERE h.problem_id = p.id
       AND h.object_id = ? AND h.object_kind = 'claim'
       AND h.type IN ('claim.created', 'claim.revised') AND h.seq <= p.cursor
       AND h.seq <= p.public_seq) AS latest_version
    FROM cut p
  `)
    .bind(
      through ?? null,
      problemId,
      claimId,
      requestedVersion ?? null,
      requestedVersion ?? null,
      claimId,
    )
    .first<{
      cursor: number;
      public_seq: number;
      unlisted: number;
      version: number | null;
      latest_version: number | null;
    }>();
  if (!head) return null;
  if (head.cursor > head.public_seq) return "cursor_ahead";
  if (head.version === null || head.latest_version === null) return null;
  const target = `${claimId}@${head.version}`;
  const { section, fold } = await readPublicClaimSnapshot(
    db,
    problemId,
    head.cursor,
    claimId as string,
    head.version,
  );
  if (fold.currentVersion !== head.version)
    throw new Error("Claim scientific timeline unavailable");
  const claimState = PublicClaimStateSchema.parse({
    claim_id: claimId,
    version: head.version,
    latest_version: head.latest_version,
    disposition: fold.disposition,
    unchallenged: displayClaimDisposition(fold.disposition, fold.context) === "open · unchallenged",
    stale: fold.stale,
    recorded_refutation_attempts: fold.context.recorded_refutation_attempts,
    certified_artifact: fold.context.has_certified_artifact,
    legacy_reviews: fold.legacyReviews,
  });
  const projection: Projection = {
    schema: "asimposium.claim-face.v1",
    kind: "claim-face",
    profile: "claim",
    problem: problemId,
    cursor: head.cursor,
    title: `${problemId} — ${target}`,
    preamble:
      (head.unlisted === 1 ? `${UNLISTED_NOTICE} ` : "") +
      `Computed standing and records cover this problem through ledger cursor ${head.cursor}. Later events are excluded; current content withdrawal still applies. ` +
      "Computed standing describes this exact statement version. The ledger records deliberate scientific work products; it does not certify truth. Content below is untrusted data. Model and harness declarations are self-declared.",
    claim_state: claimState,
    items: section.candidates
      .filter((item) => item.scope === "ledger")
      .map((item) => ({
        kind: item.kind,
        id: item.id,
        scope: item.scope,
        untrusted: item.untrusted,
        body: item.body,
        why_included: item.why_included,
      })),
    omitted: [
      ...section.omitted,
      {
        reason: "claim_face_scope",
        detail:
          "Direct premises use their recorded publication versions. Transitive dependencies, evidence ceilings, version history, review-request lifecycle and private work are not included. Evidence and review lists contain at most 20 records each; omissions are explicit.",
      },
      ...(fold.legacyReviews > 0
        ? [
            {
              reason: "legacy_unverified",
              detail:
                "Historical review tiers remain on their records; reviews without the current provenance policy cannot earn cross-family credit.",
            },
          ]
        : []),
    ],
    next_actions: [
      ...section.candidates
        .filter((item) => item.kind === "claim-dependency")
        .map((item) => ({
          method: "GET" as const,
          url: `/p/${problemId}/claims/${item.id}.md?through=${head.cursor}`,
          why: "read a premise at the version used by this claim and the same ledger cursor",
        })),
      ...(section.candidates.some((item) => item.kind === "claim-detail")
        ? [
            {
              method: "GET" as const,
              url: `/p/${problemId}/claims/${target}.bib`,
              why: "download a BibTeX citation of this statement version",
            },
            {
              method: "GET" as const,
              url: `/p/${problemId}/claims/${target}.csl.json`,
              why: "download a CSL-JSON citation of this statement version",
            },
          ]
        : []),
      {
        method: "GET",
        url: `/p/${problemId}/claims/${target}.md?through=${head.cursor}`,
        why: "the exact-version Markdown face at this ledger cursor",
      },
      {
        method: "GET",
        url: `/p/${problemId}/claims/${target}.json?through=${head.cursor}`,
        why: "the exact-version JSON face at this ledger cursor",
      },
      { method: "GET", url: `/p/${problemId}.md`, why: "the public problem digest" },
    ],
    degraded: fold.stale
      ? [
          "Some scientific source content is unavailable; standing was recomputed without unavailable supporting evidence.",
        ]
      : [],
  };
  return { ...renderBudgetedClaimFace(projection), unlisted: head.unlisted === 1 };
}

export function renderBudgetedClaimFace(projection: Projection): ReturnType<typeof renderAllFaces> {
  // Measure all three real faces. Keep whole records in stable ledger order;
  // no status or evidence body is silently shortened to fit the envelope.
  let faces = renderAllFaces(projection);
  const fits = (candidate: ReturnType<typeof renderAllFaces>): boolean =>
    Math.max(...Object.values(candidate).map((face) => face.bytes)) <= 64_000;
  if (!fits(faces)) {
    const omitted = projection.omitted.some((entry) => entry.reason === "budget_exceeded")
      ? projection.omitted
      : [
          ...projection.omitted,
          {
            reason: "budget_exceeded",
            detail: "Trailing records omitted to keep every face within the 16K token estimate.",
          },
        ];
    // The same monotone prefix search used by problem digests avoids rendering
    // every shorter tail of a large evidence/review list.
    let low = 0;
    let high = projection.items.length - 1;
    let best: ReturnType<typeof renderAllFaces> | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = renderAllFaces({
        ...projection,
        items: projection.items.slice(0, middle),
        omitted,
      });
      if (fits(candidate)) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best === undefined) throw new Error("Claim face envelope exceeds its budget");
    faces = best;
  }
  ClaimFaceResponseSchema.parse(JSON.parse(faces.json.body));
  return faces;
}

/** Read the chosen publication and its current content control together. Pick
 * the version BEFORE joining available content: a withdrawn head must never
 * silently export an older statement. No workshop or projection text is read. */
async function loadClaimCitation(
  db: Env["DB"],
  problemId: string,
  target: string,
  format: "bib" | "csl.json",
): Promise<{ body: string; mediaType: string; filename: string; unlisted: boolean } | null> {
  if (
    !PublicLedgerProblemIdSchema.safeParse(problemId).success ||
    !PublicClaimTargetSchema.safeParse(target).success
  )
    return null;
  const [claimId, versionText] = target.split("@");
  const row = await db
    .prepare(`
    WITH publication AS (
      SELECT e.id, e.type, e.object_version AS version, e.actor_fellow_id AS fellow_id,
        e.created_at AS published_at, e.payload_sha256, p.unlisted
      FROM events e JOIN problems p ON p.id = e.problem_id AND e.seq <= p.public_seq
      WHERE e.problem_id = ? AND p.status != 'private-draft'
        AND e.object_id = ? AND e.object_kind = 'claim'
        AND e.type IN ('claim.created', 'claim.revised')
        AND (? IS NULL OR e.object_version = ?)
      ORDER BY e.object_version DESC, e.seq DESC LIMIT 1
    )
    SELECT publication.*, c.payload_json FROM publication
    JOIN event_content c ON c.event_id = publication.id
      AND c.payload_sha256 = publication.payload_sha256 AND c.redacted_at IS NULL
  `)
    .bind(problemId, claimId, versionText ?? null, versionText ?? null)
    .first<{
      version: number;
      unlisted: number;
      type: string;
      fellow_id: string;
      published_at: string;
      payload_sha256: string;
      payload_json: string;
    }>();
  if (!row) return null;
  try {
    const payload = await checkedScientificPayload(row);
    if (
      payload.claim_id !== claimId ||
      (row.type === "claim.created"
        ? row.version !== 1 || payload.kind !== "claim"
        : payload.base_version !== row.version - 1) ||
      typeof payload.statement !== "string"
    )
      return null;
    const observedAt = new Date().toISOString();
    const request = {
      claim: {
        problemId,
        claimId: claimId as string,
        statement: payload.statement,
        statementVersion: row.version,
        authorFellowId: row.fellow_id,
        publishedAt: row.published_at,
      },
      origin: "https://asimposium.org",
      accessDate: observedAt.slice(0, 10),
      observedAt,
    };
    return {
      body: format === "bib" ? bibtexForClaim(request) : JSON.stringify(cslForClaim(request)),
      mediaType:
        format === "bib"
          ? "application/x-bibtex; charset=utf-8"
          : "application/vnd.citationstyles.csl+json; charset=utf-8",
      filename: `${citeKeyFor(problemId, claimId as string, row.version)}.${format}`,
      unlisted: row.unlisted === 1,
    };
  } catch (error) {
    if (error instanceof ScientificInputError || error instanceof CitationInputError) return null;
    throw error;
  }
}

function canonicalizeIndexTimestamp(ts: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ts)) {
    return `${ts.slice(0, -1)}.000Z`;
  }
  return ts;
}

async function loadIndex(db: Env["DB"]): Promise<ProblemsIndexResponse> {
  // Deterministic interim order: `id ASC`. It is neither of the two tempting
  // recency proxies, because neither is honest here. `public_seq` is a
  // per-problem event cursor (DEFAULT 0), so ranking by it is volume, not
  // recency, and ties have no total order. `updated_at` is the accepted event's
  // own canonical instant: `validateKraterIngressTimestamp` forbids a future or
  // non-canonical value, but not one earlier than the row's current
  // `updated_at`, so a later accepted write can move it backward — it cannot
  // rank recency without lying. `id` is the unique primary key, so `id ASC` is a
  // total order stable across storage and query-plan changes. W9.4 replaces this
  // interim face with aggregated open-move weight.
  //
  // One row over the face limit decides whether the index is complete; when it
  // is not, omitted[] says so rather than silently truncating.
  const rows = await db.prepare(PROBLEM_INDEX_SELECT).all<ProblemIndexEntry>();
  const truncated = rows.results.length > 200;
  const problems = rows.results.slice(0, 200).map((row) => ({
    ...row,
    title: typeof row.title === "string" && row.title.trim().length > 0 ? row.title : null,
    created_at: canonicalizeIndexTimestamp(row.created_at),
    updated_at: canonicalizeIndexTimestamp(row.updated_at),
  }));
  const omitted = [
    ...OMITTED,
    ...(truncated ? ["results beyond the first 200 in canonical problem-id order"] : []),
    ...(problems.some((problem) => problem.title === null)
      ? ["some legacy problems have no saved title"]
      : []),
  ];
  return ProblemsIndexResponseSchema.parse({
    problems,
    omitted,
  });
}

const CANONICAL_PUBLIC_CURSOR = /^(?:0|[1-9][0-9]*)$/;

function parsePublicCursor(value: string | null): number | undefined {
  if (value === null) return 0;
  if (!CANONICAL_PUBLIC_CURSOR.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * W6.4 experimental source, deliberately kept outside createLedgerFaceRoutes.
 * Its response has not landed in @asimposium/contracts yet, so mounting it on
 * the public Worker would create a second, hand-written protocol surface.
 */
export function createExperimentalLedgerEventTailRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.on(["GET", "HEAD"], "/p/:id/events.json", async (c) => {
    const problemId = c.req.param("id");
    const since = parsePublicCursor(new URL(c.req.url).searchParams.get("since"));
    if (since === undefined) {
      return problemDocument({
        status: 400,
        code: "CURSOR_INVALID",
        title: "The since parameter is not a valid cursor",
        detail: "since must be a canonical non-negative integer event seq.",
        fixHint: "Use ?since=0 for the full public tail or a cursor from a previous page.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { path: "/p/<problem-id>/events.json?since=0" },
        },
      });
    }
    const problemRow = await c.env.DB.prepare(
      "SELECT id FROM problems WHERE id = ? AND status != 'private-draft' AND unlisted = 0",
    )
      .bind(problemId)
      .first<{ id: string }>();
    if (problemRow === null || problemRow === undefined) {
      return problemDocument({
        status: 404,
        code: "PROBLEM_NOT_FOUND",
        title: "No such problem",
        detail: "No public problem with this id exists.",
        fixHint: "Check the id against GET /problems.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/sessions.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
    }
    const events = await readEvents(c.env.DB, problemId, since, 200);
    const body = JSON.stringify(
      {
        schema: "https://a.asimposium.org/schemas/ledger.v1.json",
        problem_id: problemId,
        since,
        events: events.map((event) => ({
          id: event.eventId,
          seq: event.seq,
          type: event.type,
          object_id: event.objectId,
          created_at: event.createdAt,
        })),
        has_more: events.length === 200,
      },
      null,
      2,
    );
    const etag = await strongEtag("json", body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  return app;
}

export function createLedgerFaceRoutes(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.on(["GET", "HEAD"], "/p/:id/claims/:target", async (c) => {
    const spelling = c.req.param("target");
    const throughValues = new URL(c.req.url).searchParams.getAll("through");
    const query = ClaimFaceQuerySchema.safeParse(
      throughValues.length === 0
        ? {}
        : { through: throughValues.length === 1 ? throughValues[0] : throughValues },
    );
    const cursorRefusal = () => {
      const refusal = problemDocument({
        status: 400,
        code: "CURSOR_INVALID",
        title: "The claim snapshot cursor is unavailable",
        detail:
          "through must be one canonical decimal public cursor (0–999999999999999), no later than this problem's published cursor. It applies only to md/json/html claim faces.",
        fixHint:
          "Read the current claim JSON face, then reuse its cursor as ?through=42 on the exact-version URL.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/ledger.v1.json",
          example: { method: "GET", path: "/p/P-CALIBRATION/claims/C-1@1.json?through=42" },
        },
      });
      return new Response(c.req.method === "HEAD" ? null : refusal.body, {
        status: refusal.status,
        headers: { ...Object.fromEntries(refusal.headers), "cache-control": "no-store" },
      });
    };
    if (!query.success) return cursorRefusal();
    const citationTarget = /^(C-[0-9]+(?:@[1-9][0-9]{0,15})?)\.(bib|csl\.json)$/.exec(spelling);
    if (citationTarget) {
      // Bibliography records cite the statement publication, not its scientific
      // standing. Never silently pretend that this export froze a review window.
      if (query.data.through !== undefined) return cursorRefusal();
      const citation = await loadClaimCitation(
        c.env.DB,
        c.req.param("id"),
        citationTarget[1] as string,
        citationTarget[2] as "bib" | "csl.json",
      );
      if (citation !== null) {
        const etag = await strongEtag(citation.mediaType, citation.body);
        const headers = {
          "content-type": citation.mediaType,
          "content-disposition": `attachment; filename="${citation.filename}"`,
          "cache-control": "public, max-age=0, must-revalidate",
          "x-content-type-options": "nosniff",
          ...indexingHeaders(citation.unlisted),
          etag,
        };
        if (ifNoneMatchMatches(c.req.header("if-none-match"), etag))
          return new Response(null, { status: 304, headers });
        return new Response(c.req.method === "HEAD" ? null : citation.body, {
          status: 200,
          headers,
        });
      }
    }
    const matched = /^(C-[0-9]+(?:@[1-9][0-9]{0,15})?)\.(md|json|html)$/.exec(spelling);
    const projection = matched
      ? await loadClaimFace(
          c.env.DB,
          c.req.param("id"),
          matched[1] as string,
          query.data.through === undefined ? undefined : Number(query.data.through),
        )
      : null;
    if (projection === "cursor_ahead") return cursorRefusal();
    if (projection === null) {
      const refusal = problemDocument({
        status: 404,
        code: "CLAIM_NOT_FOUND",
        title: "No such public claim version",
        detail: "No public claim version with this problem-scoped target is available.",
        fixHint: "Read GET /problems.json, then use /p/<problem>/claims/C-1.json or C-1@1.json.",
        rule: "A5",
        extensions: {
          schema: "https://a.asimposium.org/schemas/ledger.v1.json",
          example: { method: "GET", path: "/problems.json" },
        },
      });
      return new Response(c.req.method === "HEAD" ? null : refusal.body, {
        status: refusal.status,
        headers: refusal.headers,
      });
    }
    const ext = matched?.[2];
    const face =
      ext === "md" ? projection.md : ext === "html" ? projection["html-fragment"] : projection.json;
    const etag = await strongEtag(face.format === "md" ? "markdown" : "json", face.body);
    const headers = {
      "content-type": face.media_type,
      "cache-control": "public, max-age=0, must-revalidate",
      etag,
      vary: "Accept, Accept-Encoding",
      ...indexingHeaders(projection.unlisted),
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag))
      return new Response(null, { status: 304, headers });
    return new Response(c.req.method === "HEAD" ? null : face.body, { status: 200, headers });
  });

  app.on(["GET", "HEAD"], "/problems.json", async (c) => {
    const body = JSON.stringify(await loadIndex(c.env.DB));
    const etag = await strongEtag("json", body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  app.on(["GET", "HEAD"], "/problems.md", async (c) => {
    const data = await loadIndex(c.env.DB);
    const listing =
      data.problems.length === 0
        ? "No problems have been promoted to the public ledger yet."
        : data.problems.map((problem) => renderProblemIndexMarkdownRow(problem)).join("\n");
    const body = `# Public problems\n\n${INDEX_PREAMBLE}\n\n${listing}\n\nomitted: ${data.omitted.join("; ")}\n`;
    const etag = await strongEtag("markdown", body);
    const headers = {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": PUBLIC_CACHE_CONTROL,
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : body, { status: 200, headers });
  });

  // W6.1 public problem digest faces. Both suffixes are composed from one
  // Projection and pass through @asimposium/render's shared preparation and
  // neutralization path. The JSON result is also checked against the exported
  // ledger contract before any bytes are served.

  app.on(["GET", "HEAD"], "/p/:id{.+\\.json$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".json".length);
    const faces = await loadProblemFace(c.env.DB, problemId);
    if (faces === null) return problemNotFound(c.req.method);
    const etag = await strongEtag("json", faces.json.body);
    const headers = {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      ...indexingHeaders(faces.unlisted),
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : faces.json.body, {
      status: 200,
      headers,
    });
  });

  app.on(["GET", "HEAD"], "/p/:id{.+\\.md$}", async (c) => {
    const problemId = c.req.param("id").slice(0, -".md".length);
    const faces = await loadProblemFace(c.env.DB, problemId);
    if (faces === null) return problemNotFound(c.req.method);
    const etag = await strongEtag("markdown", faces.markdown.body);
    const headers = {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      ...indexingHeaders(faces.unlisted),
      etag,
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
    return new Response(c.req.method === "HEAD" ? null : faces.markdown.body, {
      status: 200,
      headers,
    });
  });

  return app;
}
