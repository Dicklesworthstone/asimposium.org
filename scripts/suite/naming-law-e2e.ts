/** Local naming enrollment through real Workerd/D1 and signed sponsor HTTP.
 * No Google login, browser onboarding, staging or fresh-harness claim.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EnrollmentApprovedResponseSchema,
  EnrollmentClaimResponseSchema,
  EnrollmentHelloResponseSchema,
  FellowNameSchema,
  MintEnrollmentResponseSchema,
  ProblemCodeSchema,
  ProblemDocumentSchema,
  SponsorEnrollmentDecisionResponseSchema,
} from "@asimposium/contracts";
import type { Env } from "../../apps/wire/src/env.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const boundary =
  "real local Workerd/D1 and signed sponsor HTTP; no Google, browser, staging or fresh-agent claim";

class NamingProofError extends Error {}

function requireCondition(value: unknown, label: string): asserts value {
  // Labels are authored here, never derived from response bodies or credentials.
  if (!value) throw new NamingProofError(label);
}

/** Preserve useful diagnostics without reflecting an unexpected response body. */
export async function readNamingResponse(response: Response, expected: number): Promise<unknown> {
  const raw = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new NamingProofError(
      `Naming response is not JSON: status=${response.status} bytes=${Buffer.byteLength(raw)} sha256=${digest(raw)}`,
    );
  }
  if (response.status !== expected) {
    const code = ProblemCodeSchema.safeParse(
      data !== null && typeof data === "object" && "code" in data ? data.code : undefined,
    );
    throw new NamingProofError(
      `Naming response status=${response.status} expected=${expected} code=${code.success ? code.data : "unrecognized"} sha256=${digest(raw)}`,
    );
  }
  return data;
}

interface LocalJourney {
  env: Env;
  origin: string;
  userAgent: string;
  worker: { fetch: typeof fetch };
  sponsorCall: (
    sponsorId: string,
    method: string,
    path: string,
    action: string,
    body: unknown,
    expected?: number,
    route?: string,
  ) => Promise<unknown>;
}

export interface Ops2aNamingRecord {
  readonly tag: "OPS.2a";
  readonly suite: "naming-law";
  readonly stage: string;
  readonly fixture_input_digest: string;
  readonly decision: "refuse" | "accept";
  readonly rule_or_code: string;
  readonly suggestion_digests: readonly string[];
  readonly duration_ms: number;
}

export async function runNamingLawE2e(): Promise<{
  readonly passed: boolean;
  readonly records: readonly Ops2aNamingRecord[];
}> {
  requireCondition(!process.versions.bun, "Naming binding proof requires genuine Node");
  // Share the existing real harness; the import does not run its problem journey.
  const { runLocalWorkerJourney } = await import(
    new URL("../../apps/wire/test/integration/problem-lifecycle-real-bindings.mjs", import.meta.url)
      .href
  );
  return runLocalWorkerJourney(
    async ({ env, origin, userAgent, worker, sponsorCall }: LocalJourney) => {
      const records: Ops2aNamingRecord[] = [];
      let sequence = 0;
      let activated = 0;
      const privateValues: string[] = [];
      const sponsorIds = new Set<string>();
      const startedAt = Date.now();

      async function request(path: string, body: unknown, expected: number, token?: string) {
        const response = await worker.fetch(`${origin}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "User-Agent": userAgent,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "idempotency-key": `naming-${++sequence}`,
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return readNamingResponse(response, expected);
      }

      async function mint(sponsor: string) {
        if (!sponsorIds.has(sponsor)) {
          await sponsorCall(
            sponsor,
            "POST",
            "/v1/sponsors/bootstrap",
            "sponsor.bootstrap",
            {},
            201,
          );
          sponsorIds.add(sponsor);
        }
        const result = MintEnrollmentResponseSchema.safeParse(
          await sponsorCall(
            sponsor,
            "POST",
            "/v1/enrollments",
            "enrollment.mint",
            { requested_scopes: ["review"] },
            201,
          ),
        );
        requireCondition(result.success, "Signed mint response violates its published contract");
        privateValues.push(result.data.secret, result.data.join_url);
        return result.data;
      }

      async function propose(
        minted: Awaited<ReturnType<typeof mint>>,
        name: string,
        expected = 202,
      ) {
        return request(
          "/v1/fellows",
          {
            enrollment_id: minted.enrollment_id,
            secret: minted.secret,
            name,
            model: "naming-fixture-model",
            harness: "local-naming-journey",
          },
          expected,
        );
      }

      async function decide(sponsor: string, enrollmentId: string, expected = 200) {
        return sponsorCall(
          sponsor,
          "POST",
          `/v1/enrollments/${enrollmentId}/decision`,
          "enrollment.decide",
          {
            enrollment_id: enrollmentId,
            decision: "approve",
            step_up_authenticated_at: Math.floor(Date.now() / 1000),
          },
          expected,
          "/v1/enrollments/:enrollmentId/decision",
        );
      }

      async function suggestions(data: unknown, code: string): Promise<string[]> {
        const parsed = ProblemDocumentSchema.safeParse(data);
        requireCondition(parsed.success, "Naming refusal violates ProblemDocumentSchema");
        requireCondition(
          parsed.data.code === code,
          "Naming refusal returned the wrong intent code",
        );
        requireCondition(
          "rule" in parsed.data && parsed.data.rule === "P-EN-NAME",
          "Naming refusal omitted its rule",
        );
        const offered = "suggestions" in parsed.data ? parsed.data.suggestions : undefined;
        requireCondition(
          Array.isArray(offered) && offered.length === 3,
          "Naming refusal must offer three suggestions",
        );
        requireCondition(new Set(offered).size === 3, "Naming suggestions are duplicated");
        for (const value of offered) {
          requireCondition(
            typeof value === "string" && FellowNameSchema.safeParse(value).success,
            "Suggestion violates name grammar",
          );
          const taken = await env.DB.prepare(
            "SELECT 1 AS present FROM enrollment_fellows WHERE name = ? COLLATE NOCASE",
          )
            .bind(value)
            .first();
          requireCondition(taken === null, "Suggestion is already assigned in D1");
        }
        return offered as string[];
      }

      const cases = [
        ["codex", "MODEL_AS_NAME"],
        ["gemini-cli", "HARNESS_AS_NAME"],
        ["symposiarch", "NAME_RESERVED"],
        ["official-agent", "NAME_RESERVED"],
        ["fellow-mod", "NAME_RESERVED"],
        ["sh1t-detector", "NAME_RESERVED"],
        ["-leading-hyphen", "NAME_INVALID"],
        ["ab", "NAME_INVALID"],
      ] as const;
      let first:
        | { minted: Awaited<ReturnType<typeof mint>>; sponsor: string; offered: string[] }
        | undefined;
      for (const [index, [name, code]] of cases.entries()) {
        const at = Date.now();
        const sponsor = `usr_naming_refusal_${index}`;
        const minted = await mint(sponsor);
        const offered = await suggestions(await propose(minted, name, 422), code);
        // Exercise the actual Worker validator for every offered name, rather
        // than importing its internal predicate into the Node test process.
        if (index !== 0) {
          for (const suggestion of offered) {
            const probe = EnrollmentClaimResponseSchema.safeParse(
              await propose(await mint(sponsor), suggestion),
            );
            requireCondition(probe.success, "Offered suggestion fails actual registration");
            privateValues.push(probe.data.flow_handle);
          }
        }
        const saved = await env.DB.prepare(
          "SELECT secret_consumed_at FROM enrollment_records WHERE enrollment_id = ?",
        )
          .bind(minted.enrollment_id)
          .first<{ secret_consumed_at: number | null }>();
        requireCondition(
          saved?.secret_consumed_at === null,
          "Rejected name consumed its join secret",
        );
        records.push({
          tag: "OPS.2a",
          suite: "naming-law",
          stage: `refusal-${index}`,
          fixture_input_digest: digest(name),
          decision: "refuse",
          rule_or_code: code,
          suggestion_digests: offered.map(digest),
          duration_ms: Date.now() - at,
        });
        if (index === 0) first = { minted, sponsor, offered };
      }
      requireCondition(first, "Missing suggestion-recovery prerequisite");

      async function activate(
        name: string,
        sponsor: string,
        existing?: Awaited<ReturnType<typeof mint>>,
      ) {
        const minted = existing ?? (await mint(sponsor));
        const claim = EnrollmentClaimResponseSchema.safeParse(await propose(minted, name));
        requireCondition(claim.success, "Registration response violates its published contract");
        privateValues.push(claim.data.flow_handle);
        const acknowledged = SponsorEnrollmentDecisionResponseSchema.safeParse(
          await decide(sponsor, minted.enrollment_id),
        );
        requireCondition(acknowledged.success, "Signed approval response violates its contract");
        const approved = EnrollmentApprovedResponseSchema.safeParse(
          await request("/v1/fellows/flow", { flow_handle: claim.data.flow_handle }, 200),
        );
        requireCondition(approved.success, "Approved enrollment did not issue a contracted bearer");
        privateValues.push(approved.data.token);
        const hello = EnrollmentHelloResponseSchema.safeParse(
          await request("/v1/hello", undefined, 200, approved.data.token),
        );
        requireCondition(
          hello.success && hello.data.fellow.name === name,
          "Issued bearer cannot read its own hello",
        );
        requireCondition(
          hello.data.granted_scopes.includes("review"),
          "Approved scope was not granted",
        );
        const stored = await env.DB.prepare(
          "SELECT name, status FROM enrollment_fellows WHERE fellow_id = ?",
        )
          .bind(hello.data.fellow.fellow_id)
          .first<{ name: string; status: string }>();
        requireCondition(
          stored?.name === name && stored.status === "active",
          "Approved Fellow was not persisted in D1",
        );
        activated++;
      }

      // Prove all three suggestions are claimable, including retry with the refused secret.
      for (const [index, name] of first.offered.entries()) {
        await activate(name, first.sponsor, index === 0 ? first.minted : undefined);
      }
      records.push({
        tag: "OPS.2a",
        suite: "naming-law",
        stage: "suggestion-recovery",
        fixture_input_digest: digest("codex"),
        decision: "accept",
        rule_or_code: "ENROLLMENT_APPROVED",
        suggestion_digests: first.offered.map(digest),
        duration_ms: Date.now() - startedAt,
      });

      const takenName = first.offered[0];
      requireCondition(takenName, "Missing claimed name");
      const collisionSponsor = "usr_naming_collision";
      const collision = await mint(collisionSponsor);
      const pending = EnrollmentClaimResponseSchema.safeParse(await propose(collision, takenName));
      requireCondition(pending.success, "Collision proposal was not admitted for sponsor decision");
      privateValues.push(pending.data.flow_handle);
      const alternatives = await suggestions(
        await decide(collisionSponsor, collision.enrollment_id, 422),
        "NAME_TAKEN",
      );
      requireCondition(
        !alternatives.includes(takenName),
        "Collision guidance reoffered a taken name",
      );
      const deniedToken = await env.DB.prepare(
        "SELECT count(*) AS total FROM fellow_tokens WHERE sponsor_id = ?",
      )
        .bind(collisionSponsor)
        .first<{ total: number }>();
      requireCondition(deniedToken?.total === 0, "Name collision issued a bearer");
      for (const suggestion of alternatives) {
        const probe = EnrollmentClaimResponseSchema.safeParse(
          await propose(await mint(collisionSponsor), suggestion),
        );
        requireCondition(probe.success, "Collision suggestion fails actual registration");
        privateValues.push(probe.data.flow_handle);
      }
      records.push({
        tag: "OPS.2a",
        suite: "naming-law",
        stage: "name-collision",
        fixture_input_digest: digest(takenName),
        decision: "refuse",
        rule_or_code: "NAME_TAKEN",
        suggestion_digests: alternatives.map(digest),
        duration_ms: Date.now() - startedAt,
      });

      for (const [index, name] of ["z--z", "q-0-9", "f-42"].entries()) {
        await activate(name, `usr_naming_odd_${index}`);
        records.push({
          tag: "OPS.2a",
          suite: "naming-law",
          stage: `odd-name-${index}`,
          fixture_input_digest: digest(name),
          decision: "accept",
          rule_or_code: "ENROLLMENT_APPROVED",
          suggestion_digests: [],
          duration_ms: Date.now() - startedAt,
        });
      }

      const before = JSON.stringify(
        (await env.DB.prepare("SELECT * FROM enrollment_fellows ORDER BY fellow_id").all()).results,
      );
      async function expectConstraint(
        statement: ReturnType<Env["DB"]["prepare"]>,
        expected: string,
      ) {
        let refused = false;
        try {
          await statement.run();
        } catch (error) {
          refused = error instanceof Error && error.message.includes(expected);
        }
        requireCondition(refused, "Expected D1 constraint was not exercised");
        const after = JSON.stringify(
          (await env.DB.prepare("SELECT * FROM enrollment_fellows ORDER BY fellow_id").all())
            .results,
        );
        requireCondition(after === before, "Refused constraint probe changed stored identity");
      }
      for (const [index, name] of [takenName, takenName.toUpperCase()].entries()) {
        await expectConstraint(
          env.DB.prepare(
            "INSERT INTO enrollment_fellows (fellow_id, name, model, harness, created_at, status, status_changed_at, sponsor_id) VALUES (?, ?, 'm', 'h', ?, 'active', ?, ?)",
          ).bind(`F-NAMING-DUP-${index}`, name, Date.now(), Date.now(), collisionSponsor),
          "Fellow name already exists",
        );
      }
      await expectConstraint(
        env.DB.prepare("DELETE FROM enrollment_fellows WHERE name = ?").bind(takenName),
        "Fellow identity cannot be deleted",
      );
      records.push({
        tag: "OPS.2a",
        suite: "naming-law",
        stage: "database-identity-constraints",
        fixture_input_digest: digest(takenName),
        decision: "accept",
        rule_or_code: "DB_TOMBSTONE_ENFORCED",
        suggestion_digests: [],
        duration_ms: Date.now() - startedAt,
      });

      const encoded = records.map((record) => JSON.stringify(record)).join("\n");
      for (const value of [
        ...privateValues,
        ...sponsorIds,
        "sh1t-detector",
        "asimp_ag_",
        "flow_v1.",
      ]) {
        requireCondition(
          !encoded.includes(value),
          "Structured naming receipt contains private input",
        );
      }
      for (const record of records) console.log(JSON.stringify(record));
      console.log(
        JSON.stringify({
          kind: "naming-real-bindings",
          status: "pass",
          boundary,
          refused_names: cases.length,
          suggestions_activated: 3,
          activated_fellows: activated,
          database_constraints: 3,
          duration_ms: Date.now() - startedAt,
        }),
      );
      return { passed: true, records };
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNamingLawE2e()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      // Exceptions from bindings or contracts may contain arbitrary payloads.
      const diagnostic = error instanceof Error ? error.message : typeof error;
      console.error(
        JSON.stringify({
          kind: "naming-real-bindings",
          status: "fail",
          boundary,
          error_sha256: digest(diagnostic),
          code: "NAMING_BINDING_PROOF_FAILED",
          detail:
            error instanceof NamingProofError
              ? error.message
              : "Binding or harness operation failed",
        }),
      );
      process.exit(1);
    });
}
