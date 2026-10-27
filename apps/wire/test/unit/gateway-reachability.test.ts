import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../../src/app.ts";
import type { Env } from "../../src/env.ts";

// Observed defect class (2026-09-24): sub-routers dispatched through app.ts
// path gates had routes the gates did not own (/v1/problems/:id/follow; all
// W3.8 transfer and account routes), so the Worker answered ROUTE_NOT_FOUND
// while unit tests that mounted the sub-router directly passed. This census
// reads every route template the gated sub-routers declare and requests it
// through the real gateway. Without bindings an owned route fails for another
// reason (unavailable, unauthorized, invalid); only an unowned one is
// ROUTE_NOT_FOUND.
const SRC = resolve(import.meta.dir, "../../src");
const GATED_ROUTERS = [
  "enrollment/router.ts",
  "inbox/router.ts",
  "problems/router.ts",
  "directives/router.ts",
  "commentary/router.ts",
  "mega-commands/router.ts",
  "review-requests/router.ts",
];
const ROUTE = /app\.(get|post|put|patch|delete)\(\s*"(\/[^"]+)"/g;
const ON_ROUTE = /app\.on\(\s*\[([^\]]+)\],\s*"(\/[^"]+)"/g;

const SAMPLES: Record<string, string> = {
  id: "P-4DSP",
  problemId: "P-4DSP",
  transferId: "TRF-01JXYZ0000000000000000000A",
  enrollmentId: "ASIMP-EN-01JXYZ4K6Q",
  commentaryId: "CM-01JXYZ0000000000000000000A",
  requestId: "RR-01JXYZ0000000000000000000A",
  sponsorId: "usr_sample_sponsor",
  cursor: "1",
};

function sample(path: string): string {
  return path.replace(/:([A-Za-z]+)(\{[^}]*\})?/g, (_, name: string) => SAMPLES[name] ?? "P-4DSP");
}

function declaredRoutes(): { method: string; path: string; file: string }[] {
  const routes: { method: string; path: string; file: string }[] = [];
  for (const file of GATED_ROUTERS) {
    const source = readFileSync(resolve(SRC, file), "utf8");
    for (const match of source.matchAll(ROUTE)) {
      routes.push({ method: (match[1] ?? "get").toUpperCase(), path: match[2] ?? "", file });
    }
    for (const match of source.matchAll(ON_ROUTE)) {
      for (const method of (match[1] ?? "").matchAll(/"([A-Z]+)"/g)) {
        if (method[1] !== "HEAD")
          routes.push({ method: method[1] ?? "GET", path: match[2] ?? "", file });
      }
    }
  }
  return routes;
}

describe("every gated sub-router route is owned by the gateway", () => {
  const routes = declaredRoutes();

  test("the census found the gated routes", () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  test("no declared route answers ROUTE_NOT_FOUND through createApp", async () => {
    const app = createApp();
    const unreachable: string[] = [];
    for (const route of routes) {
      const response = await app.request(`https://a.asimposium.org${sample(route.path)}`, {
        method: route.method,
        headers: route.method === "GET" ? {} : { "content-type": "application/json" },
        ...(route.method === "GET" ? {} : { body: "{}" }),
      });
      const text = await response.text();
      if (text.includes('"code":"ROUTE_NOT_FOUND"'))
        unreachable.push(`${route.method} ${route.path} (${route.file})`);
    }
    expect(unreachable).toEqual([]);
  });

  test("human screening appeals reach authentication through the production gateway", async () => {
    const app = createApp();
    for (const [method, path] of [
      ["GET", "/v1/sponsors/screening-cases"],
      ["GET", "/v1/sponsors/screening-cases/QC-00000000000000000000000000"],
      ["POST", "/v1/sponsors/screening-appeals"],
      ["GET", "/v1/operators/screening-appeals"],
      ["GET", "/v1/operators/screening-appeals/AP-00000000000000000000000000"],
      ["POST", "/v1/operators/screening-appeals/decision"],
    ] as const) {
      const response = await app.request(
        `https://a.asimposium.org${path}`,
        {
          method,
          ...(method === "POST"
            ? { headers: { "content-type": "application/json" }, body: "{}" }
            : {}),
        },
        {} as Env,
      );
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(body).toMatchObject({ code: "ENROLLMENT_UNAVAILABLE" });
    }
  });

  test("private workshop search reaches authentication through the production gateway", async () => {
    const response = await createApp().request(
      "https://a.asimposium.org/v1/sponsors/workshops/search",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "bounded convergence" }),
      },
      {} as Env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "ENROLLMENT_UNAVAILABLE" });
  });
});
