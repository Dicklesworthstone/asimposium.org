import { expect, test } from "bun:test";
import { PUBLIC_RESOURCE_REGISTRY } from "@asimposium/contracts";
import { getPublicSchema } from "@asimposium/contracts/public-schemas";
import { createApp } from "../../src/app.ts";
import { generateOpenApiDocument } from "../../src/discovery/discovery.ts";

test("research directories disclose their fixed cursors, public faces and honest failure states", () => {
  const document = JSON.parse(generateOpenApiDocument());
  for (const kind of ["evidence", "reviews"]) {
    for (const format of ["json", "md", "html"]) {
      const operation = document.paths[`/p/{id}/${kind}.${format}`].get;
      expect(operation.security).toEqual([]);
      const queries = operation.parameters.filter((parameter: { in: string }) => parameter.in === "query");
      expect(queries.map((parameter: { name: string }) => parameter.name)).toEqual(["through", "after"]);
      for (const parameter of queries) {
        expect(parameter.schema.$ref).toBe(
          `https://a.asimposium.org/schemas/research-lists.v1.json#/properties/query/properties/${parameter.name}`,
        );
      }
      const media = format === "json" ? "application/json" : format === "md" ? "text/markdown" : "text/html";
      expect(operation.responses["200"].content[media]).toBeDefined();
      if (format === "json") {
        expect(operation.responses["200"].content[media].schema.$ref).toBe(
          `https://a.asimposium.org/schemas/research-lists.v1.json#/properties/${kind}`,
        );
      }
      expect(operation.responses["304"].description).toContain("current visibility");
      expect(operation.responses["400"].description).toContain("CURSOR_INVALID");
      expect(operation.responses["503"].description).toContain("not an empty collection");
      expect(operation.responses["200"].headers.Link).toBeDefined();
    }
    const redirect = document.paths[`/p/{id}/${kind}`].get;
    expect(redirect.responses["308"].headers.Location).toBeDefined();
    expect(redirect.responses["200"]).toBeUndefined();
  }
  expect(document.paths["/reviews.json"].get.responses["200"].content["application/json"].schema.$ref)
    .not.toContain("research-lists");
});

test("the canonical resource and schema registries expose both complete directories", () => {
  const schema = getPublicSchema("research-lists");
  expect(schema).toBeDefined();
  const document = JSON.parse(schema.body);
  expect(Object.keys(document.properties)).toEqual(["query", "evidence", "reviews"]);
  for (const [kind, path] of [["evidence-list", "evidence"], ["reviews-list", "reviews"]]) {
    const resource = PUBLIC_RESOURCE_REGISTRY.find((entry) => entry.kind === kind);
    expect(resource?.agent_markdown_url).toBe(`/p/:id/${path}.md`);
    expect(resource?.json_url).toBe(`/p/:id/${path}.json`);
    expect(resource?.html_url).toBe(`/p/:id/${path}.html`);
    expect(resource?.human_route_key).toBe(`/p/:id/${path}`);
  }
});

test("the complete application mounts each directory before the legacy public matcher", async () => {
  const app = createApp();
  for (const kind of ["evidence", "reviews"]) {
    const redirect = await app.request(`https://a.asimposium.org/p/P-RESEARCH/${kind}?through=20&after=8`);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(`/p/P-RESEARCH/${kind}.md?through=20&after=8`);
    for (const format of ["json", "md", "html"]) {
      const invalid = await app.request(`https://a.asimposium.org/p/P-RESEARCH/${kind}.${format}?after=0`);
      expect(invalid.status).toBe(400);
      expect((await invalid.json()).code).toBe("CURSOR_INVALID");
      const unavailable = await app.request(`https://a.asimposium.org/p/P-RESEARCH/${kind}.${format}`);
      expect(unavailable.status).toBe(503);
      expect((await unavailable.json()).code).not.toBe("ROUTE_NOT_FOUND");
    }
  }
});
