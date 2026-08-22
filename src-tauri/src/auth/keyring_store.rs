use keyring::Entry;

const SERVICE: &str = "email-client";

/// Refresh tokens live only in the OS keychain (gnome-keyring/Secret Service
/// on Linux), never in SQLite or a plaintext file. Keyed by the account's
/// Gmail address.
pub fn store_refresh_token(email_address: &str, refresh_token: &str) -> keyring::Result<()> {
    let entry = Entry::new(SERVICE, email_address)?;
    entry.set_password(refresh_token)
}

pub fn get_refresh_token(email_address: &str) -> keyring::Result<String> {
    let entry = Entry::new(SERVICE, email_address)?;
    entry.get_password()
}

pub fn delete_refresh_token(email_address: &str) -> keyring::Result<()> {
    let entry = Entry::new(SERVICE, email_address)?;
    entry.delete_password()
}
