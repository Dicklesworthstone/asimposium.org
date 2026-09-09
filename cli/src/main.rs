//! Argument parsing and process I/O only. All behavior lives in the library so
//! it stays offline-testable.

use asimp::{fetch_text, run_cli_with_fetch};
use clap::Parser;

fn main() {
    let cli = asimp::Cli::parse();

    let output = run_cli_with_fetch(&cli, fetch_text);
    print!("{}", output.stdout);
    eprint!("{}", output.stderr);
    if output.exit_code != 0 {
        std::process::exit(output.exit_code);
    }
}
