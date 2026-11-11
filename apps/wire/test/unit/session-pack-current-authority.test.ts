import { describe, expect, test } from "bun:test";
import { ProblemDocumentSchema, SessionOpenResponseSchema } from "@asimposium/contracts";
import { D1EnrollmentStore } from "../../src/enrollment/d1-store.ts";
import { EnrollmentService } from "../../src/enrollment/service.ts";
import { createSessionRouter } from "../../src/sessions/router.ts";
import { fixture } from "./session-routes.test.ts";

// Reuse the migrated SQLite route fixture and canonical credential store.
// These deterministic concurrency cases are unit proof, not Workerd/D1 proof.
describe("published pack current authority", () => {
  for (const profile of ["working", "graveyard"] as const) {
    for (const conditional of [false, true]) {
      for (const change of [
        "revocation",
        "session close",
        ...(profile === "graveyard" && conditional
          ? ([
              "authority store failure",
              "fellow identity change",
              "sponsor identity change",
              "credential identity change",
              "problem grant reduction",
              "scope reduction",
              "quarantine",
            ] as const)
          : []),
      ] as const) {
        test(`${profile} ${conditional ? "conditional" : "ordinary"} read withholds private work after ${change}`, async () => {
          let invalidate: (() => Promise<void>) | undefined;
          let invalidated = false;
          const f = await fixture({
            afterRead: async (read) => {
              if (
                read.kind === "all" &&
                read.sql.includes("FROM workshop_objects") &&
                read.sql.includes(
                  profile === "working"
                    ? "AND state = 'open'"
                    : "type IN ('dead-end-draft', 'dead-end')",
                ) &&
                invalidate !== undefined
              ) {
                const run = invalidate;
                invalidate = undefined;
                await run();
                invalidated = true;
              }
            },
          });
          const authority = new EnrollmentService({
            stoaOrigin: "https://a-staging.asimposium.org",
            agoraOrigin: "https://staging.asimposium.org",
            store: new D1EnrollmentStore(f.db),
            replayProtector: f.replayProtector,
          });
          const router = createSessionRouter({
            service: authority,
            replayProtector: f.replayProtector,
          });
          const call = (path: string, init: RequestInit = {}) =>
            router.fetch(
              new Request(`https://a-staging.asimposium.org${path}`, {
                ...init,
                headers: { authorization: `Bearer ${f.token}`, ...init.headers },
              }),
              f.env,
            );
          let serial = 0;
          const post = (path: string, body: unknown) =>
            call(path, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": `pack-current-authority-${++serial}`,
              },
              body: JSON.stringify(body),
            });
          const opened = await post("/v1/sessions", { problem_id: "P-4DSP", intent: "explore" });
          expect(opened.status, await opened.clone().text()).toBe(201);
          const { session_id: session } = SessionOpenResponseSchema.parse(await opened.json());
          const canary = "PRIVATE-PACK-CURRENT-AUTHORITY-CANARY";
          const pushed = await post(`/v1/sessions/${session}/workshop`, {
            type: profile === "working" ? "note" : "dead-end-draft",
            title: canary,
            body_md: `${canary}: a private deliberate work product.`,
            relates_to: [],
          });
          expect(pushed.status, await pushed.clone().text()).toBe(201);
          const path = `/v1/sessions/${session}/pack?profile=${profile}&max_tokens=8000`;
          const before = await call(path);
          expect(before.status, await before.clone().text()).toBe(200);
          expect(await before.text()).toContain(canary);
          const etag = before.headers.get("etag");
          expect(etag).not.toBeNull();
          const headers = { "if-none-match": etag ?? "" };
          expect((await call(path, { headers })).status).toBe(304);

          invalidate = async () => {
            if (change === "revocation") {
              const revoked = await authority.revokeCredential(
                f.sponsor,
                {
                  fellow_id: f.binding.fellowId,
                  credential_id: f.binding.credentialId,
                  confirm: "revoke-credential",
                  step_up_authenticated_at: Math.floor(Date.now() / 1000),
                },
                { idempotencyKey: "pack-current-authority-revoke" },
              );
              expect(revoked.acknowledged).toBe(true);
            } else if (change === "session close") {
              const closed = await post(`/v1/sessions/${session}/close`, {
                handback: "Closed while this pack was being composed.",
                promote: [],
              });
              expect(closed.status, await closed.clone().text()).toBe(201);
            } else if (change === "authority store failure") {
              authority.credentialBinding = async () => {
                throw new Error("AUTHORITY-STORE-DIAGNOSTIC-CANARY");
              };
            } else if (change === "quarantine") {
              await authority.transitionFellow(
                f.sponsor,
                {
                  fellow_id: f.binding.fellowId,
                  status: "suspicious_review",
                  confirm: "change-fellow-lifecycle",
                  step_up_authenticated_at: Math.floor(Date.now() / 1000),
                },
                { idempotencyKey: "pack-current-authority-quarantine" },
              );
            } else {
              // Explicit adapter-drift cases exercise the principal/grant
              // comparison, independently of canonical revocation above.
              authority.credentialBinding = async () => ({
                ...f.binding,
                ...(change === "fellow identity change" ? { fellowId: "F-other" } : {}),
                ...(change === "sponsor identity change" ? { sponsorId: "usr_other" } : {}),
                ...(change === "credential identity change" ? { credentialId: "FC-other" } : {}),
                ...(change === "problem grant reduction"
                  ? {
                      grantedResources: {
                        ...f.binding.grantedResources,
                        problemBinding: "P-OTHER",
                      },
                    }
                  : {}),
                ...(change === "scope reduction" ? { grantedScopes: [] } : {}),
              });
            }
          };
          const raced = await call(path, conditional ? { headers } : {});
          expect(invalidated).toBe(true);
          const expectedStatus =
            change === "revocation" || change === "authority store failure"
              ? 401
              : change === "session close"
                ? 409
                : change === "fellow identity change"
                  ? 404
                  : 503;
          expect(raced.status).toBe(expectedStatus);
          expect(raced.headers.get("cache-control")).toBe("private, no-store");
          expect(raced.headers.get("etag")).toBeNull();
          const body = await raced.text();
          expect(body).not.toContain(canary);
          expect(body).not.toContain("AUTHORITY-STORE-DIAGNOSTIC-CANARY");
          expect(ProblemDocumentSchema.parse(JSON.parse(body)).code).toBe(
            expectedStatus === 401
              ? "FELLOW_TOKEN_INVALID"
              : expectedStatus === 409
                ? "SESSION_CLOSED"
                : expectedStatus === 404
                  ? "SESSION_NOT_FOUND"
                  : "INTERNAL_ERROR",
          );
          if (change === "quarantine") {
            const fresh = await call(path);
            expect(fresh.status, await fresh.clone().text()).toBe(200);
            expect(await fresh.text()).toContain(canary);
          }
        });
      }
    }
  }
});
