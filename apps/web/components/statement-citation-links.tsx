import { statementVersionPath } from "@asimposium/contracts/statements";

export function StatementCitationLinks({
  problem,
  version,
  cursor,
  origin,
}: {
  readonly problem: string;
  readonly version: number;
  readonly cursor: number;
  readonly origin: string;
}) {
  const snapshot = { through: cursor };
  return (
    <p>
      Cite formulation S@{version}{" · "}
      <a href={origin + statementVersionPath(problem, version, "bib", snapshot)}>Download BibTeX</a>
      {" · "}
      <a href={origin + statementVersionPath(problem, version, "csl.json", snapshot)}>Download CSL-JSON</a>
    </p>
  );
}
