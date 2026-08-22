mod auth;
mod commands;
mod db;
mod gmail;
mod llm;
mod search;
mod triage;
mod unsubscribe;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub triage_llm: Mutex<Option<llm::LlmHandle>>,
    pub triage_model_status: Mutex<llm::ModelStatus>,
    pub embed_llm: Mutex<Option<llm::EmbedHandle>>,
    pub embed_model_status: Mutex<llm::ModelStatus>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let conn = db::init_db(&app_data_dir)?;
            app.manage(AppState {
                db: Mutex::new(conn),
                triage_llm: Mutex::new(None),
                triage_model_status: Mutex::new(llm::ModelStatus::NotConfigured),
                embed_llm: Mutex::new(None),
                embed_model_status: Mutex::new(llm::ModelStatus::NotConfigured),
            });
            // ADR 0005: the embedding model is small, so when its file is present it loads
            // in the background at launch; the triage model stays an explicit choice.
            let handle = app.handle().clone();
            let model_present = llm::embedding_model_path(&handle).map(|p| p.exists()).unwrap_or(false);
            if model_present {
                let state = app.state::<AppState>();
                if let Err(e) = commands::start_embed_worker(&handle, state.inner()) {
                    eprintln!("embedding model auto-load failed: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_account,
            commands::list_accounts,
            commands::remove_account,
            commands::list_emails,
            commands::email_counts,
            commands::folder_counts,
            commands::archive_thread,
            commands::send_message,
            commands::set_read,
            commands::get_email,
            commands::list_thread_messages,
            commands::list_attachments,
            commands::open_attachment,
            commands::inline_images,
            commands::sync_now,
            commands::model_status,
            commands::load_model,
            commands::triage_email,
            commands::triage_all_untriaged,
            commands::get_triage_result,
            commands::set_user_risk,
            commands::set_done,
            commands::list_labels,
            commands::set_label_settings,
            commands::suggest_labels,
            commands::apply_labels,
            commands::create_gmail_draft,
            commands::draft_reply,
            commands::summarize_message,
            commands::unsubscribe_info,
            commands::unsubscribe_via_post,
            commands::unsubscribe_open_browser,
            commands::unsubscribe_via_mailto,
            commands::embedding_model_status,
            commands::load_embedding_model,
            commands::embed_pending,
            commands::search,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
