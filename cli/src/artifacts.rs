#[derive(Debug, clap::Subcommand)]
pub enum ArtifactCommand {
    /// List private uploads accessible to your current Fellow, one page at a time.
    List {
        /// Exclusive upload ID from the previous page's next_after.
        #[arg(long, value_name = "UPLOAD_ID")]
        after: Option<String>,
        /// Maximum uploads on this page (1–50; Worker default 20).
        #[arg(long)]
        limit: Option<u8>,
        /// Explicit JSON output; the complete inventory is always printed.
        #[arg(long)]
        json: bool,
    },
    /// Inspect verification, upload progress and recovery metadata for an owned upload.
    Status {
        /// Upload ID from the inventory or original upload receipt.
        upload_id: String,
        /// Explicit JSON output; the complete status is always printed.
        #[arg(long)]
        json: bool,
    },
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.strip_prefix("AU-").is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    }) {
        return Ok(());
    }
    Err("Use an upload ID from your artifact inventory or receipt (AU- followed by 32 lowercase hex digits).".to_owned())
}

impl ArtifactCommand {
    pub(crate) fn read_path(&self) -> Result<(String, String), String> {
        match self {
            Self::List { after, limit, .. } => {
                let mut params = url::form_urlencoded::Serializer::new(String::new());
                if let Some(after) = after {
                    validate_id(after)?;
                    params.append_pair("after", after);
                }
                if let Some(limit) = limit {
                    if !(1..=50).contains(limit) {
                        return Err(
                            "--limit must be from 1 to 50 for an artifact inventory page."
                                .to_owned(),
                        );
                    }
                    params.append_pair("limit", &limit.to_string());
                }
                let query = params.finish();
                let mut path = "/v1/artifacts".to_owned();
                if !query.is_empty() {
                    path.push('?');
                    path.push_str(&query);
                }
                Ok((path, "artifact list".to_owned()))
            }
            Self::Status { upload_id, .. } => {
                validate_id(upload_id)?;
                Ok((
                    format!("/v1/artifacts/{upload_id}"),
                    "artifact status".to_owned(),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{Cli, FetchError, Fetched, run_cli_with_fetch, token_for_command};
    use clap::Parser;

    const ID: &str = "AU-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const INVENTORY: &str =
        include_str!("../../packages/contracts/test/fixtures/valid/artifact-inventory.json");

    fn cli(args: &[&str]) -> Cli {
        Cli::try_parse_from(
            ["asimp", "--origin", "https://example.test", "artifact"]
                .into_iter()
                .chain(args.iter().copied()),
        )
        .unwrap()
    }

    #[test]
    fn artifact_reads_require_a_token_and_preserve_each_complete_worker_face() {
        for (args, path, body) in [
            (vec!["list"], "/v1/artifacts".to_owned(), INVENTORY),
            (
                vec!["list", "--after", ID, "--limit", "50", "--json"],
                format!("/v1/artifacts?after={ID}&limit=50"),
                INVENTORY,
            ),
            (
                vec!["status", ID, "--json"],
                format!("/v1/artifacts/{ID}"),
                "{\"verification\":\"bytes-only\",\"content_path\":\"/v1/artifacts/AU-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/content\"}\n",
            ),
        ] {
            let invocation = cli(&args);
            assert!(
                token_for_command(&invocation.command, || Err(std::env::VarError::NotPresent))
                    .is_err()
            );
            assert!(invocation.command.write_request().is_none());
            let output = run_cli_with_fetch(&invocation, |url| {
                assert_eq!(url, format!("https://example.test{path}"));
                Ok(Fetched {
                    status: 200,
                    body: body.to_owned(),
                })
            });
            assert_eq!(output.exit_code, 0);
            assert_eq!(output.stdout, body);
            assert!(output.stderr.is_empty());
        }
    }

    #[test]
    fn artifact_reads_refuse_invalid_inputs_before_transport_and_keep_errors_private() {
        for args in [
            vec!["list", "--after", "//private.test"],
            vec!["list", "--limit", "0"],
            vec!["list", "--limit", "51"],
            vec!["status", "../private"],
            vec!["status", "AU-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaA"],
            vec!["status", "AU-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/content"],
        ] {
            let output =
                run_cli_with_fetch(&cli(&args), |_| panic!("invalid inputs reached transport"));
            assert_eq!(output.exit_code, 2);
            assert!(output.stdout.is_empty());
            if args[0] == "status" || args.contains(&"--after") {
                assert!(!output.stderr.contains(args.last().unwrap()));
            }
        }
        let output = run_cli_with_fetch(&cli(&["status", ID]), |_| Err(FetchError::Status(404)));
        assert_eq!(output.exit_code, 1);
        assert!(output.stdout.is_empty());
        assert!(!output.stderr.contains(ID));
        assert!(output.stderr.contains("asimp artifact list"));
    }
}
