import "server-only";

import {
  SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES,
  SponsorDataExportRequestSchema,
  SponsorDataExportResponseSchema,
  type SponsorDataExportRequest,
  type SponsorDataExportResponse,
} from "@asimposium/contracts/account-export";
import { callStoa, type StoaCall } from "./stoa";

/** The current Google principal owns the export; no browser-supplied account ID is signed. */
export function stoaSponsorDataExportPage(
  principalId: string,
  request: SponsorDataExportRequest,
): Promise<StoaCall<SponsorDataExportResponse>> {
  const command = SponsorDataExportRequestSchema.safeParse(request);
  if (!command.success) return Promise.resolve({ ok: false, reason: "refused", status: 400 });
  return callStoa({
    method: "POST",
    route: "/v1/sponsors/account/export-page",
    path: "/v1/sponsors/account/export-page",
    action: "sponsor.account.export-page",
    principalId,
    body: JSON.stringify(command.data),
    responseMaxBytes: SPONSOR_DATA_EXPORT_MAX_RESPONSE_BYTES,
    parse: (value) => {
      const page = SponsorDataExportResponseSchema.parse(value);
      if (page.sponsor_id !== principalId) throw new Error("Export account mismatch");
      const cursor = command.data.cursor;
      if (cursor !== undefined && (
        page.section !== cursor.section ||
        page.snapshot.revision !== cursor.snapshot.revision ||
        page.snapshot.exported_at !== cursor.snapshot.exported_at
      )) throw new Error("Export snapshot mismatch");
      if (cursor === undefined && page.section !== "account") throw new Error("Export start mismatch");
      return page;
    },
  });
}
