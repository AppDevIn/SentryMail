use oauth2::basic::BasicClient;
use oauth2::reqwest::async_http_client;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge,
    RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use std::net::TcpListener;
use tauri_plugin_shell::ShellExt;

const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// `gmail.modify` replaced `gmail.readonly` + `gmail.compose` once the client gained
/// mark-read/unread: it is the narrowest Google scope that allows changing a message's labels,
/// and it already covers reading and drafts. It still excludes permanent deletion. Accounts
/// connected under the older scopes keep working read-only for label changes until re-added.
const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/userinfo.email",
];

pub struct OauthConfig {
    pub client_id: String,
    pub client_secret: String,
}

pub struct OauthResult {
    pub email_address: String,
    pub access_token: String,
    pub refresh_token: String,
}

/// Runs the Authorization Code + PKCE + loopback-redirect flow (RFC 8252):
/// opens the system browser (never an embedded webview) so the user
/// authenticates with their normal Google session, then captures the
/// redirect on a short-lived localhost listener.
pub async fn run_oauth_flow(
    app: &tauri::AppHandle,
    config: &OauthConfig,
) -> Result<OauthResult, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let client = BasicClient::new(
        ClientId::new(config.client_id.clone()),
        Some(ClientSecret::new(config.client_secret.clone())),
        AuthUrl::new(GOOGLE_AUTH_URL.to_string()).map_err(|e| e.to_string())?,
        Some(TokenUrl::new(GOOGLE_TOKEN_URL.to_string()).map_err(|e| e.to_string())?),
    )
    .set_redirect_uri(RedirectUrl::new(redirect_uri).map_err(|e| e.to_string())?);

    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();

    let mut auth_request = client
        .authorize_url(CsrfToken::new_random)
        .set_pkce_challenge(pkce_challenge);
    for scope in SCOPES {
        auth_request = auth_request.add_scope(Scope::new(scope.to_string()));
    }
    // Always ask for consent: Google only issues a refresh token on a consent screen, and
    // re-connecting an account (e.g. to grant a newly added scope) must yield a fresh one.
    auth_request = auth_request
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent");
    let (auth_url, csrf_token) = auth_request.url();

    app.shell()
        .open(auth_url.to_string(), None)
        .map_err(|e| format!("failed to open system browser: {e}"))?;

    let server = tiny_http::Server::from_listener(listener, None).map_err(|e| e.to_string())?;
    let (code, state) = tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
        let request = server.recv().map_err(|e| e.to_string())?;
        let full_url =
            oauth2::url::Url::parse(&format!("http://127.0.0.1{}", request.url()))
                .map_err(|e| e.to_string())?;

        let mut code = None;
        let mut state = None;
        for (key, value) in full_url.query_pairs() {
            match key.as_ref() {
                "code" => code = Some(value.into_owned()),
                "state" => state = Some(value.into_owned()),
                _ => {}
            }
        }

        let body = "You're signed in - you can close this tab and return to email-client.";
        let _ = request.respond(tiny_http::Response::from_string(body));

        Ok((
            code.ok_or_else(|| "no authorization code in OAuth callback".to_string())?,
            state.ok_or_else(|| "no state parameter in OAuth callback".to_string())?,
        ))
    })
    .await
    .map_err(|e| e.to_string())??;

    if state != *csrf_token.secret() {
        return Err("OAuth state mismatch - possible CSRF, aborting".to_string());
    }

    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .set_pkce_verifier(pkce_verifier)
        .request_async(async_http_client)
        .await
        .map_err(|e| format!("token exchange failed: {e}"))?;

    let access_token = token.access_token().secret().clone();
    let refresh_token = token
        .refresh_token()
        .ok_or_else(|| {
            "Google did not return a refresh token - revoke prior access at \
             https://myaccount.google.com/permissions and reconnect the account"
                .to_string()
        })?
        .secret()
        .clone();

    let email_address = fetch_email_address(&access_token).await?;

    Ok(OauthResult {
        email_address,
        access_token,
        refresh_token,
    })
}

async fn fetch_email_address(access_token: &str) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct UserInfo {
        email: String,
    }

    let resp = reqwest::Client::new()
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json::<UserInfo>()
        .await
        .map_err(|e| e.to_string())?;

    Ok(resp.email)
}

/// Revokes a refresh token at Google so the grant disappears from the user's account
/// permissions (used when an inbox is removed from this device). Best effort.
pub async fn revoke_token(token: &str) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .post("https://oauth2.googleapis.com/revoke")
        .form(&[("token", token)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("revoke returned {}", resp.status()))
    }
}

/// Exchanges a stored refresh token for a fresh access token. Called before
/// every Gmail API request rather than caching a long-lived access token.
pub async fn refresh_access_token(
    config: &OauthConfig,
    refresh_token: &str,
) -> Result<String, String> {
    let client = BasicClient::new(
        ClientId::new(config.client_id.clone()),
        Some(ClientSecret::new(config.client_secret.clone())),
        AuthUrl::new(GOOGLE_AUTH_URL.to_string()).map_err(|e| e.to_string())?,
        Some(TokenUrl::new(GOOGLE_TOKEN_URL.to_string()).map_err(|e| e.to_string())?),
    );

    let token = client
        .exchange_refresh_token(&oauth2::RefreshToken::new(refresh_token.to_string()))
        .request_async(async_http_client)
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?;

    Ok(token.access_token().secret().clone())
}
