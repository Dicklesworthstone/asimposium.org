import { describe, expect, test } from "bun:test";
import { HealthBindingName, INTERNAL_HEALTH_SCHEMA_ID } from "@asimposium/contracts";
import Ajv2020 from "ajv/dist/2020";
import { createApp } from "../../src/app";
import { REQUIRED_BINDINGS } from "../../src/env";
import { HEALTH_SCHEMA } from "../../src/http/health";
import { boundEnv } from "../support/bindings";

/**
 * asimposiumorg-261q: the health success envelope advertises
 * /schemas/internal.health.v1.json; that document must actually be served,
 * must accept the exact body the route emits, and must refuse drift in both
 * directions (producer shape vs registry face).
 */

const SCHEMA_PATH = new URL(INTERNAL_HEALTH_SCHEMA_ID).pathname;

type WorkerReply = {
  status: number;
  contentType: string;
  bodyText: string;
  body: unknown;
};

async function callWorker(path: string): Promise<WorkerReply> {
  const app = createApp();
  const response = await app.fetch(new Request(`https://a.asimposium.org${path}`), boundEnv());
  const bodyText = await response.text();
  let body: unknown = bodyText;
  try {
    body = JSON.parse(bodyText) as unknown;
  } catch {
    // non-JSON replies stay text
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bodyText,
    body,
  };
}

function stripKey(object: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = structuredClone(object);
  delete clone[key];
  return clone;
}

describe("GET /schemas/internal.health.v1.json", () => {
  test("is served by the mounted Worker as application/schema+json", async () => {
    const res = await callWorker(SCHEMA_PATH);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/schema+json; charset=utf-8");
  });

  test("accepts the exact body the mounted health route emits", async () => {
    const schemaRes = await callWorker(SCHEMA_PATH);
    const servedDocument = schemaRes.bodyText;

    const health = await callWorker("/internal/health");
    expect(health.status).toBe(200);

    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(JSON.parse(servedDocument));
    const valid = validate(health.body);

    expect(valid).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  test("rejects drifted producer shapes against the served document", async () => {
    const schemaRes = await callWorker(SCHEMA_PATH);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(JSON.parse(schemaRes.bodyText));

    const goodBody = (await callWorker("/internal/health")).body as Record<string, unknown>;
    const goodData = structuredClone(goodBody.data) as Record<string, unknown>;
    const negatives: Array<Record<string, unknown>> = [
      // missing field
      stripKey(goodBody, "ok"),
      // extra field
      { ...structuredClone(goodBody), surprise: true },
      // wrong type
      { ...structuredClone(goodBody), ok: "yes" },
      // wrong binding state
      {
        ...structuredClone(goodBody),
        data: {
          ...goodData,
          bindings: { ...(goodData.bindings as Record<string, unknown>), DB: "maybe" },
        },
      },
      // self-referential constant drift: advertised id no longer matches
      {
        ...structuredClone(goodBody),
        schema: "https://a.asimposium.org/schemas/internal.health.v2.json",
      },
    ];
    for (const negative of negatives) {
      expect(validate(negative)).toBe(false);
    }
  });

  test("pins the producer constant to the registry identity and the topology bindings", () => {
    // Self-referential constants: handler literal == contract $id == served path name.
    expect(HEALTH_SCHEMA).toBe(INTERNAL_HEALTH_SCHEMA_ID);
    expect(HEALTH_SCHEMA.endsWith("/schemas/internal.health.v1.json")).toBe(true);
    // Producer/registry drift guard: the contracts binding enum must equal the
    // Worker's REQUIRED_BINDINGS exactly, in order.
    expect([...HealthBindingName.options]).toEqual([...REQUIRED_BINDINGS]);
  });
});
