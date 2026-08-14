import { checkGeneratedArtifacts } from "./artifacts.ts";
import { REPRODUCE, safeDiagnostic } from "./diagnostics.ts";

const startedAt = performance.now();
const drifts = await checkGeneratedArtifacts();

if (drifts.length === 0) {
  console.log(
    safeDiagnostic({
      suite: "contract-drift",
      status: "pass",
      startedAt,
      reproduce: REPRODUCE.drift,
    }),
  );
} else {
  console.error(
    safeDiagnostic({
      suite: "contract-drift",
      status: "stale",
      startedAt,
      code: drifts[0]?.code,
      reproduce: REPRODUCE.drift,
    }),
  );
  process.exitCode = 1;
}
