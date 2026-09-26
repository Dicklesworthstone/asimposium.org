import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runLocalWorkerJourney } from "./problem-lifecycle-real-bindings.mjs";
import { sessionLifecycleJourney } from "./session-lifecycle-journey.mjs";

assert.equal(process.versions.bun, undefined, "This lane requires genuine Node");

await runLocalWorkerJourney(sessionLifecycleJourney)
  .then((receipt) => {
    console.log(
      JSON.stringify({
        kind: "session-lifecycle-real-bindings-complete",
        status: "pass",
        receipt,
      }),
    );
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      JSON.stringify({
        kind: "session-lifecycle-real-bindings-complete",
        status: "fail",
        // The error class tells an assertion failure from a broken harness.
        error_code: typeof err?.code === "string" ? err.code : (err?.name ?? null),
        error: err instanceof Error ? err.message : String(err),
        error_sha256: createHash("sha256")
          .update(err instanceof Error ? err.message : typeof err)
          .digest("hex"),
      }),
    );
    process.exit(1);
  });
