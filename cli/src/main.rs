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
        Command::Get { path } => (path.clone(), path.clone()),
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
            println!("{}", fetched.body);
        }
        Err(FetchError::Status(status, body)) => {
            eprintln!("asimp: {label} returned HTTP {status}");
            if !body.is_empty() {
                eprintln!("{body}");
            }
            std::process::exit(1);
        }
        Err(FetchError::Network(error)) => {
            eprintln!("asimp: {label} failed: {error}");
            std::process::exit(2);
        }
    }
}
