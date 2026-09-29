import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";

// asimp search (bead asimposiumorg-l3b.1) against a real local Worker: real
// Workerd/D1, a promoted claim, and the CLI's parsed command, URL encoding and
// HTTP read (the Rust test search_real_http, reached through a loopback
// bridge because the CLI accepts only https origins). For every case the
// expected bytes are what curl fetched from the same Worker. Not a deployed,
// TLS or authenticated-session-loop proof.
//
// Build the Rust library test binary first. On a host whose cargo runs through
// RCH, sync it back as a job artifact, e.g.
//   rch exec --job --result-dir e2e/artifacts/<dir> -- bash -c '... cargo test
//     --manifest-path cli/Cargo.toml --locked --no-run --message-format=json ...
//     && cp <lib test executable> e2e/artifacts/<dir>/asimp-lib-tests'
// then run with ASIMP_SEARCH_TEST_BINARY=<that file>.

const execute = promisify(execFile);
const binary = process.env.ASIMP_SEARCH_TEST_BINARY;
assert.ok(binary, "set ASIMP_SEARCH_TEST_BINARY to the built asimp library test binary");

await runLocalWorkerJourney(async ({ call, enroll, sponsorCall, worker, origin, userAgent }) => {
  const SPONSOR = "usr_cli_search_author";
  const author = await enroll("cli-search-author", SPONSOR);
  const problem = (
    await call(
      "/v1/problems",
      {
        title: "Odd squares modulo eight",
        statement: "Every odd square leaves remainder one when divided by eight.",
        falsifier: "An odd integer whose square leaves another remainder modulo eight.",
        motivation: "Exercise public search from the CLI.",
        areas: ["number-theory"],
      },
      author,
      201,
    )
  ).problem.id;
  await sponsorCall(
    SPONSOR,
    "POST",
    `/v1/sponsors/problems/${problem}/lifecycle`,
    "problem-lifecycle",
    {
      action: "publish",
    },
  );
  const reviewer = await enroll("cli-search-reviewer", "usr_cli_search_reviewer");
  const reviewSession = (
    await call("/v1/sessions", { problem_id: problem, intent: "review" }, reviewer, 201)
  ).session_id;
  await call(
    `/v1/problems/${problem}/statement-review`,
    {
      session_id: reviewSession,
      statement_version: 1,
      verdict: "statement-clear",
      basis: "Exact.",
    },
    reviewer,
  );
  const session = (
    await call("/v1/sessions", { problem_id: problem, intent: "prove" }, author, 201)
  ).session_id;
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
      statement: "Squares of odd integers are congruent to one modulo eight, e.g. 3^2 = 9 = 8 + 1.",
      falsifier: "An odd n whose square modulo 8 is not 1.",
    },
    author,
    201,
  );

  // A real loopback bridge forwards the CLI's GETs, unchanged, to the Worker.
  let requests = [];
  const bridge = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, ua: request.headers["user-agent"] });
    const result = await worker.fetch(`${origin}${request.url}`, {
      headers: { "User-Agent": request.headers["user-agent"] ?? "" },
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${bridge.address().port}`;

  // curl's view of the same face, with the query encoded by curl itself.
  async function curlFace(face, params) {
    const args = ["--silent", "--get", "--user-agent", userAgent, "--write-out", "\n%{http_code}"];
    for (const [key, value] of params) args.push("--data-urlencode", `${key}=${value}`);
    args.push(`${local}${face}`);
    const { stdout } = await execute("curl", args, { maxBuffer: 1024 * 1024 });
    const cut = stdout.lastIndexOf("\n");
    return { body: stdout.slice(0, cut), status: Number(stdout.slice(cut + 1)) };
  }

  // The lexical index is filled from the outbox after the promotion commits,
  // so wait until the claim is findable before comparing faces; until then the
  // face declares index_pending rather than a false "no matches".
  for (let attempt = 0; ; attempt++) {
    const probe = await curlFace("/search.json", [["q", "congruent modulo eight"]]);
    const face = JSON.parse(probe.body);
    if (face.items.some((item) => item.id === claim.claim_id)) break;
    assert.ok(
      face.omitted.some((entry) => entry.reason === "index_pending"),
      "a face missing the fresh claim must declare index_pending",
    );
    assert.ok(attempt < 50, "the promoted claim was never indexed");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const cases = [
    { query: "congruent modulo eight", json: false },
    { query: "congruent modulo eight", json: true, kind: "claim", limit: 5 },
    { query: `${problem}#${claim.claim_id}`, json: true },
    // Plus, hash, ampersand, percent, Unicode and injection-shaped text.
    { query: "3^2 = 9 = 8 + 1 & 100% #odd ∀n ≡ 1 (mod 8) ?kind=fellow&limit=999", json: false },
    { query: "'; DROP TABLE claims; -- <script>", json: true },
    // A Worker refusal: the CLI exits nonzero without reflecting the query.
    { query: "", json: true },
  ];
  let found = 0;
  try {
    for (const item of cases) {
      const face = item.json ? "/search.json" : "/search.md";
      const params = [["q", item.query]];
      if (item.kind !== undefined) params.push(["kind", item.kind]);
      if (item.limit !== undefined) params.push(["limit", String(item.limit)]);
      const expectedQuery = new URLSearchParams(params).toString();
      const curled = await curlFace(face, params);
      if (curled.status === 200 && curled.body.includes(claim.claim_id)) found++;
      requests = [];
      const probe = {
        origin: local,
        ...item,
        expected_query: expectedQuery,
        status: curled.status,
        body: curled.body,
      };
      const { stdout } = await execute(
        binary,
        ["--exact", "tests::search_real_http", "--ignored"],
        {
          env: { ...process.env, ASIMP_SEARCH_PROBE: JSON.stringify(probe) },
          timeout: 20000,
          maxBuffer: 256 * 1024,
        },
      ).catch((error) => {
        if (error.stdout) process.stdout.write(error.stdout);
        if (error.stderr) process.stderr.write(error.stderr);
        throw new assert.AssertionError({
          message: `asimp search diverged for ${JSON.stringify(item)}`,
        });
      });
      assert.match(stdout, /test result: ok\. 1 passed; 0 failed; 0 ignored;/);
      assert.deepEqual(
        requests,
        [{ method: "GET", url: `${face}?${expectedQuery}`, ua: userAgent }],
        "exactly one GET for curl's face with the WHATWG-encoded query, with the required user agent",
      );
    }
  } finally {
    await new Promise((resolve) => bridge.close(resolve));
  }
  assert.ok(found >= 2, `the promoted claim is findable (found in ${found} faces)`);
  console.log(
    JSON.stringify({
      kind: "cli-search-real-bindings",
      status: "pass",
      cases: cases.length,
      boundary:
        "local Workerd/D1 through a loopback bridge; Rust command path; no TLS, deploy or auth claim",
    }),
  );
});
