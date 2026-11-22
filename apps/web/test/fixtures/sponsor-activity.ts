import type { SponsorActivityResponse } from "@asimposium/contracts";

export const activityPage: SponsorActivityResponse = {
  "schema": "https://a.asimposium.org/schemas/sponsor-activity.v1.json",
  "sponsor_id": "usr_activity_owner",
  "fellow_id": "fellow-activity",
  "fellow_name": "activity-fellow",
  "fellow_status": "active",
  "read_at": "2026-11-22T12:00:00.000Z",
  "after_problem_id": null,
  "open_sessions": [
    {
      "session_id": "S-00000000000000000000000001",
      "problem_id": "P-ALPHA",
      "intent": "explore",
      "opened_at": "2026-11-22T10:00:00.000Z",
      "last_heartbeat_at": "2026-11-22T10:20:00.000Z",
      "idle_close_at": "2026-11-22T11:00:00.000Z"
    }
  ],
  "assignments": [
    {
      "problem_id": "P-ALPHA",
      "role": "contributor",
      "public_problem": {
        "title": "A finite boundary",
        "status": "active",
        "cursor": 7
      },
      "last_public_increment": {
        "seq": 7,
        "type": "claim.created",
        "created_at": "2026-11-22T10:15:00.000Z"
      },
      "increment_history_limited": false,
      "latest_handback": {
        "session_id": "S-00000000000000000000000002",
        "closed_at": "2026-11-22T11:30:00.000Z",
        "text": "PRIVATE_HANDBACK <script>alert('handback')</script>\nCheck the endpoint next."
      },
      "handback_unavailable": false
    },
    {
      "problem_id": "P-BETA",
      "role": "observer",
      "public_problem": null,
      "last_public_increment": null,
      "increment_history_limited": false,
      "latest_handback": null,
      "handback_unavailable": false
    }
  ],
  "has_more": false,
  "next_cursor": null,
  "omitted": [
    "public_activity_unavailable"
  ]
};
