import { expect, test } from "bun:test";

import {
  checkGeneratedArtifacts,
  compareGeneratedArtifact,
  generatedArtifacts,
} from "../../src/artifacts.ts";
import { type DiagnosticCode, REPRODUCE, safeDiagnostic } from "../../src/diagnostics.ts";

function failureDiagnostic(suite: string, startedAt: number, code: DiagnosticCode): string {
  return safeDiagnostic({
    suite,
    status: code.includes("STALE") ? "stale" : "invalid",
    startedAt,
    code,
    reproduce: REPRODUCE.contract,
  });
}

test("committed JSON Schema and TypeScript outputs have no drift", async () => {
  const startedAt = performance.now();
  const drifts = await checkGeneratedArtifacts();

  if (drifts.length > 0) {
    const [firstDrift] = drifts;
    if (firstDrift === undefined) {
      throw new Error(failureDiagnostic("artifacts.drift", startedAt, "NO_ARTIFACT"));
    }
    throw new Error(failureDiagnostic("artifacts.drift", startedAt, firstDrift.code));
  }

  expect(drifts).toEqual([]);
});

test("planted stale generated content fails the drift comparison", () => {
  const startedAt = performance.now();
  const [artifact] = generatedArtifacts();

  if (artifact === undefined) {
    throw new Error(failureDiagnostic("artifacts.stale-negative", startedAt, "NO_ARTIFACT"));
  }

  const drift = compareGeneratedArtifact(artifact, `${artifact.content}// stale\n`);
  if (drift === undefined) {
    throw new Error(
      failureDiagnostic("artifacts.stale-negative", startedAt, "STALE_ARTIFACT_ACCEPTED"),
    );
  }

  expect(drift).toEqual({
    code: "GENERATED_ARTIFACT_STALE",
    artifact: artifact.relativePath,
  });
});

test("planted stale enrollment schema is rejected by the artifact manifest", () => {
  const startedAt = performance.now();
  const artifact = generatedArtifacts().find(
    (candidate) => candidate.relativePath === "generated/enrollment.schema.json",
  );

  if (artifact === undefined) {
    throw new Error(failureDiagnostic("artifacts.enrollment-missing", startedAt, "NO_ARTIFACT"));
  }

  const drift = compareGeneratedArtifact(
    artifact,
    `${artifact.content}// stale enrollment schema\n`,
  );
  if (drift === undefined) {
    throw new Error(
      failureDiagnostic(
        "artifacts.enrollment-stale-negative",
        startedAt,
        "STALE_ARTIFACT_ACCEPTED",
      ),
    );
  }

  expect(drift).toEqual({
    code: "GENERATED_ARTIFACT_STALE",
    artifact: "generated/enrollment.schema.json",
  });
});
