use clap::Parser;

fn main() {
    // Clap owns the machine-safe exit behavior for this scaffold: `--help` and
    // `--version` succeed, while unsupported arguments produce a nonzero exit
    // with a copy-pasteable help hint on stderr.
    let _ = asimp::Cli::parse();
}
