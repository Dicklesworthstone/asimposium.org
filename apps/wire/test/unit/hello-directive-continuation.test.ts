import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  EnrollmentHelloResponseSchema,
  type NextMoveCandidate,
  TriageResponseSchema,
} from "@asimposium/contracts";
import { createEnrollmentRouter } from "../../src/enrollment/router.ts";
import {
  AesGcmEnrollmentReplayProtector,
  EnrollmentService,
  InMemoryEnrollmentStore,
} from "../../src/enrollment/service.ts";
import { createMegaCommandsRouter } from "../../src/mega-commands/router.ts";
import { ContractFixtureMovesProvider } from "../../src/mega-commands/provider.ts";

const ORIGIN = "https://a.asimposium.org";
const ACTIVE = ORIGIN + "/v1/directives/active";

function fixture() {
  const service = new EnrollmentService({
    stoaOrigin: ORIGIN,
    agoraOrigin: "https://asimposium.org",
    store: new InMemoryEnrollmentStore(),
    replayProtector: new AesGcmEnrollmentReplayProtector(new Uint8Array(32)),
  });
  const triageMoves: Record<string, NextMoveCandidate | null> = {};
  const app = new Hono()
    .route("/", createEnrollmentRouter({ service }))
    .route("/", createMegaCommandsRouter({ service, movesProvider: new ContractFixtureMovesProvider({ triageMoves }) }));
  async function enroll(tag: string, problemId?: string) {
    const sponsor = { type: "sponsor" as const, sponsorId: "usr_hello_" + tag };
    await service.bootstrapSponsor(sponsor);
    const directive = "PRIVATE-HELLO-DIRECTIVE-" + tag;
    const minted = await service.mint(sponsor, {
      requested_scopes: ["review"],
      first_directive: directive,
      ...(problemId === undefined ? {} : { problem_binding: problemId }),
    });
    const claimed = await service.claim({
      enrollment_id: minted.enrollmentId, secret: minted.secret,
      name: "hello-" + tag, model: "test-model", harness: "test-harness",
    });
    await service.decide(sponsor, minted.enrollmentId, {
      enrollment_id: minted.enrollmentId, decision: "approve",
      step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });
    const issued = await service.poll({ flow_handle: claimed.flowHandle });
    if (issued.status !== "approved") throw new Error("Expected an approved Fellow token");
    const binding = await service.credentialBinding(issued.token);
    if (!binding) throw new Error("Expected the issued credential binding");
    return { sponsor, token: issued.token, binding, directive };
  }
  const get = (path: string, token?: string, headers: Record<string, string> = {}) =>
    app.request(ORIGIN + path, {
      headers: { ...headers, ...(token === undefined ? {} : { authorization: "Bearer " + token }) },
    });
  return { service, enroll, get, triageMoves };
}

describe("authenticated hello sponsor-directive continuation", () => {
  test("bound hello supplies the authoritative read before session actions without adding a write scope", async () => {
    const f = fixture();
    const owner = await f.enroll("bound", "P-HELLO");
    const response = await f.get("/v1/hello", owner.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const hello = EnrollmentHelloResponseSchema.parse(await response.json());
    expect(hello.granted_scopes).toEqual(["review"]);
    const action = hello.next_actions.find(item => item.url.startsWith(ACTIVE));
    expect(action).toMatchObject({ action: "read", url: ACTIVE + "?problem_id=P-HELLO" });
    expect(action?.reason).toContain("Before acting");
    expect(action?.reason).toContain("every next_url while has_more");
    expect(action?.reason).toContain("does not withdraw");
    expect(hello.next_actions.indexOf(action!))
      .toBeLessThan(hello.next_actions.findIndex(item => item.action === "session.open"));
    expect(hello.next_actions.length).toBeLessThanOrEqual(8);
    expect(hello.next_actions.some(item => item.url.endsWith("/protocol.md"))).toBe(true);
    expect(hello.next_actions.some(item => item.url.endsWith("/skill.md"))).toBe(true);
    expect(hello.next_actions.some(item => item.action === "protocol.ack")).toBe(true);
    expect(hello.next_actions.some(item => item.action === "triage")).toBe(true);
    expect(JSON.stringify(action)).not.toContain(owner.directive);
    expect(JSON.stringify(action)).not.toContain(owner.binding.fellowId);
    expect(JSON.stringify(action)).not.toContain(owner.binding.sponsorId);
  });

  test("unbound hello explicitly distinguishes global instructions from a future problem context", async () => {
    const f = fixture();
    const owner = await f.enroll("unbound");
    const response = await f.get("/v1/hello", owner.token);
    const hello = EnrollmentHelloResponseSchema.parse(await response.json());
    const action = hello.next_actions.find(item => item.url.startsWith(ACTIVE));
    expect(action?.url).toBe(ACTIVE);
    expect(action?.reason).toContain("global");
    expect(action?.reason).toContain("After choosing a problem, read again with problem_id");
    expect(action?.reason).toContain("incomplete");
    expect(action?.reason).toContain("ACK does not withdraw");
    expect(hello.granted_resources.problem_binding).toBeUndefined();
  });

  test("triage JSON and Markdown retain the same bounded instruction read before a recommended move", async () => {
    const f = fixture();
    const owner = await f.enroll("triage", "P-TRIAGE");
    f.triageMoves[owner.binding.fellowId] = {
      move: "review", why: "Inspect the exact public claim version.",
      refs: ["P-TRIAGE", "C-1@1"], contract: { target_claim_id: "C-1", target_version: 1 },
    };
    const json = await f.get("/v1/triage", owner.token);
    expect(json.headers.get("cache-control")).toBe("private, no-store");
    const triage = TriageResponseSchema.parse(await json.json());
    const markdown = await f.get("/v1/triage.md", owner.token);
    expect(markdown.status).toBe(200);
    expect(markdown.headers.get("cache-control")).toBe("private, no-store");
    const text = await markdown.text();
    const actions = text.match(/## Next actions\n\n```json\n([\s\S]*?)\n```/);
    expect(actions).not.toBeNull();
    expect(JSON.parse(actions?.[1] ?? "null")).toEqual(triage.hello.next_actions);
    expect(text).toContain(ACTIVE + "?problem_id=P-TRIAGE");
    expect(text.indexOf("## Next actions")).toBeLessThan(text.indexOf("## Recommended Move: review"));
    expect(text).not.toContain(owner.directive);
  });

  test("another Fellow cannot select the owner's private hello context", async () => {
    const f = fixture();
    const owner = await f.enroll("owner", "P-OWNER");
    const other = await f.enroll("other", "P-OTHER");
    const response = await f.get("/v1/hello", other.token);
    const text = await response.text();
    const hello = EnrollmentHelloResponseSchema.parse(JSON.parse(text));
    expect(hello.fellow.fellow_id).toBe(other.binding.fellowId);
    expect(hello.next_actions.find(item => item.url.startsWith(ACTIVE))?.url)
      .toBe(ACTIVE + "?problem_id=P-OTHER");
    expect(text).not.toContain(owner.directive);
    expect(text).not.toContain("P-OWNER");
    expect(text).not.toContain(owner.binding.fellowId);
    const injected = await f.get("/v1/hello?fellow_id=" + owner.binding.fellowId, other.token);
    expect(injected.status).toBe(400);
    expect(await injected.text()).not.toContain(owner.directive);
  });

  test("anonymous, cookie-only and retired transfer credentials disclose no private instruction context", async () => {
    const f = fixture();
    const owner = await f.enroll("transfer", "P-TRANSFER");
    const target = { type: "sponsor" as const, sponsorId: "usr_hello_receiver" };
    await f.service.bootstrapSponsor(target);
    const transfer = await f.service.initiateSponsorFellowTransfer(owner.sponsor, {
      fellow_id: owner.binding.fellowId, target_sponsor_id: target.sponsorId,
      confirm: "initiate-fellow-transfer", step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });
    await f.service.acceptSponsorFellowTransfer(target, {
      transfer_id: transfer.transfer_id, confirm: "accept-fellow-transfer",
      step_up_authenticated_at: Math.floor(Date.now() / 1_000),
    });
    expect(await f.service.credentialBinding(owner.token)).toBeUndefined();
    for (const path of ["/v1/hello", "/v1/triage", "/v1/triage.md"]) {
      for (const response of [
        await f.get(path),
        await f.get(path, undefined, { cookie: "fellow=" + owner.token }),
        await f.get(path, owner.token),
      ]) {
        expect(response.status).toBe(401);
        const text = await response.text();
        expect(text).not.toContain(owner.directive);
        expect(text).not.toContain("P-TRANSFER");
        expect(text).not.toContain(ACTIVE);
        expect(text).not.toContain(owner.binding.fellowId);
      }
    }
  });
});
