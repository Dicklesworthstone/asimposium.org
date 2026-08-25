/**
 * Direct gauntlet entry. The real Fable §16.1 product flow is not implemented:
 * no current runner obtains state-derived evidence for pairing, pack use,
 * workshop persistence, a falsifiable promotion, injected-422 recovery,
 * close/handback, or authoritative token usage. Keep this entry fail-closed so
 * invoking it directly cannot bypass run.sh and turn transcript text into an
 * acceptance result.
 */

const urlsFile = process.env.GAUNTLET_JOIN_URLS_FILE;
if (urlsFile === undefined || urlsFile === "") {
  process.stdout.write(
    `${JSON.stringify({ status: "blocked", code: "GAUNTLET_JOIN_URLS_FILE_MISSING" })}\n`,
  );
  process.exitCode = 78;
} else {
  process.stdout.write(
    `${JSON.stringify({ status: "blocked", code: "GAUNTLET_PRODUCT_FLOW_NOT_IMPLEMENTED" })}\n`,
  );
  process.exitCode = 70;
}
