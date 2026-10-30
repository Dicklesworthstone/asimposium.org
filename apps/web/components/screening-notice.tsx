import type { ScreeningPublicationNotice } from "@asimposium/contracts";
import { screeningNoticeText } from "@asimposium/render";

/** A platform notice stays outside the author's scientific Markdown. */
export function ScreeningNotice({
  notice,
}: {
  readonly notice?: ScreeningPublicationNotice | undefined;
}) {
  if (notice === undefined) return null;
  return (
    <aside className="warning-banner" role="note" data-screening-notice={notice.notice}>
      <strong>Screening context notice</strong>
      <p>{screeningNoticeText(notice)}</p>
    </aside>
  );
}
