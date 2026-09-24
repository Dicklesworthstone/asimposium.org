import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderEnvironment } from "./generate-wrangler.mjs";

const policy = {
  required_r2_roles: ["private-cas", "public-delivery"],
  deferred_bindings: [],
  outbox_cron: "*/5 * * * *",
};

/** Frozen renderer fixtures, not cloud resources or provider inventory. */
function environment(name) {
  const local = name === "local";
  const suffix = name === "production" ? "prod" : name;
  return {
    kind: local ? "local" : "remote",
    worker_origin: local ? "http://127.0.0.1:8787"
      : name === "staging" ? "https://a-staging.asimposium.org" : "https://a.asimposium.org",
    agora_origin: name === "staging" ? "https://staging.asimposium.org" : "https://asimposium.org",
    d1: {
      binding: "DB", database_name: `asimposium-${suffix}`,
      database_id: local ? "00000000-0000-0000-0000-000000000000"
        : `\${ASIMP_D1_DATABASE_ID_${name.toUpperCase()}}`,
    },
    r2: [
      { role: "private-cas", binding: "ARTIFACTS", bucket_name: `asimposium-artifacts-${suffix}` },
      { role: "public-delivery", binding: "PUBLIC_ARTIFACTS", bucket_name: `asimposium-public-${suffix}` },
    ],
    durable_objects: { binding: "HERALD_ROOMS", class_name: "HeraldRoom",
      script_namespace: `asimposium-stoa-${suffix}`, storage: "sqlite" },
    outbox: { binding: "KRATER_OUTBOX", class_name: "KraterOutboxDrainer", storage: "sqlite" },
    ...(local ? {} : { ai: { binding: "AI" } }),
    published_hostname: local ? "" : name === "staging" ? "artifacts-staging.asimposium.org" : "artifacts.asimposium.org",
    key_ids: local ? ["local-dev-1"] : [`${suffix}-2026-08`, `${suffix}-2026-07`],
    service_envelope_key_ids: local ? ["local-svc-1"] : [`${suffix}-svc-2026-08`, `${suffix}-svc-2026-07`],
  };
}

for (const name of ["local", "staging", "production"]) {
  test(`${name} regeneration retains event-wait cancellation and current configuration`, () => {
    const rendered = renderEnvironment(name, environment(name), policy);
    const checkedIn = readFileSync(new URL(`./environments/${name}.wrangler.toml`, import.meta.url), "utf8");
    assert.equal(rendered, checkedIn);
    assert.deepEqual(Bun.TOML.parse(rendered).compatibility_flags, ["nodejs_compat", "enable_request_signal"]);
  });
}

// Generated configs bind HeraldRoom together with its export, because the Worker
// entrypoint exports the class (the deferral was retired with that export).
for (const path of ["environments/local.wrangler.toml",
  "environments/staging.wrangler.toml", "environments/production.wrangler.toml"]) {
  test(`${path} enables incoming request cancellation and binds exported rooms`, () => {
    const config = Bun.TOML.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    assert.deepEqual(config.compatibility_flags, ["nodejs_compat", "enable_request_signal"]);
    assert.equal(config.workers_dev, false);
    assert.equal(config.durable_objects.bindings.some((binding) =>
      binding.name === "HERALD_ROOMS" && binding.class_name === "HeraldRoom"), true);
    assert.equal(config.exports?.HeraldRoom?.type, "durable-object");
  });
}

// The scaffold config and the hand-resolved production deploy overlay keep rooms
// unbound until a staging deploy proves room delivery (asimposiumorg-rs5n, kzq).
for (const path of ["wrangler.toml", "environments/production.deploy.wrangler.toml"]) {
  test(`${path} enables incoming request cancellation without binding rooms before staging proof`, () => {
    const config = Bun.TOML.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
    assert.deepEqual(config.compatibility_flags, ["nodejs_compat", "enable_request_signal"]);
    assert.equal(config.workers_dev, false);
    assert.equal(config.durable_objects.bindings.some((binding) => binding.class_name === "HeraldRoom"), false);
  });
}

export { environment, policy };
