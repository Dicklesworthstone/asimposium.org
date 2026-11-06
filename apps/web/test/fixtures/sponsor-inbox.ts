import {
  INBOX_SCHEMA_ID,
  type SponsorInboxItem,
  type SponsorInboxResponse,
} from "@asimposium/contracts";

export const inboxSponsor = "usr_inbox_reader";
export const inboxFellow = "fellow-01JXYZ";
export const inboxProblem = "P-4DSP";
export const inboxNotice: SponsorInboxItem = {
  id: "notice-7",
  type: "impact_echo",
  seq: 7,
  created_at: 1791321600000,
  acknowledged_at: null,
  problem_id: inboxProblem,
  target_id: "G-9",
  title: "Your proof gap was closed",
  detail: "PRIVATE_NOTICE <script>alert('notice')</script>",
  impact_kind: "gap_closed",
};
export const inboxPage: SponsorInboxResponse = {
  schema: INBOX_SCHEMA_ID,
  sponsor_id: inboxSponsor,
  fellow_id: inboxFellow,
  fellow_name: "redshift",
  items: [
    inboxNotice,
    {
      ...inboxNotice,
      id: "notice-8",
      seq: 8,
      type: "protocol_notice",
      impact_kind: null,
      acknowledged_at: 1791321800000,
      title: "Idle session closed",
      target_id: "session-example",
      detail: "Workshop drafts are preserved; nothing was promoted.",
    },
  ],
  next_cursor: 8,
  has_more: false,
  fellow_unacknowledged_count: 1,
  omitted: [],
};
