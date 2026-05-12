use std::{net::IpAddr, path::PathBuf};

use anyhow::{Context, bail};

#[derive(Debug, Clone)]
pub struct Settings {
    pub app_env: AppEnv,
    pub host: IpAddr,
    pub port: u16,
    pub database_url: String,
    pub csv_path: PathBuf,
    pub pdf_path: PathBuf,
    pub pdf_text_path: Option<PathBuf>,
    pub log_format: LogFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppEnv {
    Local,
    Production,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogFormat {
    Pretty,
    Json,
}

impl Settings {
    pub fn from_env() -> anyhow::Result<Self> {
        let app_env = match env_or("APP_ENV", "local").as_str() {
            "local" | "development" => AppEnv::Local,
            "production" | "prod" => AppEnv::Production,
            other => bail!("unsupported APP_ENV '{other}'"),
        };

        let host = env_or("HOST", "127.0.0.1")
            .parse()
            .context("HOST must be a valid IP address")?;
        let port = env_or("PORT", "8080")
            .parse()
            .context("PORT must be a valid u16")?;
        let database_url = env_or("DATABASE_URL", "sqlite://data/agent_foundry.db");
        let csv_path = csv_path_from_env();
        let pdf_path = PathBuf::from(env_or("PDF_PATH", "data/Vermögensübersicht.pdf"));
        let pdf_text_path = Some(PathBuf::from(env_or(
            "PDF_TEXT_PATH",
            "data/asset_overview_extracted.txt",
        )));
        let log_format = match env_or("LOG_FORMAT", "pretty").as_str() {
            "pretty" => LogFormat::Pretty,
            "json" => LogFormat::Json,
            other => bail!("unsupported LOG_FORMAT '{other}'"),
        };

        Ok(Self {
            app_env,
            host,
            port,
            database_url,
            csv_path,
            pdf_path,
            pdf_text_path,
            log_format,
        })
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_owned())
}

fn csv_path_from_env() -> PathBuf {
    if let Ok(path) = std::env::var("CSV_PATH") {
        return PathBuf::from(path);
    }

    let preferred = PathBuf::from("data/Transaktionsexport.csv");
    if preferred.exists() {
        preferred
    } else {
        PathBuf::from("data/Transaktionsexport(2).csv")
    }
}
