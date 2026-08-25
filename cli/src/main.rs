//! Argument parsing and exit-code policy only. All behavior lives in the
//! library so it stays offline-testable.

use asimp::{Command, FetchError, build_url, fetch_text, problems_path, resolve_origin};
use clap::Parser;

fn main() {
    let cli = asimp::Cli::parse();

    let origin = match resolve_origin(cli.origin.as_ref()) {
        Ok(origin) => origin,
        Err(error) => {
            eprintln!("asimp: {error}");
            std::process::exit(2);
        }
    };

    let (path, label) = match &cli.command {
        Command::Capabilities => ("/capabilities".to_string(), "/capabilities".to_string()),
        Command::Problems { json } => {
            let path = problems_path(*json).to_string();
            let label = path.clone();
            (path, label)
        }
        Command::Get { path } => (path.clone(), "GET request".to_string()),
    };

    let url = match build_url(&origin, &path) {
        Ok(url) => url,
        Err(error) => {
            eprintln!("asimp: {error}");
            std::process::exit(2);
        }
    };

    match fetch_text(&url) {
        Ok(fetched) => {
            print!("{}", fetched.body);
        }
        Err(FetchError::Status(status)) => {
            eprintln!("asimp: {label} returned HTTP {status}");
            std::process::exit(1);
        }
        Err(FetchError::Network) => {
            eprintln!("asimp: {label} failed: network or response read error");
            std::process::exit(2);
        }
        Err(FetchError::InvalidUtf8) => {
            eprintln!("asimp: {label} failed: response body is not valid UTF-8");
            std::process::exit(2);
        }
        Err(FetchError::BodyTooLarge { limit_bytes }) => {
            eprintln!("asimp: {label} failed: response exceeds the {limit_bytes}-byte limit");
            std::process::exit(2);
        }
    }
}
