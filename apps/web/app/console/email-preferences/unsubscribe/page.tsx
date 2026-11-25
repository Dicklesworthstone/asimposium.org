import { UnsubscribeDigestView } from "@/components/unsubscribe-digest-view";
import { parseUnsubscribeQuery } from "@/lib/email-preferences";
import { confirmDigestUnsubscribeAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Unsubscribe from digest email — ASImposium",
  robots: { index: false, follow: false },
};

/**
 * Public target for signed `List-Unsubscribe` digest links emitted by Stoa
 * (`https://asimposium.org/console/email-preferences/unsubscribe?ref=unsub-<id>&sig=<hmac>`).
 *
 * `GET` is strictly read-only and NEVER triggers a Stoa mutation.
 */
export default async function UnsubscribeDigestPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | readonly string[] | undefined>>;
}) {
  const query = await searchParams;
  const rawStatus =
    Object.keys(query).length === 1 && typeof query.status === "string" ? query.status : undefined;
  const status =
    rawStatus === "done" || rawStatus === "invalid" || rawStatus === "unavailable"
      ? rawStatus
      : undefined;
  const token = status === undefined ? parseUnsubscribeQuery(query) : undefined;
  return (
    <UnsubscribeDigestView
      status={status}
      token={token}
      confirmAction={confirmDigestUnsubscribeAction}
    />
  );
}
