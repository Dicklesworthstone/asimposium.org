import { z } from "zod";

/**
 * Public ledger read faces (W6.1). First slice: the problems index.
 *
 * The entry mirrors the Krater `problems` projection exactly — identifiers,
 * sequence, timestamps. Titles, statements, and statuses arrive with the
 * problem lifecycle (W5.1) and extend this entry; they are never simulated.
 * `omitted[]` is mandatory on the response so every reader can see what the
 * face deliberately left out.
 */
export const ProblemIndexEntrySchema = z
  .object({
    id: z.string().min(1).max(80),
    public_seq: z.number().int().min(0),
    created_at: z.string().min(1).max(40),
    updated_at: z.string().min(1).max(40),
  })
  .strict();

export const ProblemsIndexResponseSchema = z
  .object({
    problems: z.array(ProblemIndexEntrySchema).max(200),
    omitted: z.array(z.string().min(1).max(160)),
  })
  .strict();

/** The single generated JSON-Schema root for the public ledger read faces. */
export const LedgerContractsSchema = z
  .object({
    problem_index_entry: ProblemIndexEntrySchema,
    problems_index_response: ProblemsIndexResponseSchema,
  })
  .strict();

export type ProblemIndexEntry = z.infer<typeof ProblemIndexEntrySchema>;
export type ProblemsIndexResponse = z.infer<typeof ProblemsIndexResponseSchema>;
