# Storage Explorer

A read-only Windows disk space analyzer built with Tauri 2, Rust, React, TypeScript, Tailwind, source-owned shadcn-style components, Lucide, Motion, TanStack Table/Virtual, and ECharts.

## Run

Requires Windows 10 build 17763 or newer, Node.js, Rust (MSVC), Visual Studio C++ Build Tools, and WebView2. See [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/).

```powershell
npm ci
npm run tauri dev
```

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run check:rust
npm run tauri build
```

The Windows executable is `src-tauri/target/release/storage-explorer.exe`. The per-user NSIS installer is under `src-tauri/target/release/bundle/nsis/`. Installers are unsigned; no signing certificate is configured. `npm run dev` alone runs the interface in a browser and explicitly reports that native storage access requires the Windows application.

## Releases

Pushing a version tag such as `0.1.0` runs `.github/workflows/release.yml`. The Windows job checks frontend/Rust tests and Clippy, builds the application, and publishes the NSIS installer and standalone executable to a GitHub Release. Branch and pull-request pushes do not run this workflow. No repository secret is needed beyond GitHub's automatic `GITHUB_TOKEN`.

Before tagging a new version, update `package.json`, `package-lock.json`, `src-tauri/Cargo.toml` (and its lockfile), and `src-tauri/tauri.conf.json` to match the tag. The workflow rejects mismatched versions.

## Functionality

- Detect local, removable, network, and RAM volumes using Win32. Drive capacity and free space are separate from scanned file totals. Actual volume capacity uses [GetDiskSpaceInformationW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskspaceinformationw), independently of per-user quotas. If that API fails, the card explicitly shows account-accessible capacity and is excluded from combined volume capacity. Refresh after attaching or removing a drive.
- Scan drives or folders in a background Rust worker; inspect progressive results, stop, or rescan. Scan completion, cancellation, access errors, skipped locations, and unknown physical allocation remain visible.
- Scans run one at a time at Windows background CPU/I/O priority, yield between metadata batches, and stop with a visible memory-limit status at 768 MiB of backend private memory or below 512 MiB of available RAM/commit. Partial results remain indexed; queries reserve 256 MiB of system headroom. These are sampled safeguards, not a hard allocation cap. Windows filesystem calls can still block until the OS returns.
- Browse and expand the directory hierarchy, navigate breadcrumbs, search descendants, resize/show/hide columns, and sort each folder's siblings in either direction. The Rust query cache handles sorting; only five pages of 256 entries are retained by the frontend, with virtualized rows.
- Search, path and size input waits for a 350 ms typing pause. Superseded searches stop during traversal and between bounded sort chunks; descendant paths are built once per traversal depth. Live table/map refreshes happen every five seconds, paging retains one index revision, and breadcrumbs do not rebuild the table index. Results refresh immediately when the scan ends.
- Logical sizes highlight files and folders in amber at 1 GiB and coral at 10 GiB, with labeled legends in the table and treemap. Exact sizes and percentages remain visible.
- Find unique largest files in the current hierarchy; filter by category, minimum GiB, or path. Open locations in Explorer via context menu or entry details. Keyboard: arrows, Home/End, Enter; column separators also support keyboard resizing.
- Explore a lazy-loaded treemap, click folders to navigate, and switch back to the matching table hierarchy. It shows up to 400 entries per folder and groups remaining bytes; the table exposes every entry. The table is the keyboard-accessible alternative to the canvas.
- Categories use extensions and recognized `steamapps` / `Epic Games` path segments. These are file classifications, not installed application sizes.

## Accounting and coverage

Logical size is the length of each unique scanned file. Allocated size uses Windows allocation metadata; compressed/sparse files use `GetCompressedFileSizeW`. Hard links contribute bytes at the first encountered directory entry and subsequent entries are marked with a link icon. File counts include directory entries, including hard links and skipped files. Allocation that cannot be measured is reported as unavailable, with the known subtotal in coverage.

The scanner does not read file contents or request administrator elevation. Junctions, symbolic links, cloud placeholders, and other reparse points are skipped, including reparse scan roots. It validates each directory's ancestors again before enumeration and holds non-following directory handles during enumeration, temporarily preventing rename/replacement. A changing filesystem is not a snapshot; rescan after changes. Directory metadata, alternate data streams, reserved storage, and unscanned/protected files are excluded. Therefore scanned file totals need not equal volume usage.

Scan names and parent IDs are stored in memory; full paths are reconstructed for requested rows. Names, paths, and scan history are not persisted. SQLite is intentionally unnecessary for the initial release. Memory still scales with scanned entries. Network filesystem calls can block until Windows returns even after cancellation.

## Explicit limits

An MFT-based NTFS scanner is **not implemented**. The extension boundary is `scanner::scan_into` producing the same indexed `ScanTree`, coverage counters, and batched progress callback consumed by `commands`. A future MFT backend must implement identical aggregation, hard-link attribution, cancellation, and query contracts, detect capability/privilege requirements, and fall back to the recursive scanner. No administrator access is required by the current backend.

No cleanup/deletion, elevation flow, historical database, mount-point-only volume discovery, filesystem snapshot, or signed distribution is included. Drive-letter volumes are supported. FAT/exFAT/ReFS, remote shares, and hot-unplug behavior require additional hardware testing. The current accounting tests run on the local Windows filesystem.

## Verification

Rust tests use real temporary files for Unicode/long paths, hard links, junction loops, sparse allocation, access denied, aggregation, root validation, and cancellation. Directory guards and quota accounting have regression tests. Query tests cover hierarchy sorting, all required sort columns in both directions, unavailable allocation, filtering, and a 100,000-entry page boundary. Frontend unit tests cover binary units and zero/unknown values.

Native UI integration tests connect to a running development WebView2 using a local debugging port. This debugging setting is for testing only, not enabled by the packaged application:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9223'
npm run tauri dev
# In another terminal:
npm run test:ui
```

Test fixtures live in `.superpowers/` and do not ship with the app. Workflow artifacts are ignored and should not be committed.

The same native UI tests can run against the release executable by launching it with the test-only WebView2 debugging environment variable. They exercise real Rust IPC, real temporary files, drive discovery, paging failure/recovery, sorting and filters, hierarchy navigation, Explorer opening, treemap click-to-zoom, cancellation/rescan, minimum window geometry, reduced motion, size colors using sparse files, and search debounce. Cancellation uses a bounded fixture folder, not a system-drive scan. No mocked storage data is installed in the application. Completion of a full multi-terabyte scan and a measured 60 FPS hardware benchmark have not been verified.
