import { describe, expect, test } from "bun:test";
import {
  auditBeadsDatabase,
  auditBeadsGraph,
  type GraphDependency,
  type GraphIssue,
  REQUIRED_DEPLOY_GATE,
  REQUIRED_G0_GATES,
  REQUIRED_LAUNCH_TARGETS,
} from "./check-beads-graph.ts";

function baseHealthyGraph(): { issues: GraphIssue[]; deps: GraphDependency[] } {
  const issues: GraphIssue[] = [
    {
      id: REQUIRED_DEPLOY_GATE,
      title: "OPERATOR ACTION: deploy staging",
      status: "open",
      issue_type: "task",
      priority: 0,
    },
    {
      id: REQUIRED_G0_GATES[0],
      title: "S-7 G0 exit",
      status: "open",
      issue_type: "task",
      priority: 1,
    },
    {
      id: REQUIRED_G0_GATES[1],
      title: "G0: Laws of the Machine",
      status: "open",
      issue_type: "epic",
      priority: 1,
    },
    {
      id: "asimposiumorg-6q0",
      title: "W2: Krater data plane",
      status: "open",
      issue_type: "epic",
      priority: 1,
    },
    {
      id: "asimposiumorg-leaf",
      title: "W7.1 The /cursor endpoint",
      status: "open",
      issue_type: "task",
      priority: 1,
    },
    ...REQUIRED_LAUNCH_TARGETS.map((id) => ({
      id,
      title: `W12.8 Launch gate ${id}`,
      status: "open",
      issue_type: id === "asimposiumorg-gfd" ? "epic" : "task",
      priority: 1,
    })),
  ];
  const deps: GraphDependency[] = [
    { issue_id: REQUIRED_G0_GATES[0], depends_on_id: REQUIRED_DEPLOY_GATE, type: "blocks" },
    ...REQUIRED_LAUNCH_TARGETS.map((id) => ({
      issue_id: id,
      depends_on_id: REQUIRED_G0_GATES[0],
      type: "blocks",
    })),
  ];
  return { issues, deps };
}

describe("Beads dependency-graph health audit (bead jc0h)", () => {
  test("accepts a healthy graph with launch gates preserved and ready product work", () => {
    const { issues, deps } = baseHealthyGraph();
    const report = auditBeadsGraph(issues, deps);
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.ready_product_count).toBeGreaterThanOrEqual(1);
  });

  test("should-fail: detects blocking cycles", () => {
    const { issues, deps } = baseHealthyGraph();
    issues.push({
      id: "asimposiumorg-leaf2",
      title: "W7.2 DO rooms",
      status: "open",
      issue_type: "task",
      priority: 1,
    });
    deps.push(
      { issue_id: "asimposiumorg-leaf", depends_on_id: "asimposiumorg-leaf2", type: "blocks" },
      { issue_id: "asimposiumorg-leaf2", depends_on_id: "asimposiumorg-leaf", type: "blocks" },
    );
    const report = auditBeadsGraph(issues, deps);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.code === "DEPENDENCY_CYCLE")).toBe(true);
  });

  test("should-fail: detects epic-blocks-own-child inversion", () => {
    const { issues, deps } = baseHealthyGraph();
    deps.push(
      { issue_id: "asimposiumorg-leaf", depends_on_id: "asimposiumorg-6q0", type: "parent-child" },
      { issue_id: "asimposiumorg-leaf", depends_on_id: "asimposiumorg-6q0", type: "blocks" },
    );
    const report = auditBeadsGraph(issues, deps);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.code === "EPIC_BLOCKS_OWN_CHILD")).toBe(true);
  });

  test("should-fail: refuses ungated launch beads when G0 or rs5n gate is missing", () => {
    const { issues, deps } = baseHealthyGraph();
    const filtered = deps.filter((d) => d.issue_id !== "asimposiumorg-oot");
    const report = auditBeadsGraph(issues, filtered);
    expect(report.ok).toBe(false);
    expect(
      report.violations.some(
        (v) => v.code === "LAUNCH_GATE_UNGATED" && v.ids.includes("asimposiumorg-oot"),
      ),
    ).toBe(true);
  });

  test("should-fail: detects coarse open-epic blocking non-launch leaf", () => {
    const { issues, deps } = baseHealthyGraph();
    deps.push({
      issue_id: "asimposiumorg-leaf",
      depends_on_id: "asimposiumorg-6q0",
      type: "blocks",
    });
    const report = auditBeadsGraph(issues, deps);
    expect(report.ok).toBe(false);
    expect(report.violations.some((v) => v.code === "COARSE_EPIC_DEADLOCK")).toBe(true);
    expect(report.violations.some((v) => v.code === "READY_QUEUE_STARVED")).toBe(true);
  });

  test("live repository .beads/beads.db passes all graph health and launch-gate invariants", () => {
    const report = auditBeadsDatabase(".beads/beads.db");
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.ready_product_count).toBeGreaterThanOrEqual(5);
  });
});
