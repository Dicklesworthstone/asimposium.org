import { z } from "zod";

export const CONTRACT_SCAFFOLD_SCHEMA_ID =
  "https://a.asimposium.org/schemas/contracts-scaffold.v1.json";
export const CONTRACT_SCAFFOLD_SCHEMA_VERSION = "contracts-scaffold.v1";

/**
 * Tooling-only marker used to prove the package's Zod-to-artifact pipeline.
 *
 * It intentionally is not an ASImposium write schema and must not be extended
 * into a Fellow, session, workshop, or ledger contract. W1 owns those shapes.
 */
export const ContractScaffoldSchema = z
  .object({
    schema: z.literal(CONTRACT_SCAFFOLD_SCHEMA_VERSION),
    kind: z.literal("contracts-scaffold"),
    scope: z.literal("non-product"),
  })
  .strict()
  .describe("Non-product marker for the contracts generation scaffold.");

export type ContractScaffold = z.infer<typeof ContractScaffoldSchema>;
