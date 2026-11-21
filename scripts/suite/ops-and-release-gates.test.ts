/**
 * Aggregates the root ops, release, legal, IP-firewall, DNS-cutover, archival,
 * error-copy, and launch-gate regression suites directly into `scripts/suite/`
 * so `bun run toolchain:test` and `bun run test` execute them automatically
 * without needing changes to `package.json`.
 */

import "../archive-e2e-artifacts.test.ts";
import "../asimp-installer-e2e.test.ts";
import "../error-copy-audit.test.ts";
import "../ip-and-slop-audit.test.ts";
import "../launch-gates-scorecard.test.ts";
import "../legal-claims-audit.test.ts";
import "../ops-schedules.test.ts";
import "../ops-vpx.test.ts";
import "../w12-7-dns-cutover-gate.test.ts";
