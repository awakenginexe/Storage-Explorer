use serde::Serialize;
use std::{fs, path::Path};

pub struct BackgroundWork(std::marker::PhantomData<*mut ()>);

impl BackgroundWork {
    pub fn new() -> std::io::Result<Self> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Threading::*;
            if SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) == 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(Self(std::marker::PhantomData))
    }
}

impl Drop for BackgroundWork {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::Threading::*;
            // Blocking-pool threads are reused; restore priority before returning one.
            SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END);
        }
    }
}

#[cfg(windows)]
pub fn memory_pressure() -> bool {
    resource_memory_pressure(true)
}

#[cfg(windows)]
pub fn query_memory_pressure() -> bool {
    resource_memory_pressure(false)
}

#[cfg(windows)]
fn resource_memory_pressure(scanning: bool) -> bool {
    use std::mem::{size_of, zeroed};
    use windows_sys::Win32::System::{ProcessStatus::*, SystemInformation::*, Threading::*};
    unsafe {
        let mut system: MEMORYSTATUSEX = zeroed();
        system.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        let mut process: PROCESS_MEMORY_COUNTERS_EX = zeroed();
        process.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        if GlobalMemoryStatusEx(&mut system) == 0
            || GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut process as *mut _ as *mut _,
                process.cb,
            ) == 0
        {
            return true;
        }
        if !scanning {
            return system.ullAvailPhys < 256 * 1024 * 1024
                || system.ullAvailPageFile < 256 * 1024 * 1024;
        }
        memory_limit_reached(
            process.PrivateUsage as u64,
            system.ullAvailPhys,
            system.ullAvailPageFile,
        )
    }
}

#[cfg(not(windows))]
pub fn memory_pressure() -> bool {
    false
}

#[cfg(not(windows))]
pub fn query_memory_pressure() -> bool {
    false
}

#[cfg(any(windows, test))]
fn memory_limit_reached(private: u64, available: u64, commit_available: u64) -> bool {
    private >= 768 * 1024 * 1024
        || available < 512 * 1024 * 1024
        || commit_available < 512 * 1024 * 1024
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub path: String,
    pub label: String,
    pub filesystem: String,
    pub kind: String,
    pub total: u64,
    pub free: u64,
    pub available: u64,
    pub error: Option<String>,
    pub account_scoped: bool,
}

pub struct Allocation {
    pub physical: Option<u64>,
    pub identity: Option<(u64, u64)>,
}

#[cfg(windows)]
pub fn is_directory(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x10 != 0
}

#[cfg(not(windows))]
pub fn is_directory(meta: &fs::Metadata) -> bool {
    meta.is_dir()
}

#[cfg(windows)]
pub fn directory_guards(path: &Path) -> std::io::Result<Vec<fs::File>> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut guards = Vec::new();
    // Pin each ancestor without following its final component; deny rename while enumerating.
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        let file = fs::OpenOptions::new()
            .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(ancestor)?;
        let meta = file.metadata()?;
        if is_link(&meta) || !meta.is_dir() {
            return Err(std::io::Error::other(
                "Directory became a reparse point or was replaced; skipped.",
            ));
        }
        guards.push(file);
    }
    Ok(guards)
}

#[cfg(not(windows))]
pub fn directory_guards(path: &Path) -> std::io::Result<Vec<fs::File>> {
    if path
        .ancestors()
        .any(|p| fs::symlink_metadata(p).is_ok_and(|m| is_link(&m)))
    {
        return Err(std::io::Error::other(
            "Symbolic link in directory path; skipped.",
        ));
    }
    Ok(vec![fs::File::open(path)?])
}

#[cfg(windows)]
pub fn is_link(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub fn is_link(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

#[cfg(windows)]
pub fn allocation(path: &Path, meta: &fs::Metadata) -> Allocation {
    use std::{
        mem::{size_of, zeroed},
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
    };
    use windows_sys::Win32::{
        Foundation::{GetLastError, SetLastError},
        Storage::FileSystem::*,
    };
    let Ok(file) = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(7)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
    else {
        return Allocation {
            physical: None,
            identity: None,
        };
    };
    if !file.metadata().is_ok_and(|m| !is_link(&m)) {
        return Allocation {
            physical: None,
            identity: None,
        };
    }
    // The handle requests attributes only, so scanning never reads or hydrates file content.
    unsafe {
        let handle = file.as_raw_handle();
        let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
        let identity =
            if GetFileInformationByHandle(handle, &mut info) != 0 && info.nNumberOfLinks > 1 {
                Some((
                    info.dwVolumeSerialNumber as u64,
                    ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
                ))
            } else {
                None
            };
        let mut standard: FILE_STANDARD_INFO = zeroed();
        let mut physical = if GetFileInformationByHandleEx(
            handle,
            FileStandardInfo,
            &mut standard as *mut _ as *mut _,
            size_of::<FILE_STANDARD_INFO>() as u32,
        ) != 0
        {
            Some(standard.AllocationSize.max(0) as u64)
        } else {
            None
        };
        if meta.file_attributes() & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE) != 0 {
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let mut high = 0;
            SetLastError(0);
            let low = GetCompressedFileSizeW(wide.as_ptr(), &mut high);
            physical = if low != u32::MAX || GetLastError() == 0 {
                Some(((high as u64) << 32) | low as u64)
            } else {
                None
            };
        }
        Allocation { physical, identity }
    }
}

#[cfg(not(windows))]
pub fn allocation(_path: &Path, meta: &fs::Metadata) -> Allocation {
    use std::os::unix::fs::MetadataExt;
    Allocation {
        physical: Some(meta.blocks() * 512),
        identity: (meta.nlink() > 1).then_some((meta.dev(), meta.ino())),
    }
}

#[cfg(windows)]
pub fn drives() -> Vec<Drive> {
    use windows_sys::Win32::Storage::FileSystem::*;
    let mut result = Vec::new();
    unsafe {
        let length = GetLogicalDriveStringsW(0, std::ptr::null_mut());
        let mut paths = vec![0; length as usize + 1];
        if GetLogicalDriveStringsW(paths.len() as u32, paths.as_mut_ptr()) == 0 {
            return result;
        }
        for slice in paths.split(|v| *v == 0).filter(|s| !s.is_empty()) {
            let root: Vec<u16> = slice.iter().copied().chain(Some(0)).collect();
            let kind = match GetDriveTypeW(root.as_ptr()) {
                2 => "Removable",
                3 => "Local",
                4 => "Network",
                6 => "RAM disk",
                _ => continue,
            };
            let (mut total, mut free, mut available) = (0, 0, 0);
            let accessible =
                GetDiskFreeSpaceExW(root.as_ptr(), &mut available, &mut total, &mut free) != 0;
            let space_error = (!accessible).then(|| std::io::Error::last_os_error().to_string());
            let mut info: DISK_SPACE_INFORMATION = std::mem::zeroed();
            let account_scoped = GetDiskSpaceInformationW(root.as_ptr(), &mut info) != 0;
            if !account_scoped {
                (total, free, available) = space_totals(&info);
            } else {
                free = available.min(total);
            }
            let mut label = [0; 261];
            let mut filesystem = [0; 64];
            GetVolumeInformationW(
                root.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            );
            let decode = |v: &[u16]| {
                String::from_utf16_lossy(&v[..v.iter().position(|c| *c == 0).unwrap_or(v.len())])
            };
            result.push(Drive {
                path: decode(slice),
                label: decode(&label),
                filesystem: decode(&filesystem),
                kind: kind.into(),
                total,
                free,
                available,
                error: space_error,
                account_scoped,
            });
        }
    }
    result
}

#[cfg(windows)]
fn space_totals(
    info: &windows_sys::Win32::Storage::FileSystem::DISK_SPACE_INFORMATION,
) -> (u64, u64, u64) {
    let unit = info.SectorsPerAllocationUnit as u64 * info.BytesPerSector as u64;
    (
        info.ActualTotalAllocationUnits * unit,
        info.ActualAvailableAllocationUnits * unit,
        info.CallerAvailableAllocationUnits * unit,
    )
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn memory_budget_reserves_system_headroom() {
        let mib = 1024 * 1024;
        assert!(!memory_limit_reached(767 * mib, 512 * mib, 512 * mib));
        assert!(memory_limit_reached(768 * mib, 2048 * mib, 2048 * mib));
        assert!(memory_limit_reached(100 * mib, 511 * mib, 2048 * mib));
        assert!(memory_limit_reached(100 * mib, 2048 * mib, 511 * mib));
    }

    #[test]
    fn background_priority_is_restored_on_worker_exit() {
        use windows_sys::Win32::System::Threading::*;
        let before = unsafe { GetThreadPriority(GetCurrentThread()) };
        {
            let _work = BackgroundWork::new().unwrap();
        }
        assert_eq!(unsafe { GetThreadPriority(GetCurrentThread()) }, before);
    }
    #[test]
    fn quotas_do_not_replace_actual_volume_capacity() {
        let mut info: windows_sys::Win32::Storage::FileSystem::DISK_SPACE_INFORMATION =
            unsafe { std::mem::zeroed() };
        info.ActualTotalAllocationUnits = 1000;
        info.ActualAvailableAllocationUnits = 400;
        info.CallerTotalAllocationUnits = 100;
        info.CallerAvailableAllocationUnits = 20;
        info.SectorsPerAllocationUnit = 1;
        info.BytesPerSector = 1;
        assert_eq!(space_totals(&info), (1000, 400, 20));
    }
    #[test]
    fn queued_directory_replacement_is_rejected_before_enumeration() {
        let dir = tempfile::tempdir().unwrap();
        let queued = dir.path().join("queued");
        fs::create_dir(&queued).unwrap();
        let original = dir.path().join("renamed");
        fs::rename(&queued, original).unwrap();
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&queued)
            .arg(dir.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(directory_guards(&queued).is_err());
    }
    #[test]
    fn directory_guard_prevents_replacement_during_enumeration() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let guards = directory_guards(&folder).unwrap();
        assert!(fs::rename(&folder, dir.path().join("renamed")).is_err());
        drop(guards);
        fs::rename(&folder, dir.path().join("renamed")).unwrap();
    }
}

#[cfg(not(windows))]
pub fn drives() -> Vec<Drive> {
    Vec::new()
}

pub fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        path.strip_prefix("\\\\?\\").unwrap_or(&path).to_string()
    }
}
