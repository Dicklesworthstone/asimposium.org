#!/usr/bin/env python3
"""Replay a pinned research seed from its source repository without training or network access."""

import argparse
import gzip
import hashlib
import json
import math
from collections import Counter, defaultdict
from io import BytesIO
from itertools import product
from pathlib import Path
from zipfile import ZipFile


INTAKE = Path(__file__).resolve().parents[1] / "docs" / "seed" / "research-intake.json"
HEBBIAN = "hebbian-binding-controls"
GROUP = "checked-group-catalog"
REWARD_TIMING = "hebbian-reward-timing"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pinned_bytes(source_root, spec):
    path = (source_root / spec["path"]).resolve()
    require(path.is_relative_to(source_root), "Artifact path escapes the source checkout")
    data = path.read_bytes()
    require(hashlib.sha256(data).hexdigest() == spec["sha256"], f"Digest mismatch: {spec['path']}")
    return data


def replay_hebbian(report, archive):
    import numpy as np

    decision = report["decision"]
    rows = [json.loads(line) for line in gzip.decompress(archive).splitlines()]
    seeds = (6311, 6312, 6313, 6314)
    arms = ("initial", "paired", "shuffle")
    modes = ("identity", "shuffle", "frozen")
    docs = sorted({row["doc_sha256"] for row in rows})
    evidence = {(row["seed"], row["arm"], row["doc_sha256"]): row for row in rows}
    expected = {(seed, arm, doc) for seed in seeds for arm in arms for doc in docs}
    require(
        len(docs) == 128 and len(rows) == len(evidence) == len(expected),
        "Incomplete or duplicate document panel",
    )
    require(evidence.keys() == expected, "Seed, arm, or document membership differs")
    records = [[[evidence[seed, arm, doc] for doc in docs] for arm in arms] for seed in seeds]
    counts = np.array([[[row["bytes"] for row in arm] for arm in seed] for seed in records])
    byte_counts = counts[0, 0]
    total_bytes = int(byte_counts.sum())
    require(bool(np.all(counts == byte_counts) and np.all(byte_counts > 0)), "Document byte denominators differ")
    require(total_bytes == decision["bytes"] and len(docs) == decision["n_docs"], "Reported cohort size differs")
    bits = np.array(
        [[[[row[f"{mode}_bits"] for mode in modes] for row in arm] for arm in seed] for seed in records]
    )
    require(bool(np.all(np.isfinite(bits))), "Nonfinite coding loss in the archive")
    bpb = bits.sum(axis=2) / total_bytes
    expected_bpb = [
        [[decision["bpb"][str(seed)][arm][mode] for mode in modes] for arm in arms]
        for seed in seeds
    ]
    require(np.allclose(bpb, expected_bpb, rtol=0, atol=1e-12), "Reported bits per byte differ")

    shuffle_gap = bits[..., 1] - bits[..., 0]
    paired = shuffle_gap[:, 1]
    contrasts = np.stack(
        (
            paired,
            bits[:, 1, :, 2] - bits[:, 1, :, 0],
            paired - shuffle_gap[:, 0],
            paired - shuffle_gap[:, 2],
        ),
        axis=-1,
    )
    per_seed = contrasts.sum(axis=1) / total_bytes
    samples = np.random.default_rng(19610).integers(len(docs), size=(32768, len(docs)))
    sampled_bytes = byte_counts[samples].sum(axis=1)[:, None]
    sampled_contrasts = contrasts.mean(axis=0)[samples].sum(axis=1) / sampled_bytes
    lower = np.quantile(sampled_contrasts, 0.0125, axis=0)
    names = ("over_shuffle", "over_frozen", "trained_minus_initial", "paired_minus_shuffle_training")
    results = {}
    for i, name in enumerate(names):
        recorded = decision["contrasts"][name]
        effects = per_seed[:, i]
        mean = float(effects.mean())
        bound = float(lower[i])
        favorable = int(np.count_nonzero(effects > 0))
        passed = mean >= 0.005 and bound > 0 and favorable == len(seeds)
        require(
            np.allclose(
                [mean, bound, *effects],
                [recorded["delta_bpb"], recorded["paired_lower"], *recorded["seed_deltas"]],
                rtol=0,
                atol=1e-12,
            ) and passed == recorded["pass"],
            f"Reported decision differs for {name}",
        )
        results[name] = {
            "delta_bpb": mean,
            "paired_lower": bound,
            "positive_seeds": favorable,
            "pass": passed,
        }
    advance = all(result["pass"] for result in results.values())
    require(advance == decision["advance"], "Overall advancement decision differs")
    return {
        "rows": len(rows),
        "documents": len(docs),
        "bytes_per_state": total_bytes,
        "bootstrap_draws": len(samples),
        "advance": advance,
        "contrasts": results,
    }


def evaluate(edges, word):
    state = 0
    for digit in word:
        require(digit in "01", "Invalid generator in archived word")
        state = edges[state][int(digit)]
    return state


def replay_cancellation(run, edges, reps):
    require(run["edges"] == edges and run["representatives"] == reps, "Cancellation recovered a different action")
    paid = Counter()
    for edge in run["trace"]:
        target = evaluate(edges, edge["word"])
        require(target == edge["target"], "Archived cancellation target differs")
        for candidate, source, answer in edge["trials"]:
            require(answer == (evaluate(edges, reps[candidate]) == target), "Archived cancellation comparison differs")
            if source == "oracle":
                paid["oracle_equal" if answer else "oracle_different"] += 1
    for name in ("oracle_equal", "oracle_different"):
        require(paid[name] == run["counts"][name], "Archived cancellation query count differs")
    return paid.total()


def replay_group(report, archive):
    with ZipFile(BytesIO(archive)) as bundle:
        manifest = json.loads(bundle.read("proposal-run.json"))
    rows = manifest["results"]
    require(manifest["catalog"] == 57 and len(rows) == 18, "Unexpected catalog or panel size")
    families = {"s5": 6, "c120": 6, "d60": 3, "a5xc2": 3}
    require(Counter(row["family"] for row in rows) == families, "Frozen family counts differ")
    require(len({row["graph_sha"] for row in rows}) == len(rows), "Duplicate action in the frozen panel")
    totals = defaultdict(Counter)

    for row in rows:
        baseline = row["baseline"]
        edges, reps = baseline["edges"], baseline["representatives"]
        require(
            len(edges) == len(reps) == 120 and all(len(edge) == 2 for edge in edges),
            "Invalid marked action shape",
        )
        for generator in (0, 1):
            require(sorted(edge[generator] for edge in edges) == list(range(120)), "Generator does not permute the action")
        require(all(evaluate(edges, word) == state for state, word in enumerate(reps)), "Representative map differs")
        require(
            len(row["samples"]) == 192 and all(evaluate(edges, word) == target for word, target in row["samples"]),
            "Held-out word replay differs",
        )
        baseline_calls = replay_cancellation(baseline, edges, reps)
        accelerated = row["accelerated"]
        selection = accelerated["proposal"]["queries"]
        seen = {}
        for query in selection:
            pair = tuple(sorted(query["pair"]))
            answer = evaluate(edges, pair[0]) == evaluate(edges, pair[1])
            require(query["answer"] == answer, "Archived catalog selection comparison differs")
            seen[pair] = answer

        certificate = accelerated["certificate"]
        require(
            bool(certificate) and all(check["answer"] for check in certificate[:-1]),
            "Certificate continued after a failed check or was empty",
        )
        fresh = 0
        for check in certificate:
            pair = tuple(check["pair"])
            require(check["reused"] == (pair in seen), "Certificate reuse flag differs")
            answer = evaluate(edges, pair[0]) == evaluate(edges, pair[1])
            require(answer == check["answer"], "Archived certificate comparison differs")
            fresh += int(not check["reused"])
        require(fresh == accelerated["new_queries"], "Archived certificate query count differs")
        accepted = accelerated["accepted"]
        require(accepted == certificate[-1]["answer"], "Recorded acceptance differs")
        if accepted:
            equations = {
                tuple(sorted((reps[state] + str(generator), reps[target])))
                for state, edge in enumerate(edges)
                for generator, target in enumerate(edge)
                if reps[state] + str(generator) != reps[target]
            }
            checked = [tuple(check["pair"]) for check in certificate]
            require(
                len(checked) == len(equations) == 121 and set(checked) == equations,
                "Accepted certificate does not cover the final action",
            )
            require(row["fallback"] is None, "Accepted case unexpectedly ran fallback")
            fallback_calls = 0
        else:
            fallback_calls = replay_cancellation(row["fallback"], edges, reps)
        totals[row["family"]].update(
            cases=1,
            accepted=int(accepted),
            baseline=baseline_calls,
            selection=len(selection),
            certificate=fresh,
            fallback=fallback_calls,
            paid=len(selection) + fresh + fallback_calls,
            edges=len(edges) * 2,
            words=len(row["samples"]),
        )

    require(totals == report["totals"], "Reported family totals differ")
    return {
        "cases": len(rows),
        "edges": sum(row["edges"] for row in totals.values()),
        "held_out_words": sum(row["words"] for row in totals.values()),
        "families": totals,
    }


def reward_checkpoints(run, arm):
    checkpoints = ("0", "32", "64", "96", "128")
    require(run["heldout"].keys() == set(checkpoints), "Incorrect reward checkpoints")
    require(run["sites"] == 4 and len(run["train"]) == 128, "Incorrect reward run size")
    reward_ema = None
    dopamine = 0.0
    for step_number, step in enumerate(run["train"], 1):
        require(step["step"] == step_number and step["writes"] == 4, "Deferred write count differs")
        reward = step["reward"]
        require(0 <= reward <= 1 and (reward * 16) % 1 == 0, "Invalid batch reward")
        previous_dopamine = dopamine
        error = reward - (reward_ema if reward_ema is not None else 0.0)
        dopamine = 0.8 * previous_dopamine + 0.2 * math.tanh(2 * error)
        reward_ema = reward if reward_ema is None else 0.8 * reward_ema + 0.2 * reward
        gain = {"aligned": 1 + dopamine, "lagged": 1 + previous_dopamine, "neutral": 1}[arm]
        require(
            math.isclose(step["da"], dopamine, rel_tol=0, abs_tol=1e-6)
            and math.isclose(step["dopamine_gain"], gain, rel_tol=0, abs_tol=1e-6),
            "Feedback schedule differs",
        )
    scores = []
    for checkpoint in checkpoints:
        record = run["heldout"][checkpoint]
        require(record["examples"] == 512 and 0 < record["expected_reward"] < 1, "Invalid holdout")
        scores.append(record["expected_reward"])
    return scores


def replay_reward_timing(report, archive):
    traces = json.loads(gzip.decompress(archive))
    studies = {"cold": range(410, 418), "supervised": range(40521, 47522, 1000)}
    require(traces.keys() == studies.keys(), "Incorrect reward studies")
    require(report["traces"]["sha256"] == hashlib.sha256(archive).hexdigest(), "Trace digest differs")
    arms = ("aligned", "neutral", "lagged")
    outcomes = {}
    for cohort, seeds in studies.items():
        study = traces[cohort]
        runs = study["runs"]
        require(runs.keys() == {str(seed) for seed in seeds}, "Incorrect set of reward seeds")
        paired = []
        for seed in seeds:
            policies = runs[str(seed)]
            require(policies.keys() == set(arms), "Missing or extra feedback arm")
            require(
                all(policies[arm]["heldout"]["0"] == policies["aligned"]["heldout"]["0"] for arm in arms),
                "Matched policies start with different holdout scores",
            )
            paired.append({arm: reward_checkpoints(policies[arm], arm) for arm in arms})

        contrasts = {}
        require(study["contrasts"] == report[cohort]["contrasts"], "Summary and trace contrasts differ")
        for control in ("neutral", "lagged"):
            differences = [
                math.fsum(a - b for a, b in zip(row["aligned"][1:], row[control][1:], strict=True)) / 4
                for row in paired
            ]
            observed = math.fsum(differences)
            extreme = sum(
                math.fsum(sign * delta for sign, delta in zip(signs, differences, strict=True))
                >= observed - 1e-14
                for signs in product((-1, 1), repeat=len(differences))
            )
            mean_gain = observed / len(differences)
            p_value = extreme / 2 ** len(differences)
            wins = sum(delta > 0 for delta in differences)
            passed = mean_gain >= 0.01 and p_value <= 0.025 and wins >= 6
            expected = study["contrasts"][control]
            require(
                math.isclose(mean_gain, expected["mean"], rel_tol=0, abs_tol=1e-14)
                and all(
                    math.isclose(actual, recorded, rel_tol=0, abs_tol=1e-14)
                    for actual, recorded in zip(differences, expected["seed_deltas"], strict=True)
                )
                and (p_value, wins, passed) == (expected["one_sided_p"], expected["positive_seeds"], expected["pass"]),
                f"Registered contrast differs: {cohort} versus {control}",
            )
            contrasts[control] = {"mean": mean_gain, "one_sided_p": p_value, "positive_seeds": wins, "pass": passed}
        competent = sum(row["aligned"][0] >= 0.10 for row in paired)
        if cohort == "supervised":
            require(
                study["competent_initializations"] == report[cohort]["competent_initializations"] == competent
                and study["starting_state_sha256"] == report[cohort]["starting_state_sha256"],
                "Supervised starting evidence differs",
            )
        advance = all(contrast["pass"] for contrast in contrasts.values()) and (
            cohort == "cold" or competent >= 6
        )
        require(advance == study["advance"] == report[cohort]["advance"], "Advancement decision differs")
        outcomes[cohort] = {"advance": advance, "competent_starts": competent, "contrasts": contrasts}

    policy_runs = sum(len(seeds) for seeds in studies.values()) * len(arms)
    training_episodes = policy_runs * 128
    heldout_scores = policy_runs * 5
    require(
        (policy_runs, training_episodes, heldout_scores)
        == tuple(report["traces"][field] for field in ("policy_runs", "training_episodes", "archived_holdout_scores")),
        "Reported trace counts differ",
    )
    return {
        "policy_runs": policy_runs,
        "gain_observations": training_episodes,
        "committed_writes": training_episodes * 4,
        "heldout_scores": heldout_scores,
        "studies": outcomes,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    replays = {HEBBIAN: replay_hebbian, GROUP: replay_group, REWARD_TIMING: replay_reward_timing}
    parser.add_argument("seed", choices=replays)
    parser.add_argument("source_root", type=Path, help="Path to the local source project")
    args = parser.parse_args()
    try:
        intake = json.loads(INTAKE.read_text(encoding="utf-8"))
        source = (
            intake["followups"][args.seed]
            if args.seed in intake["followups"]
            else next(draft["source"] for draft in intake["drafts"] if draft["id"] == args.seed)
        )
        root = args.source_root.resolve(strict=True)
        artifacts = {
            role: pinned_bytes(root, spec) for role, spec in source["artifacts"].items()
        }
        result = replays[args.seed](json.loads(artifacts["report"]), artifacts["archive"])
    except (OSError, ValueError, KeyError, ImportError) as error:
        parser.exit(1, f"Replay refused: {error}\n")
    print(json.dumps({"seed": args.seed, "pinned_revision": source["revision"], **result}, sort_keys=True))


if __name__ == "__main__":
    main()
