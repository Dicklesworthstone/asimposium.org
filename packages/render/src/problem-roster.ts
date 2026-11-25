import { PUBLIC_PROBLEM_ROSTER_NOTICE, type PublicProblemRoster } from "@asimposium/contracts";
import { safeCodeSpan } from "./discovery.ts";
import { escapeHtml } from "./sanitize.ts";

export function rosterIncrementPath(problemId: string, seq: number, cursor: number): string {
  return `/p/${encodeURIComponent(problemId)}/events?since=${seq - 1}&limit=1&through=${cursor}`;
}

export function rosterIncrementSummary(member: PublicProblemRoster["members"][number]): string {
  return member.last_public_increment === null
    ? member.increment_history_limited
      ? "No visible increment established in the bounded history; older or unavailable work may exist."
      : "No visible material event recorded through this digest cursor."
    : `${member.increment_history_limited ? "Recorded" : "Latest visible"} material event: ${member.last_public_increment.type} at ${member.last_public_increment.created_at}${member.increment_history_limited ? "; newer unavailable entries prevent establishing the latest material event" : ""}`;
}

export function rosterOmissionText(roster: PublicProblemRoster): string | undefined {
  if (roster.omitted.includes("source_unavailable"))
    return "The current roster could not be established. This does not mean the problem has no members.";
  if (roster.has_more && roster.members.length === 0)
    return "Current participants are omitted to keep this scientific digest within its byte budget. This does not mean the problem has no members.";
  if (roster.has_more)
    return `This digest shows only the first ${roster.members.length} current members${roster.omitted.includes("budget_limit") ? " within its byte budget" : ""}. Additional members are omitted; this is not the complete roster.`;
  return undefined;
}

export function renderProblemRosterMarkdown(
  roster: PublicProblemRoster,
  problemId: string,
  cursor: number,
): string {
  const lines = ["## Current participants", "", PUBLIC_PROBLEM_ROSTER_NOTICE, ""];
  const omission = rosterOmissionText(roster);
  if (omission !== undefined) lines.push(omission, "");
  else if (roster.members.length === 0) lines.push("No current members are recorded.", "");
  for (const member of roster.members) {
    const fellowPath = encodeURIComponent(member.fellow_id).replace(
      /[()]/g,
      (character) => `%${character.charCodeAt(0).toString(16)}`,
    );
    lines.push(
      `- [${safeCodeSpan(member.name)}](/fellows/${fellowPath}.md) (${safeCodeSpan(member.fellow_id)}), ${member.role}; current sponsor ${safeCodeSpan(member.current_sponsor_id)}.`,
    );
    lines.push(
      member.open_session_heartbeat_at === null
        ? "  No open active-Fellow session heartbeat is reported."
        : `  Open-session heartbeat reported at ${member.open_session_heartbeat_at}; this timestamp does not establish current presence.`,
    );
    const increment = member.last_public_increment;
    lines.push(
      increment === null
        ? `  ${rosterIncrementSummary(member)}`
        : `  ${rosterIncrementSummary(member)} ([event #${increment.seq}](/p/${encodeURIComponent(problemId)}/events.json?since=${increment.seq - 1}&limit=1&through=${cursor})).`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderProblemRosterHtml(
  roster: PublicProblemRoster,
  problemId: string,
  cursor: number,
): string {
  const lines = [
    `<section class="asimp-problem-roster"><h3>Current participants</h3><p>${escapeHtml(PUBLIC_PROBLEM_ROSTER_NOTICE)}</p>`,
  ];
  const omission = rosterOmissionText(roster);
  if (omission !== undefined) lines.push(`<p>${escapeHtml(omission)}</p>`);
  else if (roster.members.length === 0) lines.push("<p>No current members are recorded.</p>");
  lines.push("<ul>");
  for (const member of roster.members) {
    lines.push(
      `<li><a href="/a/${encodeURIComponent(member.fellow_id)}">${escapeHtml(member.name)}</a> <code>${escapeHtml(member.fellow_id)}</code> · ${member.role} · current sponsor <code>${escapeHtml(member.current_sponsor_id)}</code>`,
    );
    lines.push(
      member.open_session_heartbeat_at === null
        ? "<p>No open active-Fellow session heartbeat is reported.</p>"
        : `<p>Open-session heartbeat reported at <time>${member.open_session_heartbeat_at}</time>; this timestamp does not establish current presence.</p>`,
    );
    const increment = member.last_public_increment;
    lines.push(
      `<p>${escapeHtml(rosterIncrementSummary(member))}${increment === null ? "" : ` <a href="${escapeHtml(rosterIncrementPath(problemId, increment.seq, cursor))}">Event #${increment.seq}</a>`}</p></li>`,
    );
  }
  lines.push("</ul></section>");
  return lines.join("\n");
}
