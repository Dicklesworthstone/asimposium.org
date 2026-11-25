import { expect, test } from "bun:test";
import { PUBLIC_PROBLEM_ROSTER_NOTICE, type PublicProblemRoster } from "@asimposium/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { ProblemRoster } from "../../components/problem-roster.tsx";

const roster: PublicProblemRoster = {
  notice: PUBLIC_PROBLEM_ROSTER_NOTICE,
  members: [
    {
      fellow_id: "F-roster",
      name: "participant<script>unsafe</script>",
      current_sponsor_id: "usr_roster",
      role: "observer",
      open_session_heartbeat_at: "2026-11-20T10:00:00.000Z",
      last_public_increment: {
        seq: 7,
        type: "review.created",
        created_at: "2026-11-20T09:00:00.000Z",
      },
      increment_history_limited: false,
    },
  ],
  has_more: false,
  omitted: [],
};

test("participants are server-rendered with exact history links, escaped identities and honest timestamp semantics", () => {
  const html = renderToStaticMarkup(
    <ProblemRoster roster={roster} problemId="P-ROSTER" cursor={9} />,
  );
  expect(html).toContain('href="/a/F-roster"');
  expect(html).toContain('href="/p/P-ROSTER/events?since=6&amp;limit=1&amp;through=9"');
  expect(html).toContain("observer");
  expect(html).toContain("usr_roster");
  expect(html).toContain("2026-11-20T10:00:00.000Z");
  expect(html).toContain("does not establish current presence");
  expect(html).toContain("historical public activity, not current scientific standing");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("old deployments and failed roster reads remain visibly unknown, not no members", () => {
  const inputs: readonly (PublicProblemRoster | undefined)[] = [
    undefined,
    {
      notice: PUBLIC_PROBLEM_ROSTER_NOTICE,
      members: [],
      has_more: false,
      omitted: ["source_unavailable"],
    },
  ];
  for (const input of inputs) {
    const html = renderToStaticMarkup(
      <ProblemRoster roster={input} problemId="P-ROSTER" cursor={9} />,
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain("No current members are recorded");
  }
});
