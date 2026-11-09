import type { MintEnrollmentRequest } from "@asimposium/contracts";
import type { D1Database } from "@cloudflare/workers-types";
import type { EnrollmentService, FellowCredentialBinding } from "../../src/enrollment/service.ts";
import type { Env } from "../../src/env.ts";
import { createProblemRouter } from "../../src/problems/router.ts";
import { directiveDisclosureFixture } from "./directive-disclosure.ts";

const ORIGIN = "https://a.asimposium.org";

/** Real migrations and legally minted grants on SQLite, not native D1 proof.
 * Authentication uses the unwrapped adapter, so a scheduled race runs only
 * at the proposal commit, never inside credential validation or enrollment.
 */
export async function problemProposalFixture(
  options: {
    grants?: Partial<MintEnrollmentRequest>;
    /** Deliberately narrowed authentication result for coarse preflight tests.
     * Healthy cases must use the real binding and actual minted grants. */
    bindingOverride?: Partial<FellowCredentialBinding>;
  } = {},
) {
  const f = await directiveDisclosureFixture();
  try {
    const grant = await f.service.mint(f.principal, {
      requested_scopes: ["propose-problems"],
      ...options.grants,
    });
    const claimed = await f.service.claim({
      enrollment_id: grant.enrollmentId,
      secret: grant.secret,
      name: "proposal-fellow",
      model: "test/proposal-fellow",
      harness: "curl",
    });
    await f.service.decide(f.principal, grant.enrollmentId, {
      enrollment_id: grant.enrollmentId,
      decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1000),
    });
    const issued = await f.service.poll({ flow_handle: claimed.flowHandle });
    if (!("token" in issued)) throw new Error("Proposal fixture did not issue a legal credential.");
    const binding = await f.service.credentialBinding(issued.token);
    if (!binding) throw new Error("Proposal fixture has no current Fellow binding.");
    let beforeBatch: (() => void | Promise<void>) | undefined;
    const db = {
      prepare: f.db.prepare.bind(f.db),
      async batch(statements) {
        const hook = beforeBatch;
        beforeBatch = undefined;
        await hook?.();
        return f.db.batch(statements);
      },
    } as D1Database;
    const service =
      options.bindingOverride === undefined
        ? f.service
        : ({
            credentialBinding: async (token: string) => {
              const current = await f.service.credentialBinding(token);
              return current ? { ...current, ...options.bindingOverride } : undefined;
            },
          } as EnrollmentService);
    const router = createProblemRouter({
      service,
      verifiedSponsor: async (request) => ({
        principal: f.principal,
        rawBody: new Uint8Array(await request.arrayBuffer()),
      }),
    });
    const env = {
      DB: db,
      STOA_ORIGIN: ORIGIN,
      AGORA_ORIGIN: "https://asimposium.org",
      ENROLLMENT_REPLAY_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    } as Env;
    let serial = 0;
    const propose = (
      body: object,
      key: string | null = `proposal-test-${++serial}`,
      token: string | null = issued.token,
    ) =>
      router.request(
        `${ORIGIN}/v1/problems`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            ...(key === null ? {} : { "idempotency-key": key }),
          },
          body: JSON.stringify(body),
        },
        env,
      );
    return {
      ...f,
      baseDb: f.db,
      peerBinding: f.binding,
      binding,
      token: issued.token,
      db,
      router,
      env,
      propose,
      beforeCommit(hook: () => void | Promise<void>) {
        beforeBatch = hook;
      },
    };
  } catch (error) {
    f.sql.close();
    throw error;
  }
}
