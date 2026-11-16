import { test } from "bun:test";
import assert from "node:assert/strict";
import { generateArtifactUploadsSchema } from "@asimposium/contracts/artifact-uploads";
import { ARTIFACT_UPLOAD_OPERATIONS } from "../../src/discovery/artifact-uploads-discovery.ts";
import {
  DISCLOSED_OPERATIONS,
  DISCOVERY_ORIGINS,
  generateOpenApiDocument,
} from "../../src/discovery/discovery.ts";

test("capabilities and OpenAPI expose the complete authenticated private upload loop", () => {
  const document = JSON.parse(generateOpenApiDocument());
  const schema = JSON.parse(generateArtifactUploadsSchema());
  for (const [route, auth, , request] of ARTIFACT_UPLOAD_OPERATIONS) {
    const [method, sourcePath] = route.split(" ");
    assert.ok(method && sourcePath);
    const path = sourcePath.replace(/:([A-Za-z]+)/g, "{$1}");
    const disclosed = DISCLOSED_OPERATIONS.filter(
      (row) => row.method === method && row.openApiPath === path,
    );
    assert.equal(disclosed.length, 1, route);
    assert.equal(disclosed[0]?.auth, auth);
    const operation = document.paths[path]?.[method.toLowerCase()];
    assert.ok(operation, route);
    assert.deepEqual(operation.security, [{ bearerAuth: [] }]);
    if (request) {
      const root = request.split(":")[1];
      assert.ok(root && schema.properties[root]);
      assert.equal(
        operation.requestBody.content["application/json"].schema.$ref,
        `${DISCOVERY_ORIGINS.agent}/schemas/artifact-uploads.v1.json#/properties/${root}`,
      );
    }
    const accepted = method === "POST" && path === "/v1/artifacts" ? "201" : "200";
    const result = operation.responses[accepted];
    assert.equal(result.headers["Cache-Control"].schema.const, "private, no-store");
    const ref = result.content?.["application/json"]?.schema.$ref;
    if (ref) assert.ok(schema.properties[ref.split("/").at(-1)]);
    if (method === "HEAD") {
      assert.equal(result.content, undefined);
      assert.equal(operation.responses.default.content, undefined);
      assert.equal(operation.requestBody, undefined);
    }
  }
  const part = document.paths["/v1/artifacts/{uploadId}/parts/{partNumber}"].put;
  assert.equal(part.requestBody.content["application/octet-stream"].schema.format, "binary");
  assert.equal(part.requestBody.content["application/json"], undefined);
  const inventory = document.paths["/v1/artifacts"].get;
  assert.deepEqual(
    inventory.parameters.map((item: { name: string }) => item.name),
    ["after", "limit"],
  );
  assert.equal(inventory.requestBody, undefined);
  const content = document.paths["/v1/artifacts/{uploadId}/content"].get;
  assert.deepEqual(content.parameters.map((item: { name: string }) => item.name).sort(), [
    "If-Range",
    "Range",
    "uploadId",
  ]);
  assert.ok(content.responses["206"].headers["Content-Range"]);
  assert.ok(content.responses["416"].headers["Content-Range"]);
  assert.equal(content.responses["200"].headers["Accept-Ranges"].schema.const, "bytes");
});
