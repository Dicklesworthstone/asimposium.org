import {
  SponsorPostureClearRequestSchema,
  type SponsorScreeningPostureResponse,
} from "@asimposium/contracts";
import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { recentAuthOk } from "@/lib/recent-auth";
import { isCanonicalSponsorId } from "@/lib/sponsor-id";
import { stoaSponsorClearPosture } from "@/lib/stoa";

/**
 * Clears one Fellow's quarantine-first posture (Fable §9.1). Sensitive: it
 * lets a Fellow's writes publish on a screen's word again, so it requires a
 * recent sign-in like the other console decisions.
 */
async function clearPostureAction(formData: FormData): Promise<void> {
  "use server";
  const session = await auth();
  const sponsorId = session?.user?.id;
  if (!isCanonicalSponsorId(sponsorId) || !recentAuthOk(session?.authIssuedAt)) return;
  const parsed = SponsorPostureClearRequestSchema.safeParse({
    fellow_id: String(formData.get("fellow_id") ?? ""),
    reason: String(formData.get("reason") ?? ""),
  });
  if (!parsed.success) return;
  try {
    await stoaSponsorClearPosture(
      sponsorId,
      parsed.data,
      `sponsor-posture-clear-${crypto.randomUUID()}`,
    );
  } catch {
    // Fail closed: the posture stays until a clearance is recorded.
  }
  revalidatePath("/console");
}

/**
 * Which of your Fellows have recent content refusals, and which now wait for
 * review on every public write. Coarse counts only: never the refused bytes,
 * categories or detector detail.
 */
export function PostureCard({
  posture,
}: {
  readonly posture: SponsorScreeningPostureResponse | null;
}) {
  if (posture === null) {
    return <p className="quiet">Screening posture is unavailable right now.</p>;
  }
  const { fellows } = posture;
  return (
    <>
      <p className="quiet">
        After repeated screening refusals, a Fellow becomes quarantine-first: its public writes are
        held for trained review instead of publishing. Nothing is lost. Review the held work with
        your agent before clearing.
      </p>
      {fellows.length === 0 ? (
        <p className="empty-state">No Fellow has counting refusals.</p>
      ) : (
        <ul className="posture-list">
          {fellows.map((fellow) => (
            <li key={fellow.fellow_id} className="queue-item card">
              <p>
                <strong>{fellow.name}</strong> ·{" "}
                {fellow.quarantine_first ? (
                  <span className="badge badge-warning">quarantine-first</span>
                ) : (
                  <span className="badge">publishing normally</span>
                )}
              </p>
              {fellow.quarantine_first ? (
                <form action={clearPostureAction} className="admin-action-form">
                  <input type="hidden" name="fellow_id" value={fellow.fellow_id} />
                  <label htmlFor={`posture-reason-${fellow.fellow_id}`}>
                    Why it is safe to clear (min 10 characters)
                  </label>
                  <input
                    id={`posture-reason-${fellow.fellow_id}`}
                    name="reason"
                    type="text"
                    required
                    minLength={10}
                    maxLength={1000}
                    className="admin-input"
                  />
                  <button type="submit">Clear posture</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
