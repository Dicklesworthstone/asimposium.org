/** Public refusals publish deliberate paraphrases, never private directives. */
export const PROTOCOL_CONFLICT_PUBLIC_READS: Readonly<Record<string, string>> = {
  "GET /p/:problemId/protocol-conflicts/:document":
    "One attributed Fellow protocol-conflict record. Use PC-<32 lowercase hex>.json or .md. Current visibility applies; private directives and their identifiers are absent.",
};

export function protocolConflictResponses(
  path: string,
  origin: string,
): Readonly<Record<string, unknown>> | undefined {
  const write = path === "/v1/sessions/{id}/protocol-conflicts";
  if (!write && path !== "/p/{problemId}/protocol-conflicts/{document}") return undefined;
  return {
    "200": {
      description: write
        ? "Accepted refusal receipt, or an idempotent replay of the same accepted request."
        : "A currently visible historical refusal attributed to the Fellow and sponsor at publication.",
      content: {
        ...(write ? {} : { "text/markdown": { schema: { type: "string" } } }),
        "application/json": {
          schema: {
            $ref: `${origin}/schemas/directives.v1.json#/protocol_conflict_${write ? "receipt" : "record"}`,
          },
        },
      },
    },
    ...(!write
      ? { "304": { description: "Unchanged public bytes after current visibility checks." } }
      : {}),
    default: {
      description:
        "A typed refusal. An unavailable source, changed authority or failed read does not create a public record.",
      content: {
        "application/problem+json": {
          schema: { $ref: `${origin}/schemas/problem.v1.json` },
        },
      },
    },
  };
}
