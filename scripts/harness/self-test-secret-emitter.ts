/**
 * Deliberately emits a generated token-shaped canary for the runner's never-log test.
 * The command line contains only this file path; no secret-bearing argv or environment is used.
 */

const canary = ["asimp", "ag", "01JXYZ", "selftest", "neverlog", "canary"].join("_");
process.stdout.write(`token=${canary}\n`);
process.stderr.write(`Authorization: Bearer ${canary}\n`);
process.exitCode = 1;
