import { expect, test } from "bun:test";
import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

import { generatedArtifacts, packageDirectory } from "../../src/artifacts.ts";
import {
  getPublicSchema,
  listPublicSchemas,
  PUBLIC_SCHEMA_EXCLUSIONS,
  PUBLIC_SCHEMA_IDS,
} from "../../src/public-schemas.ts";

const GENERATED_SCHEMA_SUFFIX = ".schema.json";

const EXPECTED_PUBLIC_SCHEMA_IDS = [
  "enrollment",
  "enrollment-capsule",
  "internal-health",
  "ledger",
  "moves",
  "problem",
  "rubrics",
  "screening",
  "sessions",
] as const;


const EXPECTED_PUBLIC_SCHEMA_EXCLUSIONS = [
  {
    id: "batch",
    reason: "Batch planning contract; it has no separate public read face.",
  },
  {
    id: "contracts-scaffold",
    reason: "Generator metadata; it is not a product protocol schema.",
  },
  {
    id: "s2-cost-receipt",
    reason: "Internal S-2 cost-receipt evidence; it has no public agent face.",
  },
] as const;

type GeneratedSchemaDirectoryEntry = {
  readonly name: string;
  readonly kind: "directory" | "file" | "symlink" | "unsupported";
};

type GeneratedSchemaDirectoryReader = (
  directory: string,
) => readonly GeneratedSchemaDirectoryEntry[];

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function generatedSchemaDirectoryEntryKind(entry: Dirent): GeneratedSchemaDirectoryEntry["kind"] {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  return "unsupported";
}

function generatedSchemaDirectoryEntries(
  directory: string,
): readonly GeneratedSchemaDirectoryEntry[] {
  return readdirSync(directory, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    kind: generatedSchemaDirectoryEntryKind(entry),
  }));
}

function checkedInGeneratedSchemaPaths(
  directory = join(packageDirectory(), "generated"),
  readDirectory: GeneratedSchemaDirectoryReader = generatedSchemaDirectoryEntries,
): string[] {
  const paths: string[] = [];
  const visit = (currentDirectory: string, relativeDirectory: string): void => {
    const entries = [...readDirectory(currentDirectory)].sort((left, right) =>
      comparePaths(left.name, right.name),
    );
    for (const entry of entries) {
      const relativePath =
        relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = join(currentDirectory, entry.name);

      if (entry.kind === "symlink") {
        throw new Error(`PUBLIC_SCHEMA_CENSUS_SYMLINK:${relativePath}`);
      }
      if (entry.kind === "directory") {
        visit(absolutePath, relativePath);
        continue;
      }
      if (entry.kind !== "file") {
        throw new Error(`PUBLIC_SCHEMA_CENSUS_UNSUPPORTED_ENTRY:${relativePath}`);
      }
      if (entry.name.endsWith(GENERATED_SCHEMA_SUFFIX)) paths.push(relativePath);
    }
  };

  visit(directory, "");
  return paths.sort(comparePaths);
}

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

test("the public schema classification is pinned to approved served ids and exclusions", () => {
  expect(PUBLIC_SCHEMA_IDS).toEqual(EXPECTED_PUBLIC_SCHEMA_IDS);
  expect(PUBLIC_SCHEMA_EXCLUSIONS).toEqual(EXPECTED_PUBLIC_SCHEMA_EXCLUSIONS);
  expect(Object.isFrozen(PUBLIC_SCHEMA_IDS)).toBe(true);
});

test("checked-in generated schemas partition into served documents and reasoned exclusions", () => {
  const checkedIn = checkedInGeneratedSchemaPaths();
  const served = listPublicSchemas().map((document) => `${document.id}${GENERATED_SCHEMA_SUFFIX}`);
  const exclusions = PUBLIC_SCHEMA_EXCLUSIONS.map(
    (exclusion) => `${exclusion.id}${GENERATED_SCHEMA_SUFFIX}`,
  );
  const partition = [...served, ...exclusions].sort();

  expect(checkedIn.length).toBeGreaterThan(0);
  expect(new Set(checkedIn).size).toBe(checkedIn.length);
  expect(new Set(partition).size).toBe(partition.length);
  expect(checkedIn).toEqual(partition);

  for (const exclusion of PUBLIC_SCHEMA_EXCLUSIONS) {
    expect(exclusion.reason.trim().length, exclusion.id).toBeGreaterThan(0);
    expect(Object.isFrozen(exclusion), exclusion.id).toBe(true);
  }
  expect(Object.isFrozen(PUBLIC_SCHEMA_EXCLUSIONS)).toBe(true);
});

test("generated schema census is deterministic, recursive, and rejects symlinks", () => {
  const fixtureDirectory = "fixture";
  const nestedDirectory = join(fixtureDirectory, "nested");
  const readFixtureDirectory: GeneratedSchemaDirectoryReader = (directory) => {
    if (directory === fixtureDirectory) {
      return [
        { name: "zeta.schema.json", kind: "file" },
        { name: "nested", kind: "directory" },
      ];
    }
    if (directory === nestedDirectory) {
      return [
        { name: "ignore.txt", kind: "file" },
        { name: "alpha.schema.json", kind: "file" },
      ];
    }
    throw new Error(`unexpected fixture directory: ${directory}`);
  };

  expect(checkedInGeneratedSchemaPaths(fixtureDirectory, readFixtureDirectory)).toEqual([
    "nested/alpha.schema.json",
    "zeta.schema.json",
  ]);

  const readSymlinkedFixtureDirectory: GeneratedSchemaDirectoryReader = (directory) => {
    if (directory === nestedDirectory) {
      return [
        { name: "alpha.schema.json", kind: "file" },
        { name: "alias.schema.json", kind: "symlink" },
      ];
    }
    return readFixtureDirectory(directory);
  };
  expect(() =>
    checkedInGeneratedSchemaPaths(fixtureDirectory, readSymlinkedFixtureDirectory),
  ).toThrow("PUBLIC_SCHEMA_CENSUS_SYMLINK:nested/alias.schema.json");
});
