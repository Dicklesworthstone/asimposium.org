import type { FC } from "react";
import Link from "next/link";
import { StatusBadge } from "./status-badge";

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly status?: string;
  readonly href?: string;
}

export interface GraphEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relation: string;
  readonly label?: string;
}

export interface AccessibleGraphTableProps {
  readonly caption: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly className?: string;
  readonly defaultOpen?: boolean;
}

/**
 * Accessible Tabular Fallback for Graphs (Fable §8.3 & WCAG 2.2 AA).
 * Every visual relation graph (claims, citations, hypotheses) must provide an
 * equivalent accessible tabular representation for screen readers and non-JS clients.
 */
export const AccessibleGraphTable: FC<AccessibleGraphTableProps> = ({
  caption,
  nodes,
  edges,
  className = "",
  defaultOpen = true,
}) => {
  const nodeMap = new Map<string, GraphNode>(nodes.map((n) => [n.id, n]));

  // Build rows from edges, or from nodes if there are no edges
  const rows =
    edges.length > 0
      ? edges.map((edge) => {
          const source = nodeMap.get(edge.sourceId) ?? {
            id: edge.sourceId,
            label: edge.sourceId,
            kind: "unknown",
          };
          const target = nodeMap.get(edge.targetId) ?? {
            id: edge.targetId,
            label: edge.targetId,
            kind: "unknown",
          };
          return {
            source,
            relation: edge.relation,
            target,
          };
        })
      : nodes.map((node) => ({
          source: node,
          relation: "isolated",
          target: undefined,
        }));

  return (
    <details
      className={`graph-table-fallback my-4 p-3 bg-card border border-line rounded-sm ${className}`}
      open={defaultOpen}
    >
      <summary className="font-serif italic text-sm text-ink cursor-pointer hover:text-clay select-none">
        Accessible tabular fallback: {caption} ({nodes.length} nodes, {edges.length} edges)
      </summary>
      <div className="overflow-x-auto mt-3">
        <table className="min-w-full text-left text-sm font-mono border-collapse" aria-label={caption}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-muted">
              <th scope="col" className="py-2 px-3 font-normal">
                Source
              </th>
              <th scope="col" className="py-2 px-3 font-normal">
                Kind
              </th>
              <th scope="col" className="py-2 px-3 font-normal">
                Status
              </th>
              <th scope="col" className="py-2 px-3 font-normal">
                Relation
              </th>
              <th scope="col" className="py-2 px-3 font-normal">
                Target
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line text-ink">
            {rows.map((row, index) => (
              <tr key={`${row.source.id}-${row.relation}-${row.target?.id ?? index}`} className="hover:bg-paper/50">
                <th scope="row" className="py-2 px-3 font-normal whitespace-nowrap">
                  {row.source.href ? (
                    <Link href={row.source.href} className="text-clay hover:underline">
                      {row.source.id}
                    </Link>
                  ) : (
                    <span>{row.source.id}</span>
                  )}
                </th>
                <td className="py-2 px-3 text-muted">{row.source.kind}</td>
                <td className="py-2 px-3 whitespace-nowrap">
                  {row.source.status ? (
                    <StatusBadge status={row.source.status} size="sm" />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="py-2 px-3 text-ink2">{row.relation}</td>
                <td className="py-2 px-3 whitespace-nowrap">
                  {row.target ? (
                    row.target.href ? (
                      <Link href={row.target.href} className="text-clay hover:underline">
                        {row.target.id}
                      </Link>
                    ) : (
                      <span>{row.target.id}</span>
                    )
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
};
