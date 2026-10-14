use crate::platform;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, UNIX_EPOCH},
};

#[derive(Default, Debug)]
pub struct ScanTree {
    pub root: PathBuf,
    pub nodes: Vec<Node>,
    pub cancelled: bool,
    pub skipped: u64,
    pub error_count: u64,
    pub errors: Vec<CoverageIssue>,
    pub revision: u64,
    pub status: String,
    pub current_path: String,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Videos,
    Audio,
    Games,
    Applications,
    Archives,
    Documents,
    #[default]
    Other,
}

impl Category {
    pub fn label(self) -> &'static str {
        match self {
            Self::Videos => "Videos",
            Self::Audio => "Audio",
            Self::Games => "Games",
            Self::Applications => "Applications",
            Self::Archives => "Archives",
            Self::Documents => "Documents",
            Self::Other => "Other",
        }
    }
}

pub fn category(path: &Path) -> Category {
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    match extension.as_str() {
        "mp4" | "mkv" | "mov" | "avi" | "webm" | "wmv" | "m4v" => Category::Videos,
        "mp3" | "flac" | "wav" | "m4a" | "ogg" | "aac" => Category::Audio,
        "zip" | "7z" | "rar" | "tar" | "gz" | "iso" => Category::Archives,
        "pdf" | "doc" | "docx" | "txt" | "xls" | "xlsx" | "pptx" | "csv" | "md" => {
            Category::Documents
        }
        _ if path.components().any(|p| {
            let part = p.as_os_str().to_string_lossy();
            part.eq_ignore_ascii_case("steamapps") || part.eq_ignore_ascii_case("Epic Games")
        }) =>
        {
            Category::Games
        }
        "exe" | "dll" | "msi" | "msix" | "sys" => Category::Applications,
        _ => Category::Other,
    }
}

#[derive(Default, Debug)]
pub struct Node {
    pub name: String,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub directory: bool,
    pub logical: u64,
    pub physical: u64,
    pub files: u64,
    pub folders: u64,
    pub modified: u64,
    pub unknown_physical: u64,
    pub duplicate: bool,
    pub skipped: bool,
    pub category: Category,
    pub entry_size: u64,
}

impl ScanTree {
    pub fn new(root: &Path) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err("Choose an absolute folder path.".into());
        }
        let meta = fs::symlink_metadata(root).map_err(|e| e.to_string())?;
        if !meta.is_dir() || platform::is_link(&meta) {
            return Err("Choose a real directory, not a file, junction, or symbolic link.".into());
        }
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let name = root
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| platform::display_path(&root));
        Ok(Self {
            root,
            nodes: vec![Node {
                name,
                directory: true,
                modified: modified(&meta),
                ..Node::default()
            }],
            status: "scanning".into(),
            ..Self::default()
        })
    }

    pub fn path(&self, id: usize) -> PathBuf {
        let mut names = Vec::new();
        let mut current = id;
        while let Some(parent) = self.nodes[current].parent {
            names.push(&self.nodes[current].name);
            current = parent;
        }
        let mut path = self.root.clone();
        for name in names.into_iter().rev() {
            path.push(name);
        }
        path
    }

    fn issue(&mut self, path: &Path, message: String) {
        self.error_count += 1;
        if self.errors.len() < 200 {
            self.errors.push(CoverageIssue {
                path: platform::display_path(path),
                message,
            });
        }
    }

    fn append(&mut self, batch: &mut Vec<Node>) {
        for node in batch.drain(..) {
            let id = self.nodes.len();
            let mut ancestor = node.parent;
            if let Some(parent) = ancestor {
                self.nodes[parent].children.push(id);
            }
            while let Some(parent) = ancestor {
                let p = &mut self.nodes[parent];
                p.logical += node.logical;
                p.physical += node.physical;
                p.files += u64::from(!node.directory);
                p.folders += u64::from(node.directory);
                p.unknown_physical += node.unknown_physical;
                ancestor = p.parent;
            }
            self.skipped += u64::from(node.skipped);
            self.nodes.push(node);
        }
        self.revision += 1;
    }
}

fn modified(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs())
}

pub fn scan_into(tree: &Arc<RwLock<ScanTree>>, cancel: &AtomicBool, progress: impl FnMut()) {
    let _background = match platform::BackgroundWork::new() {
        Ok(work) => work,
        Err(e) => {
            let mut t = tree.write().unwrap();
            let root = t.root.clone();
            t.issue(&root, format!("Unable to start a low-priority scan: {e}"));
            t.status = "failed".into();
            drop(t);
            let mut progress = progress;
            progress();
            return;
        }
    };
    scan_with_budget(tree, cancel, progress, platform::memory_pressure);
}

fn scan_with_budget(
    tree: &Arc<RwLock<ScanTree>>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(),
    mut memory_pressure: impl FnMut() -> bool,
) {
    let started = Instant::now();
    let root = tree.read().unwrap().root.clone();
    let mut stack = vec![(0, root)];
    let mut seen = HashSet::new();
    let mut batch = Vec::with_capacity(256);
    let mut next_id = 1;
    let mut published = Instant::now();
    let mut limited = false;
    let mut checked_entries = 0;
    'scan: while let Some((parent, path)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        if memory_pressure() {
            limited = true;
            break;
        }
        let (entries, _guards) = match platform::directory_guards(&path)
            .and_then(|guards| fs::read_dir(&path).map(|entries| (entries, guards)))
        {
            Ok(result) => result,
            Err(e) => {
                let mut t = tree.write().unwrap();
                t.issue(&path, e.to_string());
                t.nodes[parent].skipped = true;
                t.skipped += 1;
                continue;
            }
        };
        for entry in entries {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            if checked_entries == 256 {
                std::thread::sleep(Duration::from_millis(5));
                checked_entries = 0;
                if memory_pressure() {
                    limited = true;
                    break 'scan;
                }
            }
            checked_entries += 1;
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    tree.write().unwrap().issue(&path, e.to_string());
                    continue;
                }
            };
            let full = entry.path();
            let meta = match fs::symlink_metadata(&full) {
                Ok(m) => m,
                Err(e) => {
                    tree.write().unwrap().issue(&full, e.to_string());
                    continue;
                }
            };
            let directory = platform::is_directory(&meta);
            let skipped = platform::is_link(&meta) || (!directory && !meta.is_file());
            let mut node = Node {
                name: entry.file_name().to_string_lossy().into_owned(),
                parent: Some(parent),
                directory,
                modified: modified(&meta),
                skipped,
                category: category(&full),
                files: u64::from(!directory),
                entry_size: meta.len(),
                ..Node::default()
            };
            if directory && !skipped {
                stack.push((next_id, full.clone()));
            }
            if !directory && !skipped {
                let allocation = platform::allocation(&full, &meta);
                node.duplicate = allocation.identity.is_some_and(|id| !seen.insert(id));
                if !node.duplicate {
                    node.logical = meta.len();
                    node.physical = allocation.physical.unwrap_or(0);
                    node.unknown_physical = u64::from(allocation.physical.is_none());
                }
            }
            batch.push(node);
            next_id += 1;
            if batch.len() >= 256 || published.elapsed().as_secs() >= 1 {
                let mut t = tree.write().unwrap();
                t.append(&mut batch);
                t.current_path = platform::display_path(&full);
                t.elapsed_ms = started.elapsed().as_millis() as u64;
                drop(t);
                if published.elapsed().as_secs() >= 1 {
                    progress();
                    published = Instant::now();
                }
            }
        }
        tree.write().unwrap().append(&mut batch);
        if published.elapsed().as_secs() >= 1 {
            progress();
            published = Instant::now();
        }
    }
    let mut t = tree.write().unwrap();
    t.append(&mut batch);
    if limited {
        let root = t.root.clone();
        t.issue(&root, "Scan stopped at the memory safety limit (768 MiB backend memory or less than 512 MiB available RAM/commit), or memory could not be checked. Results are incomplete; scan a smaller folder.".into());
    }
    t.cancelled = cancel.load(Ordering::Relaxed);
    t.status = if t.cancelled {
        "cancelled"
    } else if limited {
        "limited"
    } else if t.nodes[0].skipped {
        "failed"
    } else {
        "complete"
    }
    .into();
    t.elapsed_ms = started.elapsed().as_millis() as u64;
    t.current_path.clear();
    drop(t);
    progress();
}

#[cfg(test)]
pub fn scan(
    root: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&ScanTree),
) -> Result<ScanTree, String> {
    let tree = Arc::new(RwLock::new(ScanTree::new(root)?));
    scan_into(&tree, cancel, || progress(&tree.read().unwrap()));
    Ok(Arc::try_unwrap(tree).unwrap().into_inner().unwrap())
}

#[cfg(test)]
mod tests;
