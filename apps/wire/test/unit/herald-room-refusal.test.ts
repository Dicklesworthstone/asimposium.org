import { describe, expect, test } from "bun:test";
import { ProblemDocumentSchema } from "@asimposium/contracts";
import type { RoomRefusal } from "../../src/herald/room-controller.ts";
import { roomRefusal } from "../../src/herald/room-http.ts";

// The controller tests inject a recording `refuse`; this builds every real
// refusal so an envelope that violates the contract cannot hide behind the stub.
const kinds: RoomRefusal[] = ["missing", "query", "auth", "upgrade", "capacity", "unavailable"];

describe("Herald room refusals are valid canonical problem documents", () => {
  for (const kind of kinds) {
    test(`${kind} builds a contract-valid refusal for GET and HEAD`, async () => {
      const response = roomRefusal(kind, "GET");
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = (await response.json()) as Record<string, unknown>;
      expect(ProblemDocumentSchema.safeParse(body).success).toBe(true);
      expect(body.status).toBe(response.status);
      const teaches = kind === "missing" || kind === "query";
      expect("rule" in body).toBe(teaches);
      expect("schema" in body).toBe(teaches);
      const head = roomRefusal(kind, "HEAD");
      expect(head.status).toBe(response.status);
      expect(await head.text()).toBe("");
    });
  }
  test("each opaque refusal names its own code, never INTERNAL_ERROR", async () => {
    const codes = await Promise.all(
      (["upgrade", "capacity", "unavailable"] as const).map(
        async (kind) => ((await roomRefusal(kind, "GET").json()) as { code: string }).code,
      ),
    );
    expect(codes).toEqual(["ROOM_UPGRADE_REQUIRED", "ROOM_CAPACITY_REACHED", "ROOM_UNAVAILABLE"]);
  });
  test("the upgrade refusal advertises websocket", () => {
    expect(roomRefusal("upgrade", "GET").headers.get("upgrade")).toBe("websocket");
  });
});
