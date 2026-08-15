import { expect, test } from "bun:test";

import { generatedArtifacts } from "../../src/artifacts.ts";
import { getPublicSchema, listPublicSchemas, PUBLIC_SCHEMA_IDS } from "../../src/public-schemas.ts";

test("the public schema registry serves the exact generated artifacts", () => {
  const artifacts = new Map(
    generatedArtifacts().map((artifact) => [artifact.relativePath, artifact.content]),
  );

  expect(PUBLIC_SCHEMA_IDS).toEqual(["enrollment", "ledger", "problem"]);
  expect(listPublicSchemas().map((document) => document.id)).toEqual([...PUBLIC_SCHEMA_IDS]);

  for (const document of listPublicSchemas()) {
    const generated = artifacts.get(`generated/${document.id}.schema.json`);
    expect(generated).toBeDefined();
    if (generated === undefined) throw new Error(`Missing generated schema for ${document.id}`);
    expect(document.body).toBe(generated);
    expect(document.media_type).toBe("application/schema+json; charset=utf-8");

    const parsed = JSON.parse(document.body) as { readonly $id?: unknown };
    expect(parsed.$id).toBe(`https://a.asimposium.org${document.served_at}`);
    expect(getPublicSchema(document.id)).toBe(document);
    expect(Object.isFrozen(document)).toBe(true);
  }
  expect(Object.isFrozen(listPublicSchemas())).toBe(true);
});
