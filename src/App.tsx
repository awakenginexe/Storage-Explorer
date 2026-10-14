import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import * as Dialog from '@radix-ui/react-dialog';
import { HardDrive, LayoutDashboard, FolderTree, FileSearch, Grid2X2, FolderSearch, ChevronRight, ChevronLeft, RefreshCw, Square, ShieldCheck, AlertTriangle, X, Info, LoaderCircle, CheckCircle2, ExternalLink, Folder, File, Link2, Clock, Shield, CircleHelp } from 'lucide-react';
import { useStorage } from './hooks/useStorage';
import { DriveOverview } from './components/DriveOverview';
import { Button } from './components/ui/button';
import { formatBytes, formatCount, formatDate, formatDuration } from './lib/format';
import { categoryColors, categoryLabels, type Entry, type View } from './lib/types';
import './App.css';

const StorageMap = lazy(() => import('./components/StorageMap'));
const EntryTable = lazy(() => import('./components/EntryTable').then(module => ({ default: module.EntryTable })));
const navigation = [
  { id: 'overview', label: 'Storage overview', icon: LayoutDashboard },
  { id: 'explorer', label: 'Folder explorer', icon: FolderTree },
  { id: 'largest', label: 'Largest files', icon: FileSearch },
  { id: 'map', label: 'Storage map', icon: Grid2X2 },
] as const;

export default function App() {
  const storage = useStorage();
  const { summary } = storage;
  const [view, setView] = useState<View>('overview');
  const [root, setRoot] = useState(0);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<Entry[]>([]);
  const [dialog, setDialog] = useState<'coverage' | 'about' | 'scan' | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const chooseFolder = () => setDialog('scan');
  const browseFolder = async () => {
    try { const folder = await open({ directory: true, multiple: false, title: 'Select a folder to analyze' }); if (typeof folder === 'string') setFolderPath(folder); }
    catch (e) { storage.reportError(e); }
  };
  useEffect(() => { if (summary) { setRoot(0); setSelected(null); setView('explorer'); } }, [summary?.scanId]);
  useEffect(() => {
    if (!summary) return;
    let disposed = false;
    void invoke<Entry[]>('folder_breadcrumbs', { scanId: summary.scanId, root }).then(rows => { if (!disposed) setBreadcrumbs(rows); }).catch(() => { if (!disposed) setBreadcrumbs([]); });
    return () => { disposed = true; };
  }, [summary?.scanId, root]);
  const navigate = useCallback((id: number) => { setRoot(id); setSelected(null); }, []);
  const currentView = navigation.find(n => n.id === view)!;
  const partial = !!summary && (summary.status !== 'complete' || summary.errorCount > 0 || summary.skipped > 0 || summary.unknownPhysical > 0);
  const scanning = summary?.status === 'scanning';
  return <MotionConfig reducedMotion="user"><div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><HardDrive size={23} strokeWidth={1.7} /></span><div>Storage<span>Explorer</span></div></div>
      <nav className="main-nav" aria-label="Main navigation">{navigation.map(item => <button key={item.id} className={`nav-item ${view === item.id ? 'nav-active' : ''}`} onClick={() => setView(item.id)} aria-current={view === item.id ? 'page' : undefined}>
        {view === item.id && <motion.div layoutId="nav-selection" className="nav-selection" transition={{ type: 'spring', stiffness: 430, damping: 38 }} />}<item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span>
      </button>)}</nav>
      <div className="sidebar-heading">Connected drives<span>{storage.drives.length}</span></div><div className="sidebar-drives">{storage.loading ? <span className="muted text-xs px-3">Detecting drives…</span> : storage.drives.map(d => <button key={d.path} className={`sidebar-drive ${summary?.root.toLowerCase().startsWith(d.path.toLowerCase()) ? 'sidebar-drive-active' : ''}`} disabled={!!d.error || storage.starting} onClick={() => void storage.scan(d.path)} title={`${d.path} ${d.label}`}><HardDrive size={15} /><span>{d.label || 'Local disk'}</span><strong>{d.path.slice(0, 2)}</strong></button>)}</div>
      <Button variant="secondary" className="sidebar-scan" onClick={chooseFolder} disabled={storage.starting || !storage.native}><FolderSearch size={16} />Scan a folder</Button>
      <div className="sidebar-bottom"><div className="read-only-note"><ShieldCheck size={18} /><div>Look closer. Keep everything.<span>Your files are never modified.</span></div></div><button className="about-button" onClick={() => setDialog('about')}><Info size={15} />About & scan notes</button></div>
    </aside>
    <main className="workspace"><header className="workspace-header"><div className="header-location"><HardDrive size={15} /><span>This PC</span><ChevronRight size={13} /><span>{currentView.label}</span></div><div className="header-status"><ShieldCheck size={14} />Read-only analysis</div></header>
      <div className="page-heading"><div><h1>{currentView.label}</h1><p>{view === 'overview' ? 'Make room for what matters.' : view === 'largest' ? 'Find the files with the biggest footprint.' : view === 'map' ? 'See the shape of your storage.' : 'Follow the space, folder by folder.'}</p></div><div className="heading-actions">{summary && view !== 'overview' && <Button variant="secondary" onClick={() => void storage.scan(summary.root)} disabled={storage.starting || scanning}><RefreshCw size={15} />Rescan</Button>}<Button onClick={chooseFolder} disabled={!storage.native || storage.starting}><FolderSearch size={16} />{storage.starting ? 'Starting scan…' : 'Scan a folder'}</Button></div></div>
      {storage.error && <div className="error-banner" role="alert"><AlertTriangle size={17} /><span>{storage.error}</span><button aria-label="Dismiss error" onClick={storage.dismissError}><X size={16} /></button></div>}
      <div className="view-container">
        {view === 'overview' ? <DriveOverview {...storage} chooseFolder={chooseFolder} analyze={() => setView('explorer')} /> : !summary ? <div className="no-scan surface"><span className="no-scan-icon"><FolderSearch size={38} strokeWidth={1.4} /></span><h2>Start with a drive or a folder</h2><p>Scan once to browse folders, find the largest files, and explore an interactive storage map.</p><Button onClick={chooseFolder} disabled={!storage.native || storage.starting}><FolderSearch size={16} />Choose a folder</Button><button className="text-button" onClick={() => setView('overview')}>View connected drives<ChevronRight size={14} /></button></div> : <div className="analysis-content">
          <section className="scan-summary surface"><div className="scan-source"><span className="scan-drive-icon"><HardDrive size={24} /></span><div><strong title={summary.root}>{summary.root}</strong><span>{scanning ? 'Recursive filesystem scan' : 'Scanned folder contents'}</span></div></div><div className="scan-metric"><span>Logical size</span><strong>{formatBytes(summary.logical)}</strong></div><div className="scan-metric"><span>Allocated on disk</span><strong>{formatBytes(summary.physical)}</strong></div><div className="scan-metric"><span>Files scanned</span><strong>{formatCount(summary.files)}</strong></div><button className={`scan-coverage ${partial ? 'coverage-partial' : ''}`} onClick={() => setDialog('coverage')}>{scanning ? <LoaderCircle size={16} className="spin" /> : partial ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}<span>{scanning ? 'Scanning' : summary.status === 'cancelled' ? 'Cancelled'
            : summary.status === 'limited' ? 'Memory limit reached'
            : summary.status === 'failed' ? 'Scan failed' : partial ? 'Partial coverage' : 'Scan complete'}<small>View coverage</small></span></button></section>
          {scanning && <div className="scan-progress-panel"><div className="scan-path"><LoaderCircle size={14} className="spin" /><span title={summary.currentPath}>{summary.currentPath || 'Reading filesystem…'}</span><span className="elapsed">{formatDuration(summary.elapsedMs)}</span><Button variant="ghost" size="sm" onClick={() => void storage.cancel()}><Square size={12} />Stop scan</Button></div><div className="indeterminate-track"><div /></div></div>}
          <div className="analysis-navigation"><div className="breadcrumbs"><button disabled={breadcrumbs.length < 2} aria-label="Parent folder" onClick={() => navigate(breadcrumbs[breadcrumbs.length - 2].id)}><ChevronLeft size={17} /></button>{breadcrumbs.map((b, i) => <span className="breadcrumb" key={b.id}>{i > 0 && <ChevronRight size={12} />}<button onClick={() => navigate(b.id)} className={i === breadcrumbs.length - 1 ? 'current-crumb' : ''} title={b.path}>{b.id === 0 ? <HardDrive size={14} /> : null}{b.name}</button></span>)}</div>{view !== 'largest' && <div className="view-switch" aria-label="Analysis view"><button className={view === 'explorer' ? 'view-selected' : ''} onClick={() => setView('explorer')}><FolderTree size={15} />Table</button><button className={view === 'map' ? 'view-selected' : ''} onClick={() => setView('map')}><Grid2X2 size={15} />Treemap</button></div>}{view === 'largest' && root !== 0 && <Button variant="ghost" size="sm" onClick={() => navigate(0)}>Search entire scan</Button>}</div>
          <div className="analysis-body"><div className="analysis-main"><Suspense fallback={<div className="map-panel surface loading-panel"><LoaderCircle size={26} className="spin" />Loading view…</div>}>{view === 'map' ? <StorageMap summary={summary} root={root} onNavigate={navigate} onSelect={setSelected} /> : <EntryTable key={`${summary.scanId}-${view}`} summary={summary} root={root} largest={view === 'largest'} selected={selected} onNavigate={navigate} onSelect={setSelected} reveal={storage.reveal} />}</Suspense></div>
          <AnimatePresence>{selected && <motion.aside className="details-panel surface" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: .16 }}><div className="details-top"><span>Entry details</span><Button variant="ghost" size="icon" aria-label="Close entry details" onClick={() => setSelected(null)}><X size={16} /></Button></div><span className="details-icon">{selected.directory ? <Folder size={30} /> : <File size={30} style={{ color: categoryColors[selected.category] }} />}</span><h3>{selected.name}</h3><p className="details-path">{selected.path}</p><dl><div><dt>Logical size</dt><dd>{formatBytes(selected.logical)}</dd></div><div><dt>Allocated size</dt><dd>{formatBytes(selected.physical)}</dd></div><div><dt>Modified</dt><dd>{formatDate(selected.modified)}</dd></div>{selected.directory ? <><div><dt>Files</dt><dd>{formatCount(selected.files)}</dd></div><div><dt>Folders</dt><dd>{formatCount(selected.folders)}</dd></div></> : <div><dt>Category</dt><dd>{categoryLabels[selected.category]}</dd></div>}<div><dt>Share of parent</dt><dd>{selected.percentage.toFixed(1)}%</dd></div></dl>{selected.protected && <p className="details-notice"><Shield size={15} />Protected system location. Analysis is read-only.</p>}{selected.duplicate && <p className="details-notice"><Link2 size={15} />Hard link: {formatBytes(selected.entrySize)} is attributed to another entry in this scan.</p>}{selected.skipped && <p className="details-notice warning"><AlertTriangle size={15} />This location was skipped. Its contents are excluded.</p>}<Button variant="secondary" onClick={() => void storage.reveal(selected.id)}><ExternalLink size={15} />Open location</Button>{selected.directory && !selected.skipped && <Button variant="ghost" onClick={() => navigate(selected.id)}><FolderTree size={15} />Browse folder</Button>}</motion.aside>}</AnimatePresence></div>
          <p className="analysis-footnote"><CircleHelp size={13} />Folder totals cover scanned file data. Volume usage also includes filesystem metadata, reserved space, and inaccessible files.</p>
        </div>}
      </div>
      <footer className="statusbar"><span>{scanning ? <LoaderCircle size={12} className="spin" /> : <ShieldCheck size={13} />}{scanning ? 'Scanning in the background' : 'Ready'}{summary && <span className="status-divider">{formatCount(summary.folders)} folders</span>}</span><span>{summary && <><Clock size={12} />{formatDuration(summary.elapsedMs)}<span className="status-divider">Recursive scanner</span></>}<span>Storage Explorer</span></span></footer>
    </main>
    <Dialog.Root open={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content"><Dialog.Title>{dialog === 'coverage' ? 'Scan coverage' : dialog === 'scan' ? 'Scan a folder' : 'About Storage Explorer'}</Dialog.Title><Dialog.Description>{dialog === 'coverage' ? 'What was measured, and what could not be read.' : dialog === 'scan' ? 'Choose a folder or paste its full path. Your files remain untouched.' : 'A clearer view of your Windows storage.'}</Dialog.Description><Dialog.Close asChild><Button variant="ghost" size="icon" className="dialog-close" aria-label="Close dialog"><X size={18} /></Button></Dialog.Close>
      {dialog === 'scan' && <form className="scan-form" onSubmit={async e => { e.preventDefault(); if (await storage.scan(folderPath.trim())) setDialog(null); }}><label htmlFor="scan-path-input">Folder path</label><div><input id="scan-path-input" value={folderPath} onChange={e => setFolderPath(e.target.value)} placeholder="C:\Users" required autoFocus /><Button variant="secondary" onClick={() => void browseFolder()}>Browse…</Button></div><Button type="submit" disabled={!folderPath.trim() || storage.starting}>{storage.starting ? 'Starting…' : 'Analyze folder'}</Button></form>}
      {dialog !== 'scan' && <>
      {dialog === 'coverage' && summary ? <><div className="coverage-stats"><div><span>Skipped locations</span><strong>{formatCount(summary.skipped)}</strong></div><div><span>Access / read errors</span><strong>{formatCount(summary.errorCount)}</strong></div><div><span>Unknown allocations</span><strong>{formatCount(summary.unknownPhysical)}</strong></div></div><p>Junctions, symbolic links, and other reparse points are skipped to prevent loops and cloud file hydration. Hard-linked files contribute bytes only once, at the first encountered entry.</p>
        {summary.status === 'limited' && <p className="warning">The scan stopped to protect memory. These totals are incomplete. Scan a smaller folder to continue.</p>}
        {summary.status === 'cancelled' && <p className="warning">The scan was cancelled. All totals are partial.</p>}{summary.unknownPhysical > 0 && <p>Known allocated file data: {formatBytes(summary.knownPhysical)}. The full physical total is unavailable.</p>}{summary.errors.length > 0 && <div className="coverage-errors">{summary.errors.map((e, i) => <div key={i}><strong>{e.path}</strong><span>{e.message}</span></div>)}</div>}{summary.errorCount > summary.errors.length && <p className="muted">Showing the first {summary.errors.length} errors of {formatCount(summary.errorCount)}.</p>}<p className="muted">A live filesystem can change during analysis. Rescan to refresh results. Allocation excludes directory metadata and alternate data streams.</p></> : <><div className="about-product"><HardDrive size={35} /><div>Storage Explorer<span>Version 0.1.0 · Windows desktop</span></div></div><p>Browse recursive folder sizes, find large files, and explore an interactive treemap. No file contents are read, no files are deleted, and scan paths are not saved.</p><p>The recursive scanner works without administrator privileges. An optimized NTFS MFT backend is not implemented. Windows access restrictions can produce incomplete coverage.</p><p>Sizes use binary units (KiB, MiB, GiB). Categories use extensions and known game library paths; they are not installed application inventories.</p><div className="about-stack"><ShieldCheck size={16} />Read-only · Rust scanner · Tauri 2</div></>}
      </>}
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  </div></MotionConfig>;
}
