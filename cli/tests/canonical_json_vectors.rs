//! The Rust consumer of the shared canonical-JSON golden vectors (bead
//! asimposiumorg-phg): the same file the Worker's TypeScript codec is tested
//! against, so the two implementations cannot drift apart silently.

use asimp::canonical_json::canonical_json;
use serde_json::Value;

// A byte-identical copy of packages/contracts/test/fixtures/canonical-json.vectors.json
// (the crate builds in isolation); packages/contracts/test/unit/canonical-json.test.ts
// fails if the two drift.
const VECTORS: &str = include_str!("fixtures/canonical-json.vectors.json");

#[test]
fn every_golden_vector_matches_or_is_reported_skipped() {
    let doc: Value = serde_json::from_str(VECTORS).expect("vectors file parses");
    let vectors = doc["vectors"].as_array().expect("vectors array");
    let mut checked = 0;
    let mut skipped = Vec::new();
    for vector in vectors {
        let id = vector["id"].as_str().expect("vector id");
        let requires: Vec<&str> = vector["requires"]
            .as_array()
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        // serde_json refuses lone surrogates, so that capability is absent here.
        if requires.contains(&"lone-surrogates") {
            skipped.push(id.to_string());
            continue;
        }
        let input: Value = serde_json::from_str(vector["input"].as_str().expect("input"))
            .unwrap_or_else(|error| panic!("{id}: input parses: {error}"));
        let expected = vector["canonical"].as_str().expect("canonical");
        assert_eq!(canonical_json(&input).expect(id), expected, "vector {id}");
        let again: Value = serde_json::from_str(expected).expect("canonical parses");
        assert_eq!(
            canonical_json(&again).expect(id),
            expected,
            "fixed point {id}"
        );
        checked += 1;
    }
    assert!(checked >= 10, "vectors checked: {checked}");
    // Skips are reported, never silent.
    println!("canonical-json vectors: checked {checked}, skipped {skipped:?}");
    assert_eq!(skipped, vec!["lone-surrogate-escaped".to_string()]);
}
