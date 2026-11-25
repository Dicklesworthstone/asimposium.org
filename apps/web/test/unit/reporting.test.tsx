import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseReportTarget, reportPageHref, reportSourceHref } from "../../lib/report-submission";

if (process.env.ASIMPOSIUM_REPORT_PAGE_TEST_CHILD !== import.meta.path) {
  test("report page authentication assertions pass in an isolated Bun process", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "test",
        "--no-orphans",
        "/dev/null",
        "--timeout=120000",
        import.meta.path,
      ],
      cwd: import.meta.dir,
      env: { ...process.env, ASIMPOSIUM_REPORT_PAGE_TEST_CHILD: import.meta.path },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 110_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (timedOut)
        throw new Error(
          `Report page child exceeded its 110-second deadline:\n${stdout}\n${stderr}`,
        );
      if (exitCode !== 0) throw new Error(`Report page assertions failed:\n${stdout}\n${stderr}`);
      expect(exitCode).toBe(0);
      expect(stderr).toMatch(/\b6 pass\b/);
      expect(stderr).toMatch(/\b0 fail\b/);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  }, 120_000);
} else {
  mock.module("server-only", () => ({}));
  describe("report navigation and sign-in", () => {
    let realAuth: typeof import("../../auth");
    let Page: typeof import("../../app/report/page").default;
    let ReportLink: typeof import("../../components/report-panel").ReportLink;
    let sponsor: string | null = "usr_report_page";

    beforeAll(async () => {
      realAuth = { ...(await import("../../auth")) };
      mock.module("@/auth", () => ({
        ...realAuth,
        auth: async () => (sponsor === null ? null : { user: { id: sponsor } }),
      }));
      const specifier: string = "../../app/report/page.tsx?report-page-unit";
      Page = (await import(specifier)).default;
      ReportLink = (await import("../../components/report-panel")).ReportLink;
    });

    afterAll(() => mock.module("@/auth", () => realAuth));
    beforeEach(() =>
      mock.module("@/auth", () => ({
        ...realAuth,
        auth: async () => (sponsor === null ? null : { user: { id: sponsor } }),
      })),
    );

    test("report targets follow the shared contract, without accepting duplicate query values or private objects", () => {
      for (const target of [
        "problem",
        "C-1@2",
        "H-1",
        "E-1",
        "R-1",
        "G-1",
        "L-1",
        "DE-1",
        "Q-1",
        "CF-1",
        "SYNTH-1",
      ])
        expect(parseReportTarget("P-4DSP", target)).toEqual({ problem_id: "P-4DSP", target });
      for (const target of [
        ["C-1", "C-2"],
        "W-private",
        "C-1@0",
        "//another.test",
        "E-1?note=secret",
      ])
        expect(parseReportTarget("P-4DSP", target)).toBeNull();
      expect(parseReportTarget(["P-4DSP"], "C-1")).toBeNull();
    });

    test("back links use existing registered readers and keep the exact claim version", () => {
      const targets = {
        problem: "/p/P-4DSP",
        "C-1@2": "/p/P-4DSP/claims/C-1%402",
        "E-1": "/r/p/P-4DSP/evidence/E-1",
        "R-1": "/r/p/P-4DSP/reviews/R-1",
        "H-1": "/r/p/P-4DSP/hypotheses/H-1",
        "L-1": "/p/P-4DSP/citations/L-1",
        "DE-1": "/r/p/P-4DSP/dead-ends/DE-1",
        "G-1": "/r/p/P-4DSP/gaps/G-1",
        "Q-1": "/r/p/P-4DSP/questions/Q-1",
        "CF-1": "/r/p/P-4DSP/conflicts/CF-1",
        "SYNTH-1": "/p/P-4DSP/syntheses/SYNTH-1",
      };
      for (const [target, expected] of Object.entries(targets))
        expect(reportSourceHref({ problem_id: "P-4DSP", target })).toBe(expected);
    });

    test("a URL status parameter cannot forge success or an authoritative receipt", async () => {
      sponsor = "usr_report_page";
      const query = { problem_id: "P-4DSP", target: "C-1@2", report: "filed" };
      const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(query) }));
      expect(html).not.toContain("Report filed.");
      expect(html).not.toContain("Report confirmed:");
      expect(html).toContain("File report");
      expect(html).toContain("C-1@2");
    });

    test("evidence and review targets present an operable form instead of the old invalid-link message", async () => {
      sponsor = "usr_report_page";
      for (const target of ["E-1", "R-1", "Q-1"]) {
        const html = renderToStaticMarkup(
          await Page({ searchParams: Promise.resolve({ problem_id: "P-4DSP", target }) }),
        );
        expect(html).toContain("File report");
        expect(html).toContain(`Report ${target}`);
        expect(html).not.toContain("Open this page from the Report link");
      }
    });

    test("signed-out readers get a real sign-in route with the exact reporting target retained", async () => {
      sponsor = null;
      const html = renderToStaticMarkup(
        await Page({ searchParams: Promise.resolve({ problem_id: "P-4DSP", target: "C-1@2" }) }),
      );
      expect(html).toContain("Sign in with Google");
      expect(html).toContain("P-4DSP / C-1@2");
      expect(html).not.toContain("File report");
      expect(reportPageHref({ problem_id: "P-4DSP", target: "C-1@2" })).toBe(
        "/report?problem_id=P-4DSP&target=C-1%402",
      );
    });

    test("public conduct links support ledger objects and refuse private target names", () => {
      const html = renderToStaticMarkup(ReportLink({ problemId: "P-4DSP", target: "E-1" }));
      expect(html).toContain("/report?problem_id=P-4DSP&amp;target=E-1");
      expect(html).toContain("Report E-1");
      expect(ReportLink({ problemId: "P-4DSP", target: "W-private" })).toBeNull();
    });
  });
}
