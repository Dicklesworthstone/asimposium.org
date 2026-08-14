import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertS3PublicProjectionShape,
  assertS3PublicValueSafe,
  assertS3RenderedFaceShape,
  normalizeS3ClaimStatement,
} from "../../src/split/local-worker.ts";

const root = resolve(import.meta.dir, "../../../..");

/**
 * Exact semantic manifest for the local Workerd proof. A count alone can stay
 * green when one assertion disappears and an unrelated assertion is added.
 * Keeping the names sorted makes a failure identify the missing or unexpected
 * product guarantee directly in Bun's bounded diff.
 */
const EXPECTED_LOCAL_BINDING_ASSERTIONS: string[] = [
  "R2_put_then_D1_failure_leaves_an_unreachable_orphan_and_retry_binds_without_a_cursor_burn",
  "S4_allow_with_warning_publishes_a_safe_category_action_notice_without_provider_detail",
  "S4_authorized_benign_outage_fixture_degrades_to_a_public_warning_notice_not_a_silent_pass",
  "S4_concurrent_same_key_publishing_replays_the_exact_201_and_commits_one_event_action_and_receipt",
  "S4_contextual_aggregation_reads_all_four_D1_authorized_public_fields_and_holds_without_public_effect",
  "S4_direct_content_reject_is_not_downgraded_by_contextual_screening",
  "S4_extract_history_field_reaches_contextual_provider_without_public_effect",
  "S4_frontier_receipts_revalidate_same_fellow_history_but_do_not_spuriously_invalidate_another_fellow",
  "S4_negative_content_context_dedup_is_expiring_receipted_and_never_leaks_into_public_projection",
  "S4_oversized_context_fails_closed_without_response_R2_event_or_export_canary_leakage",
  "S4_oversized_historical_artifact_is_omitted_before_materialization_and_later_benign_promotion_records_the_exact_omission",
  "S4_problem_statement_is_server_owned_and_caller_material_never_reflects",
  "S4_promotion_requires_an_explicit_idempotency_key_before_screening_or_public_effect",
  "S4_provider_exception_message_and_stack_are_a_coarse_private_hold_without_response_R2_event_or_export_leakage",
  "S4_provider_timeout_fails_closed_to_a_private_appealable_hold_without_public_cursor_or_artifact",
  "S4_public_artifact_md_history_field_reaches_contextual_provider_without_public_effect",
  "S4_replay_map_expires_after_24_hours_without_erasing_immutable_decision_history",
  "S4_statement_history_field_reaches_contextual_provider_without_public_effect",
  "S4_title_history_field_reaches_contextual_provider_without_public_effect",
  "all_eleven_async_route_entry_faults_return_one_exact_nonreflective_binding_failure",
  "anonymous_or_stale_private_authority_is_not_found_without_a_private_cache_entry",
  "caller_cannot_choose_a_claim_identifier",
  "caller_cannot_choose_a_workshop_identifier",
  "concurrent_promotions_allocate_server_claim_ids_and_D1_RETURNING_public_sequences_without_burns",
  "concurrent_workshop_pushes_use_D1_RETURNING_sequences_without_duplicates_or_burns",
  "duplicate_and_P2_P4_refusals_leave_the_public_projection_at_its_original_cursor",
  "large_workshop_body_spills_to_R2_and_gets_a_server_owned_workshop_id",
  "local_workerd_reports_D1_and_R2_bindings_with_a_public_readiness_nonce_but_never_authority",
  "missing_problem_never_fabricates_an_empty_public_projection",
  "near_duplicate_promotion_is_refused_citing_P11_without_a_cursor_burn",
  "one_promotion_atomically_allocates_the_first_public_claim_and_binds_its_public_artifact",
  "only_the_explicitly_published_public_artifact_is_readable_after_complete_D1_binding",
  "owner_private_read_crosses_R2_and_revalidates_the_D1_binding",
  "post_promotion_face_validators_are_representation_specific",
  "post_promotion_html-fragment_is_a_private-free_rendered_face_with_a_representation_etag",
  "post_promotion_html-fragment_matching_validator_returns_a_private-free_304",
  "post_promotion_json_is_a_private-free_rendered_face_with_a_representation_etag",
  "post_promotion_json_matching_validator_returns_a_private-free_304",
  "post_promotion_md_is_a_private-free_rendered_face_with_a_representation_etag",
  "post_promotion_md_matching_validator_returns_a_private-free_304",
  "post_promotion_public_projection_search_and_export_apply_shape_guards",
  "private_only_problem_is_byte_indistinguishable_from_unknown_on_every_public_route",
  "public_errors_search_and_export_never_reflect_private_probe_material",
  "public_faces_begin_only_after_a_committed_ledger_event",
  "raw_C0_controls_cannot_collide_with_protected_math_tokens",
  "readiness_nonce_or_nonempty_route_binding_poison_headers_are_byte_for_byte_inert_on_every_async_route",
  "rendered_json_contains_only_one_public_ledger_item",
  "reused_idempotency_key_with_a_different_promotion_preserves_the_one_promotion_invariant",
  "self_certified_status_is_refused_citing_P2_P4",
  "sponsor_can_read_own_fellow_workshop_while_public_routes_disclose_nothing",
  "staged_private_digest_is_not_publicly_readable_before_promotion",
  "top_level_authoritative_fields_and_status_upgrades_are_refused_citing_P2_P4",
];

const LOCAL_WORKER_BUNDLE_SENTINELS = [
  "s3_local_workshops",
  "/__s3/workshops",
  "s3-local/private/staged/sha256/",
  "s3_local_fellow_workshop_ids",
] as const;

function localWorkerBundleSentinels(bundle: string): readonly string[] {
  return LOCAL_WORKER_BUNDLE_SENTINELS.filter((sentinel) => bundle.includes(sentinel));
}

function assertProductionBundleExcludesLocalWorker(bundle: string): void {
  const localWorkerSentinels = localWorkerBundleSentinels(bundle);
  if (localWorkerSentinels.length !== 0) {
    throw new Error(`S3_LOCAL_WORKER_IN_PRODUCTION_BUNDLE:${localWorkerSentinels.join(",")}`);
  }
}

function sourceRegion(source: string, start: string, nextStart: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(nextStart, startIndex + start.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`S3_SOURCE_REGION_NOT_FOUND:${start}`);
  }
  return source.slice(startIndex, endIndex);
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

async function bundleText(outputs: readonly Blob[]): Promise<string> {
  return (await Promise.all(outputs.map((output) => output.text()))).join("\n");
}

async function counterfactualProductionBundle(
  productionEntrypoint: string,
  localWorkerEntrypoint: string,
) {
  const entrypoint = "s3-production-counterfactual-entry";
  const namespace = "s3-production-counterfactual";
  return Bun.build({
    entrypoints: [entrypoint],
    format: "esm",
    target: "browser",
    // Bun.build inside Bun's test runner cannot currently resolve the Zod
    // dependency through packages/contracts' workspace-local node_modules.
    // Zod cannot import the local S-3 worker; keeping only that third-party
    // package external preserves the production/local entry-graph assertion.
    external: ["zod"],
    plugins: [
      {
        name: namespace,
        setup(build) {
          build.onResolve({ filter: /^s3-production-counterfactual-entry$/u }, () => ({
            path: entrypoint,
            namespace,
          }));
          build.onLoad({ filter: /^s3-production-counterfactual-entry$/u, namespace }, () => ({
            loader: "ts",
            contents: [
              `import productionWorker from ${JSON.stringify(productionEntrypoint)};`,
              `import localWorker from ${JSON.stringify(localWorkerEntrypoint)};`,
              "export default {",
              "  fetch(request: Request, env: unknown, ctx: unknown) {",
              '    if (request.headers.get("x-s3-counterfactual") === "1") {',
              "      return localWorker.fetch(request, env as never, ctx as never);",
              "    }",
              "    return productionWorker.fetch(request, env as never, ctx as never);",
              "  },",
              "};",
            ].join("\n"),
          }));
        },
      },
    ],
  });
}

test("the S-3 harness binds readiness to its child and excludes the deployed entry graph", async () => {
  const script = readFileSync(resolve(root, "scripts/e2e-s3-split.sh"), "utf8");
  const worker = readFileSync(resolve(root, "apps/wire/src/split/local-worker.ts"), "utf8");
  const checker = readFileSync(resolve(root, "apps/wire/src/split/local-check.ts"), "utf8");
  const productionApp = readFileSync(resolve(root, "apps/wire/src/app.ts"), "utf8");
  const productionIndex = readFileSync(resolve(root, "apps/wire/src/index.ts"), "utf8");
  const wirePackage = JSON.parse(readFileSync(resolve(root, "apps/wire/package.json"), "utf8")) as {
    readonly exports?: { readonly "."?: string };
  };
  const productionConfigs = [
    "infra/wrangler.toml",
    "infra/environments/local.wrangler.toml",
    "infra/environments/staging.wrangler.toml",
    "infra/environments/production.wrangler.toml",
  ].map((path) => readFileSync(resolve(root, path), "utf8"));
  const productionEntrypoint = resolve(root, "apps/wire/src/index.ts");
  const localWorkerEntrypoint = resolve(root, "apps/wire/src/split/local-worker.ts");
  const productionBundle = await Bun.build({
    entrypoints: [productionEntrypoint],
    format: "esm",
    target: "browser",
    external: ["zod"],
  });
  const counterfactualBundle = await counterfactualProductionBundle(
    productionEntrypoint,
    localWorkerEntrypoint,
  );
  const publicRowInjection =
    "const publicRows = publicRowsForRequest(request, env, events.results);";
  const publicRowGuard = "assertS3PublicEventRows(publicRows);";
  const faultGateSource = sourceRegion(
    worker,
    "function d1FaultRequested(",
    "function publicRowsForRequest(",
  );
  const projectionSource = sourceRegion(
    worker,
    "async function publicProjection(",
    "async function publicFace(",
  );
  const faceSource = sourceRegion(
    worker,
    "async function publicFace(",
    "async function publicSearch(",
  );
  const searchSource = sourceRegion(
    worker,
    "async function publicSearch(",
    "async function publicExport(",
  );
  const exportSource = sourceRegion(
    worker,
    "async function publicExport(",
    "async function publicArtifact(",
  );
  const fetchSource = worker.slice(worker.indexOf("  async fetch("));
  const exactBindingFailureSource = sourceRegion(
    worker,
    "function localS3BindingFailure()",
    "function notFound()",
  );
  const checkerExactBindingFailureSource = sourceRegion(
    checker,
    "function isExactLocalS3BindingFailure(",
    "async function pushWorkshop(",
  );
  const routePoisonSource = sourceRegion(
    worker,
    "function throwIfRouteBindingPoisoned(",
    "function publicRowsForRequest(",
  );
  const publicShapePoisonAssertionSource = sourceRegion(
    checker,
    '"post_promotion_public_projection_search_and_export_apply_shape_guards",',
    '  check(\n    "all_eleven_async_route_entry_faults_return_one_exact_nonreflective_binding_failure",',
  );
  const readinessLoopSource = sourceRegion(script, "ready=0\n", `if [[ \${ready} -ne 1 ]]`);
  const healthHandlerSource = sourceRegion(
    worker,
    'if (request.method === "GET" && url.pathname === "/__s3/health") {',
    'if (request.method === "POST" && url.pathname === "/__s3/workshops") {',
  );

  expect(script).toContain("S3_PORT_OCCUPIED");
  expect(script).toMatch(/--var "S3_RUN_TOKEN:\$\{S3_RUN_TOKEN\}"/);
  expect(script).toMatch(/--var "S3_READINESS_NONCE:\$\{S3_READINESS_NONCE\}"/);
  expect(readinessLoopSource).toContain("readiness_nonce");
  expect(readinessLoopSource).toContain("S3_READINESS_NONCE");
  expect(readinessLoopSource).not.toContain("S3_RUN_TOKEN");
  expect(healthHandlerSource).toContain("readiness_nonce: readinessNonce");
  expect(healthHandlerSource).not.toContain("run_token");
  expect(script).toContain("CHECKER_DEADLINE_SECONDS");
  expect(script).toMatch(/S3_LOCAL_RUN_TOKEN="\$\{S3_RUN_TOKEN\}"/);
  expect(script).toContain("S3_SELF_TEST_TERM_RESISTANT_CHILD");
  expect(script).toContain("S3_SELF_TEST_IDENTITY_MISMATCH");
  expect(script).toContain("S3_SELF_TEST_SECOND_SIGNAL_DURING_CLEANUP");
  expect(script).toContain("S3_SELF_TEST_PROVISIONAL_EXACT_FAILURE");
  expect(script).toContain("S3_SELF_TEST_STARTUP_SIGNAL_WINDOW");
  expect(script).toContain("S3_SELF_TEST_CHECKER_TIMEOUT");
  expect(script).toContain("S3_SELF_TEST_CHECKER_CONTAINMENT_FAILURE");
  expect(script).toContain("S3_SELF_TEST_PID_REUSE");
  expect(script).toContain("s3-pinned-supervisor:");
  expect(script).toContain("ps -o lstart=");
  expect(script).toContain("supervisor_identity_is_exact");
  expect(script).toContain("listener_pids_are_in_group");
  expect(script).toContain("assert_no_survivors");
  expect(script).toContain("signal_exact_group KILL");
  expect(script).toContain("trap '' HUP INT TERM");
  expect(script).toContain("cleanup_with_retry");
  expect(script).toContain("signal_exact_direct_supervisor");
  expect(script).toContain("signal_exact_group_supervisor");
  expect(script).toContain("start_supervised_payload checker");
  expect(script).toContain("LOCAL_SPLIT_CHECKER_CONTAINMENT_FAILED");
  expect(script).toContain("checker_exit_diagnostics");
  expect(script).toContain("checker_exit_status");
  expect(script).toContain("S3_SELF_TEST_CHECKER_EXIT_1");
  expect(script).toContain("S3_SELF_TEST_DISPATCH_STARTUP_SIGNAL");
  expect(script).toContain("is_retained_signal_status");
  expect(script).toContain("emit_checked_checker_jsonl");
  expect(script).not.toMatch(/cat "\$\{CHECK_LOG\}"/);
  expect(script).not.toMatch(/kill -TERM .*CHECKER_PID/);
  expect(worker).toContain("const authority = env.S3_RUN_TOKEN");
  expect(worker).toContain("request.headers.get(header) === env.S3_RUN_TOKEN");
  expect(worker).toContain("only `__s3` test routes plus the artifact host shape are mounted");
  expect(occurrences(worker, publicRowGuard)).toBe(3);
  for (const routeSource of [projectionSource, searchSource, exportSource]) {
    expect(occurrences(routeSource, publicRowInjection)).toBe(1);
    expect(occurrences(routeSource, publicRowGuard)).toBe(1);
    expect(routeSource.indexOf(publicRowInjection)).toBeLessThan(
      routeSource.indexOf(publicRowGuard),
    );
  }
  expect(occurrences(projectionSource, "assertS3PublicProjectionShape(projection);")).toBe(1);
  expect(occurrences(faceSource, "assertS3RenderedFaceShape(face, format);")).toBe(1);
  expect(worker).toContain("FROM s3_local_public_cursors");
  expect(worker).toContain('const LOCAL_SPONSOR_ID = "local-sponsor-fixture";');
  expect(worker).not.toContain("function localSponsorId(");
  expect(faultGateSource).toContain(
    "request.headers.get(TEST_D1_BIND_FAULT_HEADER) === TEST_D1_BIND_FAULT",
  );
  expect(faultGateSource).toContain(
    "hasLocalHarnessAuthority(request, env, TEST_D1_BIND_FAULT_AUTHORITY_HEADER)",
  );
  expect(worker).toContain("hasLocalHarnessAuthority(request, env, TEST_PUBLIC_ROW_POISON_HEADER)");
  expect(worker).toContain("TEST_ROUTE_BINDING_POISON_HEADER");
  expect(routePoisonSource).toContain(
    "hasLocalHarnessAuthority(request, env, TEST_ROUTE_BINDING_POISON_HEADER)",
  );
  expect(exactBindingFailureSource).toContain(
    'JSON.stringify({ code: "LOCAL_S3_BINDING_FAILURE" })',
  );
  expect(exactBindingFailureSource).toContain("status: 500");
  expect(exactBindingFailureSource).toContain(
    'headers: { "content-type": "application/json; charset=utf-8" }',
  );
  expect(exactBindingFailureSource).not.toContain("cache-control");
  expect(exactBindingFailureSource).not.toContain("x-content-type-options");
  expect(fetchSource).toContain("return localS3BindingFailure();");
  // Mutation guard: replacing exact poison verification with a bare status
  // check, body, or header check must fail before runtime coverage is reached.
  // The direct S-3 command exercises every route against the same contract.
  expect(checkerExactBindingFailureSource).toContain("output.response.status === 500");
  expect(checkerExactBindingFailureSource).toContain(
    'output.body === \'{"code":"LOCAL_S3_BINDING_FAILURE"}\'',
  );
  expect(checkerExactBindingFailureSource).toContain("applicationHeaders.length === 1");
  expect(checkerExactBindingFailureSource).toContain(
    'applicationHeaders[0]?.[0] === "content-type"',
  );
  expect(checkerExactBindingFailureSource).toContain(
    'applicationHeaders[0]?.[1] === "application/json; charset=utf-8"',
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "poisonedPublic.every(\n        (response) =>\n          isExactLocalS3BindingFailure(response) &&",
  );
  expect(publicShapePoisonAssertionSource).not.toContain(
    "response.response.status === 500 &&\n          hasNoPrivateMaterial(response",
  );
  expect(checker).toContain("poisonProbeSnapshots({})");
  expect(checker).toContain("const poisonedProbeForbidden = [");
  expect(checker).toContain("poisonedPrivateLocator,\n    localAuthorityToken");
  expect(publicShapePoisonAssertionSource).toContain(
    "response.response.status === unpoisonedPublic[index]?.response.status",
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "response.body === unpoisonedPublic[index]?.body",
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "response.headers === unpoisonedPublic[index]?.headers",
  );
  expect(publicShapePoisonAssertionSource).toContain(
    "hasNoPrivateMaterial(response, poisonedProbeForbidden)",
  );
  expect(checker).toContain("readinessNonceRouteBindingPoisonHeaders");
  expect(checker).toContain("nonemptyRouteBindingPoisonHeaders");
  expect(checker).toContain(
    "readiness_nonce_or_nonempty_route_binding_poison_headers_are_byte_for_byte_inert_on_every_async_route",
  );
  expect(checker).toContain("routeBindingPoisonSnapshots({})");
  expect(checker).toContain("response.body === routeBindingBaseline[index]?.body");
  expect(checker).toContain("response.headers === routeBindingBaseline[index]?.headers");
  for (const dispatch of [
    "return await pushWorkshop(request, env);",
    "return await promoteWorkshop(request, env);",
    "return await privateArtifact(request, env, privateMatch[1]);",
    "return await recoveryAudit(request, env, recoveryMatch[1]);",
    "return await publicArtifact(request, env, artifactMatch[1]);",
    "return await publicSearch(request, env, searchMatch[1]);",
    "return await publicScreeningActions(request, env, screeningActionsMatch[1]);",
    "return await localS4Diagnostics(request, env, s4DiagnosticsMatch[1]);",
    "return await seedOversizedS4History(request, env, oversizedHistorySeedMatch[1]);",
    "return await publicExport(request, env, exportMatch[1]);",
    "return await publicFace(request, env, publicMatch[1]);",
  ]) {
    expect(occurrences(fetchSource, dispatch)).toBe(1);
  }
  expect(occurrences(fetchSource, "return await ")).toBe(11);
  expect(worker).toContain("token-gated\n      // NOT_FOUND existence behavior");
  expect(worker).not.toContain('LOCAL_SPONSOR_ID = "local-sponsor"');
  expect(worker).not.toContain('RECOVERY_AUDIT_HEADER = "local-recovery-audit"');
  expect(productionApp).not.toContain("split/local-worker");
  expect(productionIndex).toContain('import { createApp } from "./app"');
  expect(productionIndex).not.toContain("split/local-worker");
  expect(wirePackage.exports?.["."]).toBe("./src/index.ts");
  expect(productionConfigs.every((config) => config.includes("apps/wire/src/index.ts"))).toBe(true);
  expect(productionBundle.success).toBe(true);
  const productionBundleText = await bundleText(productionBundle.outputs);
  expect(localWorkerBundleSentinels(productionBundleText)).toEqual([]);
  expect(() => assertProductionBundleExcludesLocalWorker(productionBundleText)).not.toThrow();
  expect(counterfactualBundle.success).toBe(true);
  const counterfactualBundleText = await bundleText(counterfactualBundle.outputs);
  expect(localWorkerBundleSentinels(counterfactualBundleText)).toEqual(
    LOCAL_WORKER_BUNDLE_SENTINELS,
  );
  expect(() => assertProductionBundleExcludesLocalWorker(counterfactualBundleText)).toThrow(
    "S3_LOCAL_WORKER_IN_PRODUCTION_BUNDLE",
  );
  expect(checker).toContain("S3_LOCAL_ORIGIN_MUST_BE_LOOPBACK");
  expect(checker).toContain("S3_LOCAL_RUN_TOKEN_REQUIRED");
  expect(checker).toContain("AbortSignal.timeout(FETCH_TIMEOUT_MS)");
});

test("local public guards normalize private locator keys and allow renderer body only by exact shape", () => {
  for (const key of [
    "sponsor-id",
    "Sponsor Id",
    "Ｓｐｏｎｓｏｒ　Ｉｄ",
    "body_key",
    "Body Digest",
    "Ｏｂｊｅｃｔ－Ｋｅｙ",
    "fellow_id",
    "Session Id",
    "source-workshop-id",
  ]) {
    expect(() => assertS3PublicValueSafe({ [key]: "private locator canary" })).toThrow(
      "S3_LOCAL_PUBLIC_SHAPE_INVALID",
    );
  }

  const projection = {
    schema: "asimposium.pack.v1",
    kind: "ledger",
    problem: "P-public",
    profile: "public",
    cursor: 1,
    title: "Public ledger",
    preamble: "Untrusted data follows.",
    items: [
      {
        kind: "claim",
        id: "EV-1",
        scope: "ledger",
        untrusted: true,
        body: "Legitimate public renderer body.",
        why_included: "public event 1",
      },
    ],
    omitted: [
      { reason: "workshop_scope_excluded", detail: "private workshop bodies are not public" },
    ],
    next_actions: [{ method: "GET", url: "/v1/hello", why: "public orientation" }],
    degraded: [],
  };
  expect(() => assertS3PublicProjectionShape(projection)).not.toThrow();
  expect(() =>
    assertS3PublicProjectionShape({ ...projection, annotation: "not allowlisted" }),
  ).toThrow("S3_LOCAL_PUBLIC_SHAPE_INVALID");
  expect(() =>
    assertS3RenderedFaceShape(
      {
        format: "md",
        media_type: "text/markdown; charset=utf-8",
        body: "body",
        fingerprint: "fingerprint",
        bytes: 4,
        neutralized: [],
      },
      "md",
    ),
  ).not.toThrow();
  expect(() =>
    assertS3RenderedFaceShape(
      {
        format: "md",
        media_type: "text/markdown; charset=utf-8",
        body: "body",
        fingerprint: "fingerprint",
        bytes: 4,
        neutralized: [],
        sponsor_id: "private locator canary",
      },
      "md",
    ),
  ).toThrow("S3_LOCAL_PUBLIC_SHAPE_INVALID");
});

test("local P11 normalization matches the shared inline-math contract and preserves whitespace collapse", () => {
  const rawControl = normalizeS3ClaimStatement("The relation \u0002x + y\u0003 is recorded.");
  const explicitMath = normalizeS3ClaimStatement("The relation \\(x + y\\) is recorded.");
  const inlineMath = normalizeS3ClaimStatement("The relation $x + y$ is recorded.");

  expect(rawControl).not.toBe(explicitMath);
  expect(rawControl).toContain("[c0-02]");
  expect(rawControl).toContain("[c0-03]");
  expect(inlineMath).toBe(explicitMath);
  expect(normalizeS3ClaimStatement("line one\nline two\tline three")).toBe(
    normalizeS3ClaimStatement("line one line two line three"),
  );
});

test(
  "PLANTED: an occupied pinned port is refused before foreign readiness can be borrowed",
  async () => {
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response('{"status":"ok"}\n'),
    });
    try {
      const child = Bun.spawn({
        cmd: ["bash", "scripts/e2e-s3-split.sh"],
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          S3_PORT: String(listener.port),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('"code":"S3_PORT_OCCUPIED"');
      expect(`${stdout}\n${stderr}`).not.toContain('"status":"pass"');
    } finally {
      listener.stop(true);
    }
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: a failed provisional exact check sends no signal and retains ownership for retry",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_PROVISIONAL_EXACT_FAILURE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      '"assertion":"provisional_exact_check_failure_sent_no_signal_retained_ownership_and_retried"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: startup signals cannot escape any spawn through return ownership window",
  async () => {
    for (const window of [
      "background_spawn",
      "scratch_assignment",
      "stop_proof",
      "adoption",
      "cont_release",
      "return",
    ]) {
      const child = Bun.spawn({
        cmd: ["bash", "scripts/e2e-s3-split.sh"],
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          S3_SELF_TEST_STARTUP_SIGNAL_WINDOW: window,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(129);
      expect(stdout).toContain(
        `"assertion":"startup_signal_window_${window}_retained_exact_ownership"`,
      );
      expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
    }
  },
  { timeout: 30_000 },
);

for (const owner of ["server", "checker"] as const) {
  test(
    `PLANTED: the production ${owner} dispatch preserves a retained startup HUP`,
    async () => {
      const startedAt = performance.now();
      const child = Bun.spawn({
        cmd: ["bash", "scripts/e2e-s3-split.sh"],
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          S3_SELF_TEST_DISPATCH_STARTUP_SIGNAL: owner,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const combined = `${stdout}\n${stderr}`;
      expect(exitCode).toBe(129);
      expect(performance.now() - startedAt).toBeLessThan(10_000);
      expect(stdout).toContain(`"assertion":"dispatch_startup_signal_${owner}_preserves_exit_129"`);
      expect(combined).not.toContain('"code":"LOCAL_WORKER_SUPERVISOR_UNAVAILABLE"');
      expect(combined).not.toContain('"code":"LOCAL_SPLIT_ASSERTION_FAILED"');
    },
    { timeout: 10_000 },
  );
}

test(
  "PLANTED: checker timeout reaps its exact group, descendants, listener, and state FD",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_CHECKER_TIMEOUT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    for (const assertion of [
      "checker_timeout_uses_exact_bounded_term_kill_and_wait",
      "checker_timeout_has_zero_group_or_descendant_survivors",
      "checker_timeout_releases_its_test_port",
      "checker_timeout_has_zero_state_fd_survivors",
    ]) {
      expect(stdout).toContain(`"assertion":"${assertion}"`);
    }
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: an uninspectable checker group reports containment failure and EXIT reclaims it",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_CHECKER_CONTAINMENT_FAILURE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain('"code":"LOCAL_SPLIT_CHECKER_CONTAINMENT_FAILED"');
    expect(`${stdout}\n${stderr}`).not.toContain('"code":"LOCAL_WORKER_CLEANUP_FAILED"');
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: a real checker exit 1 reports a bounded safe diagnostic without waiting for timeout",
  async () => {
    const startedAt = performance.now();
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_CHECKER_EXIT_1: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const combined = `${stdout}\n${stderr}`;
    expect(exitCode).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(10_000);
    expect(stdout).toContain('"code":"LOCAL_SPLIT_ASSERTION_FAILED"');
    expect(stdout).toContain('"checker_exit_status":1');
    expect(stdout).toContain('"checker_lifecycle":{"supervisor":"reaped","payload":"exited_1"}');
    expect(stdout).toContain('"kind":"empty"');
    for (const forbidden of [root, "/Users/", "file:///", "Error:", "local-worker.ts"]) {
      expect(combined).not.toContain(forbidden);
    }
    expect(combined).not.toMatch(/\bat\s+.+:\d+:\d+/u);
  },
  { timeout: 10_000 },
);

test(
  "PLANTED: simulated PID reuse with a different marker and lstart sends no signal",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_PID_REUSE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('"assertion":"planted_pid_reuse_lstart_mismatch_sent_no_signal"');
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: a payload leader exits under TERM while the pinned supervisor retains resistant descendants",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_TERM_RESISTANT_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    for (const assertion of [
      "payload_leader_exits_while_pinned_supervisor_and_resistant_descendant_remain",
      "term_resistant_group_has_zero_survivors",
      "term_resistant_fixture_releases_its_test_port",
      "term_resistant_state_fd_has_zero_survivors",
    ]) {
      expect(stdout).toContain(`"assertion":"${assertion}"`);
    }
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: a marker-only mismatch with the real lstart refuses group signals and reports cleanup failure",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_IDENTITY_MISMATCH: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(19);
    expect(stdout).toContain('"code":"LOCAL_WORKER_CLEANUP_FAILED"');
    expect(stdout).toContain('"original_status":19');
    expect(stdout).toContain(
      '"assertion":"marker_only_mismatch_refuses_group_signals_and_preserves_ownership"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"code":"SECOND_SIGNAL_CLEANUP_BYPASS"');
  },
  { timeout: 15_000 },
);

test(
  "PLANTED: HUP INT and TERM are masked throughout a retained-identity EXIT cleanup retry",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        S3_SELF_TEST_SECOND_SIGNAL_DURING_CLEANUP: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      '"assertion":"second_signals_are_masked_during_bounded_exit_cleanup_retry"',
    );
    expect(`${stdout}\n${stderr}`).not.toContain('"status":"fail"');
  },
  { timeout: 15_000 },
);

/**
 * The command must positively exercise local workerd D1/R2 and renderer
 * boundaries before honestly blocking staging-only identity/browser proof.
 */
test(
  "the S-3 command proves local bindings and blocks only staging proof",
  async () => {
    const child = Bun.spawn({
      cmd: ["bash", "scripts/e2e-s3-split.sh"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const records = stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const local = records.find(
      (record) => record.suite === "s3-local-bindings" && record.status === "pass",
    );
    const staging = records.find((record) => record.suite === "s3-staging-paired-principal");
    const assertions = records.filter(
      (record) =>
        record.suite === "e2e-s3-split-local" &&
        typeof record.assertion === "string" &&
        record.assertion !== "local_binding_summary",
    );

    expect(exitCode).toBe(78);
    expect(local).toMatchObject({
      tool: "wrangler+bun",
      package: "@asimposium/wire",
      suite: "s3-local-bindings",
      status: "pass",
      bindings: { d1: "DB", r2: "ARTIFACTS" },
      reproduce: "bash scripts/e2e-s3-split.sh",
    });
    expect(staging).toMatchObject({
      tool: "wrangler",
      package: "@asimposium/wire",
      suite: "s3-staging-paired-principal",
      status: "blocked",
      exit_code: 78,
      code: "S3_STAGING_ENVIRONMENT_ABSENT",
      reproduce: "bash scripts/e2e-s3-split.sh",
    });
    expect(String(staging?.blocked_on)).toContain("paired sponsor plus anonymous browser proof");
    expect(String(staging?.forbidden_substitutes)).toContain("local-workerd behavior");
    const assertionNames = assertions.map((record) => record.assertion as string).toSorted();
    expect(new Set(assertionNames).size).toBe(assertionNames.length);
    expect(assertionNames).toEqual(EXPECTED_LOCAL_BINDING_ASSERTIONS);
    expect(assertions.every((record) => record.status === "pass")).toBe(true);
    expect(stderr).toContain("BLOCKED s3-staging-paired-principal");
    expect(`${stdout}\n${stderr}`).not.toContain(root);
    expect(`${stdout}\n${stderr}`).not.toContain("/Users/");
    expect(`${stdout}\n${stderr}`).not.toMatch(/asimp_ag_[A-Za-z0-9_-]{4,}/);
  },
  { timeout: 20_000 },
);
