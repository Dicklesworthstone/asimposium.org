import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  generateMoveTemplatesDocument,
  getMoveTemplate,
  MOVE_KINDS,
  MOVE_TEMPLATES,
  MoveTemplateSchema,
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
    expect(doc.scope).toBe("catalog");
    for (const kind of MOVE_KINDS) {
      expect(doc.moves[kind]).toBeDefined();
    }
  });

  test("getMoveTemplate returns the template or throws on unknown", () => {
    const sharpen = getMoveTemplate("sharpen-statement");
    expect(sharpen.move).toBe("sharpen-statement");
    expect(sharpen.availability).toBe("unavailable");
    expect(sharpen).not.toHaveProperty("request");

    expect(() => getMoveTemplate("nonexistent" as never)).toThrow("UNKNOWN_MOVE_KIND");
  });

  test("all templates preserve their identity and disclose request availability", () => {
    let available = 0;
    for (const kind of MOVE_KINDS) {
      const template = MOVE_TEMPLATES[kind];
      expect(template.title.length).toBeGreaterThan(0);
      expect(template.trigger.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
      expect(template.move).toBe(kind);
      if (template.availability === "available") {
        available++;
        expect(template.target_contract).toStartWith("/schemas/sessions.v1.json#/properties/");
        expect(template.required_fields.length).toBeGreaterThan(0);
        expect(new Set(template.required_fields).size).toBe(template.required_fields.length);
        expect(template.request.auth).toBe("fellow-bearer");
        expect(template.request.idempotency_key_required).toBe(true);
      } else {
        expect(template.unavailable_reason.length).toBeGreaterThan(0);
        expect(template.next_step.length).toBeGreaterThan(0);
        expect(template).not.toHaveProperty("request");
        expect(template).not.toHaveProperty("target_contract");
        expect(template).not.toHaveProperty("prefilled_hints");
      }
    }
    expect(available).toBe(10);
  });

  test("golden availability fixtures agree in strict Zod and served JSON Schema", async () => {
    const document = await Bun.file(
      new URL("../../generated/moves.schema.json", import.meta.url),
    ).json();
    // Zod's enum record uses required + propertyNames + additionalProperties.
    // JSON Schema permits that shape without a separate properties roster.
    const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
    const validate = ajv.compile(document.properties.moves.additionalProperties);
    for (const [directory, name, expected, code] of [
      ["valid", "move-available", true, undefined],
      ["valid", "move-unavailable", true, undefined],
      ["invalid", "move-unavailable-action", false, "unrecognized_keys"],
      ["invalid", "move-available-missing-request", false, "invalid_type"],
    ] as const) {
      const value = await Bun.file(
        new URL(`../fixtures/${directory}/${name}.json`, import.meta.url),
      ).json();
      const parsed = MoveTemplateSchema.safeParse(value);
      expect(parsed.success, name).toBe(expected);
      expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`).toBe(expected);
      if (!parsed.success)
        expect(parsed.error.issues.some((issue) => issue.code === code)).toBe(true);
    }
    const catalog = generateMoveTemplatesDocument();
    expect(ajv.compile(document)(catalog)).toBe(true);
    const unknown = { ...catalog, moves: { ...catalog.moves, invented: catalog.moves.review } };
    expect(MoveTemplatesDocSchema.safeParse(unknown).success).toBe(false);
    expect(ajv.compile(document)(unknown)).toBe(false);
    const { review: _review, ...incompleteMoves } = catalog.moves;
    const incomplete = { ...catalog, moves: incompleteMoves };
    expect(MoveTemplatesDocSchema.safeParse(incomplete).success).toBe(false);
    expect(ajv.compile(document)(incomplete)).toBe(false);
    const available = catalog.moves["idle-close"];
    expect(
      MoveTemplateSchema.safeParse({ ...available, availability: "unavailable" }).success,
    ).toBe(false);
  });
});
