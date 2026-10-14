import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { File, Film, Archive, Gamepad2, FileText, AppWindow, Music, CircleHelp } from 'lucide-react';
import { formatBytes, formatCount, percentage } from '../lib/format';
import { categoryColors, categoryLabels, type CategoryTotal, type Summary } from '../lib/types';

const icons = { videos: Film, audio: Music, games: Gamepad2, applications: AppWindow, archives: Archive, documents: FileText, other: File };
export function Insights({ summary }: { summary: Summary }) {
  const [totals, setTotals] = useState<CategoryTotal[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void invoke<CategoryTotal[]>('category_totals', { scanId: summary.scanId }).then(data => { if (!disposed) { setTotals(data.sort((a, b) => b.bytes - a.bytes)); setError(null); } }).catch(e => { if (!disposed) setError(String(e)); });
    return () => { disposed = true; };
  }, [summary.scanId, summary.status, Math.floor(summary.elapsedMs / 5000)]);
  return <section className="insights surface"><div className="insight-summary"><span className="muted text-sm">Scanned logical size</span><strong>{formatBytes(summary.logical)}</strong><span className="muted">{formatCount(summary.files)} files · {formatCount(summary.folders)} folders</span><div className="classification-note"><CircleHelp size={14} /><span>Categories use file extensions and known game library paths. They describe scanned files only.</span></div></div><div className="category-list">{error ? <p className="warning">{error}</p> : !totals.length ? <p className="muted">Categories will appear as files are scanned.</p> : totals.map(total => {
    const Icon = icons[total.category];
    return <div className="category-row" key={total.category}><Icon size={17} style={{ color: categoryColors[total.category] }} /><span>{categoryLabels[total.category]}</span><div className="category-track"><div style={{ width: `${percentage(total.bytes, summary.logical)}%`, background: categoryColors[total.category] }} /></div><strong>{formatBytes(total.bytes)}</strong></div>;
  })}</div></section>;
}
