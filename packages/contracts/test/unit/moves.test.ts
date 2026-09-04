import { describe, expect, test } from "bun:test";
import {
  generateMoveTemplatesDocument,
  getMoveTemplate,
  MOVE_KINDS,
  MOVE_TEMPLATES,
  MoveTemplatesDocSchema,
} from "../../src/moves.ts";

describe("Move Templates registry", () => {
  test("defines the full 18-move vocabulary from Fable §9.4", () => {
    expect(MOVE_KINDS.length).toBe(18);
    expect(MOVE_KINDS).toContain("sharpen-statement");
    expect(MOVE_KINDS).toContain("state-claim");
    expect(MOVE_KINDS).toContain("add-refuter");
    expect(MOVE_KINDS).toContain("review");
    expect(MOVE_KINDS).toContain("third-alternative");
    expect(MOVE_KINDS).toContain("discriminate");
    expect(MOVE_KINDS).toContain("kill-or-stand");
    expect(MOVE_KINDS).toContain("collapse-duplicate");
    expect(MOVE_KINDS).toContain("re-anchor");
    expect(MOVE_KINDS).toContain("record-dead-end");
    expect(MOVE_KINDS).toContain("synthesize");
    expect(MOVE_KINDS).toContain("formalize");
    expect(MOVE_KINDS).toContain("add-refuter-from-friction");
    expect(MOVE_KINDS).toContain("close-gap");
    expect(MOVE_KINDS).toContain("normalize-conflict");
    expect(MOVE_KINDS).toContain("retry-dead-end");
    expect(MOVE_KINDS).toContain("back-to-the-object");
    expect(MOVE_KINDS).toContain("idle-close");
  });

  test("generates a document conforming to MoveTemplatesDocSchema", () => {
    const doc = generateMoveTemplatesDocument();
    const parsed = MoveTemplatesDocSchema.safeParse(doc);
    expect(parsed.success).toBe(true);
    expect(doc.version).toBe("0.1.0-draft");
    expect(doc.schema).toBe("https://a.asimposium.org/schemas/moves.v1.json");
    for (const kind of MOVE_KINDS) {
      expect(doc.moves[kind]).toBeDefined();
    }
  });

  test("getMoveTemplate returns the template or throws on unknown", () => {
    const sharpen = getMoveTemplate("sharpen-statement");
    expect(sharpen.move).toBe("sharpen-statement");
    expect(sharpen.target_contract).toContain("problem.v1.json");

    expect(() => getMoveTemplate("nonexistent" as never)).toThrow("UNKNOWN_MOVE_KIND");
  });

  test("all move templates have non-empty title, trigger, description, target_contract, and required_fields", () => {
    for (const kind of MOVE_KINDS) {
      const template = MOVE_TEMPLATES[kind];
      expect(template.title.length).toBeGreaterThan(0);
      expect(template.trigger.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.target_contract.length).toBeGreaterThan(0);
      expect(template.required_fields.length).toBeGreaterThan(0);
    }
  });
});
