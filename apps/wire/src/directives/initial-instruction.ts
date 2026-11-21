import {
  type InitialSponsorInstruction,
  InitialSponsorInstructionSchema,
} from "@asimposium/contracts/directives";
import type { FellowCredentialBinding } from "../enrollment/service.ts";
import { sha256Hex } from "../krater/krater.ts";

/** The same immutable source identity is used by private reads and historical
 * disclosure. A sponsor transfer must never rename the original instruction. */
export async function enrollmentInstructionId(
  enrollmentId: string,
  fellowId: string,
  initialSponsorId: string,
): Promise<string> {
  return `EI-${(await sha256Hex(`${enrollmentId}\0${fellowId}\0${initialSponsorId}`)).slice(0, 32)}`;
}

export interface InitialInstructionRow {
  initial_enrollment_id: string;
  initial_sponsor_id: string;
  initial_created_at: number;
  initial_instruction_type: string | null;
  initial_instruction_text: string | null;
  initial_problem_id: string | null;
}

/** These columns come from the same SQL snapshot as live credential authority.
 * The approved grant, rather than the requested grant, decides whether an
 * instruction survived approval. Former sponsors remain historical disclosure
 * principals; their onboarding text is not current sponsor steering. */
export async function initialInstructionFromRow(
  row: InitialInstructionRow,
  binding: FellowCredentialBinding,
  problemId: string | null,
): Promise<InitialSponsorInstruction | null> {
  if (
    row.initial_instruction_type === null ||
    row.initial_sponsor_id !== binding.sponsorId ||
    (row.initial_problem_id !== null && row.initial_problem_id !== problemId)
  )
    return null;
  if (
    row.initial_instruction_type !== "text" ||
    typeof row.initial_enrollment_id !== "string" ||
    row.initial_enrollment_id.length === 0
  )
    throw new Error("SPONSOR_INITIAL_INSTRUCTION_UNAVAILABLE");
  return InitialSponsorInstructionSchema.parse({
    directive_id: await enrollmentInstructionId(
      row.initial_enrollment_id,
      binding.fellowId,
      row.initial_sponsor_id,
    ),
    source_kind: "enrollment-instruction",
    verb: "initial",
    fellow_id: binding.fellowId,
    sponsor_id: row.initial_sponsor_id,
    problem_id: row.initial_problem_id,
    text: row.initial_instruction_text,
    created_at: row.initial_created_at,
  });
}
