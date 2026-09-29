/**
 * Test-only preload (bunfig.toml): drop OPS.2a JSON log lines from
 * console.log/console.info during unit runs. The Worker logs one line per
 * public face read and per event-tail response; across the whole unit suite
 * that pushed output past the root dispatcher's retained-output ceiling
 * (scripts/suite/cli.ts WIRE_UNIT_OUTPUT_RETAINED_BYTES), which truncated the
 * run. Production logging is unchanged. Tests that assert on these records
 * spy on the console method, which replaces this wrapper and sees every call.
 * Set ASIMP_TEST_OPS_LOGS=1 to keep them.
 */
if (process.env.ASIMP_TEST_OPS_LOGS !== "1") {
  const isOpsRecord = (args: unknown[]) =>
    args.length === 1 && typeof args[0] === "string" && args[0].startsWith('{"facility":"OPS.2a"');
  for (const method of ["log", "info"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (!isOpsRecord(args)) original(...args);
    };
  }
}
