import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { workspace, workspaceCases, workspaceSponsor } from "../fixtures/problem-lifecycle";

mock.module("server-only", () => ({}));
const { ProblemLifecycleControl, ProblemWorkspaceReceiptView } = await import(
  "../../components/problem-lifecycle-control"
);

test("governance controls are present and safe before client recovery is initialized", () => {
  const html = renderToStaticMarkup(
    <ProblemLifecycleControl
      sponsorId={workspaceSponsor}
      initial={workspace}
      returnPath="/console/problems/P-LINEAGE"
      reauthenticate={async () => {}}
    />,
  );
  expect(html).toContain("Problem lineage and retirement");
  expect(html).toContain("Create a private fork");
  expect(html).toContain("Merge into another problem");
  expect(html).toContain("Retire this problem");
  expect(html).toContain("<fieldset disabled");
  expect(html).toContain("<noscript>");
  expect(html).not.toContain('name="statement"');
  expect(html).not.toContain("Stoa created private draft");
});

test("closed problem controls do not offer a second retirement or merge", () => {
  for (const status of ["resolved", "retired"] as const) {
    const html = renderToStaticMarkup(
      <ProblemLifecycleControl
        sponsorId={workspaceSponsor}
        initial={{ ...workspace, problem: { ...workspace.problem, status } }}
        returnPath="/console/problems/P-LINEAGE"
        reauthenticate={async () => {}}
      />,
    );
    expect(html).toContain('<option value="merge" disabled=""');
    expect(html).toContain('<option value="retire" disabled=""');
    expect(html).toContain("cannot be retired or merged again");
  }
});

test("receipts expose actual stored destinations and preserve the scientific boundary", () => {
  for (const { receipt } of workspaceCases) {
    const html = renderToStaticMarkup(<ProblemWorkspaceReceiptView receipt={receipt} />);
    expect(html).toContain("Recorded at");
    expect(html).toContain("/p/P-LINEAGE/history");
    if (receipt.action === "fork") {
      expect(html).toContain("/console/problems/P-PRIVATEFORK");
      expect(html).toContain("has not been published");
    } else if (receipt.action === "merge") {
      expect(html).toContain("/p/P-CANONICAL");
      expect(html).toContain("no scientific equivalence");
    } else {
      expect(html).toContain("retirement is not a resolution");
      const hostile = renderToStaticMarkup(
        <ProblemWorkspaceReceiptView
          receipt={{
            ...receipt,
            result: {
              problem: { ...receipt.result.problem, resolution_summary: "<script>BAD()</script>" },
            },
          }}
        />,
      );
      expect(hostile).toContain("&lt;script&gt;");
      expect(hostile).not.toContain("<script>BAD()");
    }
  }
});
