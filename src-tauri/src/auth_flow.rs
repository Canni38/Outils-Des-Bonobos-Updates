use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

const KEYRING_SERVICE: &str = "com.canni.bonobos-fr-app";
const KEYRING_ACCOUNT: &str = "pending-desktop-steam-auth";
const CALLBACK_SCHEME: &str = "com.canni.bonobos-fr-app";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDesktopAuth {
    pub state: String,
    pub verifier: String,
    pub expires_at: u64,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthCallback {
    pub state: String,
    pub code: Option<String>,
    pub error: Option<String>,
}

fn current_time_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .map_err(|error| format!("System clock is invalid: {error}"))
}

fn credential_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|error| format!("Unable to access the system credential store: {error}"))
}

fn valid_base64url(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn parse_desktop_auth_callback(
    raw_url: &str,
    expected_state: &str,
) -> Result<DesktopAuthCallback, String> {
    let url = Url::parse(raw_url).map_err(|_| "invalid_callback_url".to_owned())?;
    if url.scheme() != CALLBACK_SCHEME
        || url.host_str() != Some("auth")
        || url.path() != "/callback"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("invalid_callback_url".to_owned());
    }

    let pairs: Vec<_> = url.query_pairs().collect();
    if pairs.len() != 2 {
        return Err("invalid_callback_parameters".to_owned());
    }
    let state_values: Vec<_> = pairs
        .iter()
        .filter(|(name, _)| name == "state")
        .map(|(_, value)| value.as_ref())
        .collect();
    if state_values.len() != 1
        || state_values[0] != expected_state
        || !valid_base64url(expected_state, 43, 43)
    {
        return Err("invalid_callback_state".to_owned());
    }

    let code_values: Vec<_> = pairs
        .iter()
        .filter(|(name, _)| name == "code")
        .map(|(_, value)| value.as_ref())
        .collect();
    let error_values: Vec<_> = pairs
        .iter()
        .filter(|(name, _)| name == "error")
        .map(|(_, value)| value.as_ref())
        .collect();
    if code_values.len() == 1 && error_values.is_empty() {
        let code = code_values[0];
        if !valid_base64url(code, 43, 43) {
            return Err("invalid_callback_code".to_owned());
        }
        return Ok(DesktopAuthCallback {
            state: expected_state.to_owned(),
            code: Some(code.to_owned()),
            error: None,
        });
    }

    if code_values.is_empty() && error_values.len() == 1 {
        let error = error_values[0];
        if ![
            "cancelled",
            "provider_unavailable",
            "invalid_openid_response",
        ]
        .contains(&error)
        {
            return Err("invalid_callback_error".to_owned());
        }
        return Ok(DesktopAuthCallback {
            state: expected_state.to_owned(),
            code: None,
            error: Some(error.to_owned()),
        });
    }

    Err("invalid_callback_parameters".to_owned())
}

#[tauri::command]
pub fn store_pending_desktop_auth(
    state: String,
    verifier: String,
    expires_at: u64,
) -> Result<(), String> {
    if !valid_base64url(&state, 43, 43) || !valid_base64url(&verifier, 43, 128) {
        return Err("invalid_pending_auth".to_owned());
    }
    let now = current_time_ms()?;
    if expires_at <= now || expires_at > now + 10 * 60 * 1_000 {
        return Err("invalid_pending_auth_expiry".to_owned());
    }
    let pending = PendingDesktopAuth {
        state,
        verifier,
        expires_at,
    };
    let serialized = serde_json::to_string(&pending)
        .map_err(|error| format!("Unable to encode pending authentication: {error}"))?;
    credential_entry()?
        .set_password(&serialized)
        .map_err(|error| format!("Unable to save pending authentication securely: {error}"))
}

#[tauri::command]
pub fn get_pending_desktop_auth() -> Result<Option<PendingDesktopAuth>, String> {
    match credential_entry()?.get_password() {
        Ok(serialized) => serde_json::from_str(&serialized)
            .map(Some)
            .map_err(|error| format!("Stored pending authentication is invalid: {error}")),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Unable to read pending authentication securely: {error}"
        )),
    }
}

#[tauri::command]
pub fn clear_pending_desktop_auth() -> Result<(), String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Unable to clear pending authentication securely: {error}"
        )),
    }
}

#[tauri::command]
pub fn validate_desktop_auth_callback(raw_url: String) -> Result<DesktopAuthCallback, String> {
    let pending = get_pending_desktop_auth()?.ok_or_else(|| "no_pending_auth".to_owned())?;
    if pending.expires_at <= current_time_ms()? {
        clear_pending_desktop_auth()?;
        return Err("pending_auth_expired".to_owned());
    }
    parse_desktop_auth_callback(&raw_url, &pending.state)
}

#[cfg(test)]
mod tests {
    use super::parse_desktop_auth_callback;

    const STATE: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
    const CODE: &str = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

    #[test]
    fn accepts_only_the_expected_one_time_code_callback() {
        let callback = parse_desktop_auth_callback(
            &format!("com.canni.bonobos-fr-app://auth/callback?code={CODE}&state={STATE}"),
            STATE,
        )
        .expect("callback should be accepted");
        assert_eq!(callback.code.as_deref(), Some(CODE));
        assert_eq!(callback.error, None);
    }

    #[test]
    fn accepts_cancel_errors_without_a_code() {
        let callback = parse_desktop_auth_callback(
            &format!("com.canni.bonobos-fr-app://auth/callback?error=cancelled&state={STATE}"),
            STATE,
        )
        .expect("cancel callback should be accepted");
        assert_eq!(callback.code, None);
        assert_eq!(callback.error.as_deref(), Some("cancelled"));
    }

    #[test]
    fn rejects_wrong_scheme_state_duplicate_parameters_and_unknown_errors() {
        assert!(
            parse_desktop_auth_callback(
                &format!("https://auth/callback?code={CODE}&state={STATE}"),
                STATE,
            )
            .is_err()
        );
        assert!(
            parse_desktop_auth_callback(
                &format!(
                    "com.canni.bonobos-fr-app://auth/callback?code={CODE}&state={}",
                    "1111111111111111111111111111111111111111111"
                ),
                STATE,
            )
            .is_err()
        );
        assert!(parse_desktop_auth_callback(
            &format!(
                "com.canni.bonobos-fr-app://auth/callback?code={CODE}&state={STATE}&state={STATE}"
            ),
            STATE,
        )
        .is_err());
        assert!(
            parse_desktop_auth_callback(
                &format!(
                    "com.canni.bonobos-fr-app://auth/callback?error=account_suspended&state={STATE}"
                ),
                STATE,
            )
            .is_err()
        );
    }
}
