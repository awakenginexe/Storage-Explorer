import { motion, useReducedMotion } from 'motion/react';
import { ArrowUpRight, HardDrive, Usb, FolderSearch, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { Button } from './ui/button';
import { formatBytes, percentage } from '../lib/format';
import type { Drive, Summary } from '../lib/types';
import { Insights } from './Insights';

export function DriveOverview({ drives, loading, native, starting, summary, scan, refresh, chooseFolder, analyze }: {
  drives: Drive[]; loading: boolean; native: boolean; starting: boolean; summary: Summary | null;
  scan: (path: string) => void; refresh: () => void; chooseFolder: () => void; analyze: () => void;
}) {
  const reduced = useReducedMotion();
  const available = drives.filter(d => !d.error && !d.accountScoped);
  const total = available.reduce((v, d) => v + d.total, 0);
  const free = available.reduce((v, d) => v + d.free, 0);
  const used = total - free;
  return <div className="overview-content">
    <section className="capacity-overview surface">
      <div className="overview-heading"><div><span className="muted text-sm">Combined drive capacity</span><div className="capacity-number">{loading ? 'Reading drives…' : formatBytes(used)}<span>used of {formatBytes(total)}</span></div></div><span className="subtle-label">{available.length} {available.length === 1 ? 'volume' : 'volumes'}</span></div>
      <div className="capacity-track capacity-track-large" role="meter" aria-label="Combined disk usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage(used, total)}><motion.div className="capacity-fill" initial={false} animate={{ scaleX: percentage(used, total) / 100 }} transition={{ duration: reduced ? 0 : .6, ease: 'easeOut' }} /></div>
      <div className="capacity-legend"><span><i className="legend-dot accent-dot" />Used <strong>{formatBytes(used)}</strong></span><span><i className="legend-dot free-dot" />Free <strong>{formatBytes(free)}</strong></span><span className="capacity-note">Volume capacity, independent of scan totals</span></div>
    </section>
    <div className="section-heading"><div><h2>Your drives</h2><p>Select a drive to see what’s taking up space.</p></div><Button variant="ghost" size="sm" onClick={refresh} disabled={loading || !native}><RefreshCw size={15} className={loading ? 'spin' : ''} />Refresh</Button></div>
    {loading ? <div className="drive-grid">{[0, 1, 2].map(i => <div key={i} className="drive-card skeleton" />)}</div> : !native ? <div className="empty-state surface"><HardDrive size={32} /><h3>Your storage lives on your PC</h3><p>Open the Windows app to detect your drives and analyze real files.</p><code>npm run tauri dev</code></div> : !drives.length ? <div className="empty-state surface"><Usb size={30} /><h3>No supported drives found</h3><p>Connect a drive or choose a folder to analyze.</p><Button onClick={chooseFolder}><FolderSearch size={16} />Choose folder</Button></div> : <div className="drive-grid">{drives.map(d => {
      const percent = percentage(d.total - d.free, d.total);
      return <motion.button key={d.path} className="drive-card" disabled={starting || !!d.error} onClick={() => scan(d.path)} whileHover={reduced ? undefined : { y: -3 }} whileTap={reduced ? undefined : { scale: .99 }}>
        <div className="drive-card-top"><span className="drive-icon">{d.kind === 'Removable' ? <Usb size={23} /> : <HardDrive size={23} />}</span><span className="drive-type">{d.kind} · {d.filesystem || 'Unknown format'}</span><ArrowUpRight size={16} className="drive-arrow" /></div>
        <h3>{d.label || 'Local disk'} <span>{d.path.replace('\\', '')}</span></h3>
        {d.accountScoped && <p className="muted text-xs mb-2">Account-accessible capacity</p>}
        {d.error ? <p className="warning">Unavailable: {d.error}</p> : <><div className="drive-usage"><strong>{formatBytes(d.total - d.free)}</strong><span>{percent.toFixed(0)}% used</span></div>
          <div className="capacity-track"><motion.div className={`capacity-fill ${percent > 90 ? 'capacity-warning' : ''}`} initial={false} animate={{ scaleX: percent / 100 }} transition={{ duration: reduced ? 0 : .6 }} /></div>
          <div className="drive-free"><span>{formatBytes(d.free)} free</span><span>{formatBytes(d.total)} total</span></div>
          {d.available < d.free && <p className="muted text-xs">Your account can use {formatBytes(d.available)}.</p>}</>}
      </motion.button>;
    })}</div>}
    {summary ? <><div className="section-heading"><div><h2>From your current scan</h2><p className="truncate" title={summary.root}>{summary.root}</p></div><Button variant="secondary" size="sm" onClick={analyze}>Browse results<ArrowUpRight size={14} /></Button></div><Insights summary={summary} /></> : <div className="ready-panel"><span className="ready-icon"><FolderSearch size={27} /></span><div><h3>A clearer picture of your storage</h3><p>Scan a drive or a folder. Then browse the hierarchy, find large files, or explore a storage map.</p></div><Button variant="secondary" onClick={chooseFolder} disabled={!native || starting}><FolderSearch size={16} />Choose folder</Button></div>}
    <div className="safety-note"><ShieldCheck size={15} /><span>Read-only analysis. Your files stay exactly where they are.</span>{drives.some(d => d.error) && <span><AlertTriangle size={14} />Some volumes are unavailable.</span>}</div>
  </div>;
}
