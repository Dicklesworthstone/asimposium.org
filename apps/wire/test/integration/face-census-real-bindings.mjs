import assert from "node:assert/strict";
import { PUBLIC_RESOURCE_REGISTRY } from "../../../../packages/contracts/src/public-resources.ts";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// Same-cursor public face census (beads asimposiumorg-lu59 / 92x, Rule A1
// Diptych) on real local Workerd, D1 and R2. State is caused by real writes.
// For every entry in the canonical public resource registry whose parameters
// this journey can resolve, every agent-facing suffix is fetched at one quiet
// ledger state. Each face must answer 200 with an ETag that revalidates to
// 304 and carry the content license, and the Markdown face must state the
// same cursor as the JSON face.
//
// Not covered: the Agora .html faces (agora-local-lane), item kinds this
// journey does not create (their list faces are covered), edge caching.

const REPORT = process.argv.includes("--report");
const AGENT_SUFFIXES = new Set([".md", ".json", ".toon", ".ndjson", ".bib", ".csl.json"]);

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, worker, origin, userAgent }) => {
  const author = await enroll("census-author", "usr_census_author");
  const reviewer = await enroll("census-reviewer", "usr_census_reviewer");
  const created = await call(
    "/v1/problems",
    {
      title: "Census parity problem",
      statement: "Every integer in 0..70 has a square of the same parity.",
      falsifier: "An integer in 0..70 whose square has the opposite parity.",
      motivation: "Exercise every public face at one cursor.",
      areas: ["number-theory"],
    },
    author,
    201,
  );
  const problem = created.problem.id;
  await sponsorCall(
    "usr_census_author",
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    { action: "publish" },
  );
  const open = async (token, intent) =>
    (await call("/v1/sessions", { problem_id: problem, intent }, token, 201)).session_id;
  const reviewSession = await open(reviewer, "review");
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact range.",
    },
    reviewer,
  );
  const session = await open(author, "prove");
  const draft = await call(
    `/v1/sessions/${session}/workshop`,
    { type: "claim-draft", title: "Draft", body_md: "Private." },
    author,
    201,
  );
  const claim = await call(
    `/v1/sessions/${session}/promote`,
    {
      workshop_id: draft.workshop_id,
      kind: "conjecture",
      statement: "Zero squared is even.",
      falsifier: "Zero squared is odd.",
    },
    author,
    201,
  );
  await call(
    `/v1/p/${problem}/reviews`,
    {
      target_claim_id: claim.claim_id,
      target_version: 1,
      verdict: "inform",
      basis: "Checked zero squared against the definition of evenness.",
      capable_of_failure: "Zero squared being odd would refute it.",
      rubric: [],
      body_md: "Zero squared is zero, which is even.",
    },
    reviewer,
    201,
  );
  await call(
    `/v1/p/${problem}/dead-ends`,
    {
      approach: "Tried induction on the square alone.",
      why_it_fails: "The induction step never uses the parity of the base.",
      retry_predicate: "Retry once the base parity enters the step.",
    },
    author,
    201,
  );
  const fellowName = (await call("/v1/hello", undefined, author)).fellow.name;

  const params = { id: problem, cid: claim.claim_id, version: "1", name: fellowName, since: "0" };
  const resolve = (pattern) => {
    let unresolved = false;
    const url = pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
      if (params[name] === undefined) unresolved = true;
      return encodeURIComponent(params[name] ?? "");
    });
    return unresolved ? null : url;
  };
  // Swap the suffix of a registry URL, keeping any query string.
  const withSuffix = (url, suffix) => {
    const [path, query] = url.split("?");
    const bare = path.replace(/(\.csl\.json|\.jsonl\.gz|\.[a-z]+)$/, "");
    return `${bare}${suffix}${query ? `?${query}` : ""}`;
  };
  const fetchFace = async (path, headers = {}) =>
    worker.fetch(`${origin}${path}`, { headers: { "User-Agent": userAgent, ...headers } });

  const rows = [];
  const covered = [];
  const skipped = [];
  for (const entry of PUBLIC_RESOURCE_REGISTRY) {
    const base = resolve(entry.agent_markdown_url);
    if (base === null) {
      skipped.push(entry.kind);
      continue;
    }
    covered.push(entry.kind);
    let jsonCursor;
    const suffixes = entry.allowed_suffixes.filter((suffix) => AGENT_SUFFIXES.has(suffix));
    // JSON first, so the Markdown face can be compared with its cursor.
    suffixes.sort((a, b) => (a === ".json" ? -1 : b === ".json" ? 1 : 0));
    for (const suffix of suffixes) {
      const path =
        suffix === ".json" && entry.json_url
          ? resolve(entry.json_url)
          : withSuffix(base, suffix);
      const response = await fetchFace(path);
      const text = await response.text();
      const etag = response.headers.get("etag");
      const revalidated = etag ? (await fetchFace(path, { "if-none-match": etag })).status : null;
      if (suffix === ".json" && response.status === 200) {
        try {
          const cursor = JSON.parse(text).cursor;
          if (typeof cursor === "number") jsonCursor = cursor;
        } catch {
          /* non-object JSON faces carry no cursor */
        }
      }
      rows.push({
        kind: entry.kind,
        path,
        status: response.status,
        etag: etag !== null,
        revalidated,
        license: text.includes("CC-BY-4.0") || text.includes("CC BY 4.0"),
        cursorAgrees:
          suffix === ".md" && jsonCursor !== undefined
            ? new RegExp(`\\b${jsonCursor}\\b`).test(text)
            : null,
      });
    }
  }

  if (REPORT) {
    for (const row of rows) console.log(JSON.stringify(row));
    console.log(JSON.stringify({ covered, skipped }));
    return;
  }
  const failures = rows.filter(
    (row) =>
      row.status !== 200 ||
      !row.etag ||
      row.revalidated !== 304 ||
      !row.license ||
      row.cursorAgrees === false,
  );
  assert.deepEqual(failures, [], "every resolvable public face is served consistently");
  assert.ok(covered.length >= 25, `covered ${covered.length} registry kinds`);
  console.log(
    JSON.stringify({
      stage: "face-census-journey-passed",
      kind: "face-census-real-bindings",
      status: "pass",
      kinds_covered: covered.length,
      faces_checked: rows.length,
      kinds_skipped: skipped,
      boundary: "local Workerd/D1/R2; agent faces only; one quiet ledger state",
    }),
  );
});
