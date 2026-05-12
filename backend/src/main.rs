use agent_foundry_backend::{App, config::Settings, telemetry};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    let settings = Settings::from_env()?;
    telemetry::init(&settings)?;
    App::build(settings).await?.run().await
}
