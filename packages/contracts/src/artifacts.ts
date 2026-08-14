import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { CONTRACT_SCAFFOLD_SCHEMA_ID, ContractScaffoldSchema } from "./schema.ts";

export interface GeneratedArtifact {
  readonly relativePath: string;
  readonly content: string;
}

export interface ArtifactDrift {
  readonly code: "GENERATED_ARTIFACT_MISSING" | "GENERATED_ARTIFACT_STALE";
  readonly artifact: string;
}

const TYPES_ARTIFACT = "generated/contracts-scaffold.types.ts";
const JSON_SCHEMA_ARTIFACT = "generated/contracts-scaffold.schema.json";

export function packageDirectory(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function generatedJsonSchema(): string {
  const document = {
    $id: CONTRACT_SCAFFOLD_SCHEMA_ID,
    title: "Contracts scaffold marker",
    description: "Non-product tooling marker. This is not an ASImposium protocol schema.",
    ...z.toJSONSchema(ContractScaffoldSchema),
  };

  return formatJson(document);
}

function generatedTypes(): string {
  return [
    "// Generated from src/schema.ts by `bun run generate`. Do not edit.",
    'export type { ContractScaffold } from "../src/schema.ts";',
    "",
  ].join("\n");
}

export function generatedArtifacts(): readonly GeneratedArtifact[] {
  return [
    { relativePath: JSON_SCHEMA_ARTIFACT, content: generatedJsonSchema() },
    { relativePath: TYPES_ARTIFACT, content: generatedTypes() },
  ];
}

export function compareGeneratedArtifact(
  artifact: GeneratedArtifact,
  actual: string | undefined,
): ArtifactDrift | undefined {
  if (actual === undefined) {
    return { code: "GENERATED_ARTIFACT_MISSING", artifact: artifact.relativePath };
  }

  if (actual !== artifact.content) {
    return { code: "GENERATED_ARTIFACT_STALE", artifact: artifact.relativePath };
  }

  return undefined;
}

export async function checkGeneratedArtifacts(
  root = packageDirectory(),
): Promise<readonly ArtifactDrift[]> {
  const drifts: ArtifactDrift[] = [];

  for (const artifact of generatedArtifacts()) {
    let actual: string | undefined;
    try {
      actual = await readFile(join(root, artifact.relativePath), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const drift = compareGeneratedArtifact(artifact, actual);
    if (drift !== undefined) drifts.push(drift);
  }

  return drifts;
}

export async function writeGeneratedArtifacts(root = packageDirectory()): Promise<void> {
  for (const artifact of generatedArtifacts()) {
    const destination = join(root, artifact.relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, artifact.content, "utf8");
  }
}
