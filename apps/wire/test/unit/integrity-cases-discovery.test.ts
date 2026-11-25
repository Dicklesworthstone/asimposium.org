import { expect, test } from "bun:test";
import { ProblemDocumentSchema, PUBLIC_RESOURCE_REGISTRY } from "@asimposium/contracts";
import { getPublicSchema } from "@asimposium/contracts/public-schemas";
import { createApp } from "../../src/app.ts";
import {
  DISCOVERY_UNDISCLOSED_ROUTES,
  generateOpenApiDocument,
} from "../../src/discovery/discovery.ts";
import type { Env } from "../../src/env.ts";

test("public integrity discovery exposes neutral notices while private cases stay off agent capabilities", () => {
  const document = JSON.parse(generateOpenApiDocument());
  for (const format of ["json", "md", "html"]) {
    const operation = document.paths[`/p/{id}/integrity.${format}`].get;
    expect(operation.security).toEqual([]);
    expect(operation.responses["200"].description).toContain("remain restricted");
    expect(operation.responses["304"].description).toContain("current source visibility");
    expect(
      operation.parameters
        .filter((parameter: { in: string }) => parameter.in === "query")
        .map((parameter: { name: string }) => parameter.name),
    ).toEqual(["after"]);
    expect(operation.responses["503"]).toBeDefined();
  }
  expect(document.paths["/p/{id}/integrity"].get.responses["308"]).toBeDefined();
  for (const [principal, actions] of [
    ["operators", ["query", "read", "open", "resolve"]],
    ["sponsors", ["query", "read", "respond"]],
  ] as const) {
    for (const action of actions) {
      const route = `/v1/${principal}/integrity/cases/${action}`;
      expect(DISCOVERY_UNDISCLOSED_ROUTES[`POST ${route}`]).toBe(true);
      expect(document.paths[route]).toBeUndefined();
    }
  }
});

test("canonical contracts and face registry distinguish public notices from restricted investigations", () => {
  const schema = JSON.parse(getPublicSchema("integrity-cases").body);
  expect(schema.properties.public_notices).toBeDefined();
  expect(schema.properties.open).toBeDefined();
  expect(schema.properties.respond).toBeDefined();
  expect(schema.properties.resolve).toBeDefined();
  const entry = PUBLIC_RESOURCE_REGISTRY.find((item) => item.kind === "integrity-notices");
  expect(entry?.agent_markdown_url).toBe("/p/:id/integrity.md");
  expect(entry?.json_url).toBe("/p/:id/integrity.json");
  expect(entry?.html_url).toBe("/p/:id/integrity.html");
  expect(entry?.human_route_key).toBe("/p/:id/integrity");
});

test("the full app routes public notices and all seven signed operations to their actual handlers", async () => {
  const app = createApp();
  const caseId = `IC-${"0".repeat(26)}`;
  const redirect = await app.request(
    `https://a.asimposium.org/p/P-INTEGRITY/integrity?after=${caseId}`,
  );
  expect(redirect.status).toBe(308);
  expect(redirect.headers.get("location")).toBe(`/p/P-INTEGRITY/integrity.md?after=${caseId}`);
  for (const format of ["json", "md", "html"]) {
    const invalid = await app.request(
      `https://a.asimposium.org/p/P-INTEGRITY/integrity.${format}?secret=1`,
    );
    expect(invalid.status).toBe(400);
    expect(ProblemDocumentSchema.parse(await invalid.json()).code).toBe("CURSOR_INVALID");
    const unavailable = await app.request(
      `https://a.asimposium.org/p/P-INTEGRITY/integrity.${format}`,
    );
    expect(unavailable.status).toBe(503);
    expect(ProblemDocumentSchema.parse(await unavailable.json()).code).not.toBe("ROUTE_NOT_FOUND");
  }
  for (const [principal, actions] of [
    ["operators", ["query", "read", "open", "resolve"]],
    ["sponsors", ["query", "read", "respond"]],
  ] as const) {
    for (const action of actions) {
      const response = await app.request(
        `https://a.asimposium.org/v1/${principal}/integrity/cases/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
        {} as Env,
      );
      expect(response.status).toBe(503);
      expect(ProblemDocumentSchema.parse(await response.json()).code).not.toBe("ROUTE_NOT_FOUND");
    }
  }
});
