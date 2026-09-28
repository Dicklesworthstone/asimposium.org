import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApp } from "../../src/app";
import { varyOnAccept } from "../../src/http/vary";

const ENV = { STOA_ORIGIN: "https://a.asimposium.org", AGORA_ORIGIN: "https://asimposium.org" };

test("a negotiated spelling varies on Accept; a suffixed face does not", async () => {
  const app = createApp();
  const md = await app.request(
    "https://a.asimposium.org/moves",
    { headers: { accept: "text/markdown" } },
    ENV,
  );
  const json = await app.request(
    "https://a.asimposium.org/moves",
    { headers: { accept: "application/json" } },
    ENV,
  );
  // The same URL really does return two representations...
  expect(md.headers.get("content-type")).toStartWith("text/markdown");
  expect(json.headers.get("content-type")).toStartWith("application/json");
  // ...so a shared cache must key on Accept.
  expect(md.headers.get("vary")).toContain("Accept");
  expect(json.headers.get("vary")).toContain("Accept");
  const suffixed = await app.request("https://a.asimposium.org/moves.json", {}, ENV);
  expect(suffixed.headers.get("vary")).toBeNull();
});

test("an existing Vary is extended once, never duplicated", async () => {
  const app = new Hono();
  app.use("*", varyOnAccept);
  app.get("/a", () => new Response("x", { headers: { vary: "Origin" } }));
  app.get("/b", () => new Response("x", { headers: { vary: "accept, Origin" } }));
  app.get("/c", () => new Response("x", { status: 404 }));
  expect((await app.request("/a")).headers.get("vary")).toBe("Origin, Accept");
  expect((await app.request("/b")).headers.get("vary")).toBe("accept, Origin");
  expect((await app.request("/c")).headers.get("vary")).toBeNull();
});
