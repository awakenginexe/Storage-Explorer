use super::*;
use std::{fs, sync::atomic::AtomicBool};

#[test]
fn memory_limit_preserves_results_and_reports_incomplete_coverage() {
    let dir = tempfile::tempdir().unwrap();
    for id in 0..300 {
        fs::write(dir.path().join(format!("{id}.bin")), [1; 2]).unwrap();
    }
    let tree = Arc::new(RwLock::new(ScanTree::new(dir.path()).unwrap()));
    let mut checks = 0;
    scan_with_budget(
        &tree,
        &AtomicBool::new(false),
        || {},
        || {
            checks += 1;
            checks > 1
        },
    );
    let tree = tree.read().unwrap();
    assert_eq!(tree.status, "limited");
    assert!(!tree.cancelled);
    assert!(tree.nodes[0].files > 0 && tree.nodes[0].files < 300);
    assert_eq!(tree.nodes[0].logical, tree.nodes[0].files * 2);
    assert!(tree.errors[0].message.contains("memory"));
    assert!(tree.nodes.iter().skip(1).all(|n| n.parent == Some(0)));
}

#[test]
fn aggregates_nested_unicode_files_without_confusing_counts() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("資料 ไทย")).unwrap();
    fs::write(dir.path().join("zero"), []).unwrap();
    fs::write(dir.path().join("資料 ไทย/movie.mp4"), [7; 12345]).unwrap();
    let tree = scan(dir.path(), &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(tree.nodes.len(), 4);
    assert_eq!(tree.nodes[0].logical, 12345);
    assert_eq!(tree.nodes[0].files, 2);
    assert_eq!(tree.nodes[0].folders, 1);
    assert!(tree.nodes[0].physical >= 12345);
    assert_eq!(tree.nodes[0].unknown_physical, 0);
}

#[test]
fn hard_links_count_allocations_once() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a"), [1; 1000]).unwrap();
    fs::hard_link(dir.path().join("a"), dir.path().join("b")).unwrap();
    let tree = scan(dir.path(), &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(tree.nodes[0].logical, 1000);
    assert_eq!(tree.nodes[0].files, 2);
    assert_eq!(tree.nodes.iter().filter(|n| n.duplicate).count(), 1);
}

#[test]
fn cancellation_preserves_an_honest_partial_tree() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("a"), [1; 50]).unwrap();
    let tree = scan(dir.path(), &AtomicBool::new(true), |_| {}).unwrap();
    assert!(tree.cancelled);
    assert_eq!(tree.nodes.len(), 1);
    assert_eq!(tree.nodes[0].logical, 0);
}

#[test]
fn rejects_a_file_or_missing_scan_root() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file");
    fs::write(&file, []).unwrap();
    assert!(scan(&file, &AtomicBool::new(false), |_| {}).is_err());
    assert!(scan(&dir.path().join("missing"), &AtomicBool::new(false), |_| {}).is_err());
}

#[test]
fn supports_paths_longer_than_max_path() {
    let dir = tempfile::tempdir().unwrap();
    let mut path = fs::canonicalize(dir.path()).unwrap();
    for _ in 0..20 {
        path = path.join("long-folder-name");
    }
    fs::create_dir_all(&path).unwrap();
    fs::write(path.join("deep.txt"), [3; 32]).unwrap();
    let tree = scan(dir.path(), &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(tree.nodes[0].logical, 32);
    assert_eq!(tree.nodes[0].folders, 20);
}

#[cfg(windows)]
#[test]
fn skips_junction_loops_and_rejects_junction_roots() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("real.txt"), [1; 16]).unwrap();
    let link = dir.path().join("loop");
    let output = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tree = scan(dir.path(), &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(tree.nodes[0].logical, 16);
    assert_eq!(tree.skipped, 1);
    assert_eq!(tree.nodes.len(), 3);
    assert_eq!(tree.nodes[0].folders, 1);
    assert_eq!(tree.nodes[0].files, 1);
    assert!(scan(&link, &AtomicBool::new(false), |_| {}).is_err());
}

#[cfg(windows)]
#[test]
fn inaccessible_directories_produce_partial_coverage_and_do_not_crash() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("blocked");
    fs::create_dir(&blocked).unwrap();
    fs::write(blocked.join("secret.bin"), [1; 100]).unwrap();
    fs::write(dir.path().join("readable.bin"), [1; 12]).unwrap();
    let user = std::env::var("USERNAME").unwrap();
    let deny = std::process::Command::new("icacls")
        .arg(&blocked)
        .arg("/deny")
        .arg(format!("{user}:(RD)"))
        .output()
        .unwrap();
    assert!(deny.status.success());
    let result = scan(dir.path(), &AtomicBool::new(false), |_| {});
    let blocked_result = scan(&blocked, &AtomicBool::new(false), |_| {});
    let restore = std::process::Command::new("icacls")
        .arg(&blocked)
        .args(["/remove:d", &user])
        .output()
        .unwrap();
    assert!(restore.status.success());
    let tree = result.unwrap();
    assert_eq!(tree.nodes[0].logical, 12);
    assert_eq!(tree.error_count, 1);
    assert_eq!(tree.skipped, 1);
    assert_eq!(tree.status, "complete");
    assert_eq!(blocked_result.unwrap().status, "failed");
}

#[cfg(windows)]
#[test]
fn sparse_file_physical_size_is_not_its_logical_length() {
    use std::io::{Seek, SeekFrom, Write};
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sparse.bin");
    let mut file = fs::File::create(&path).unwrap();
    let output = std::process::Command::new("fsutil")
        .args(["sparse", "setflag"])
        .arg(&path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    file.seek(SeekFrom::Start(16 * 1024 * 1024 - 1)).unwrap();
    file.write_all(&[1]).unwrap();
    drop(file);
    let tree = scan(dir.path(), &AtomicBool::new(false), |_| {}).unwrap();
    assert_eq!(tree.nodes[0].logical, 16 * 1024 * 1024);
    assert!(tree.nodes[0].physical < 1024 * 1024);
}
