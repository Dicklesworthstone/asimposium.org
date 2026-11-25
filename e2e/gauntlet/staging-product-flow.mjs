/**
 * State-derived staging Cold-Agent Gauntlet runner (Fable §16.1, bead fd5e).
 *
 * Replaces the legacy exit-70 stub with a real recording-proxy + anonymous
 * public-face verifier sharing `gauntletVerdict` (`./state-verdict.mjs`) and
 * `scoreGauntlet` (`./scorecard.ts`).
 *
 * Hard invariants:
 * - Production origins (`a.asimposium.org`, `asimposium.org`, `artifacts.asimposium.org`)
 *   are refused fail-closed BEFORE any request is sent.
 * - Loopback origins (`127.0.0.1` / `localhost`) are accepted ONLY when
 *   `allowLoopback: true` is explicitly passed (for rehearsal/tests).
 * - Completion is strictly state-derived from recording-proxy observations and
 *   anonymous public reads (`/p/:id/claims.json`). Agent transcript prose is
 *   never an input to `completed`.
 * - Every attempt must supply reconciled positive `tokensUsed` to pass.
 * - Join URL fragments, secrets, bearer tokens, and cookies are never emitted.
 */

import { once } from "node:events";
import { createServer } from "node:http";
import {
  PromoteRequestSchema,
  PromoteResponseSchema,
} from "../../packages/contracts/src/sessions.ts";
import { HARNESS_ADAPTERS } from "./adapters.ts";
import { runHarnessAgent } from "./harness-agent.mjs";
import { GAUNTLET_REQUIRED_ATTEMPTS, scoreGauntlet } from "./scorecard.ts";
import { GAUNTLET_STAGES, gauntletVerdict } from "./state-verdict.mjs";

const FORBIDDEN_PRODUCTION_HOSTS = new Set([
  "a.asimposium.org",
  "asimposium.org",
  "www.asimposium.org",
  "artifacts.asimposium.org",
]);

const CONJECTURE_CLASS = new Set([
  "conjecture",
  "counterexample-claim",
  "bound",
  "theorem-attempt",
]);

const PROMOTE_PATH = /^\/v1\/sessions\/([^/]+)\/promote$/;
const WORKSHOP_PATH = /^\/v1\/sessions\/([^/]+)\/workshop$/;
const CLOSE_PATH = /^\/v1\/sessions\/([^/]+)\/close$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const USER_AGENT = "asimposium.org-agent (+https://github.com/Dicklesworthstone/asimposium.org)";

export function validateStagingAgentOrigin(rawOrigin, options = {}) {
  const allowLoopback = options.allowLoopback === true;
  if (typeof rawOrigin !== "string" || rawOrigin.trim() === "") {
    return { ok: false, exitCode: 78, code: "STAGING_AGENT_BASE_URL_MISSING" };
  }
  let parsed;
  try {
    parsed = new URL(rawOrigin.trim());
  } catch {
    return { ok: false, exitCode: 64, code: "STAGING_AGENT_BASE_URL_INVALID" };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (FORBIDDEN_PRODUCTION_HOSTS.has(hostname)) {
    return { ok: false, exitCode: 64, code: "STAGING_ORIGIN_PRODUCTION_FORBIDDEN" };
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return { ok: false, exitCode: 64, code: "STAGING_AGENT_BASE_URL_INVALID" };
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return { ok: false, exitCode: 64, code: "STAGING_AGENT_BASE_URL_INVALID" };
  }
  const isLoopback = LOOPBACK_HOSTS.has(hostname);
  if (parsed.protocol === "https:") {
    return { ok: true, origin: parsed.origin };
  }
  if (parsed.protocol === "http:" && isLoopback && allowLoopback) {
    return { ok: true, origin: parsed.origin };
  }
  return { ok: false, exitCode: 64, code: "STAGING_AGENT_BASE_URL_INVALID" };
}

export function parseJoinUrlEntry(line, index, defaults = {}) {
  const trimmed = line.trim();
  let joinUrl;
  let problemId = defaults.problemId ?? "";
  let sponsorId = defaults.sponsorId ?? "";
  let harness;
  if (trimmed.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`GAUNTLET_JOIN_URL_INVALID: line ${index + 1} is not valid JSON`);
    }
    if (typeof parsed?.join_url !== "string" || parsed.join_url.trim() === "") {
      throw new Error(`GAUNTLET_JOIN_URL_INVALID: line ${index + 1} missing join_url`);
    }
    joinUrl = parsed.join_url.trim();
    if (typeof parsed.problem_id === "string" && parsed.problem_id.trim() !== "") {
      problemId = parsed.problem_id.trim();
    }
    if (typeof parsed.sponsor_id === "string" && parsed.sponsor_id.trim() !== "") {
      sponsorId = parsed.sponsor_id.trim();
    }
    if (typeof parsed.harness === "string" && parsed.harness.trim() !== "") {
      harness = parsed.harness.trim();
    }
  } else {
    joinUrl = trimmed;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(joinUrl);
  } catch {
    throw new Error(`GAUNTLET_JOIN_URL_INVALID: line ${index + 1} is not a valid URL`);
  }
  if (FORBIDDEN_PRODUCTION_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    throw new Error("STAGING_ORIGIN_PRODUCTION_FORBIDDEN");
  }
  const match = /^\/join\/(ASIMP-EN-[A-Za-z0-9_-]+)$/.exec(parsedUrl.pathname);
  const secret = parsedUrl.hash.startsWith("#") ? parsedUrl.hash.slice(1) : "";
  if (!match || !secret.startsWith("v1.") || secret.length < 10) {
    throw new Error(`GAUNTLET_JOIN_URL_INVALID: line ${index + 1} missing /join/<id>#v1.<secret>`);
  }
  if (problemId === "" || sponsorId === "") {
    throw new Error(
      `GAUNTLET_JOIN_URL_INVALID: line ${index + 1} requires problem_id and sponsor_id`,
    );
  }
  const defaultHarness =
    HARNESS_ADAPTERS[index % HARNESS_ADAPTERS.length]?.harness ?? "claude-code";
  return {
    attemptIndex: index,
    joinUrl,
    enrollmentId: match[1],
    secret,
    problemId,
    sponsorId,
    harness: harness ?? defaultHarness,
  };
}

export function parseJoinUrlsFile(content, defaults = {}) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (lines.length === 0) {
    throw new Error("GAUNTLET_JOIN_URLS_EMPTY");
  }
  return lines.map((line, index) => parseJoinUrlEntry(line, index, defaults));
}

function observeResponseFinish(res, nextOrder, onFinish) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    onFinish(nextOrder());
  };
  res.once("finish", finish);
  res.once("close", finish);
}

/**
 * Local recording proxy forwarding to the upstream staging origin.
 * Injects a deterministic 422 on the first valid `POST /v1/sessions/:id/promote`
 * per session (by deleting `workshop_id`, matching `local-target.mjs`) and
 * collects monotonic server-side observations for `gauntletVerdict`.
 */
export async function startStagingRecordingProxy({
  upstreamOrigin,
  enrollmentSecret,
  injectFirstPromoteRefusal = true,
}) {
  const observations = [];
  const injectedSessions = new Set();
  const sessions = new Map();
  let fellow = null;
  let secretSeenInPaths = false;
  let order = 0;

  function maybeInjectRefusal(pathname, body) {
    if (!injectFirstPromoteRefusal) return { body, injected: false };
    const match = PROMOTE_PATH.exec(pathname);
    if (!match || injectedSessions.has(match[1])) return { body, injected: false };
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      return { body, injected: false };
    }
    if (!PromoteRequestSchema.safeParse(parsed).success) return { body, injected: false };
    injectedSessions.add(match[1]);
    delete parsed.workshop_id;
    return { body: Buffer.from(JSON.stringify(parsed)), injected: true };
  }

  const server = createServer(async (req, res) => {
    const startedOrder = ++order;
    let completionOrder;
    let pendingObs;
    observeResponseFinish(
      res,
      () => ++order,
      (completedOrder) => {
        completionOrder = completedOrder;
        if (pendingObs !== undefined) {
          observations.push({ ...pendingObs, completed_order: completionOrder });
        }
      },
    );
    const publishObs = (obs) => {
      pendingObs = obs;
      if (completionOrder !== undefined) {
        observations.push({ ...pendingObs, completed_order: completionOrder });
      }
    };

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawUrl = req.url ?? "/";
    if (enrollmentSecret && rawUrl.includes(enrollmentSecret)) {
      secretSeenInPaths = true;
    }
    const url = new URL(rawUrl, upstreamOrigin);
    const rawBody = chunks.length === 0 ? undefined : Buffer.concat(chunks);
    const { body: forwardBody, injected: wasInjected } =
      rawBody !== undefined && req.method === "POST"
        ? maybeInjectRefusal(url.pathname, rawBody)
        : { body: rawBody, injected: false };

    const HOP_BY_HOP = new Set([
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "keep-alive",
      "upgrade",
      "proxy-connection",
      "te",
    ]);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      if (typeof value === "string") {
        headers.set(name, value);
      } else if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      }
    }
    if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);

    let upstreamRes;
    try {
      upstreamRes = await fetch(url.href, {
        method: req.method,
        headers,
        redirect: "manual",
        ...(forwardBody && req.method !== "GET" && req.method !== "HEAD"
          ? { body: forwardBody }
          : {}),
      });
    } catch {
      publishObs({
        started_order: startedOrder,
        method: req.method ?? "GET",
        path: url.pathname,
        status: 502,
        code: null,
        claim_id: null,
        bytes: 0,
        injected: wasInjected,
      });
      if (!res.destroyed) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("staging proxy upstream error");
      }
      return;
    }

    const bytes = Buffer.from(await upstreamRes.arrayBuffer());
    const contentType = upstreamRes.headers.get("content-type") ?? "";
    let parsedRes = null;
    if (contentType.includes("json")) {
      try {
        parsedRes = JSON.parse(bytes.toString("utf8"));
      } catch {
        parsedRes = null;
      }
    }

    let code = null;
    let claimId = null;
    if (upstreamRes.status >= 400 && parsedRes && typeof parsedRes.code === "string") {
      code = parsedRes.code;
    }

    // Track server-authoritative responses returned by upstream staging.
    if (
      req.method === "GET" &&
      url.pathname === "/v1/hello" &&
      upstreamRes.status === 200 &&
      parsedRes
    ) {
      const fId = parsedRes.fellow?.fellow_id ?? parsedRes.fellow_id ?? null;
      const sId = parsedRes.fellow?.sponsor_id ?? parsedRes.sponsor_id ?? null;
      if (typeof fId === "string" && typeof sId === "string") {
        fellow = { fellow_id: fId, sponsor_id: sId };
      }
    }

    if (
      req.method === "POST" &&
      url.pathname === "/v1/sessions" &&
      (upstreamRes.status === 200 || upstreamRes.status === 201) &&
      parsedRes &&
      typeof parsedRes.session_id === "string" &&
      typeof parsedRes.problem_id === "string"
    ) {
      if (!sessions.has(parsedRes.session_id)) {
        sessions.set(parsedRes.session_id, {
          session_id: parsedRes.session_id,
          problem_id: parsedRes.problem_id,
          closed_at: null,
          has_handback: false,
          workshop_objects: 0,
        });
      }
    }

    const workshopMatch = req.method === "POST" ? WORKSHOP_PATH.exec(url.pathname) : null;
    if (workshopMatch && (upstreamRes.status === 200 || upstreamRes.status === 201)) {
      const s = sessions.get(workshopMatch[1]);
      if (s) s.workshop_objects += 1;
    }

    const promoteMatch = req.method === "POST" ? PROMOTE_PATH.exec(url.pathname) : null;
    if (promoteMatch && (upstreamRes.status === 200 || upstreamRes.status === 201) && parsedRes) {
      const receipt = PromoteResponseSchema.safeParse(parsedRes);
      if (receipt.success) {
        claimId = receipt.data.claim_id;
      } else if (typeof parsedRes.claim_id === "string") {
        claimId = parsedRes.claim_id;
      }
    }

    const closeMatch = req.method === "POST" ? CLOSE_PATH.exec(url.pathname) : null;
    if (closeMatch && (upstreamRes.status === 200 || upstreamRes.status === 201)) {
      const s = sessions.get(closeMatch[1]);
      if (s) {
        s.closed_at =
          (parsedRes && typeof parsedRes.closed_at === "string" ? parsedRes.closed_at : null) ??
          new Date().toISOString();
        try {
          const reqJson = rawBody ? JSON.parse(rawBody.toString("utf8")) : null;
          const hb = reqJson?.handback;
          if (hb && typeof hb === "object" && Object.keys(hb).length > 0) {
            s.has_handback = true;
          }
        } catch {
          // Malformed body does not establish a handback.
        }
      }
    }

    publishObs({
      started_order: startedOrder,
      claim_id: claimId,
      method: req.method ?? "GET",
      path: url.pathname,
      status: upstreamRes.status,
      code,
      bytes: bytes.length,
      injected: wasInjected,
    });

    const outHeaders = {};
    upstreamRes.headers.forEach((value, name) => {
      if (name !== "content-length" && name !== "transfer-encoding") outHeaders[name] = value;
    });
    if (!res.destroyed) {
      res.writeHead(upstreamRes.status, outHeaders);
      res.end(bytes);
    }
  });

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const addr = server.address();
  const proxyOrigin = `http://127.0.0.1:${addr.port}`;

  let closed = false;
  return {
    origin: proxyOrigin,
    snapshot() {
      return {
        fellow,
        sessions: [...sessions.values()],
        observations: [...observations],
        injected: injectedSessions.size > 0,
        secretSeenInPaths,
        servedBytes: observations.reduce((sum, o) => sum + (o.bytes ?? 0), 0),
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** Independently query anonymous public staging claims (zero credentials). */
export async function fetchAnonymousPublicClaims(upstreamOrigin, problemId) {
  const url = `${upstreamOrigin}/p/${encodeURIComponent(problemId)}/claims.json`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    redirect: "manual",
  });
  if (res.status !== 200) return [];
  let data;
  try {
    data = await res.json();
  } catch {
    return [];
  }
  const rawList = Array.isArray(data?.claims)
    ? data.claims
    : Array.isArray(data?.items)
      ? data.items
      : [];
  const normalized = [];
  for (const item of rawList) {
    const claimId = item?.claim_id ?? item?.id ?? null;
    let authorFellowId = item?.author_fellow_id ?? item?.author?.fellow_id ?? item?.fellow ?? null;
    let sessionId = item?.session_id ?? item?.author?.session_id ?? item?.session ?? null;
    let falsifier = item?.falsifier ?? null;
    let kind = typeof item?.kind === "string" ? item.kind : "";
    if (
      claimId &&
      (authorFellowId === null || sessionId === null || typeof falsifier !== "string")
    ) {
      try {
        const detailRes = await fetch(
          `${upstreamOrigin}/p/${encodeURIComponent(problemId)}/claims/${encodeURIComponent(claimId)}.json`,
          { method: "GET", headers: { accept: "application/json", "user-agent": USER_AGENT } },
        );
        if (detailRes.status === 200) {
          const detail = await detailRes.json();
          // Real Stoa ClaimFaceResponse embeds claim JSON inside items[kind="claim-detail"].body
          // with keys { fellow, session, falsifier, kind, ... }. Also accept flat test shapes.
          let claimDetailBody = null;
          if (Array.isArray(detail?.items)) {
            const detailItem = detail.items.find((entry) => entry?.kind === "claim-detail");
            if (detailItem && typeof detailItem.body === "string") {
              try {
                claimDetailBody = JSON.parse(detailItem.body);
              } catch {
                claimDetailBody = null;
              }
            }
          }
          const c = claimDetailBody ?? detail?.claim ?? detail;
          authorFellowId =
            authorFellowId ?? c?.fellow ?? c?.author_fellow_id ?? c?.author?.fellow_id ?? null;
          sessionId = sessionId ?? c?.session ?? c?.session_id ?? c?.author?.session_id ?? null;
          falsifier = falsifier ?? c?.falsifier ?? null;
          if (!kind && typeof c?.kind === "string") kind = c.kind;
        }
      } catch {
        // Leave unknown fields null so verdict fails closed.
      }
    }
    normalized.push({
      claim_id: claimId,
      author_fellow_id: authorFellowId,
      session_id: sessionId,
      has_falsifier: typeof falsifier === "string" && falsifier.trim().length > 0,
      conjecture_class: CONJECTURE_CLASS.has(kind),
    });
  }
  return normalized;
}

function deepestStateStage(reached) {
  let deepest = "none";
  for (const stage of GAUNTLET_STAGES) {
    if (reached.includes(stage)) deepest = stage;
  }
  return deepest;
}

/**
 * Execute a full staging Cold-Agent Gauntlet cohort (default 10 attempts across >= 3 harnesses).
 * Every attempt verdict comes strictly from `gauntletVerdict` over proxy + anonymous public facts.
 */
export async function runStagingCohort({
  targetOrigin,
  entries,
  allowLoopback = false,
  injectFirstPromoteRefusal = true,
  approveEnrollment,
  runner,
  emit = () => {},
}) {
  const originCheck = validateStagingAgentOrigin(targetOrigin, { allowLoopback });
  if (!originCheck.ok) {
    return {
      ok: false,
      exitCode: originCheck.exitCode,
      code: originCheck.code,
      results: [],
      scorecard: null,
      attempts: [],
    };
  }
  const upstreamOrigin = originCheck.origin;
  const results = [];
  const attempts = [];

  for (const entry of entries) {
    const proxy = await startStagingRecordingProxy({
      upstreamOrigin,
      enrollmentSecret: entry.secret,
      injectFirstPromoteRefusal,
    });
    const proxyJoinUrl = `${proxy.origin}/join/${entry.enrollmentId}#${entry.secret}`;
    let runOutcome;
    let approvalPromise = Promise.resolve();
    try {
      if (typeof approveEnrollment === "function") {
        approvalPromise = Promise.resolve(
          approveEnrollment({
            enrollmentId: entry.enrollmentId,
            sponsorId: entry.sponsorId,
            problemId: entry.problemId,
            attemptIndex: entry.attemptIndex,
          }),
        );
      }
      if (typeof runner === "function") {
        runOutcome = await runner({
          attemptIndex: entry.attemptIndex,
          harness: entry.harness,
          joinUrl: proxyJoinUrl,
          proxyOrigin: proxy.origin,
          problemId: entry.problemId,
          sponsorId: entry.sponsorId,
        });
      } else {
        const harnessResult = await runHarnessAgent(entry.harness, proxyJoinUrl, {
          timeoutMs: 240_000,
        });
        if (harnessResult.unavailable) {
          return {
            ok: false,
            exitCode: 78,
            code: "GAUNTLET_STAGING_HARNESS_UNAVAILABLE",
            results,
            scorecard: null,
            attempts,
          };
        }
        runOutcome = {
          tokensUsed:
            typeof harnessResult.tokens === "number" && Number.isSafeInteger(harnessResult.tokens)
              ? harnessResult.tokens
              : 0,
        };
      }
      await approvalPromise;
    } finally {
      await proxy.close();
    }

    const snap = proxy.snapshot();
    const publicClaims = await fetchAnonymousPublicClaims(upstreamOrigin, entry.problemId);
    const verdict = gauntletVerdict({
      fellow: snap.fellow,
      sponsorId: entry.sponsorId,
      problemId: entry.problemId,
      sessions: snap.sessions,
      publicClaims,
      observations: snap.observations,
      injected: snap.injected,
      secretSeenInPaths: snap.secretSeenInPaths,
    });

    const tokensUsed =
      typeof runOutcome?.tokensUsed === "number" &&
      Number.isSafeInteger(runOutcome.tokensUsed) &&
      runOutcome.tokensUsed >= 0
        ? runOutcome.tokensUsed
        : 0;
    const completed = verdict.completed === true && tokensUsed > 0;
    const result = {
      attemptIndex: entry.attemptIndex,
      harness: entry.harness,
      completed,
      tokensUsed,
      stageReached: deepestStateStage(verdict.reached),
    };
    const attemptSummary = {
      type: "attempt",
      attempt_index: entry.attemptIndex,
      harness: entry.harness,
      problem_id: entry.problemId,
      completed,
      tokens_used: tokensUsed,
      served_bytes: snap.servedBytes,
      stage_reached: result.stageReached,
      reached: verdict.reached,
      failures:
        tokensUsed > 0
          ? verdict.failures
          : [...verdict.failures, "reconciled positive token count missing"],
    };
    results.push(result);
    attempts.push(attemptSummary);
    emit(attemptSummary);
  }

  const scorecard = scoreGauntlet(results);
  const summary = {
    type: "scorecard",
    status: scorecard.passed ? "pass" : "fail",
    code: scorecard.passed ? "GAUNTLET_STAGING_PASS" : "GAUNTLET_STAGING_FAILED",
    required_attempts: GAUNTLET_REQUIRED_ATTEMPTS,
    total: scorecard.total,
    completed: scorecard.completed,
    harnesses: scorecard.harnesses,
    median_tokens: scorecard.medianTokens,
    passed: scorecard.passed,
  };
  emit(summary);
  return {
    ok: scorecard.passed,
    exitCode: scorecard.passed ? 0 : 1,
    code: summary.code,
    results,
    scorecard,
    attempts,
  };
}
