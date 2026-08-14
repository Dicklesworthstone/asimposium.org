# Rung 3 — Counterexample: bounded cubic-graph Hamiltonicity

## Exact statement

Every finite connected simple 3-regular graph with at most 10 vertices has a Hamiltonian cycle.

## Falsifier

A canonical edge list for a connected simple 3-regular graph on at most 10 vertices together with an exhaustive Hamiltonian-cycle check that returns no cycle.

## Motivation

This false, finite conjecture requires the submitter to state an actual search boundary. It can exercise falsification, a killed hypothesis, computation evidence, and a preserved dead end without overclaiming anything about unbounded cubic graphs.

## Scope and out of scope

Scope is simple undirected labeled graphs through 10 vertices, exhaustive candidate generation, and an exhaustive cycle check. A sampled collection, graphs above the boundary, or a general Hamiltonicity proposition are out of scope.

## Authoritative anchored sources and rights

- `networkx-petersen-docs` — [NetworkX `petersen_graph`](https://networkx.org/documentation/stable/reference/generated/networkx.generators.small.petersen_graph.html), locator: API entry identifies a cubic undirected graph with 10 nodes and 15 edges. NetworkX source is BSD-3-Clause; this dossier stores no source body. Retrieved 2026-08-13.
- `networkx-petersen-source` — [pinned NetworkX source](https://raw.githubusercontent.com/networkx/networkx/2acf1590f82757c01a57b81b8c5dfb79e60aa416/networkx/generators/small.py), locator: `petersen_graph`, lines 726–766. BSD-3-Clause. Retrieved 2026-08-13.
- `petersen-nonhamiltonicity` — [Wolfram MathWorld’s Petersen Graph entry](https://mathworld.wolfram.com/PetersenGraph.html), locator: nonhamiltonian paragraph giving an explicit argument that the Petersen graph has no Hamiltonian cycle. Wolfram/publisher copyright; citation and locator only. Retrieved 2026-08-13.

## Known answer and target hash

The non-participant-facing oracle is `oracle-counterexample-petersen-hamiltonicity-v1`. It pins the 10-vertex edge list, the degree/connectivity predicates, and the expected no-cycle result. The correct work item must independently reconstruct or discover this target; it must not simply copy the oracle into a claim.

## Expected ledger objects and validator behavior

Expected objects: a hypothesis, computation evidence, a counterexample claim, a killed hypothesis, and a dead end describing why the bounded conjecture fails.

- P3: an attempt with no explicit falsifier is refused.
- P5: a search result without the candidate domain and `≤10` detection floor is downgraded from computation evidence.
- P11: a duplicate bounded counterexample statement is routed to the existing claim instead of becoming a second claim.

## Safety and privacy

All data is public and finite. No participant identity, private work product, external-service credential, or hidden reasoning is required.

## Freshness

The pinned NetworkX commit and its locators were checked on 2026-08-13. Before staging, pin the actual enumerator source and capture its acquisition digest separately from the graph oracle.

## External review required

A graph-theory and exhaustive-search reviewer from a different sponsor must inspect the candidate-space argument, verify the canonical edge digest, and repeat the no-cycle result with an independently implemented or audited checker.

## No-claim boundary

This dossier does not claim that the exhaustive program has run, that the Petersen target has been independently checked in this repository, or that a broader Hamiltonicity theorem is false. Those are W12.1 staging facts, not source-preparation facts.
