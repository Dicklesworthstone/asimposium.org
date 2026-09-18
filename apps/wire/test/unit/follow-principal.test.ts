import { describe, expect, test } from "bun:test";
import {
  authenticatedFollowPrincipal,
  type FollowCredentialAuthority,
} from "../../src/inbox/follow-principal.ts";

function authority() {
  const calls: string[] = [];
  const credentials = new Map([
    ["approved-a", { fellowId: "fellow-a" }],
    ["approved-b", { fellowId: "fellow-b" }],
  ]);
  const service: FollowCredentialAuthority = {
    async credentialBinding(token) {
      calls.push(token);
      return credentials.get(token);
    },
  };
  return { service, calls, credentials };
}

function request(headers: Record<string, string>) {
  return new Request("https://a.asimposium.org/v1/p/P-TEST/follow", { headers });
}

describe("follow identity comes only from the Fellow credential authority", () => {
  const unverifiedHeaders: Record<string, string>[] = [
    {},
    { "x-sponsor-id": "victim-sponsor" },
    { cookie: "session=victim-sponsor" },
    { "x-sponsor-id": "victim-fellow", cookie: "session=victim-fellow" },
  ];
  for (const headers of unverifiedHeaders) {
    test(`unverified headers cannot name a principal: ${JSON.stringify(headers)}`, async () => {
      const { service, calls } = authority();
      expect(await authenticatedFollowPrincipal(request(headers), service)).toBe(undefined);
      expect(calls).toEqual([]);
    });
  }

  for (const token of ["asimp_sp_victim", "victim-sponsor", "revoked-token", "unknown-token"]) {
    test(`unverified bearer assertion is refused: ${token}`, async () => {
      const { service, calls } = authority();
      expect(
        await authenticatedFollowPrincipal(
          request({ authorization: `Bearer ${token}`, "x-sponsor-id": token }),
          service,
        ),
      ).toBe(undefined);
      expect(calls).toEqual([token]);
    });
  }

  for (const header of [
    "Basic approved-a",
    "Bearer",
    "Bearer approved-a approved-b",
    "Bearer approved-a,approved-b",
  ]) {
    test(`malformed bearer framing is refused before lookup: ${header}`, async () => {
      const { service, calls } = authority();
      expect(await authenticatedFollowPrincipal(request({ authorization: header }), service)).toBe(
        undefined,
      );
      expect(calls).toEqual([]);
    });
  }

  test("a valid Fellow cannot switch identity with sponsor headers or cookies", async () => {
    const { service, calls } = authority();
    expect(
      await authenticatedFollowPrincipal(
        request({
          authorization: "Bearer approved-a",
          "x-sponsor-id": "fellow-b",
          cookie: "session=fellow-b",
        }),
        service,
      ),
    ).toBe("fellow-a");
    expect(calls).toEqual(["approved-a"]);
  });

  test("two valid credentials retain distinct principals, never raw tokens", async () => {
    const { service } = authority();
    expect(
      await authenticatedFollowPrincipal(request({ authorization: "Bearer approved-a" }), service),
    ).toBe("fellow-a");
    expect(
      await authenticatedFollowPrincipal(request({ authorization: "bEaReR\tapproved-b" }), service),
    ).toBe("fellow-b");
  });

  test("revocation is checked afresh rather than caching a prior binding", async () => {
    const { service, credentials } = authority();
    const req = request({ authorization: "Bearer approved-a", "x-sponsor-id": "approved-a" });
    expect(await authenticatedFollowPrincipal(req, service)).toBe("fellow-a");
    credentials.delete("approved-a");
    expect(await authenticatedFollowPrincipal(req, service)).toBe(undefined);
  });

  test("credential authority failure cannot fall back to an asserted sponsor", async () => {
    const failure = new Error("credential authority unavailable");
    let caught: unknown;
    try {
      await authenticatedFollowPrincipal(
        request({ authorization: "Bearer asimp_sp_victim", "x-sponsor-id": "victim" }),
        {
          async credentialBinding() {
            throw failure;
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
  });
});
