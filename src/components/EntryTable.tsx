import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { motion, useReducedMotion } from 'motion/react';
import { useReactTable, getCoreRowModel, flexRender, type ColumnDef, type SortingState, type VisibilityState } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, ChevronDown, Columns3, Folder, File, Search, ExternalLink, Shield, Link2, AlertTriangle, LoaderCircle, Check, X } from 'lucide-react';
import { Button } from './ui/button';
import { formatBytes, formatCount, formatDate, sizeTier } from '../lib/format';
import { categoryColors, categoryLabels, type Entry, type Page, type Query, type Summary } from '../lib/types';

const PAGE_SIZE = 256;
export function EntryTable({ summary, root, largest, selected, onNavigate, onSelect, reveal }: {
  summary: Summary; root: number; largest: boolean; selected: Entry | null;
  onNavigate: (id: number) => void; onSelect: (row: Entry) => void; reveal: (id: number) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'logical', desc: true }]);
  const [expanded, setExpanded] = useState<number[]>([]);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [minSize, setMinSize] = useState('');
  const [filterMinSize, setFilterMinSize] = useState('');
  const [location, setLocation] = useState('');
  const [filterLocation, setFilterLocation] = useState('');
  const [visibility, setVisibility] = useState<VisibilityState>({ folders: false, path: largest });
  const [pages, setPages] = useState<Map<number, Entry[]>>(new Map());
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const reduced = useReducedMotion();
  const container = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const pending = useRef(new Set<number>());
  const latestSignature = useRef('');
  const cacheRevision = useRef(0);
  const toggle = useCallback((id: number) => setExpanded(old => old.includes(id) ? old.filter(v => v !== id) : [...old, id]), []);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput.trim()); setFilterLocation(location.trim()); setFilterMinSize(minSize); }, 350);
    return () => clearTimeout(timer);
  }, [searchInput, location, minSize]);
  useEffect(() => { setExpanded([]); setFocusIndex(0); }, [summary.scanId, root]);
  const query = useMemo<Query>(() => ({ root, expanded, search, column: sorting[0]?.id || 'logical', descending: sorting[0]?.desc ?? true, largest, category: category || null, minSize: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Math.max(0, Number(filterMinSize) || 0) * 1024 ** 3)), location: filterLocation, offset: 0, limit: PAGE_SIZE }), [root, expanded, search, sorting, largest, category, filterMinSize, filterLocation]);
  const signature = JSON.stringify(query);
  const refreshRevision = summary.status === 'scanning' ? Math.floor(summary.elapsedMs / 5000) : summary.revision;
  useEffect(() => {
    const current = ++generation.current;
    pending.current.clear();
    setLoading(true); setError(null);
    if (latestSignature.current !== signature) { container.current?.scrollTo({ top: 0 }); latestSignature.current = signature; }
    void invoke<Page>('query_entries', { scanId: summary.scanId, query }).then(page => {
      if (current === generation.current) { cacheRevision.current = page.revision; setPages(new Map([[0, page.rows]])); setTotal(page.total); setLoading(false); }
    }).catch(e => { if (current === generation.current) { setError(String(e)); setLoading(false); setTotal(0); } });
    return () => { generation.current++; };
  }, [signature, summary.scanId, summary.status, refreshRevision, retry]);
  const rows = useMemo(() => [...pages.entries()].sort(([a], [b]) => a - b).flatMap(([, rows]) => rows), [pages]);
  const columns = useMemo<ColumnDef<Entry>[]>(() => [
    { id: 'name', accessorKey: 'name', header: 'Name', size: largest ? 270 : 310, minSize: 180, enableHiding: false, cell: ({ row }) => {
      const n = row.original;
      return <div className="entry-name" style={{ paddingLeft: largest || search ? 0 : Math.min(n.depth, 12) * 19 }}>
        {!largest && !search && <button className="expand-button" aria-label={`${expanded.includes(n.id) ? 'Collapse' : 'Expand'} ${n.name}`} disabled={!n.directory || n.skipped} onClick={e => { e.stopPropagation(); toggle(n.id); }}>{n.directory && !n.skipped ? expanded.includes(n.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}</button>}
        {n.directory ? <Folder size={17} className="folder-icon" /> : <File size={16} style={{ color: categoryColors[n.category] }} />}
        <span className="truncate entry-label">{n.name}</span>{n.protected && <Shield size={13} className="muted shrink-0" aria-label="Protected system location" />}{n.duplicate && <Link2 size={13} aria-label="Hard link, counted elsewhere" />}{n.skipped && <AlertTriangle size={13} className="warning shrink-0" aria-label="Skipped" />}
      </div>;
    } },
    { id: 'logical', accessorKey: 'logical', header: 'Logical size', size: 132, minSize: 108, cell: ({ getValue }) => <span className="size-value">{formatBytes(getValue<number>())}</span> },
    { id: 'physical', accessorKey: 'physical', header: 'On disk', size: 132, minSize: 110, cell: ({ getValue }) => <span className={getValue() === null ? 'muted' : ''}>{formatBytes(getValue<number | null>())}</span> },
    { id: 'files', accessorKey: 'files', header: 'Files', size: 95, minSize: 75, cell: ({ getValue }) => formatCount(getValue<number>()) },
    { id: 'folders', accessorKey: 'folders', header: 'Folders', size: 100, minSize: 75, cell: ({ getValue }) => formatCount(getValue<number>()) },
    { id: 'modified', accessorKey: 'modified', header: 'Modified', size: 130, minSize: 100, cell: ({ getValue }) => formatDate(getValue<number>()) },
    { id: 'percentage', accessorKey: 'percentage', header: '% of parent', size: 156, minSize: 130, cell: ({ getValue }) => <div className="row-usage"><div className="row-usage-track"><div style={{ transform: `scaleX(${Math.min(100, getValue<number>()) / 100})` }} /></div><span>{getValue<number>().toFixed(1)}%</span></div> },
    { id: 'path', accessorKey: 'path', header: 'Full path', size: 430, minSize: 230, enableSorting: false, cell: ({ getValue }) => <span className="truncate muted" title={getValue<string>()}>{getValue<string>()}</span> },
  ], [largest, search, expanded, toggle]);
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), getRowId: r => String(r.id), manualSorting: true, enableSortingRemoval: false, enableMultiSort: false, state: { sorting, columnVisibility: visibility }, onSortingChange: setSorting, onColumnVisibilityChange: setVisibility, columnResizeMode: 'onChange' });
  const virtual = useVirtualizer({ count: total, getScrollElement: () => container.current, estimateSize: () => 39, overscan: 8 });
  const virtualItems = virtual.getVirtualItems();
  const start = virtualItems[0]?.index ?? 0;
  const end = virtualItems[virtualItems.length - 1]?.index ?? 0;
  useEffect(() => {
    if (loading || error || !total) return;
    const current = generation.current;
    const first = Math.floor(start / PAGE_SIZE);
    const last = Math.floor(end / PAGE_SIZE);
    for (let pageIndex = first; pageIndex <= last; pageIndex++) {
      if (pages.has(pageIndex) || pending.current.has(pageIndex)) continue;
      pending.current.add(pageIndex);
      void invoke<Page>('query_entries', { scanId: summary.scanId, query: { ...query, offset: pageIndex * PAGE_SIZE, revision: cacheRevision.current } }).then(page => {
        if (current !== generation.current) return;
        if (page.revision !== cacheRevision.current) { setRetry(old => old + 1); return; }
        setPages(old => {
          const next = new Map(old); next.set(pageIndex, page.rows);
          for (const key of next.keys()) if (Math.abs(key - first) > 2) next.delete(key);
          return next;
        });
      }).catch(e => { if (current === generation.current) setError(String(e)); }).finally(() => { if (current === generation.current) pending.current.delete(pageIndex); });
    }
  }, [start, end, pages, loading, error, total, signature, summary.scanId]);
  const keyboardFocus = useRef(false);
  useEffect(() => {
    if (keyboardFocus.current) container.current?.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`)?.focus({ preventScroll: true });
  }, [focusIndex, pages, start]);
  const keyDown = (e: KeyboardEvent<HTMLDivElement>, index: number, row: Entry) => {
    if (loading) return;
    let next = index;
    if (e.key === 'ArrowDown') next = Math.min(total - 1, index + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = total - 1;
    else if (e.key === 'Enter') { if (row.directory && !row.skipped) onNavigate(row.id); else onSelect(row); }
    else if (e.key === 'ArrowRight') { if (row.directory && !expanded.includes(row.id)) toggle(row.id); }
    else if (e.key === 'ArrowLeft') { if (expanded.includes(row.id)) toggle(row.id); else if (root && row.parent !== null) onNavigate(row.parent); }
    else return;
    e.preventDefault(); keyboardFocus.current = true;
    if (next !== index) { setFocusIndex(next); virtual.scrollToIndex(next); }
  };
  const grid = table.getVisibleLeafColumns().map(c => `${c.getSize()}px`).join(' ');
  return <div className="entry-panel surface">
    <div className="table-toolbar"><label className="search-box"><Search size={16} /><span className="sr-only">Search within this folder</span><input placeholder={largest ? 'Search files or paths…' : 'Search this folder and its descendants…'} value={searchInput} onChange={e => setSearchInput(e.target.value)} />{searchInput && <button aria-label="Clear search" onClick={() => setSearchInput('')}><X size={14} /></button>}</label>
      <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button variant="secondary" size="sm"><Columns3 size={15} />Columns</Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">{table.getAllLeafColumns().filter(c => c.getCanHide()).map(c => <DropdownMenu.CheckboxItem className="menu-item" key={c.id} checked={c.getIsVisible()} onCheckedChange={v => c.toggleVisibility(v)} onSelect={e => e.preventDefault()}><span className="menu-check">{c.getIsVisible() && <Check size={14} />}</span>{String(c.columnDef.header)}</DropdownMenu.CheckboxItem>)}</DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
    </div>
    <div className="size-legend" aria-label="Logical size colors"><span>Logical size</span><span><i className="size-large" />Large: ≥ 1 GiB</span><span><i className="size-huge" />Very large: ≥ 10 GiB</span></div>
    {largest && <div className="file-filters"><label>Type<select value={category} onChange={e => setCategory(e.target.value)}><option value="">All types</option>{Object.entries(categoryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>Minimum size<input type="number" min="0" step="0.1" placeholder="0" value={minSize} onChange={e => setMinSize(e.target.value)} /><span className="muted">GiB</span></label><label className="location-filter">Location<input placeholder="Filter by part of a path" value={location} onChange={e => setLocation(e.target.value)} /></label></div>}
    {error && <div className="table-error" role="alert"><AlertTriangle size={15} /><span>{error}</span><Button variant="secondary" size="sm" onClick={() => setRetry(old => old + 1)}>Retry</Button></div>}
    <div className="table-scroll" ref={container} role="treegrid" aria-label={largest ? 'Largest files' : 'Folder explorer'} aria-rowcount={total + 1} aria-colcount={table.getVisibleLeafColumns().length} aria-busy={loading}>
      <div className="table-head" role="row" style={{ gridTemplateColumns: grid, minWidth: table.getTotalSize() }}>{table.getFlatHeaders().filter(h => h.column.getIsVisible()).map(header => <div key={header.id} role="columnheader" aria-sort={header.column.getIsSorted() === 'asc' ? 'ascending' : header.column.getIsSorted() === 'desc' ? 'descending' : 'none'} className={`table-header-cell ${header.id === 'name' || header.id === 'path' ? '' : 'numeric'}`}>
        <button className="sort-button" onClick={header.column.getToggleSortingHandler()} disabled={!header.column.getCanSort()}>{flexRender(header.column.columnDef.header, header.getContext())}{header.column.getCanSort() && (header.column.getIsSorted() === 'desc' ? <ArrowDown size={13} /> : header.column.getIsSorted() === 'asc' ? <ArrowUp size={13} /> : <ArrowUpDown size={12} className="sort-idle" />)}</button>
        <div className="column-resizer" role="separator" aria-label={`Resize ${header.column.columnDef.header}`} aria-orientation="vertical" aria-valuenow={header.column.getSize()} tabIndex={0} onMouseDown={header.getResizeHandler()} onTouchStart={header.getResizeHandler()} onKeyDown={e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); table.setColumnSizing(old => ({ ...old, [header.column.id]: Math.max(header.column.columnDef.minSize || 60, header.column.getSize() + (e.key === 'ArrowRight' ? 16 : -16)) })); } }} />
      </div>)}</div>
      <div style={{ height: virtual.getTotalSize(), minWidth: table.getTotalSize(), position: 'relative' }}>{virtualItems.map(item => {
        const row = pages.get(Math.floor(item.index / PAGE_SIZE))?.[item.index % PAGE_SIZE];
        if (!row) return <div key={item.index} className="entry-row row-placeholder" style={{ transform: `translateY(${item.start}px)`, height: item.size }}><span className="skeleton" /></div>;
        const tableRow = table.getRowModel().rowsById[String(row.id)];
        if (!tableRow) return null;
        return <ContextMenu.Root key={row.id}><ContextMenu.Trigger asChild><motion.div role="row" aria-rowindex={item.index + 2} aria-level={row.depth + 1} aria-expanded={row.directory ? expanded.includes(row.id) : undefined} aria-selected={selected?.id === row.id} tabIndex={focusIndex === item.index ? 0 : -1} data-index={item.index}
          data-size-tier={sizeTier(row.logical)}
          className={`entry-row ${selected?.id === row.id ? 'selected-row' : ''}`} style={{ height: item.size, gridTemplateColumns: grid }} initial={false} animate={{ y: item.start, opacity: loading ? .5 : 1 }} transition={{ duration: reduced ? 0 : .14, ease: 'easeOut' }} onClick={() => { keyboardFocus.current = false; setFocusIndex(item.index); onSelect(row); }} onDoubleClick={() => { if (row.directory && !row.skipped) onNavigate(row.id); else onSelect(row); }} onKeyDown={e => keyDown(e, item.index, row)} onContextMenu={() => onSelect(row)} title={row.path}>
          {tableRow.getVisibleCells().map(cell => <div key={cell.id} role="gridcell" className={`table-cell ${cell.column.id === 'name' || cell.column.id === 'path' ? '' : 'numeric'}`}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>)}
        </motion.div></ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Content className="menu-content"><ContextMenu.Item className="menu-item" onSelect={() => reveal(row.id)}><ExternalLink size={15} />Open location in Explorer</ContextMenu.Item>{row.directory && !row.skipped && <ContextMenu.Item className="menu-item" onSelect={() => onNavigate(row.id)}><Folder size={15} />Browse this folder</ContextMenu.Item>}</ContextMenu.Content></ContextMenu.Portal></ContextMenu.Root>;
      })}</div>
      {!total && !loading && <div className="table-empty"><Search size={27} /><h3>{error ? 'Unable to load results' : search || category || minSize || location ? 'No matching entries' : summary.status === 'scanning' ? 'Reading this folder…' : 'This folder has no scanned entries'}</h3><p>{error || (summary.skipped || summary.errorCount ? 'Check scan coverage for skipped or inaccessible locations.' : 'Try another folder or adjust your filters.')}</p>{(searchInput || category || minSize || location) && <Button variant="secondary" size="sm" onClick={() => { setSearchInput(''); setCategory(''); setMinSize(''); setLocation(''); }}>Clear filters</Button>}</div>}
    </div>
    <div className="table-footer"><span>{loading ? <><LoaderCircle size={13} className="spin" />Updating results…</> : `${formatCount(total)} ${largest ? 'files' : 'entries'}`}</span><span>{search ? 'Search includes descendants' : largest ? 'Unique scanned files' : 'Sorted within each folder'} · {summary.status === 'scanning' ? 'Sizes are still updating' : 'Double-click a folder to browse'}</span></div>
  </div>;
}
