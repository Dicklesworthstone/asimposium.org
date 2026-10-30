import { test } from "bun:test";
import assert from "node:assert/strict";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import {
  ARTIFACT_PUBLICATION_OPERATIONS,
  artifactPublicationParameters,
  artifactPublicationResponses,
} from "../../src/discovery/artifact-publications-discovery.ts";
import {
  DISCLOSED_OPERATIONS,
  DISCOVERY_ORIGINS,
  generateOpenApiDocument,
} from "../../src/discovery/discovery.ts";

const operations = [
  {
    method: "POST",
    path: "/v1/artifacts/{uploadId}/publish",
    auth: "fellow-bearer",
    request: "request",
    response: "receipt",
  },
  {
    method: "GET",
    path: "/v1/artifact-publications/{publicationId}",
    auth: "fellow-bearer",
    response: "status",
  },
  {
    method: "POST",
    path: "/v1/artifact-publications/{publicationId}/retry",
    auth: "fellow-bearer",
    request: "retry_request",
    response: "retry_receipt",
  },
  {
    method: "GET",
    path: "/p/{problem}/artifacts/{publicationId}.json",
    auth: "public",
    response: "manifest",
  },
  {
    method: "GET",
    path: "/p/{problem}/evidence/{evidenceId}/artifacts.json",
    auth: "public",
    response: "evidence_artifacts",
  },
] as const;

test("capability discovery advertises the five publication gateway operations with their actual authority", () => {
  assert.equal(ARTIFACT_PUBLICATION_OPERATIONS.length, operations.length);
  for (const expected of operations) {
    const rows = DISCLOSED_OPERATIONS.filter(
      (row) => row.method === expected.method && row.openApiPath === expected.path,
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.auth, expected.auth);
    assert.equal(row.requiresBearer, expected.auth === "fellow-bearer");
    assert.equal(
      row.requestSchema,
      "request" in expected ? `artifact-publications:${expected.request}` : undefined,
    );
  }
  assert.equal(
    DISCLOSED_OPERATIONS.some(
      (row) =>
        row.method === "GET" &&
        row.openApiPath.endsWith("/artifact-publications/{publicationId}/retry"),
    ),
    false,
  );
});

test("generated OpenAPI resolves accepted retry receipts and every publication face on the configured Worker", () => {
  const registered = listPublicSchemas().find((row) => row.id === "artifact-publications");
  assert.ok(registered);
  const schema = JSON.parse(registered.body);
  for (const agent of [DISCOVERY_ORIGINS.agent, "https://a-staging.asimposium.org"]) {
    const document = JSON.parse(generateOpenApiDocument({ ...DISCOVERY_ORIGINS, agent }));
    for (const expected of operations) {
      const operation = document.paths[expected.path]?.[expected.method.toLowerCase()];
      assert.ok(operation);
      assert.deepEqual(operation.security, expected.auth === "public" ? [] : [{ bearerAuth: [] }]);
      const status = expected.method === "POST" ? "202" : "200";
      assert.equal(
        operation.responses[status]?.content["application/json"].schema.$ref,
        `${agent}/schemas/artifact-publications.v1.json#/properties/${expected.response}`,
      );
      assert.ok(schema.properties[expected.response]);
      if ("request" in expected) {
        assert.equal(
          operation.requestBody.content["application/json"].schema.$ref,
          `${agent}/schemas/artifact-publications.v1.json#/properties/${expected.request}`,
        );
        assert.ok(schema.properties[expected.request]);
        assert.equal(operation.responses["200"], undefined);
        assert.equal(operation.responses["201"], undefined);
      } else {
        assert.equal(operation.requestBody, undefined);
      }
      assert.equal(
        operation.responses[status].headers["Cache-Control"].schema.const,
        expected.auth === "public" ? "no-store" : "private, no-store",
      );
    }
  }
});

test("write discovery requires the transport's exact idempotency header without query authority", () => {
  const origin = DISCOVERY_ORIGINS.agent;
  for (const row of operations) {
    if (row.method !== "POST") continue;
    assert.deepEqual(
      artifactPublicationParameters(row.path, origin, row.method).map((value) => {
        const parameter = value as { name: string; in: string; required: boolean; schema: unknown };
        return {
          name: parameter.name,
          in: parameter.in,
          required: parameter.required,
          schema: parameter.schema,
        };
      }),
      [
        {
          name: "Idempotency-Key",
          in: "header",
          required: true,
          schema: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
        },
      ],
    );
  }
  for (const path of [
    "/v1/artifact-publications/{publicationId}",
    "/p/{problem}/artifacts/{publicationId}.json",
  ])
    assert.deepEqual(artifactPublicationParameters(path, origin, "GET"), []);
});

test("only the public evidence list advertises its bounded delivery cursors", () => {
  const path = "/p/{problem}/evidence/{evidenceId}/artifacts.json";
  const origin = DISCOVERY_ORIGINS.agent;
  const parameters = artifactPublicationParameters(path, origin, "GET") as {
    name: string;
    in: string;
    required: boolean;
    schema: { $ref: string };
  }[];
  assert.deepEqual(
    parameters.map((row) => row.name),
    ["after", "through"],
  );
  for (const parameter of parameters) {
    assert.equal(parameter.in, "query");
    assert.equal(parameter.required, false);
    assert.equal(
      parameter.schema.$ref,
      `${origin}/schemas/artifact-publications.v1.json#/properties/evidence_artifacts/properties/${parameter.name}`,
    );
  }
  assert.deepEqual(artifactPublicationParameters(path, origin, "POST"), []);
});

test("accepted recovery is private and public conditional reads retain current source checks", () => {
  const origin = DISCOVERY_ORIGINS.agent;
  const document = JSON.parse(generateOpenApiDocument());
  const retry = document.paths["/v1/artifact-publications/{publicationId}/retry"].post;
  assert.equal(
    retry.responses["202"].headers.Location.schema.$ref,
    `${origin}/schemas/artifact-publications.v1.json#/properties/receipt/properties/status_path`,
  );
  const registered = listPublicSchemas().find((row) => row.id === "artifact-publications");
  assert.ok(registered);
  const schema = JSON.parse(registered.body);
  assert.ok(schema.properties.receipt.properties.status_path.pattern);
  assert.equal(schema.properties.retry_receipt.oneOf.length, 2);
  assert.match(retry.responses["202"].description, /initial_delivery=release-authorized/);
  assert.equal(retry.responses["202"].headers["X-Robots-Tag"].schema.const, "noindex, nofollow");
  assert.ok(retry.responses["409"].content["application/problem+json"]);
  assert.equal(retry.responses["304"], undefined);
  for (const row of operations.filter((value) => value.auth === "public")) {
    const response = artifactPublicationResponses(row.path, origin, row.method);
    assert.ok(response?.["304"]);
    assert.match(JSON.stringify(response["304"]), /current source and visibility/);
  }
});

test("artifact discovery hooks do not bless neighboring paths or unsupported methods", () => {
  for (const [path, method] of [
    ["/v1/artifact-publications/{publicationId}/retry", "GET"],
    ["/v1/artifact-publications/{publicationId}", "POST"],
    ["/v1/artifacts/{uploadId}/complete", "POST"],
    ["/v1/artifact-publications/{publicationId}/retry/extra", "POST"],
    ["/p/{problem}/artifacts/{publicationId}.json", "POST"],
    ["/p/{problem}/evidence/{evidenceId}/artifacts.json/extra", "GET"],
  ] as const) {
    assert.equal(artifactPublicationResponses(path, DISCOVERY_ORIGINS.agent, method), undefined);
    assert.deepEqual(artifactPublicationParameters(path, DISCOVERY_ORIGINS.agent, method), []);
  }
});
