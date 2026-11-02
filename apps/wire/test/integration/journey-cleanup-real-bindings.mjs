import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { basename } from "node:path";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

// Independently observe real builder ChildProcesses; do not consult the
// journey's internal tracking or replace its builder/runtime implementation.
const builders = [];
const processes = channel("child_process");
const observe = ({ process: child }) => {
  child.once("spawn", () => {
    if (!/^esbuild(?:\.exe)?$/.test(basename(child.spawnfile ?? ""))) return;
    if (!child.spawnargs.some((argument) => argument.startsWith("--service="))) return;
    const record = { child, pid: child.pid, closed: false };
    child.once("close", () => {
      record.closed = true;
    });
    builders.push(record);
  });
};
processes.subscribe(observe);
try {
  const { runLocalWorkerJourney } = await import("./problem-lifecycle-real-bindings.mjs");
  for (const mode of ["success", "assertion"]) {
    const before = builders.length;
    const failure = new assert.AssertionError({ message: "Deliberate journey callback assertion" });
    let caught;
    try {
      await runLocalWorkerJourney(async ({ call, enroll, env }) => {
        const fellow = await enroll(`cleanup-${mode}`, `usr_cleanup_${mode}`);
        await call(
          "/v1/problems",
          {
            title: "Successor exceeds its natural-number predecessor",
            statement: "For every natural number n, n + 1 is greater than n.",
            falsifier: "A natural number n for which n + 1 is not greater than n.",
            motivation: "Exercise native journey resource ownership.",
            areas: ["number-theory"],
          },
          fellow,
          201,
        );
        await env.ARTIFACTS.put("journey-cleanup-canary", "Deliberate local work product.");
        assert.equal(
          await (await env.ARTIFACTS.get("journey-cleanup-canary")).text(),
          "Deliberate local work product.",
        );
        if (mode === "assertion") throw failure;
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(
      caught,
      mode === "assertion" ? failure : undefined,
      "preserve the exact callback outcome",
    );
    const created = builders.slice(before);
    assert.ok(created.length > 0, "each actual harness starts a real builder service");
    for (const builder of created) {
      console.log(
        JSON.stringify({
          stage: "journey-builder-retirement",
          mode,
          pid: builder.pid,
          closed: builder.closed,
        }),
      );
      assert.equal(
        builder.closed,
        true,
        "the builder closes before the sole journey returns or rejects",
      );
    }
  }
  const overlapStart = builders.length;
  let markReady;
  let release;
  const ready = new Promise((resolveReady) => {
    markReady = resolveReady;
  });
  const resume = new Promise((resolveResume) => {
    release = resolveResume;
  });
  const held = runLocalWorkerJourney(async ({ call, env }) => {
    assert.deepEqual((await call("/problems.json")).problems, []);
    await env.ARTIFACTS.put("overlap-owner", "Still owned by the active journey.");
    markReady();
    await resume;
    assert.equal((await env.DB.prepare("SELECT 1 AS n").first()).n, 1);
    assert.equal(
      await (await env.ARTIFACTS.get("overlap-owner")).text(),
      "Still owned by the active journey.",
    );
    assert.deepEqual((await call("/problems.json")).problems, []);
  });
  try {
    await Promise.race([
      ready,
      held.then(() => {
        throw new Error("Held journey finished before release");
      }),
    ]);
    await runLocalWorkerJourney(async ({ call, env }) => {
      assert.deepEqual((await call("/problems.json")).problems, []);
      assert.equal((await env.DB.prepare("SELECT 1 AS n").first()).n, 1);
    });
    const shared = builders.slice(overlapStart);
    assert.ok(shared.length > 0, "the overlapping journeys use a real builder service");
    assert.ok(
      shared.every((builder) => !builder.closed),
      "a finished journey leaves the active sibling's builder running",
    );
  } finally {
    release();
    await held;
  }
  assert.ok(
    builders.slice(overlapStart).every((builder) => builder.closed),
    "the last owner retires the shared builder",
  );
  console.log(
    JSON.stringify({
      kind: "journey-cleanup-real-bindings-complete",
      status: "pass",
      modes: ["success", "assertion", "overlap"],
    }),
  );
} finally {
  processes.unsubscribe(observe);
}
