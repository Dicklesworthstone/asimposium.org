//! Offline structural validation against the same generated schemas served by Stoa.
//! Never load a schema from caller input, retrieve a reference, or render validator
//! errors: those errors can contain private values and unknown property names.

use crate::CliOutput;
use serde_json::{Value, json};
use std::path::PathBuf;

const ORIGIN: &str = "https://a.asimposium.org";
const MAX_DIAGNOSTICS: usize = 20;
const BOUNDARY: &str = "Checks bundled published JSON Schema only. Worker authorization, publication checks, screening, relational refinements and scientific validity remain separate.";
const UNSUPPORTED_PATTERN: &str = "The published schema contains ECMAScript surrogate-range patterns that this validator cannot evaluate. Its patterns have not been changed or skipped; use the Worker's validation for this schema.";

// jsonschema 0.61.1 offers Rust regex and fancy-regex engines, neither of which
// can represent these ECMAScript surrogate ranges. Do not weaken the published
// patterns. The catalog test proves every other selector compiles and requires
// these explicit exclusions to remain justified by an actual compile failure.
const UNSUPPORTED_SELECTORS: &[&str] = &[
    "enrollment.v1",
    "enrollment.v1/operator_fellow_cap_audit_page_response",
    "enrollment.v1/operator_fellow_cap_override_request",
    "ledger.v1",
    "ledger.v1/problem_face_response",
];

#[derive(Debug, clap::Args)]
pub struct ValidateArgs {
    /// Regular UTF-8 JSON file, at most 512 KiB. Input is never uploaded.
    #[arg(
        value_name = "JSON_FILE",
        required_unless_present = "list_schemas",
        conflicts_with = "list_schemas"
    )]
    pub file: Option<PathBuf>,
    /// Bundled selector, /schemas/...json path, or canonical published schema URL.
    #[arg(
        long,
        value_name = "SCHEMA",
        required_unless_present = "list_schemas",
        conflicts_with = "list_schemas"
    )]
    pub schema: Option<String>,
    /// List the exact documents and slices supported by this binary, without a file.
    #[arg(long, conflicts_with_all = ["file", "schema"])]
    pub list_schemas: bool,
    /// Print a bounded JSON report; exit 0 for valid, 1 for invalid, 2 for input/setup errors.
    #[arg(long)]
    pub json: bool,
}

struct BundledDocument {
    id: &'static str,
    text: &'static str,
}

// Keep this a closed subset of packages/contracts/src/public-schemas.ts. The
// catalog makes the subset explicit. In particular, batch is not published and
// directives is a documentation bundle, not a schema for a request body.
const DOCUMENTS: &[BundledDocument] = &[
    BundledDocument {
        id: "enrollment",
        text: include_str!("../../packages/contracts/generated/enrollment.schema.json"),
    },
    BundledDocument {
        id: "inbox",
        text: include_str!("../../packages/contracts/generated/inbox.schema.json"),
    },
    BundledDocument {
        id: "ledger",
        text: include_str!("../../packages/contracts/generated/ledger.schema.json"),
    },
    BundledDocument {
        id: "moves",
        text: include_str!("../../packages/contracts/generated/moves.schema.json"),
    },
    BundledDocument {
        id: "problem",
        text: include_str!("../../packages/contracts/generated/problem.schema.json"),
    },
    BundledDocument {
        id: "problems",
        text: include_str!("../../packages/contracts/generated/problems.schema.json"),
    },
    BundledDocument {
        id: "sessions",
        text: include_str!("../../packages/contracts/generated/sessions.schema.json"),
    },
];

struct SchemaEntry {
    selector: String,
    path: String,
    url: String,
    property: Option<String>,
}

impl SchemaEntry {
    fn new(id: &str, property: Option<&str>) -> Self {
        let selector = match property {
            Some(property) => format!("{id}.v1/{property}"),
            None => format!("{id}.v1"),
        };
        let path = format!("/schemas/{selector}.json");
        Self {
            url: format!("{ORIGIN}{path}"),
            path,
            selector,
            property: property.map(str::to_owned),
        }
    }

    fn matches(&self, supplied: &str) -> bool {
        // Exact equality, not URL/path normalization: no alternate hosts,
        // fragments, percent encodings, traversal or arbitrary file loading.
        supplied == self.selector || supplied == self.path || supplied == self.url
    }

    fn as_json(&self) -> Value {
        json!({
            "selector": self.selector,
            "schema": self.url,
            "kind": if self.property.is_some() { "slice" } else { "document" },
        })
    }

    fn is_supported(&self) -> bool {
        !UNSUPPORTED_SELECTORS.contains(&self.selector.as_str())
    }
}

fn parse_document(document: &BundledDocument) -> Result<Value, ()> {
    let value: Value = serde_json::from_str(document.text).map_err(|_| ())?;
    if value["$id"] != SchemaEntry::new(document.id, None).url {
        return Err(());
    }
    Ok(value)
}

fn entries(document: &BundledDocument, schema: &Value) -> Vec<SchemaEntry> {
    let mut entries = vec![SchemaEntry::new(document.id, None)];
    if let Some(properties) = schema["properties"].as_object() {
        for (property, subschema) in properties {
            // Mirror the public slice builder: top-level, own, schema-valued
            // properties with a path-safe name and no $ref anywhere in the slice.
            if !property.is_empty()
                && property.len() <= 80
                && property
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
                && subschema.is_object()
                && !subschema.to_string().contains("\"$ref\"")
            {
                entries.push(SchemaEntry::new(document.id, Some(property)));
            }
        }
    }
    entries
}

fn selected_schema(parent: &Value, entry: &SchemaEntry) -> Value {
    let Some(property) = &entry.property else {
        return parent.clone();
    };
    let mut schema = parent["properties"][property].clone();
    if schema.get("$schema").is_none()
        && let Some(draft) = parent.get("$schema")
    {
        schema["$schema"] = draft.clone();
    }
    schema["$id"] = json!(entry.url);
    // The remaining Worker slice metadata does not change validation, but
    // preserve it so the selected schema has the same published identity.
    if schema.get("title").is_none() {
        let document_id = entry
            .selector
            .split_once(".v1")
            .map_or(entry.selector.as_str(), |(id, _)| id);
        schema["title"] = json!(format!(
            "{} · {property}",
            parent["title"].as_str().unwrap_or(document_id)
        ));
    }
    schema["x-asimposium-slice-of"] = json!(format!(
        "{}#/properties/{property}",
        parent["$id"].as_str().unwrap_or("")
    ));
    schema
}

fn resolve_schema(selector: &str) -> Result<Option<(SchemaEntry, Value)>, ()> {
    for document in DOCUMENTS {
        let parent = parse_document(document)?;
        for entry in entries(document, &parent) {
            if entry.matches(selector) {
                let schema = selected_schema(&parent, &entry);
                return Ok(Some((entry, schema)));
            }
        }
    }
    Ok(None)
}

fn validator(
    schema: &Value,
) -> Result<jsonschema::Validator, jsonschema::error::ValidationError<'static>> {
    jsonschema::options()
        .offline()
        .should_validate_formats(true)
        .should_ignore_unknown_formats(false)
        .build(schema)
}

fn diagnostic(schema_path: &str) -> Value {
    let (code, message) = match schema_path.rsplit('/').next().unwrap_or("") {
        "required" => ("required", "One or more required properties are missing."),
        "additionalProperties" => (
            "additional_properties",
            "An undeclared property is present.",
        ),
        "type" => ("type", "A value has the wrong JSON type."),
        "enum" | "const" => (
            "allowed_value",
            "A value is outside the schema's allowed choices.",
        ),
        "pattern" | "format" => (
            "string_format",
            "A string does not match the required format.",
        ),
        "minLength" | "maxLength" => ("string_length", "A string is outside the allowed length."),
        "minItems" | "maxItems" => ("array_length", "An array is outside the allowed length."),
        "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" | "multipleOf" => (
            "number_range",
            "A number does not meet the schema's bounds.",
        ),
        "anyOf" | "oneOf" | "allOf" | "not" => (
            "schema_combination",
            "The value does not satisfy the permitted schema shapes.",
        ),
        _ => (
            "schema_constraint",
            "A published schema constraint is not satisfied.",
        ),
    };
    // Only the trusted schema location is rendered. ValidationError Display,
    // instance_path and nested error contexts can all disclose unknown keys or
    // private values, even when the validator's value masking option is enabled.
    json!({ "code": code, "schema_path": format!("#{schema_path}"), "message": message })
}

fn report(
    args: &ValidateArgs,
    schema: Option<&str>,
    valid: Option<bool>,
    diagnostics: Vec<Value>,
    truncated: bool,
    exit_code: i32,
) -> CliOutput {
    let result = json!({
        "format": "asimp.validation.v1",
        "validation": "structural",
        "schema": schema,
        "structural_valid": valid,
        "diagnostics": diagnostics,
        "diagnostics_truncated": truncated,
        "boundary": BOUNDARY,
    });
    if args.json {
        return CliOutput {
            exit_code,
            stdout: format!(
                "{}\n",
                serde_json::to_string_pretty(&result).expect("JSON report")
            ),
            stderr: String::new(),
        };
    }
    let status = match valid {
        Some(true) => "Structural validation passed.",
        Some(false) => "Structural validation failed.",
        None => "Structural validation could not run.",
    };
    let mut text = format!("{status}\n");
    if let Some(schema) = schema {
        text.push_str(&format!("Schema: {schema}\n"));
    }
    for item in result["diagnostics"].as_array().expect("diagnostic array") {
        text.push_str(item["message"].as_str().unwrap_or("Validation failed."));
        if let Some(location) = item["schema_path"].as_str() {
            text.push_str(&format!(" Schema location: {location}"));
        }
        text.push('\n');
    }
    if truncated {
        text.push_str("Additional diagnostics were omitted.\n");
    }
    text.push_str(BOUNDARY);
    text.push('\n');
    CliOutput {
        exit_code,
        stdout: if exit_code == 2 {
            String::new()
        } else {
            text.clone()
        },
        stderr: if exit_code == 2 { text } else { String::new() },
    }
}

fn error(args: &ValidateArgs, schema: Option<&str>, code: &str, message: &str) -> CliOutput {
    report(
        args,
        schema,
        None,
        vec![json!({ "code": code, "message": message })],
        false,
        2,
    )
}

pub fn run(args: &ValidateArgs) -> CliOutput {
    if args.list_schemas {
        let mut catalog = Vec::new();
        let mut unsupported = Vec::new();
        for document in DOCUMENTS {
            let Ok(parent) = parse_document(document) else {
                return error(
                    args,
                    None,
                    "bundled_schema",
                    "A bundled schema is unavailable; rebuild this CLI from the repository.",
                );
            };
            for entry in entries(document, &parent) {
                let mut item = entry.as_json();
                if entry.is_supported() {
                    catalog.push(item);
                } else {
                    item["code"] = json!("unsupported_pattern");
                    item["message"] = json!(UNSUPPORTED_PATTERN);
                    unsupported.push(item);
                }
            }
        }
        let stdout = if args.json {
            let result = json!({
                "format": "asimp.schema_catalog.v1",
                "validation": "structural",
                "schemas": catalog,
                "unsupported_schemas": unsupported,
                "boundary": BOUNDARY,
            });
            format!(
                "{}\n",
                serde_json::to_string_pretty(&result).expect("JSON catalog")
            )
        } else {
            let mut text = String::from(
                "Bundled published schema selectors (use a request slice for a request body):\n",
            );
            for entry in catalog {
                text.push_str(entry["selector"].as_str().expect("catalog selector"));
                text.push('\n');
            }
            text.push_str("Bundled selectors currently unsupported by this validator:\n");
            for entry in unsupported {
                text.push_str(entry["selector"].as_str().expect("catalog selector"));
                text.push('\n');
            }
            text.push_str(UNSUPPORTED_PATTERN);
            text.push('\n');
            text.push_str(BOUNDARY);
            text.push('\n');
            text
        };
        return CliOutput {
            exit_code: 0,
            stdout,
            stderr: String::new(),
        };
    }
    let (Some(path), Some(selector)) = (&args.file, &args.schema) else {
        return error(
            args,
            None,
            "input",
            "Supply a JSON file and --schema, or use --list-schemas.",
        );
    };
    let (entry, schema) = match resolve_schema(selector) {
        Ok(Some(selected)) => selected,
        Ok(None) => {
            return error(
                args,
                None,
                "unknown_schema",
                "Unknown schema selector; use --list-schemas for this binary's exact supported set.",
            );
        }
        Err(_) => {
            return error(
                args,
                None,
                "bundled_schema",
                "A bundled schema is unavailable; rebuild this CLI from the repository.",
            );
        }
    };
    if !entry.is_supported() {
        return error(
            args,
            Some(&entry.url),
            "unsupported_schema",
            UNSUPPORTED_PATTERN,
        );
    }
    let text = match crate::read_request_file(path) {
        Ok(text) => text,
        Err(_) => {
            return error(
                args,
                Some(&entry.url),
                "input_file",
                "Cannot read input: supply an accessible regular UTF-8 file of at most 512 KiB.",
            );
        }
    };
    let instance: Value = match serde_json::from_str(&text) {
        Ok(instance) => instance,
        Err(_) => {
            return error(
                args,
                Some(&entry.url),
                "malformed_json",
                "Input must contain exactly one valid JSON value.",
            );
        }
    };
    let validator = match validator(&schema) {
        Ok(validator) => validator,
        Err(_) => {
            return error(
                args,
                Some(&entry.url),
                "bundled_schema",
                "The bundled schema cannot be evaluated offline; rebuild this CLI from the repository.",
            );
        }
    };
    let mut diagnostics: Vec<Value> = validator
        .iter_errors(&instance)
        .take(MAX_DIAGNOSTICS + 1)
        .map(|failure| diagnostic(&failure.schema_path().to_string()))
        .collect();
    let truncated = diagnostics.len() > MAX_DIAGNOSTICS;
    diagnostics.truncate(MAX_DIAGNOSTICS);
    let valid = diagnostics.is_empty();
    report(
        args,
        Some(&entry.url),
        Some(valid),
        diagnostics,
        truncated,
        if valid { 0 } else { 1 },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_catalog_compiles_and_slices_preserve_published_constraints() {
        let mut unexpected = Vec::new();
        let mut excluded = 0;
        for document in DOCUMENTS {
            let parent = parse_document(document).unwrap();
            for entry in entries(document, &parent) {
                let schema = selected_schema(&parent, &entry);
                match validator(&schema) {
                    Ok(_) if !entry.is_supported() => {
                        unexpected.push(format!(
                            "{} compiles; remove its stale exclusion",
                            entry.selector
                        ));
                    }
                    Err(error) if entry.is_supported() => {
                        unexpected.push(format!("{}: {error}", entry.selector));
                    }
                    Err(_) => excluded += 1,
                    Ok(_) => {}
                }
                if let Some(property) = &entry.property {
                    assert_eq!(schema["type"], parent["properties"][property]["type"]);
                    assert_eq!(
                        schema["required"],
                        parent["properties"][property]["required"]
                    );
                    assert_eq!(
                        schema["properties"],
                        parent["properties"][property]["properties"]
                    );
                }
            }
        }
        assert!(unexpected.is_empty(), "{}", unexpected.join("\n"));
        assert_eq!(excluded, UNSUPPORTED_SELECTORS.len());
    }

    #[test]
    fn remote_references_are_refused_and_local_references_work_offline() {
        assert!(
            validator(&json!({"$ref": "https://example.invalid/private-schema.json"})).is_err()
        );
        let local = validator(&json!({
            "$defs": {"text": {"type": "string"}},
            "$ref": "#/$defs/text"
        }))
        .unwrap();
        assert!(local.is_valid(&json!("text")));
        assert!(!local.is_valid(&json!(7)));
    }

    #[test]
    fn published_slices_preserve_child_metadata_and_always_assign_their_own_identity() {
        let parent = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": "https://a.asimposium.org/schemas/sessions.v1.json",
            "properties": {
                "request": {
                    "$schema": "http://json-schema.org/draft-07/schema#",
                    "$id": "https://example.invalid/original.json",
                    "title": "Child title",
                    "type": "string"
                },
                "other": { "type": "integer" }
            }
        });
        let child = selected_schema(&parent, &SchemaEntry::new("sessions", Some("request")));
        assert_eq!(child["$schema"], "http://json-schema.org/draft-07/schema#");
        assert_eq!(child["title"], "Child title");
        assert_eq!(
            child["$id"],
            "https://a.asimposium.org/schemas/sessions.v1/request.json"
        );
        let inherited = selected_schema(&parent, &SchemaEntry::new("sessions", Some("other")));
        assert_eq!(inherited["$schema"], parent["$schema"]);
        assert_eq!(inherited["title"], "sessions · other");
    }
}
