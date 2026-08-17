import { expect, test } from "bun:test";

import { generatedArtifacts } from "../../src/artifacts.ts";
import { getPublicSchema, listPublicSchemas, PUBLIC_SCHEMA_IDS } from "../../src/public-schemas.ts";

function schemaId(body: string): unknown {
  try {
    return (JSON.parse(body) as { readonly $id?: unknown }).$id;
  } catch {
    throw new Error("public schema registry contains invalid generated JSON");
  }
}

test("the public schema registry serves the exact generated artifacts", () => {
  const artifacts = new Map(
    generatedArtifacts().map((artifact) => [artifact.relativePath, artifact.content]),
  );

  expect(PUBLIC_SCHEMA_IDS).toEqual([
    "enrollment",
    "enrollment-capsule",
    "ledger",
    "problem",
    "screening",
  ]);
  expect(listPublicSchemas().map((document) => document.id)).toEqual([...PUBLIC_SCHEMA_IDS]);

  for (const document of listPublicSchemas()) {
    const generated = artifacts.get(`generated/${document.id}.schema.json`);
    expect(generated).toBeDefined();
    if (generated === undefined) throw new Error(`Missing generated schema for ${document.id}`);
    expect(document.body).toBe(generated);
    expect(document.media_type).toBe("application/schema+json; charset=utf-8");

    expect(schemaId(document.body)).toBe(`https://a.asimposium.org${document.served_at}`);
    expect(getPublicSchema(document.id)).toBe(document);
    expect(Object.isFrozen(document)).toBe(true);
  }
  expect(Object.isFrozen(listPublicSchemas())).toBe(true);
});
