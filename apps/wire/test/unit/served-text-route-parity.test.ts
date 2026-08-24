import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listPublicSchemas } from "@asimposium/contracts/public-schemas";
import { type DocumentId, getDocument } from "@asimposium/protocol";
import { callWorker } from "../support/bindings";

/**
 * asimposiumorg-2tfn parity gate: every route a served text tells an agent to
 * hit must resolve to a mounted handler. A first-contact agent follows these
 * documents verbatim; a reference that answers ROUTE_NOT_FOUND is the exact
 * cold-start failure G0 exists to prevent. The gate extracts route-like
 * references from every registered served document (plus the runtime
 * enrollment capsule source) and probes each against the real Worker.
 */

const DOCUMENT_IDS: readonly DocumentId[] = [
  "capsule",
  "handbook",
  "llms",
  "policy",
  "protocol",
  "skill",
];

/** `/v1/...`, `/capabilities`, `/problems.md`, … — route-like backticked refs. */
const REFERENCE_PATTERN = /`(\/[A-Za-z0-9._{}/:-]*)`/g;

/** Schema URLs are exact-derived from the same registry that mounts them. */
const SCHEMA_PATHS: ReadonlySet<string> = new Set(
  listPublicSchemas().map((document) => document.served_at),
);

const STATIC_FACE_PATHS = new Set(DOCUMENT_IDS.map((id) => getDocument(id).served_at));

function collectReferences(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const reference = match[1];
    if (reference !== undefined && reference.length > 1) found.add(reference);
  }
  return found;
}

describe("served texts never advertise unmounted routes (2tfn)", () => {
  test("every referenced path resolves to a handler, a face, or a served schema", async () => {
    const sources = new Map<string, string>();
    for (const id of DOCUMENT_IDS) {
      const document = getDocument(id);
      sources.set(document.served_at, document.body);
    }
    // The runtime enrollment capsule is projection-rendered, so its route
    // references are bound from the shipped source that generates it.
    const capsuleSourcePath = resolve(join(import.meta.dir, "../../src/enrollment/capsule.ts"));
    sources.set("src/enrollment/capsule.ts", readFileSync(capsuleSourcePath, "utf8"));

    const failures: string[] = [];
    for (const [origin, body] of sources) {
      for (const reference of collectReferences(body)) {
        if (reference.startsWith("/schemas/")) {
          if (!SCHEMA_PATHS.has(reference)) {
            failures.push(`${origin} advertises unmounted ${reference}`);
          }
          continue;
        }
        if (STATIC_FACE_PATHS.has(reference)) continue;
        if (reference.startsWith("/join/")) {
          const probe = await callWorker("/join/ASIMP-EN-01JXYZ4K6Q");
          if (
            probe.status === 404 &&
            JSON.stringify(probe.body ?? {}).includes("ROUTE_NOT_FOUND")
          ) {
            failures.push(`${origin} advertises unmounted /join/:enrollmentId`);
          }
          continue;
        }
        const probe = await callWorker(reference);
        if (probe.status === 404 && JSON.stringify(probe.body ?? {}).includes("ROUTE_NOT_FOUND")) {
          failures.push(`${origin} advertises unmounted ${reference}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("no served text instructs agents to POST a reports surface that does not exist", () => {
    for (const id of DOCUMENT_IDS) {
      expect(getDocument(id).body).not.toContain("/v1/reports");
    }
    const capsuleSource = readFileSync(
      resolve(join(import.meta.dir, "../../src/enrollment/capsule.ts")),
      "utf8",
    );
    expect(capsuleSource).not.toContain("/v1/reports");
  });

  test("the skill reference map names only concrete schema URLs, never a bare index", () => {
    const skill = getDocument("skill").body;
    expect(skill).not.toContain("`/schemas/`");
    for (const match of skill.matchAll(/`?(\/schemas\/[A-Za-z0-9._-]+)`?/g)) {
      const reference = match[1];
      if (reference !== undefined) expect(SCHEMA_PATHS.has(reference)).toBe(true);
    }
  });
});
