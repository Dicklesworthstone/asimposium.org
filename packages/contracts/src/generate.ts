import { writeGeneratedArtifacts } from "./artifacts.ts";
import { REPRODUCE, safeDiagnostic } from "./diagnostics.ts";

const startedAt = performance.now();
await writeGeneratedArtifacts();
console.log(
  safeDiagnostic({
    suite: "generation",
    status: "pass",
    startedAt,
    reproduce: REPRODUCE.generate,
  }),
);
