use anyhow::Context;
use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

use crate::config::{LogFormat, Settings};

pub fn init(settings: &Settings) -> anyhow::Result<()> {
    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("agent_foundry_backend=info,tower_http=info"))
        .context("failed to configure log filter")?;

    match settings.log_format {
        LogFormat::Pretty => tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer())
            .try_init()
            .context("failed to initialize logging")?,
        LogFormat::Json => tracing_subscriber::registry()
            .with(filter)
            .with(fmt::layer().json())
            .try_init()
            .context("failed to initialize logging")?,
    }

    Ok(())
}
