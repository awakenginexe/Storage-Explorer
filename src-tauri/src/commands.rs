use crate::{
    platform,
    query::{self, Page, Query, Row},
    scanner::{self, CoverageIssue, ScanTree},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::{Emitter, Manager, State};

type QueryCache = Option<(u64, Query, Vec<(usize, usize)>)>;

pub struct Session {
    pub id: u64,
    pub tree: Arc<RwLock<ScanTree>>,
    pub cancel: AtomicBool,
    cache: Mutex<QueryCache>,
    query_key: Mutex<Option<Query>>,
    query_epoch: AtomicU64,
}

#[derive(Default)]
pub struct Scans {
    current: Mutex<Option<Arc<Session>>>,
    sequence: AtomicU64,
    worker: Arc<Mutex<()>>,
}

impl Scans {
    fn get(&self, id: u64) -> Result<Arc<Session>, String> {
        self.current
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|s| s.id == id)
            .cloned()
            .ok_or_else(|| "This scan has been replaced. Refresh the view.".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTotal {
    pub category: String,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub scan_id: u64,
    pub root: String,
    pub status: String,
    pub logical: u64,
    pub physical: Option<u64>,
    pub known_physical: u64,
    pub files: u64,
    pub folders: u64,
    pub skipped: u64,
    pub error_count: u64,
    pub unknown_physical: u64,
    pub errors: Vec<CoverageIssue>,
    pub current_path: String,
    pub elapsed_ms: u64,
    pub revision: u64,
}

fn summary(session: &Session) -> Summary {
    let t = session.tree.read().unwrap();
    let n = &t.nodes[0];
    Summary {
        scan_id: session.id,
        root: platform::display_path(&t.root),
        status: t.status.clone(),
        logical: n.logical,
        physical: (n.unknown_physical == 0).then_some(n.physical),
        known_physical: n.physical,
        files: n.files,
        folders: n.folders,
        skipped: t.skipped,
        error_count: t.error_count,
        unknown_physical: n.unknown_physical,
        errors: t.errors.clone(),
        current_path: t.current_path.clone(),
        elapsed_ms: t.elapsed_ms,
        revision: t.revision,
    }
}

#[tauri::command]
pub async fn list_drives() -> Result<Vec<platform::Drive>, String> {
    tauri::async_runtime::spawn_blocking(platform::drives)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_scan(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, Scans>,
) -> Result<Summary, String> {
    let tree = tauri::async_runtime::spawn_blocking(move || ScanTree::new(&PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())??;
    let session = Arc::new(Session {
        id: state.sequence.fetch_add(1, Ordering::Relaxed) + 1,
        tree: Arc::new(RwLock::new(tree)),
        cancel: AtomicBool::new(false),
        cache: Mutex::new(None),
        query_key: Mutex::new(None),
        query_epoch: AtomicU64::new(0),
    });
    let initial = summary(&session);
    if let Some(old) = state.current.lock().unwrap().replace(session.clone()) {
        old.cancel.store(true, Ordering::Relaxed);
        old.query_epoch.fetch_add(1, Ordering::Relaxed);
    }
    let worker = state.worker.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _worker = worker.lock().unwrap();
        scanner::scan_into(&session.tree, &session.cancel, || {
            let _ = app.emit("scan-progress", summary(&session));
        });
    });
    Ok(initial)
}

#[tauri::command]
pub fn cancel_scan(scan_id: u64, state: State<'_, Scans>) -> Result<(), String> {
    state.get(scan_id)?.cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn scan_status(scan_id: u64, state: State<'_, Scans>) -> Result<Summary, String> {
    let session = state.get(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || summary(&session))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn query_entries(
    scan_id: u64,
    query: Query,
    state: State<'_, Scans>,
) -> Result<Page, String> {
    let session = state.get(scan_id)?;
    let mut key = query.clone();
    key.offset = 0;
    key.limit = 0;
    key.revision = None;
    let epoch = {
        let mut desired = session.query_key.lock().map_err(|e| e.to_string())?;
        if desired.as_ref() != Some(&key) {
            *desired = Some(key.clone());
            session.query_epoch.fetch_add(1, Ordering::Relaxed);
        }
        session.query_epoch.load(Ordering::Relaxed)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _background = platform::BackgroundWork::new().map_err(|e| e.to_string())?;
        let cancelled = || session.query_epoch.load(Ordering::Relaxed) != epoch;
        let mut cache = session.cache.lock().map_err(|e| e.to_string())?;
        if cancelled() {
            return Err("Query replaced by a newer request.".into());
        }
        let tree = session.tree.read().map_err(|e| e.to_string())?;
        if cache.as_ref().is_none_or(|(revision, old, _)| {
            (*revision != tree.revision && query.revision != Some(*revision)) || *old != key
        }) {
            *cache = None;
            *cache = Some((
                tree.revision,
                key,
                query::index_cancellable(&tree, &query, cancelled)?,
            ));
        }
        let (revision, _, index) = cache.as_ref().unwrap();
        let mut page = query::page(&tree, &query, index);
        page.revision = *revision;
        Ok(page)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn folder_breadcrumbs(
    scan_id: u64,
    root: usize,
    state: State<'_, Scans>,
) -> Result<Vec<Row>, String> {
    let session = state.get(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let tree = session.tree.read().map_err(|e| e.to_string())?;
        query::breadcrumbs(&tree, root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn category_totals(
    scan_id: u64,
    state: State<'_, Scans>,
) -> Result<Vec<CategoryTotal>, String> {
    let session = state.get(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _background = platform::BackgroundWork::new().map_err(|e| e.to_string())?;
        let tree = session.tree.read().unwrap();
        let mut totals: std::collections::BTreeMap<&str, (u64, u64)> =
            std::collections::BTreeMap::new();
        for n in tree
            .nodes
            .iter()
            .filter(|n| !n.directory && !n.duplicate && !n.skipped)
        {
            let total = totals.entry(n.category.label()).or_default();
            total.0 += n.logical;
            total.1 += 1;
        }
        Ok::<_, String>(
            totals
                .into_iter()
                .map(|(category, (bytes, files))| CategoryTotal {
                    category: category.to_lowercase(),
                    bytes,
                    files,
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEntry {
    pub entry: Option<Row>,
    pub name: String,
    pub bytes: u64,
}

#[tauri::command]
pub async fn treemap_entries(
    scan_id: u64,
    root: usize,
    state: State<'_, Scans>,
) -> Result<Vec<MapEntry>, String> {
    let session = state.get(scan_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _background = platform::BackgroundWork::new().map_err(|e| e.to_string())?;
        let tree = session.tree.read().unwrap();
        let q = Query {
            root,
            descending: true,
            ..Query::default()
        };
        let ids = query::index(&tree, &q)?;
        let mut rest = 0;
        let mut result = Vec::new();
        for (i, (id, depth)) in ids.into_iter().enumerate() {
            let n = &tree.nodes[id];
            if i >= 400 {
                rest += n.logical;
                continue;
            }
            if n.logical > 0 {
                result.push(MapEntry {
                    entry: Some(query::row(&tree, id, depth)),
                    name: n.name.clone(),
                    bytes: n.logical,
                });
            }
        }
        if rest > 0 {
            result.push(MapEntry {
                entry: None,
                name: "Remaining entries (see table)".into(),
                bytes: rest,
            });
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_in_explorer(
    scan_id: u64,
    id: usize,
    state: State<'_, Scans>,
) -> Result<(), String> {
    let session = state.get(scan_id)?;
    let path = {
        let tree = session.tree.read().unwrap();
        let node = tree.nodes.get(id).ok_or("Entry no longer exists")?;
        let path = tree.path(id);
        if node.directory {
            path
        } else {
            path.parent().ok_or("No parent folder")?.into()
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        if !path.is_dir() {
            return Err("Folder no longer exists or is inaccessible.".into());
        }
        #[cfg(windows)]
        std::process::Command::new("explorer.exe")
            .arg(platform::display_path(&path))
            .spawn()
            .map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        return Err("Opening Explorer is supported on Windows.".into());
        #[allow(unreachable_code)]
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn stop(app: &tauri::AppHandle) {
    if let Some(session) = app.state::<Scans>().current.lock().unwrap().as_ref() {
        session.cancel.store(true, Ordering::Relaxed);
    }
}
