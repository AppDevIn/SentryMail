pub mod schema;

use rusqlite::Connection;
use std::path::Path;

/// Opens (creating if needed) the app's SQLite database and applies the schema.
/// Called once at startup; the resulting connection is wrapped in
/// `Arc<Mutex<Connection>>` by the caller and shared via `tauri::State`.
pub fn init_db(app_data_dir: &Path) -> rusqlite::Result<Connection> {
    std::fs::create_dir_all(app_data_dir)
        .expect("failed to create app data directory for database");
    let db_path = app_data_dir.join("email-client.sqlite");
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "foreign_keys", true)?;
    schema::run_migrations(&conn)?;
    Ok(conn)
}
