import { describe, expect, test } from "bun:test";

import {
  archiveExpansionIsBounded,
  archiveMemberPathIsSafe,
  ARTIFACTS_ORIGIN,
  bodyLooksSecretShaped,
  CAS_EXTRACT_CHARS,
  CAS_KEY_PREFIX,
  CAS_SPILL_THRESHOLD_BYTES,
  casExtractFor,
  casKeyForHash,
  casUrlForHash,
  decideArtifactAdmission,
  MAX_ARCHIVE_EXPANSION_RATIO,
  MAX_ARTIFACT_BYTES,
  MAX_LAKE_ARCHIVE_BYTES,
  scanBodyForSecrets,
  shouldSpillToCas,
} from "../../src/krater/cas.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("CAS keying and dedupe (W2.7)", () => {
  test("the key is the digest: identical bytes dedupe to one object site-wide", () => {
    expect(casKeyForHash(HASH_A)).toBe(`${CAS_KEY_PREFIX}${HASH_A}`);
    expect(casKeyForHash(HASH_A)).toBe(casKeyForHash(HASH_A));
    expect(casKeyForHash(HASH_A)).not.toBe(casKeyForHash(HASH_B));
  });

  test("the public URL is immutable and derived from the digest", () => {
    expect(casUrlForHash(HASH_A)).toBe(`${ARTIFACTS_ORIGIN}/sha256/${HASH_A}`);
  });

  test("a non-sha256-hex digest is refused, never silently keyed", () => {
    for (const bad of ["", "xyz", HASH_A.toUpperCase(), `${HASH_A}ff`, HASH_A.slice(0, 63)]) {
      expect(() => casKeyForHash(bad)).toThrow();
      expect(() => casUrlForHash(bad)).toThrow();
    }
  });
});

describe("the spill threshold and extract", () => {
  test("bodies over 1 KB spill; at-or-under stays in the row", () => {
    expect(shouldSpillToCas(CAS_SPILL_THRESHOLD_BYTES)).toBe(false);
    expect(shouldSpillToCas(CAS_SPILL_THRESHOLD_BYTES + 1)).toBe(true);
  });

  test("the extract is exactly 280 chars max and never splits a body's tail oddly", () => {
    const long = "x".repeat(1000);
    const extract = casExtractFor(long);
    expect(extract.length).toBe(CAS_EXTRACT_CHARS);
    expect(casExtractFor("short")).toBe("short");
    // Multi-byte: the slice is on characters, never a half-encoded tail.
    const unicode = "λ".repeat(500);
    expect(casExtractFor(unicode).length).toBe(CAS_EXTRACT_CHARS);
  });
});

describe("MIME admission and the forbidden-execution wall", () => {
  test("text/source/Lean/logs are admitted inline", () => {
    for (const type of ["text/plain", "text/markdown", "text/x-lean", "application/json"]) {
      const verdict = decideArtifactAdmission({ sniffedType: type, sizeBytes: 100 });
      expect(verdict.admitted, type).toBe(true);
      if (verdict.admitted) expect(verdict.disposition).toBe("inline");
    }
  });

  test("HTML/SVG/JS never execute under a site origin — refused outright", () => {
    for (const type of ["text/html", "image/svg+xml", "application/javascript"]) {
      const verdict = decideArtifactAdmission({ sniffedType: type, sizeBytes: 100 });
      expect(verdict.admitted, type).toBe(false);
      if (!verdict.admitted) expect(verdict.code).toBe("ARTIFACT_TYPE_FORBIDDEN");
    }
  });

  test("an unrecognized type is refused, not guessed", () => {
    const verdict = decideArtifactAdmission({
      sniffedType: "application/x-msdownload",
      sizeBytes: 10,
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.code).toBe("ARTIFACT_TYPE_NOT_ALLOWED");
  });

  test("a .tar.gz lake archive downloads as an attachment, never rendered", () => {
    const verdict = decideArtifactAdmission({ sniffedType: "application/gzip", sizeBytes: 1024 });
    expect(verdict.admitted).toBe(true);
    if (verdict.admitted) {
      expect(verdict.disposition).toBe("attachment");
      expect(verdict.isLakeArchive).toBe(true);
    }
  });
});

describe("size caps", () => {
  test("the general cap is 5 MB; the lake cap is 20 MB", () => {
    const atGeneral = decideArtifactAdmission({
      sniffedType: "text/plain",
      sizeBytes: MAX_ARTIFACT_BYTES,
    });
    expect(atGeneral.admitted).toBe(true);
    const overGeneral = decideArtifactAdmission({
      sniffedType: "text/plain",
      sizeBytes: MAX_ARTIFACT_BYTES + 1,
    });
    expect(overGeneral.admitted).toBe(false);
    if (!overGeneral.admitted) expect(overGeneral.code).toBe("ARTIFACT_TOO_LARGE");

    const overLake = decideArtifactAdmission({
      sniffedType: "application/gzip",
      sizeBytes: MAX_LAKE_ARCHIVE_BYTES + 1,
    });
    expect(overLake.admitted).toBe(false);
    // A lake archive gets the larger cap, so 6 MB of gzip is admissible.
    const lakeOk = decideArtifactAdmission({
      sniffedType: "application/gzip",
      sizeBytes: MAX_ARTIFACT_BYTES + 1,
    });
    expect(lakeOk.admitted).toBe(true);
  });
});

describe("the P7 secret-shaped refusal", () => {
  test("a Fellow bearer token in the body is refused before it binds", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    expect(bodyLooksSecretShaped(`here is my token: ${token}`)).toBe(true);
    const verdict = decideArtifactAdmission({
      sniffedType: "text/markdown",
      sizeBytes: 50,
      body: `leaked: ${token}`,
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.code).toBe("ARTIFACT_SECRET_SHAPED");
  });

  test("a private key block is refused", () => {
    expect(bodyLooksSecretShaped("-----BEGIN PRIVATE KEY-----\nabc")).toBe(true);
  });

  test("ordinary research prose is not secret-shaped", () => {
    expect(
      bodyLooksSecretShaped("Every toggle-invariant labeling factors through the quotient."),
    ).toBe(false);
  });

  test("the scan reports the redacted location, never the value", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    const body = `line one is clean\nleaked: ${token} here\nline three is clean`;
    const findings = scanBodyForSecrets(body);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const first = findings[0];
    if (first === undefined) throw new Error("expected a finding");
    expect(first.kind).toBe("fellow-token");
    expect(first.line).toBe(2);
    expect(first.column).toBe(9);
    // The finding carries no bytes of the secret.
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  test("personal email addresses are PII and refused", () => {
    const findings = scanBodyForSecrets("reach me at researcher@example.org for the data");
    expect(findings.some((f) => f.kind === "personal-address")).toBe(true);
    const verdict = decideArtifactAdmission({
      sniffedType: "text/plain",
      sizeBytes: 40,
      body: "contact: someone@somewhere.com",
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.code).toBe("ARTIFACT_SECRET_SHAPED");
  });

  test("the CAS URL shape does not trip the address detector", () => {
    // An artifacts URL has no @, so it must not false-positive as an address.
    expect(scanBodyForSecrets(`see ${casUrlForHash(HASH_A)}`)).toHaveLength(0);
  });
});

describe("archive safety bounds", () => {
  test("a decompression bomb beyond the expansion ratio is refused", () => {
    expect(archiveExpansionIsBounded(1000, 1000 * MAX_ARCHIVE_EXPANSION_RATIO)).toBe(true);
    expect(archiveExpansionIsBounded(1000, 1000 * MAX_ARCHIVE_EXPANSION_RATIO + 1)).toBe(false);
    expect(archiveExpansionIsBounded(0, 100)).toBe(false);
  });

  test("traversal members are refused; ordinary members pass", () => {
    expect(archiveMemberPathIsSafe("src/main.leans")).toBe(true);
    expect(archiveMemberPathIsSafe("a/b/c.txt")).toBe(true);
    expect(archiveMemberPathIsSafe("../escape")).toBe(false);
    expect(archiveMemberPathIsSafe("/absolute")).toBe(false);
    expect(archiveMemberPathIsSafe("C:\\\\windows")).toBe(false);
    expect(archiveMemberPathIsSafe("a/../../up")).toBe(false);
    expect(archiveMemberPathIsSafe("")).toBe(false);
  });
});

import {
  stepUpload,
  uploadMayBind,
  uploadStateIsTerminal,
  type UploadState,
  type UploadTransition,
} from "../../src/krater/cas.ts";

describe("the upload manifest state machine (W2.7)", () => {
  test("the happy path: declared → presigned → uploaded → verified → bound", () => {
    let state: UploadState = "declared";
    for (const transition of ["presign", "upload", "verify", "bind"] as const) {
      const step = stepUpload(state, transition);
      expect(step.ok, `${transition} from ${state}`).toBe(true);
      if (step.ok) state = step.state;
    }
    expect(state).toBe("bound");
    expect(uploadStateIsTerminal(state)).toBe(true);
  });

  test("an unverified object can never bind", () => {
    for (const state of ["declared", "presigned", "uploaded", "quarantined", "expired"] as const) {
      expect(uploadMayBind(state), state).toBe(false);
      expect(stepUpload(state, "bind").ok, state).toBe(false);
    }
    expect(uploadMayBind("verified")).toBe(true);
  });

  test("a quarantined (digest/size mismatch) object is terminal and never binds", () => {
    const step = stepUpload("uploaded", "mismatch");
    expect(step.ok).toBe(true);
    if (step.ok) {
      expect(step.state).toBe("quarantined");
      expect(uploadStateIsTerminal(step.state)).toBe(true);
      // No resurrection.
      for (const t of ["presign", "upload", "verify", "bind", "expire"] as const) {
        expect(stepUpload(step.state, t).ok, t).toBe(false);
      }
    }
  });

  test("expiry preempts any non-terminal state and is terminal", () => {
    for (const state of ["declared", "presigned", "uploaded"] as const) {
      const step = stepUpload(state, "expire");
      expect(step.ok, state).toBe(true);
      if (step.ok) expect(step.state).toBe("expired");
    }
    expect(stepUpload("expired", "presign").ok).toBe(false);
  });

  test("a verified object cannot be re-uploaded or expired", () => {
    expect(stepUpload("verified", "upload").ok).toBe(false);
    expect(stepUpload("verified", "expire").ok).toBe(false);
    expect(stepUpload("verified", "verify").ok).toBe(false);
  });

  test("every non-terminal state reaches bound or a terminal refusal", () => {
    // Model-check the small graph: from each state, BFS to a terminal.
    const all: UploadState[] = ["declared", "presigned", "uploaded", "verified"];
    const transitions: UploadTransition[] = ["presign", "upload", "verify", "bind", "expire", "mismatch"];
    for (const start of all) {
      const seen = new Set<UploadState>([start]);
      const queue: UploadState[] = [start];
      let reachesTerminal = false;
      while (queue.length > 0) {
        const current = queue.shift() as UploadState;
        if (uploadStateIsTerminal(current)) {
          reachesTerminal = true;
          break;
        }
        for (const t of transitions) {
          const step = stepUpload(current, t);
          if (step.ok && !seen.has(step.state)) {
            seen.add(step.state);
            queue.push(step.state);
          }
        }
      }
      expect(reachesTerminal, `${start} never reaches a terminal state`).toBe(true);
    }
  });
});
