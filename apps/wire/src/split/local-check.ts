#!/usr/bin/env bun
/**
 * Assertions for the real local S-3 workerd binding harness.
 *
 * This process never touches D1 or R2 directly: each observation crosses the
 * local Worker HTTP boundary. It reports assertion names and status only;
 * private bodies, headers, and response bytes never enter diagnostics.
 */

import { FACE_FORMATS, type FaceFormat, MEDIA_TYPES } from "@asimposium/render";

const origin = process.env.S3_LOCAL_ORIGIN;
const REPRODUCE = "bash scripts/e2e-s3-split.sh";
const workshopId = "W-s3-private-spill";
const problemId = "P-s3-local";
const privateCanary = `S3-R2-PRIVATE-CANARY-${"private-body".repeat(160)}`;
const publicStatement = "Every bounded local example has the recorded public property.";
let failures = 0;

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ suite: "e2e-s3-split-local", reproduce: REPRODUCE, ...record })}\n`);
}

function check(assertion: string, ok: boolean, detail: string): void {
  if (!ok) failures += 1;
  emit({ assertion, status: ok ? "pass" : "fail", detail: ok ? "as expected" : detail });
}

async function requestJson(
  path: string,
  init: RequestInit = {},
): Promise<{ readonly response: Response; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, init);
  const body: unknown = await response.json().catch(() => undefined);
  return { response, body: body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {} };
}

async function main(): Promise<void> {
  if (origin === undefined) {
    emit({ assertion: "origin_supplied", status: "fail", detail: "S3_LOCAL_ORIGIN is not set" });
    process.exitCode = 1;
    return;
  }

  const health = await requestJson("/__s3/health");
  check(
    "local_workerd_reports_D1_and_R2_bindings",
    health.response.status === 200 && Array.isArray(health.body.bindings),
    `status ${health.response.status}`,
  );

  const pushed = await requestJson("/__s3/workshops", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      body_md: privateCanary,
      problem_id: problemId,
      title: "Private local spill",
      workshop_id: workshopId,
    }),
  });
  check(
    "large_workshop_body_spills_to_private_R2",
    pushed.response.status === 201 && pushed.body.spilled_to_private_r2 === true,
    `status ${pushed.response.status}`,
  );

  const anonymousPrivate = await fetch(`${origin}/__s3/private/${workshopId}`);
  check(
    "anonymous_private_read_is_not_found",
    anonymousPrivate.status === 404,
    `status ${anonymousPrivate.status}`,
  );
  const ownerPrivate = await fetch(`${origin}/__s3/private/${workshopId}`, {
    headers: { "x-asimp-local-sponsor": "local-sponsor" },
  });
  const ownerBody = await ownerPrivate.text();
  check(
    "owner_private_read_crosses_R2_and_revalidates_the_D1_binding",
    ownerPrivate.status === 200 &&
      ownerPrivate.headers.get("cache-control") === "private, no-store" &&
      ownerBody === privateCanary,
    `status ${ownerPrivate.status}`,
  );

  for (const format of FACE_FORMATS) {
    const before = await fetch(`${origin}/__s3/public/${problemId}?format=${format}`);
    const body = await before.text();
    check(
      `private_spill_is_absent_from_pre_promotion_${format}`,
      before.status === 200 &&
        before.headers.get("content-type") === MEDIA_TYPES[format] &&
        !body.includes(privateCanary) &&
        !body.includes(workshopId),
      `status ${before.status}`,
    );
  }

  const promoted = await requestJson("/__s3/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate: {},
      claim_id: "C-s3-local-1",
      extract: "A public extract for the local binding proof.",
      statement: publicStatement,
      title: "One public local promotion",
      workshop_id: workshopId,
    }),
  });
  check(
    "one_promotion_creates_exactly_the_first_public_event",
    promoted.response.status === 201 && promoted.body.public_seq === 1,
    `status ${promoted.response.status}`,
  );
  const repeatedPromotion = await requestJson("/__s3/promote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidate: {},
      claim_id: "C-s3-local-2",
      extract: "A second extract that must not create another event.",
      statement: "A different statement that must not be promoted twice from one workshop.",
      title: "Rejected second promotion",
      workshop_id: workshopId,
    }),
  });
  check(
    "repeat_promotion_preserves_the_one_promotion_invariant",
    repeatedPromotion.response.status === 409 &&
      repeatedPromotion.body.code === "PROMOTION_ALREADY_EXISTS",
    `status ${repeatedPromotion.response.status}`,
  );

  for (const format of FACE_FORMATS) {
    const after = await fetch(`${origin}/__s3/public/${problemId}?format=${format}`);
    const body = await after.text();
    check(
      `renderer_serves_the_public_event_without_private_spill_${format}`,
      after.status === 200 &&
        after.headers.get("content-type") === MEDIA_TYPES[format] &&
        body.includes(publicStatement) &&
        !body.includes(privateCanary) &&
        !body.includes(workshopId),
      `status ${after.status}`,
    );
  }

  const jsonFace = await fetch(`${origin}/__s3/public/${problemId}?format=json`);
  const projection = (await jsonFace.json()) as { readonly cursor?: unknown; readonly items?: unknown };
  check(
    "rendered_json_contains_one_public_ledger_item_only",
    projection.cursor === 1 &&
      Array.isArray(projection.items) &&
      projection.items.length === 1 &&
      isLedgerItem(projection.items[0]),
    "the JSON face did not contain exactly one ledger item",
  );

  emit({
    assertion: "local_binding_summary",
    status: failures === 0 ? "pass" : "fail",
    detail:
      failures === 0
        ? "real local workerd D1/R2 and public renderer checks passed"
        : `${failures} assertion(s) failed`,
    scope: "local-workerd only; no production route, OAuth, browser, or staging claim",
  });
  if (failures > 0) process.exitCode = 1;
}

function isLedgerItem(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.scope === "ledger" && item.id === "EV-local" ? false : item.scope === "ledger";
}

await main();
