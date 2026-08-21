import { describe, expect, test } from "bun:test";

import {
  ARTIFACTS_ORIGIN,
  archiveExpansionIsBounded,
  archiveMemberPathIsSafe,
  bodyLooksSecretShaped,
  CAS_EXTRACT_CHARS,
  CAS_KEY_PREFIX,
  CAS_SPILL_THRESHOLD_BYTES,
  casExtractFor,
  casKeyForHash,
  casUrlForHash,
  decideArtifactAdmission,
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

  test("PLANTED: a runtime digest cannot validate one coercion and key another", () => {
    for (const derive of [casKeyForHash, casUrlForHash]) {
      let coercions = 0;
      const digestLike = {
        [Symbol.toPrimitive](): string {
          coercions += 1;
          return coercions === 1 ? HASH_A : "../private-object";
        },
      };

      expect(() => derive(digestLike as unknown as string)).toThrow("ARTIFACT_DIGEST_INVALID");
      expect(coercions).toBe(0);
    }
  });
});

describe("the spill threshold and extract", () => {
  test("bodies over 1 KB spill; at-or-under stays in the row", () => {
    expect(shouldSpillToCas(CAS_SPILL_THRESHOLD_BYTES)).toBe(false);
    expect(shouldSpillToCas(CAS_SPILL_THRESHOLD_BYTES + 1)).toBe(true);
    for (const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => shouldSpillToCas(invalid)).toThrow("ARTIFACT_SIZE_INVALID");
    }
  });

  test("the extract is exactly 280 scalar-safe code points and never splits a surrogate pair", () => {
    const long = "x".repeat(1000);
    const extract = casExtractFor(long);
    expect(extract.length).toBe(CAS_EXTRACT_CHARS);
    expect(casExtractFor("short")).toBe("short");
    const unicode = `${"λ".repeat(CAS_EXTRACT_CHARS - 1)}😀tail`;
    const unicodeExtract = casExtractFor(unicode);
    expect([...unicodeExtract]).toHaveLength(CAS_EXTRACT_CHARS);
    expect(unicodeExtract.endsWith("😀")).toBe(true);
    expect(unicodeExtract).not.toContain("\uFFFD");
  });

  test("PLANTED: lone surrogates before and at the extract boundary normalize without splitting pairs", () => {
    for (const loneSurrogate of ["\uD800", "\uDFFF"]) {
      expect(casExtractFor(loneSurrogate)).toBe("\uFFFD");

      const beforeBoundary = casExtractFor(
        `${"x".repeat(CAS_EXTRACT_CHARS - 2)}${loneSurrogate}😀tail`,
      );
      expect(beforeBoundary).toBe(`${"x".repeat(CAS_EXTRACT_CHARS - 2)}\uFFFD😀`);
      expect([...beforeBoundary]).toHaveLength(CAS_EXTRACT_CHARS);
      // In Unicode mode the valid astral pair is one code point outside this
      // range, while a lone surrogate remains a matching invalid code point.
      expect(beforeBoundary).not.toMatch(/[\uD800-\uDFFF]/u);

      const atBoundary = casExtractFor(`${"x".repeat(CAS_EXTRACT_CHARS - 1)}${loneSurrogate}tail`);
      expect(atBoundary).toBe(`${"x".repeat(CAS_EXTRACT_CHARS - 1)}\uFFFD`);
      expect([...atBoundary]).toHaveLength(CAS_EXTRACT_CHARS);
      expect(atBoundary).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });
});

describe("MIME admission and the forbidden-execution wall", () => {
  test("the exact closed MIME vocabulary retains its declared disposition", () => {
    const allowedTypes = [
      ["text/plain", "inline", false],
      ["text/markdown", "inline", false],
      ["text/x-lean", "inline", false],
      ["text/x-python", "inline", false],
      ["text/x-csrc", "inline", false],
      ["text/x-typescript", "inline", false],
      ["text/x-log", "inline", false],
      ["application/json", "inline", false],
      ["application/gzip", "attachment", true],
    ] as const;

    for (const [type, disposition, isLakeArchive] of allowedTypes) {
      const verdict = decideArtifactAdmission({ sniffedType: type, sizeBytes: 100 });
      expect(verdict, type).toEqual({
        admitted: true,
        contentType: type,
        disposition,
        isLakeArchive,
      });
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

  test("Object.prototype names are not inherited into the closed allowlist", () => {
    for (const sniffedType of ["__proto__", "constructor", "prototype", "toString", "valueOf"]) {
      const verdict = decideArtifactAdmission({ sniffedType, sizeBytes: 10 });
      expect(verdict.admitted, sniffedType).toBe(false);
      if (!verdict.admitted) {
        expect(verdict.code, sniffedType).toBe("ARTIFACT_TYPE_NOT_ALLOWED");
        expect(verdict.reason, sniffedType).toContain(sniffedType);
      }
    }
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

  test("invalid server-observed sizes are refused before admission", () => {
    for (const sizeBytes of [
      -1,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const verdict = decideArtifactAdmission({ sniffedType: "text/plain", sizeBytes });
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.code).toBe("ARTIFACT_SIZE_INVALID");
    }
  });

  test("cheap doomed-upload checks run before the body secret scan", () => {
    for (const expected of [
      { sniffedType: "text/plain", sizeBytes: -1, code: "ARTIFACT_SIZE_INVALID" },
      { sniffedType: "text/html", sizeBytes: 1, code: "ARTIFACT_TYPE_FORBIDDEN" },
      { sniffedType: "application/x-unknown", sizeBytes: 1, code: "ARTIFACT_TYPE_NOT_ALLOWED" },
      {
        sniffedType: "text/plain",
        sizeBytes: MAX_ARTIFACT_BYTES + 1,
        code: "ARTIFACT_TOO_LARGE",
      },
    ] as const) {
      const input = Object.defineProperty(
        { sniffedType: expected.sniffedType, sizeBytes: expected.sizeBytes },
        "body",
        {
          enumerable: true,
          get(): string {
            throw new Error("body scan reached");
          },
        },
      );
      const verdict = decideArtifactAdmission(input);
      expect(verdict.admitted).toBe(false);
      if (!verdict.admitted) expect(verdict.code).toBe(expected.code);
    }
  });

  test("PLANTED: an otherwise admissible input reads its body once before scanning", () => {
    const firstBody = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    let reads = 0;
    const input = Object.defineProperty(
      { sniffedType: "text/plain", sizeBytes: firstBody.length },
      "body",
      {
        enumerable: true,
        get(): string {
          reads += 1;
          return reads === 1 ? firstBody : "clean replacement";
        },
      },
    );

    const verdict = decideArtifactAdmission(input);
    expect(reads).toBe(1);
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.code).toBe("ARTIFACT_SECRET_SHAPED");
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

  test("the scan reports every finding in deterministic location-and-kind order", () => {
    const first = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    const second = `asimp_ag_${"B".repeat(26)}_${"y".repeat(43)}`;
    const findings = scanBodyForSecrets(`first ${first}; second ${second}`);
    expect(findings).toEqual([
      { kind: "fellow-token", line: 1, column: 7 },
      { kind: "prefixed-grant", line: 1, column: 7 },
      { kind: "fellow-token", line: 1, column: 95 },
      { kind: "prefixed-grant", line: 1, column: 95 },
    ]);
  });

  test("a finding column counts code points, so an astral character shifts it by one", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    // `😀` is one code point but two UTF-16 units, so the token begins at
    // UTF-16 offset 3 and code point 2. The reported column is the code-point
    // one — 3, not the 4 a UTF-16 count would give — matching the unit
    // `casExtractFor` slices on, so a location a reader is asked to inspect
    // agrees with what they count.
    const findings = scanBodyForSecrets(`😀 ${token}`);
    expect(findings.filter((finding) => finding.kind === "fellow-token")).toEqual([
      { kind: "fellow-token", line: 1, column: 3 },
    ]);
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

  test("the early-exit wall stays equivalent to exhaustive diagnostics across calls", () => {
    const token = `asimp_ag_${"A".repeat(26)}_${"x".repeat(43)}`;
    for (const body of [
      "ordinary research prose",
      `first call ${token}`,
      "clean first line\ncontact: researcher@example.org",
    ]) {
      const expected = scanBodyForSecrets(body).length > 0;
      expect(bodyLooksSecretShaped(body)).toBe(expected);
      // The repeat is load-bearing: a future global/sticky regex would mutate
      // lastIndex and make the second observation disagree.
      expect(bodyLooksSecretShaped(body)).toBe(expected);
    }
  });
});

describe("archive safety bounds", () => {
  test("a decompression bomb beyond the exact 100:1 contract is refused without Number multiplication", () => {
    // This is the Fable acceptance contract, not the imported production
    // constant. A source ratio drift must make this boundary plant fail.
    const archiveRatioContract = 100;
    const nearSafeCompressed = Math.floor(Number.MAX_SAFE_INTEGER / archiveRatioContract);
    const exactBoundary = nearSafeCompressed * archiveRatioContract;
    expect(Number.isSafeInteger(exactBoundary)).toBe(true);
    expect(archiveExpansionIsBounded(nearSafeCompressed, exactBoundary)).toBe(true);
    expect(archiveExpansionIsBounded(nearSafeCompressed, exactBoundary + 1)).toBe(false);

    // The exact comparison must also accept an input whose ratio product is
    // beyond Number's safe-integer range; BigInt retains that comparison.
    const overflowingProductCompressed = Number.MAX_SAFE_INTEGER;
    expect(Number.isSafeInteger(overflowingProductCompressed * archiveRatioContract)).toBe(false);
    expect(BigInt(overflowingProductCompressed) * BigInt(archiveRatioContract)).toBeGreaterThan(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
    expect(archiveExpansionIsBounded(overflowingProductCompressed, Number.MAX_SAFE_INTEGER)).toBe(
      true,
    );
    expect(archiveExpansionIsBounded(0, 100)).toBe(false);
    for (const invalid of [
      -1,
      1.5,
      Number.NaN,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(archiveExpansionIsBounded(invalid, 100)).toBe(false);
      expect(archiveExpansionIsBounded(100, invalid)).toBe(false);
    }
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
  type UploadState,
  type UploadTransition,
  uploadMayBind,
  uploadStateIsTerminal,
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
    for (const state of ["declared", "presigned", "uploaded", "verified"] as const) {
      const step = stepUpload(state, "expire");
      expect(step.ok, state).toBe(true);
      if (step.ok) expect(step.state).toBe("expired");
    }
    expect(stepUpload("expired", "presign").ok).toBe(false);
  });

  test("a verified object cannot be re-uploaded or re-verified", () => {
    expect(stepUpload("verified", "upload").ok).toBe(false);
    expect(stepUpload("verified", "verify").ok).toBe(false);
  });

  test("every terminal state refuses every transition", () => {
    const transitions: readonly UploadTransition[] = [
      "presign",
      "upload",
      "verify",
      "bind",
      "expire",
      "mismatch",
    ];
    for (const state of ["bound", "expired", "quarantined"] as const) {
      expect(uploadStateIsTerminal(state)).toBe(true);
      for (const transition of transitions) {
        expect(stepUpload(state, transition).ok, `${transition} from ${state}`).toBe(false);
      }
    }
  });

  test("PLANTED: inherited state-machine keys are illegal runtime values", () => {
    const inheritedPairs = [
      ["constructor", "presign"],
      ["__proto__", "presign"],
      ["toString", "presign"],
      ["valueOf", "presign"],
      ["prototype", "constructor"],
    ] as const;

    for (const [state, transition] of inheritedPairs) {
      const step = stepUpload(
        state as unknown as UploadState,
        transition as unknown as UploadTransition,
      );
      expect(step.ok, `${transition} from ${state}`).toBe(false);
      if (!step.ok) expect(step.code).toBe("UPLOAD_TRANSITION_ILLEGAL");
    }

    expect(stepUpload("declared", "unknown" as unknown as UploadTransition).ok).toBe(false);
  });

  test("every non-terminal state reaches bound or a terminal refusal", () => {
    // Model-check the small graph: from each state, BFS to a terminal.
    const all: UploadState[] = ["declared", "presigned", "uploaded", "verified"];
    const transitions: UploadTransition[] = [
      "presign",
      "upload",
      "verify",
      "bind",
      "expire",
      "mismatch",
    ];
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

import {
  duplicateUploadKeepsPublicStatus,
  gcEligibility,
  type RetentionClass,
} from "../../src/krater/cas.ts";

describe("reference-aware GC eligibility (W2.7)", () => {
  // Independent retention contract, deliberately not imported from the GC
  // implementation: it is both the complete lawful-class universe and the
  // canonical order promised to callers.
  const retentionClasses: readonly RetentionClass[] = [
    "public",
    "licensed",
    "backup-restoration",
    "quarantine",
    "legal-hold",
    "private",
  ];

  function fullRetentionClassPermutations(
    remaining: readonly RetentionClass[],
  ): RetentionClass[][] {
    if (remaining.length === 0) return [[]];
    return remaining.flatMap((retentionClass, index) =>
      fullRetentionClassPermutations([
        ...remaining.slice(0, index),
        ...remaining.slice(index + 1),
      ]).map((tail) => [retentionClass, ...tail]),
    );
  }

  test("PLANTED: only no surviving reference is collectible; a private row preserves its bytes", () => {
    expect(gcEligibility([])).toEqual({
      eligible: true,
      reason: "no_lawful_reference_remains",
    });
    // This is the causal private-reference plant: deleting the private
    // predicate, or filtering to only non-private classes, makes it greenly
    // collect a still-referenced object and fails here.
    expect(gcEligibility(["private"])).toEqual({
      eligible: false,
      reason: "private_reference_remains",
      preservedFor: ["private"],
    });
  });

  test("PLANTED: an unknown runtime reference cannot be filtered into an empty collectible set", () => {
    for (const malformed of ["unknown", "", 7, null, undefined]) {
      expect(() => gcEligibility([malformed] as unknown as readonly RetentionClass[])).toThrow(
        "ARTIFACT_RETENTION_INVALID",
      );
    }
  });

  test("PLANTED: each surviving reference is read once before preservation", () => {
    let reads = 0;
    const remaining: RetentionClass[] = [];
    Object.defineProperty(remaining, 0, {
      enumerable: true,
      get(): RetentionClass {
        reads += 1;
        return (reads === 1 ? "public" : "unknown") as RetentionClass;
      },
    });

    expect(gcEligibility(remaining)).toEqual({
      eligible: false,
      reason: "public_bytes_stay_public",
      preservedFor: ["public"],
    });
    expect(reads).toBe(1);
  });

  test("public bytes are never collected, and stay public through a duplicate private upload", () => {
    const verdict = gcEligibility(["public", "private"]);
    expect(verdict.eligible).toBe(false);
    if (!verdict.eligible) {
      expect(verdict.reason).toBe("public_bytes_stay_public");
      expect(verdict.preservedFor).toEqual(["public", "private"]);
    }
    // The privacy rule: an existing public hash is not made private by a
    // duplicate workshop upload.
    expect(duplicateUploadKeepsPublicStatus(["public"])).toBe(true);
    expect(duplicateUploadKeepsPublicStatus(["private"])).toBe(false);
  });

  test("each retention reason is exact and outranks every lower preservation class", () => {
    // Each row gives a class all lower-priority rivals. A reordered, omitted,
    // or fallback reason therefore fails rather than merely proving non-GC.
    expect(gcEligibility(["private", "backup-restoration"])).toEqual({
      eligible: false,
      reason: "backup_restoration_reference_remains",
      preservedFor: ["backup-restoration", "private"],
    });
    expect(gcEligibility(["private", "backup-restoration", "licensed"])).toEqual({
      eligible: false,
      reason: "licensed_reference_remains",
      preservedFor: ["licensed", "backup-restoration", "private"],
    });
    expect(gcEligibility(["private", "backup-restoration", "licensed", "public"])).toEqual({
      eligible: false,
      reason: "public_bytes_stay_public",
      preservedFor: ["public", "licensed", "backup-restoration", "private"],
    });
    expect(
      gcEligibility(["private", "backup-restoration", "licensed", "public", "quarantine"]),
    ).toEqual({
      eligible: false,
      reason: "quarantine_hold",
      preservedFor: ["public", "licensed", "backup-restoration", "quarantine", "private"],
    });
    expect(
      gcEligibility([
        "private",
        "backup-restoration",
        "licensed",
        "public",
        "quarantine",
        "legal-hold",
      ]),
    ).toEqual({
      eligible: false,
      reason: "legal_hold",
      preservedFor: [
        "public",
        "licensed",
        "backup-restoration",
        "quarantine",
        "legal-hold",
        "private",
      ],
    });
  });

  test("all full-class permutations dedupe to the one canonical preserved order", () => {
    const permutations = fullRetentionClassPermutations(retentionClasses);
    expect(permutations).toHaveLength(720);
    const expected = {
      eligible: false,
      reason: "legal_hold",
      preservedFor: retentionClasses,
    } as const;
    for (const permutation of permutations) {
      expect(
        gcEligibility(permutation.flatMap((retentionClass) => [retentionClass, retentionClass])),
      ).toEqual(expected);
    }
  });

  test("every class combination preserves exactly its surviving lawful references", () => {
    // The full power set: 64 combinations, each must return a lawful verdict.
    for (let mask = 0; mask < 64; mask += 1) {
      const subset = retentionClasses.filter((_, i) => (mask & (1 << i)) !== 0);
      const verdict = gcEligibility(subset);
      expect(verdict.eligible).toBe(subset.length === 0);
      if (!verdict.eligible) expect(verdict.preservedFor).toEqual(subset);
    }
  });
});

import {
  type ArtifactIndexRow,
  type InventoryDivergence,
  reconcileArtifactInventory,
} from "../../src/krater/cas.ts";

describe("artifact inventory reconciliation (W2.7)", () => {
  const uploadStateContract: readonly ArtifactIndexRow["state"][] = [
    "declared",
    "presigned",
    "uploaded",
    "verified",
    "bound",
    "expired",
    "quarantined",
  ];

  test("an empty inventory with no objects is clean", () => {
    expect(reconcileArtifactInventory([], [])).toEqual([]);
  });

  test("an orphan object (no index row) is reported, never silently deleted", () => {
    const divergences = reconcileArtifactInventory([], [HASH_A]);
    expect(divergences).toEqual([{ kind: "orphan_object", digest: HASH_A }]);
  });

  test("a bound row with no object is a missing-object corruption signal", () => {
    const rows: ArtifactIndexRow[] = [{ digest: HASH_B, state: "bound" }];
    const divergences = reconcileArtifactInventory(rows, []);
    expect(divergences).toEqual([{ kind: "missing_object", digest: HASH_B }]);
  });

  test("a verified/uploaded row with no object is a state mismatch", () => {
    const rows: ArtifactIndexRow[] = [
      { digest: HASH_A, state: "verified" },
      { digest: HASH_B, state: "uploaded" },
    ];
    const divergences = reconcileArtifactInventory(rows, []);
    expect(divergences.map((d) => d.kind)).toEqual(["state_mismatch", "state_mismatch"]);
  });

  test("an object present for a row that never uploaded is a state mismatch", () => {
    const rows: ArtifactIndexRow[] = [{ digest: HASH_A, state: "declared" }];
    const divergences = reconcileArtifactInventory(rows, [HASH_A]);
    expect(divergences).toEqual([{ kind: "state_mismatch", digest: HASH_A, state: "declared" }]);
  });

  test("a consistent inventory reports nothing", () => {
    const rows: ArtifactIndexRow[] = [
      { digest: HASH_A, state: "bound" },
      { digest: HASH_B, state: "declared" },
    ];
    expect(reconcileArtifactInventory(rows, [HASH_A])).toEqual([]);
  });

  test("PLANTED: contradictory same-digest rows are all reported independent of row order", () => {
    const rows: ArtifactIndexRow[] = [
      { digest: HASH_A, state: "bound" },
      { digest: HASH_A, state: "uploaded" },
      { digest: HASH_A, state: "verified" },
    ];
    const expected: readonly InventoryDivergence[] = [
      { kind: "missing_object", digest: HASH_A },
      { kind: "state_mismatch", digest: HASH_A, state: "uploaded" },
      { kind: "state_mismatch", digest: HASH_A, state: "verified" },
    ];

    expect(reconcileArtifactInventory(rows, [])).toEqual(expected);
    expect(reconcileArtifactInventory([...rows].reverse(), [])).toEqual(expected);
  });

  test("PLANTED: duplicate rows and object-list entries do not duplicate one divergence", () => {
    const duplicateBoundRows: ArtifactIndexRow[] = [
      { digest: HASH_A, state: "bound" },
      { digest: HASH_A, state: "bound" },
    ];
    expect(reconcileArtifactInventory(duplicateBoundRows, [HASH_A, HASH_A])).toEqual([]);
    expect(reconcileArtifactInventory(duplicateBoundRows, [])).toEqual([
      { kind: "missing_object", digest: HASH_A },
    ]);
  });

  test("PLANTED: a present object cannot hide a declared row behind a bound row", () => {
    const rows: ArtifactIndexRow[] = [
      { digest: HASH_A, state: "declared" },
      { digest: HASH_A, state: "bound" },
    ];
    const expected: readonly InventoryDivergence[] = [
      { kind: "state_mismatch", digest: HASH_A, state: "declared" },
    ];
    expect(reconcileArtifactInventory(rows, [HASH_A])).toEqual(expected);
    expect(reconcileArtifactInventory([...rows].reverse(), [HASH_A])).toEqual(expected);
  });

  test("PLANTED: every same-digest state pair is order- and duplicate-independent", () => {
    for (const left of uploadStateContract) {
      for (const right of uploadStateContract) {
        const states = new Set([left, right]);
        const rows: ArtifactIndexRow[] = [
          { digest: HASH_A, state: left },
          { digest: HASH_A, state: right },
        ];
        for (const present of [false, true]) {
          const observed = present ? [HASH_A] : [];
          const expected: readonly InventoryDivergence[] = present
            ? states.has("declared")
              ? [{ kind: "state_mismatch", digest: HASH_A, state: "declared" }]
              : []
            : [
                ...(states.has("bound")
                  ? [{ kind: "missing_object" as const, digest: HASH_A }]
                  : []),
                ...(["uploaded", "verified"] as const)
                  .filter((state) => states.has(state))
                  .map((state) => ({ kind: "state_mismatch" as const, digest: HASH_A, state })),
              ];

          expect(reconcileArtifactInventory(rows, observed)).toEqual(expected);
          expect(reconcileArtifactInventory([...rows].reverse(), observed)).toEqual(expected);
          expect(reconcileArtifactInventory([...rows, ...rows], observed)).toEqual(expected);
        }
      }
    }
  });

  test("malformed runtime inventory data is refused instead of producing a partial report", () => {
    const malformedRows = [
      [{ digest: HASH_A.toUpperCase(), state: "bound" }],
      [{ digest: HASH_A, state: "unknown" }],
      [{ digest: HASH_A }],
      [{ state: "bound" }],
      [{ digest: 7, state: "bound" }],
      [{ digest: HASH_A, state: 7 }],
      [42],
      [null],
    ] as const;
    for (const rows of malformedRows) {
      expect(() =>
        reconcileArtifactInventory(rows as unknown as readonly ArtifactIndexRow[], []),
      ).toThrow("ARTIFACT_INVENTORY_INVALID");
    }
    for (const digest of ["", "not-a-digest", HASH_A.toUpperCase(), HASH_A.slice(1)]) {
      expect(() => reconcileArtifactInventory([], [digest])).toThrow("ARTIFACT_INVENTORY_INVALID");
    }
  });

  test("PLANTED: inventory row fields are each snapshotted once", () => {
    let digestReads = 0;
    const digestRow = Object.defineProperty({ state: "bound" as const }, "digest", {
      enumerable: true,
      get(): string {
        digestReads += 1;
        return digestReads === 1 ? HASH_A : HASH_B;
      },
    }) as ArtifactIndexRow;
    expect(reconcileArtifactInventory([digestRow], [])).toEqual([
      { kind: "missing_object", digest: HASH_A },
    ]);
    expect(digestReads).toBe(1);

    let stateReads = 0;
    const stateRow = Object.defineProperty({ digest: HASH_A }, "state", {
      enumerable: true,
      get(): ArtifactIndexRow["state"] {
        stateReads += 1;
        return stateReads === 1 ? "bound" : "declared";
      },
    }) as ArtifactIndexRow;
    expect(reconcileArtifactInventory([stateRow], [])).toEqual([
      { kind: "missing_object", digest: HASH_A },
    ]);
    expect(stateReads).toBe(1);
  });

  test("every seeded divergence is detected across a mixed inventory", () => {
    const rows: ArtifactIndexRow[] = [
      { digest: HASH_A, state: "bound" }, // present
      { digest: HASH_B, state: "bound" }, // missing
    ];
    const observed = [HASH_A, "c".repeat(64)]; // HASH_A present, orphan 'c…'
    const divergences = reconcileArtifactInventory(rows, observed);
    const kinds = divergences.map((d) => d.kind).sort();
    expect(kinds).toEqual(["missing_object", "orphan_object"]);
  });

  test("the report is deterministically ordered for diffability", () => {
    const rows: ArtifactIndexRow[] = [
      { digest: HASH_B, state: "bound" },
      { digest: HASH_A, state: "declared" },
    ];
    const observed = [HASH_A, "c".repeat(64), "d".repeat(64)];
    const first = reconcileArtifactInventory(rows, observed);
    const second = reconcileArtifactInventory([...rows].reverse(), [...observed].reverse());
    expect(first).toEqual(second);
    const digests = first.map((d) => d.digest);
    expect(digests).toEqual([...digests].sort());
  });
});
