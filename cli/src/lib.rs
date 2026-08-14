use clap::Parser;

/// Parsed command line for the optional `asimp` companion.
///
/// The CLI deliberately has no product commands in OPS.1. Adding a command is
/// a later capability and must preserve curl as a complete alternative.
#[derive(Debug, Parser)]
#[command(
    name = "asimp",
    version,
    about = "Optional ASImposium command-line companion. Curl remains sufficient.",
    long_about = "Optional ASImposium command-line companion. Curl remains sufficient. OPS.1 exposes no product commands yet."
)]
pub struct Cli {}

#[cfg(test)]
mod tests {
    use clap::{CommandFactory, Parser, error::ErrorKind};

    use super::Cli;

    #[test]
    fn help_describes_asimp_as_optional() {
        let help = Cli::command().render_help().to_string();

        assert!(help.contains("Usage: asimp"));
        assert!(help.contains("Curl remains sufficient."));
    }

    #[test]
    fn command_like_input_is_rejected_before_product_commands_exist() {
        let error = Cli::try_parse_from(["asimp", "session"])
            .expect_err("OPS.1 must not silently accept an unimplemented command");

        assert_eq!(error.kind(), ErrorKind::UnknownArgument);
        assert!(
            error
                .to_string()
                .contains("unexpected argument 'session' found")
        );
    }
}
