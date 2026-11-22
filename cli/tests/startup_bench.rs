//! W11.5 CLI warm-startup performance benchmark gate (`asimposiumorg-85s` / W10.7).
//!
//! Run explicitly against an optimized `--release` build (for example via RCH or CI):
//!   cargo test --release --locked --manifest-path cli/Cargo.toml --test startup_bench -- --ignored --nocapture
//!
//! Marked `#[ignore]` so ordinary unoptimized debug `cargo test` runs never report
//! fake startup numbers. Refuses to execute under `debug_assertions`.

use std::process::Command;
use std::time::Instant;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    let clamped = idx.saturating_sub(1).min(sorted.len() - 1);
    sorted[clamped]
}

fn measure_flag(bin: &str, flag: &str, warmup: usize, samples: usize) -> (f64, f64, f64, f64, f64) {
    let isolated_home = std::env::temp_dir().join(format!(
        "asimp-startup-bench-{}-{}",
        std::process::id(),
        flag.trim_start_matches('-')
    ));
    let _ = std::fs::create_dir_all(&isolated_home);

    for _ in 0..warmup {
        let out = Command::new(bin)
            .arg(flag)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &isolated_home)
            .env("LC_ALL", "C")
            .output()
            .expect("spawn warmup asimp");
        assert!(
            out.status.success(),
            "warmup {flag} exited {:?}",
            out.status.code()
        );
    }

    let mut timings = Vec::with_capacity(samples);
    for _ in 0..samples {
        let start = Instant::now();
        let out = Command::new(bin)
            .arg(flag)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &isolated_home)
            .env("LC_ALL", "C")
            .output()
            .expect("spawn timed asimp");
        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert!(
            out.status.success(),
            "timed {flag} exited {:?}",
            out.status.code()
        );
        timings.push(elapsed_ms);
    }

    let _ = std::fs::remove_dir_all(&isolated_home);
    timings.sort_by(|a, b| a.total_cmp(b));
    (
        timings[0],
        percentile(&timings, 50.0),
        percentile(&timings, 95.0),
        percentile(&timings, 99.0),
        timings[timings.len() - 1],
    )
}

#[test]
#[ignore = "W11.5 release-only warm-start benchmark gate; invoke with cargo test --release --test startup_bench -- --ignored --nocapture"]
fn release_warm_startup_meets_100ms_p95_budget() {
    if cfg!(debug_assertions) {
        panic!("BENCH_NON_RELEASE_BINARY_REFUSED: startup_bench must run under --release profile");
    }

    let bin = env!("CARGO_BIN_EXE_asimp");
    let budget_ms = 100.0_f64;
    let warmup = 5;
    let samples = 50;

    let (v_min, v_p50, v_p95, v_p99, v_max) = measure_flag(bin, "--version", warmup, samples);
    let (h_min, h_p50, h_p95, h_p99, h_max) = measure_flag(bin, "--help", warmup, samples);

    println!(
        "STARTUP_BENCH_RECEIPT os={} arch={} warmup={} samples={} budget_ms={:.1} version_ms=[min={:.3},p50={:.3},p95={:.3},p99={:.3},max={:.3}] help_ms=[min={:.3},p50={:.3},p95={:.3},p99={:.3},max={:.3}]",
        std::env::consts::OS,
        std::env::consts::ARCH,
        warmup,
        samples,
        budget_ms,
        v_min,
        v_p50,
        v_p95,
        v_p99,
        v_max,
        h_min,
        h_p50,
        h_p95,
        h_p99,
        h_max,
    );

    assert!(
        v_p95 < budget_ms,
        "asimp --version warm p95 {v_p95:.3}ms exceeded budget {budget_ms:.1}ms"
    );
    assert!(
        h_p95 < budget_ms,
        "asimp --help warm p95 {h_p95:.3}ms exceeded budget {budget_ms:.1}ms"
    );
}
