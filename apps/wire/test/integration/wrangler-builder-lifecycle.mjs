import { channel } from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { basename } from "node:path";

// Context disposal leaves Wrangler's process-wide esbuild service unref'ed.
// Share ownership across native journeys and gauntlet targets, using precisely
// Wrangler's dependency instance rather than a separately resolved service.
const esbuild = createRequire(import.meta.resolve("wrangler"))("esbuild");
const childProcesses = channel("child_process");
const builderClosures = new Map();
let activeOwners = 0;
let observing = false;
const observeBuilder = ({ process: child }) => {
  child.once("spawn", () => {
    if (activeOwners === 0) return;
    if (!/^esbuild(?:\.exe)?$/.test(basename(child.spawnfile ?? ""))) return;
    if (!child.spawnargs.includes(`--service=${esbuild.version}`)) return;
    const closed = new Promise((resolveClose) => {
      child.once("close", () => {
        builderClosures.delete(child);
        resolveClose();
      });
    });
    builderClosures.set(child, closed);
  });
};

export function retainWranglerBuilder() {
  if (!observing) {
    childProcesses.subscribe(observeBuilder);
    observing = true;
  }
  activeOwners++;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--activeOwners !== 0) return;
    const closing = [...builderClosures.entries()];
    // A pending Promise does not keep Node alive for an unref'ed child's close.
    for (const [child] of closing) child.ref();
    try {
      // stop initiates shutdown synchronously. Await this actual generation's
      // close events as well: stop's own promise does not prove child reaping.
      await esbuild.stop();
      await Promise.all(closing.map(([, closed]) => closed));
    } finally {
      if (activeOwners === 0 && builderClosures.size === 0) {
        childProcesses.unsubscribe(observeBuilder);
        observing = false;
      }
    }
  };
}
