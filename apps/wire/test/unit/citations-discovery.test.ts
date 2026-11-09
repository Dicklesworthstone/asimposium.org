import { expect, test } from "bun:test";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import {
  DISCOVERY_ORIGINS,
  DISCOVERY_UNDISCLOSED_ROUTES,
  generateOpenApiDocument,
} from "../../src/discovery/discovery.ts";

test("citation and literature collections disclose the same fixed-cut query and bounded response", () => {
  const schema = listPublicSchemas().find((item) => item.id === "citations");
  expect(schema).toBeDefined();
  const query = JSON.parse(schema?.body ?? "{}").$defs?.query;
  for (const agent of [DISCOVERY_ORIGINS.agent, "https://a.staging.asimposium.org"]) {
    const document = JSON.parse(generateOpenApiDocument({ ...DISCOVERY_ORIGINS, agent }));
    for (const resource of ["citations", "literature"]) {
      for (const [format, media] of [
        ["json", "application/json"],
        ["md", "text/markdown"],
        ["html", "text/html"],
      ]) {
        const operation = document.paths[`/p/{id}/${resource}.${format}`]?.get;
        expect(operation).toBeDefined();
        expect(DISCOVERY_UNDISCLOSED_ROUTES[`GET /p/:id/${resource}.${format}`]).toBeUndefined();
        expect(operation.security).toEqual([]);
        const parameters = operation.parameters.filter(
          (parameter: { in: string }) => parameter.in === "query",
        );
        expect(parameters.map((parameter: { name: string }) => parameter.name)).toEqual([
          "through",
          "after",
          "limit",
          "unanchored",
        ]);
        for (const parameter of parameters) {
          expect(parameter.required).toBe(false);
          expect(parameter.schema.$ref).toBe(
            `${agent}/schemas/citations.v1.json#/$defs/query/properties/${parameter.name}`,
          );
          expect(query?.properties?.[parameter.name]).toBeDefined();
        }
        expect(parameters[1].description).toContain("Requires the original through cursor");
        expect(parameters[2].description).toContain("defaults to 50");
        expect(parameters[3].description).toContain("true or false");
        expect(operation.responses["200"].content[media as string]).toBeDefined();
        if (format === "json")
          expect(operation.responses["200"].content["application/json"].schema.$ref).toBe(
            `${agent}/schemas/citations.v1.json`,
          );
        expect(operation.responses["200"].headers["Content-Location"]).toBeDefined();
        expect(operation.responses["200"].headers.Link).toBeDefined();
        for (const status of ["304", "400", "404", "503"])
          expect(operation.responses[status]).toBeDefined();
        expect(operation.responses["503"].headers["Retry-After"]).toBeDefined();
      }
    }
  }
});

test("exact citation discovery identifies its history schema and snapshot-preserving exports", () => {
  const schema = listPublicSchemas().find((item) => item.id === "citations");
  const definitions = JSON.parse(schema?.body ?? "{}").$defs;
  expect(definitions?.read_query?.properties?.through).toBeDefined();
  expect(definitions?.single?.properties?.cursor).toBeDefined();
  expect(definitions?.single?.properties?.versions).toBeDefined();
  const document = JSON.parse(generateOpenApiDocument());
  const operation = document.paths["/p/{id}/citations/{target}"].get;
  const parameters = operation.parameters.filter(
    (parameter: { in: string }) => parameter.in === "query",
  );
  expect(parameters.map((parameter: { name: string }) => parameter.name)).toEqual(["through"]);
  expect(parameters[0].schema.$ref).toBe(
    `${DISCOVERY_ORIGINS.agent}/schemas/citations.v1.json#/$defs/read_query/properties/through`,
  );
  expect(parameters[0].description).toContain("bibliography export");
  expect(operation.responses["200"].content).toEqual({
    "application/json": {
      schema: { $ref: `${DISCOVERY_ORIGINS.agent}/schemas/citations.v1.json#/$defs/single` },
    },
    "text/markdown": {},
    "text/html": {},
    "application/x-bibtex": {},
    "application/vnd.citationstyles.csl+json": {},
  });
  expect(operation.responses["304"].description).toContain("current visibility");
  expect(operation.security).toEqual([]);
});
