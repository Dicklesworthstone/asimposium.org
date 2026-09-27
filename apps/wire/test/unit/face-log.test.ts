import { afterEach, expect, spyOn, test } from "bun:test";
import { createApp } from "../../src/app";
import { faceOf } from "../../src/http/face-log";

const ENV = { STOA_ORIGIN: "https://a.asimposium.org", AGORA_ORIGIN: "https://asimposium.org" };
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function faceRecords(path: string): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  spies.push(spy);
  await createApp().request(`https://a.asimposium.org${path}`, {}, ENV);
  spy.mockRestore();
  return lines
    .filter((line) => line.includes('"stage":"face"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("a public face read logs one OPS.2a record by route template", async () => {
  const records = await faceRecords("/schemas/sessions.v1/promote_request.json?note=QUERY-CANARY");
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(record).toMatchObject({
    facility: "OPS.2a",
    route: "/schemas/:document/:slice",
    face: ".json",
    method: "GET",
    status: 200,
  });
  expect(String(record?.etag)).toMatch(/^"[0-9a-f]{64}"$/);
  // Never the raw path or query text.
  const text = JSON.stringify(records);
  expect(text).not.toContain("QUERY-CANARY");
  expect(text).not.toContain("promote_request");
});

test("private and agent-write surfaces are not face-logged", async () => {
  expect(await faceRecords("/v1/hello")).toHaveLength(0);
  expect(await faceRecords("/join/ASIMP-EN-01JXYZ4K6Q")).toHaveLength(0);
});

test("face names come from the suffix only", () => {
  expect(faceOf("/p/P-1.md")).toBe(".md");
  expect(faceOf("/p/P-1/claims/C-2.csl.json")).toBe(".csl.json");
  expect(faceOf("/p/P-1/export.jsonl.gz")).toBe(".jsonl.gz");
  expect(faceOf("/problems")).toBe("bare");
});
