//! Keep the SDK's request/response models; use the shared HTTP boundary so
//! Retry-After and status codes are available for every Alpaca endpoint.
use std::collections::HashMap;

use apca::{
    ApiInfo,
    api::v2::calendar,
    data::v2::{bars, last_quotes},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::provider_access::ProviderAccess;

pub struct AlpacaHttp {
    info: ApiInfo,
    access: ProviderAccess,
}

impl AlpacaHttp {
    pub fn new(info: ApiInfo, access: ProviderAccess) -> Self {
        Self { info, access }
    }

    async fn get<T: DeserializeOwned>(
        &self,
        trading: bool,
        path: &str,
        resource: &str,
        query: &impl Serialize,
    ) -> anyhow::Result<T> {
        let base = if trading {
            &self.info.api_base_url
        } else {
            &self.info.data_base_url
        };
        let url = base.join(path)?;
        self.access
            .json("alpaca", resource, |client| {
                client
                    .get(url)
                    .header("APCA-API-KEY-ID", &self.info.key_id)
                    .header("APCA-API-SECRET-KEY", &self.info.secret)
                    .query(query)
            })
            .await
    }

    pub async fn quotes(
        &self,
        request: &last_quotes::GetReq,
    ) -> anyhow::Result<HashMap<String, last_quotes::Quote>> {
        #[derive(Deserialize)]
        struct Response {
            quotes: HashMap<String, last_quotes::Quote>,
        }
        let resource = format!("quotes:{}", request.symbols.join(","));
        let response: Response = self
            .get(false, "/v2/stocks/quotes/latest", &resource, request)
            .await?;
        Ok(response.quotes)
    }

    pub async fn bars(&self, request: &bars::ListReq) -> anyhow::Result<bars::Bars> {
        let resource = format!("bars:{}", request.symbol);
        self.get(
            false,
            &format!("/v2/stocks/{}/bars", request.symbol),
            &resource,
            request,
        )
        .await
    }

    pub async fn calendar(
        &self,
        request: &calendar::ListReq,
    ) -> anyhow::Result<Vec<calendar::OpenClose>> {
        self.get(true, "/v2/calendar", "calendar", request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::provider_test_support::{MockHttp, database};

    async fn client(server: &MockHttp, access: ProviderAccess) -> anyhow::Result<AlpacaHttp> {
        let mut info = ApiInfo::from_parts(&server.url, "test-key", "test-secret")?;
        info.data_base_url = info.api_base_url.clone();
        Ok(AlpacaHttp::new(info, access))
    }

    #[tokio::test]
    async fn quote_refusal_pauses_bars_and_calendar_even_with_new_client() -> anyhow::Result<()> {
        let server = MockHttp::start(429, "{}", Some("7200")).await?;
        let pool = database().await?;
        let first = client(&server, ProviderAccess::from_pool(pool.clone(), 0.0).await?).await?;
        let quote = last_quotes::GetReqInit::default().init(["AAPL"]);
        assert!(first.quotes(&quote).await.is_err());
        let second = client(&server, ProviderAccess::from_pool(pool, 0.0).await?).await?;
        let now = chrono::Utc::now();
        let bars = bars::ListReqInit::default().init(
            "AAPL",
            now - chrono::Duration::days(5),
            now,
            bars::TimeFrame::OneDay,
        );
        assert!(second.bars(&bars).await.is_err());
        let calendar = calendar::ListReqInit::default().init(now.date_naive(), now.date_naive());
        assert!(second.calendar(&calendar).await.is_err());
        assert_eq!(server.hits(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn protected_transport_preserves_sdk_response_models() -> anyhow::Result<()> {
        let server = MockHttp::start(
            200,
            r#"{"quotes":{"AAPL":{"t":"2026-11-11T15:00:00Z","ap":101,"as":2,"bp":100,"bs":3}}}"#,
            None,
        )
        .await?;
        let client = client(
            &server,
            ProviderAccess::from_pool(database().await?, 0.0).await?,
        )
        .await?;
        let quote = last_quotes::GetReqInit::default().init(["AAPL"]);
        assert_eq!(client.quotes(&quote).await?["AAPL"].ask_size, 2);
        *server.body.lock().map_err(|_|anyhow::anyhow!("fixture lock"))?=r#"{"symbol":"AAPL","bars":[{"t":"2026-11-10T05:00:00Z","o":100,"h":105,"l":99,"c":102,"v":1000,"vw":101}],"next_page_token":null}"#.into();
        let now = chrono::Utc::now();
        let bars = bars::ListReqInit::default().init(
            "AAPL",
            now - chrono::Duration::days(5),
            now,
            bars::TimeFrame::OneDay,
        );
        assert_eq!(client.bars(&bars).await?.bars.len(), 1);
        *server
            .body
            .lock()
            .map_err(|_| anyhow::anyhow!("fixture lock"))? =
            r#"[{"date":"2026-11-11","open":"09:30","close":"16:00"}]"#.into();
        let calendar = calendar::ListReqInit::default().init(now.date_naive(), now.date_naive());
        assert_eq!(client.calendar(&calendar).await?.len(), 1);
        Ok(())
    }
}
