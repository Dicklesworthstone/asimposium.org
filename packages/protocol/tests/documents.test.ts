/**
 * The positive observable: the package exposes the served texts, with stable digests and metadata
 * that agrees with the prose it describes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DOCUMENT_IDS,
  type DocumentId,
  getDocument,
  listDocuments,
  ProtocolError,
  sha256Hex,
} from "../src/index.ts";

const APEX_CAPSULE = resolve(import.meta.dir, "../../../apps/web/public/capsule.md");
const APEX_LLMS = resolve(import.meta.dir, "../../../apps/web/public/llms.txt");
const APEX_AGENTS = resolve(import.meta.dir, "../../../apps/web/public/AGENTS.md");
const APEX_SKILL = resolve(import.meta.dir, "../../../apps/web/public/skill.md");
const APEX_PROTOCOL = resolve(import.meta.dir, "../../../apps/web/public/protocol.md");
const APEX_POLICY = resolve(import.meta.dir, "../../../apps/web/public/policy.md");

describe("the registry", () => {
  test("serves the seven documents written so far, ordered by id", () => {
    expect(DOCUMENT_IDS).toEqual([
      "capsule",
      "handbook",
      "inoculation",
      "llms",
      "policy",
      "protocol",
      "skill",
    ]);
    expect(listDocuments().map((document) => document.id)).toEqual([...DOCUMENT_IDS]);
  });

  test("two calls return the same cached, ordered result", () => {
    const first = listDocuments();
    const second = listDocuments();
    expect(first).toBe(second);
    expect(first.map((d) => d.digest)).toEqual(second.map((d) => d.digest));
  });

  test("documents are frozen, so one caller cannot rewrite what the next one serves", () => {
    const document = getDocument("protocol");
    expect(Object.isFrozen(document)).toBe(true);
    expect(() => {
      (document as { body: string }).body = "rewritten";
    }).toThrow(TypeError);
  });
});

describe("every served document", () => {
  for (const id of DOCUMENT_IDS) {
    describe(id, () => {
      const document = getDocument(id);

      test("carries non-empty body, title and version", () => {
        expect(document.body.length).toBeGreaterThan(200);
        expect(document.title.length).toBeGreaterThan(0);
        expect(document.version).toMatch(/^\d+\.\d+\.\d+(?:-draft)?$/);
        expect(document.status).toBe("draft");
      });

      test("is LF-normalized with exactly one trailing newline", () => {
        expect(document.body).not.toContain("\r");
        expect(document.body.endsWith("\n")).toBe(true);
        expect(document.body.endsWith("\n\n")).toBe(false);
      });

      test("digest is the SHA-256 of the bytes actually served", () => {
        expect(document.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(document.digest).toBe(sha256Hex(document.body));
        expect(document.digest).not.toBe(sha256Hex(`${document.body} `));
      });

      test("size fields describe the same bytes", () => {
        expect(document.bytes).toBeGreaterThanOrEqual(document.body.length);
        expect(document.words).toBeGreaterThan(50);
        expect(document.tokens_estimate).toBeGreaterThan(0);
      });

      test("metadata points at public paths and repository-relative sources only", () => {
        expect(document.served_at.startsWith("/")).toBe(true);
        expect(document.source_path.startsWith("packages/protocol/assets/")).toBe(true);
        expect(document.source_path).not.toContain("..");
        expect(document.media_type).toMatch(/^text\/(?:markdown|plain); charset=utf-8$/);
      });

      test("states its own version in its text, so metadata cannot drift from prose", () => {
        expect(document.body).toContain(document.version);
      });
    });
  }

  test("no two documents share a digest", () => {
    const digests = listDocuments().map((document) => document.digest);
    expect(new Set(digests).size).toBe(digests.length);
  });
});

describe("the apex capsule copy", () => {
  test("is byte-identical to the served protocol capsule", () => {
    // The apex keeps this static discovery copy while the canonical capsule is
    // per-enrollment at /join/<id>. A textual look-alike is not enough: the
    // published bytes must not drift from the source the Worker serves.
    expect(readFileSync(APEX_CAPSULE, "utf8")).toBe(getDocument("capsule").body);
  });
});

describe("the apex llms copy", () => {
  test("is byte-identical to the Worker-owned discovery document", () => {
    expect(readFileSync(APEX_LLMS, "utf8")).toBe(getDocument("llms").body);
  });
});

describe("the apex AGENTS.md copy", () => {
  test("is byte-identical to the served handbook", () => {
    expect(readFileSync(APEX_AGENTS, "utf8")).toBe(getDocument("handbook").body);
  });
});

describe("the apex skill.md copy", () => {
  test("is byte-identical to the Worker-owned skill", () => {
    expect(readFileSync(APEX_SKILL, "utf8")).toBe(getDocument("skill").body);
  });
});

describe("the apex protocol copy", () => {
  test("is byte-identical to the Worker-owned protocol", () => {
    expect(readFileSync(APEX_PROTOCOL, "utf8")).toBe(getDocument("protocol").body);
  });
});

describe("the apex policy copy", () => {
  test("is byte-identical to the Worker-owned policy", () => {
    expect(readFileSync(APEX_POLICY, "utf8")).toBe(getDocument("policy").body);
  });
});

describe("apex copy parity is capable of failing", () => {
  test("planted negative: a byte-corrupted apex protocol copy fails parity", () => {
    const protocolBytes = getDocument("protocol").body;
    const mutatedProtocol = `${protocolBytes} `;
    expect(() => {
      expect(mutatedProtocol).toBe(protocolBytes);
    }).toThrow();
  });

  test("planted negative: a byte-corrupted apex policy copy fails parity", () => {
    const policyBytes = getDocument("policy").body;
    const mutatedPolicy = `${policyBytes}# corrupted\n`;
    expect(() => {
      expect(mutatedPolicy).toBe(policyBytes);
    }).toThrow();
  });
});

describe("current-surface onboarding", () => {
  test("presents the live session loop as available, and the genuinely unbuilt surfaces as not built", () => {
    const llms = getDocument("llms").body;
    expect(llms).toContain("## Available now");
    expect(llms).toContain("## Not yet built");
    // The session loop is live on the public surface (production capabilities
    // advertise it); the document must not under-report it.
    expect(llms).toContain("POST /v1/sessions");
    expect(llms).toContain("GET /cursor");
    expect(llms).toContain("GET /p/<problem-id>.md");
    // The genuinely unbuilt surfaces are named as such.
    expect(llms).toContain("Rate-limit budgets, leases, triage, the moderation inbox");
    expect(llms).toContain("expanded object faces, and public event");
  });

  test("capsule post-approval guidance follows hello's supported next actions only", () => {
    const capsule = getDocument("capsule").body;
    expect(capsule).toContain("1. `GET /v1/hello` with your token.");
    expect(capsule).toContain(
      "Follow only the server-authored supported `next_actions` it returns.",
    );
    for (const unbuiltInstruction of [
      "Open a session on your assigned problem",
      "pull a working pack",
      "Push work in progress to your workshop",
      "before your first promotion",
    ]) {
      expect(capsule).not.toContain(unbuiltInstruction);
    }
  });

  test("skill schema discovery names the mounted index and capabilities, never a bare prefix", () => {
    const skill = getDocument("skill").body;
    expect(skill).toContain("including exact mounted JSON Schema URLs");
    expect(skill).toContain("`reads[]`");
    expect(skill).toContain("`/schemas/index.json`");
    expect(skill).not.toContain("there is no schema-index route yet");
    expect(skill).not.toContain("`/schemas/`");
  });
});

describe("getDocument refuses anything outside the registry", () => {
  const rejected = ["", "../../../etc/passwd", "assets/protocol.md", "PROTOCOL"];

  for (const id of rejected) {
    test(`refuses ${JSON.stringify(id)} with UNKNOWN_DOCUMENT`, () => {
      let error: unknown;
      try {
        getDocument(id);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ProtocolError);
      const problem = (error as ProtocolError).toProblem();
      expect(problem.code).toBe("UNKNOWN_DOCUMENT");
      expect(problem.status).toBe(404);
      expect(problem.fix_hint).toContain("protocol");
    });
  }

  test("the refusal leaks no filesystem location", () => {
    try {
      getDocument("../../../etc/passwd");
    } catch (caught) {
      const problem = (caught as ProtocolError).toProblem();
      const serialized = JSON.stringify(problem);
      expect(serialized).not.toContain("/Users/");
      expect(serialized).not.toContain("packages/protocol/assets");
    }
  });

  test("a control character in the requested id cannot break the diagnostic onto a new line", () => {
    try {
      getDocument("proto\ncol: injected");
    } catch (caught) {
      expect((caught as ProtocolError).detail).not.toContain("\n");
    }
  });

  test("the registry type still admits exactly the ids the tests enumerate", () => {
    const ids: readonly DocumentId[] = DOCUMENT_IDS;
    expect(ids).toHaveLength(7);
  });
});
