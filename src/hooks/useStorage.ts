import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Drive, Summary } from '../lib/types';

export function useStorage() {
  const [drives, setDrives] = useState<Drive[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const activeId = useRef<number | null>(null);
  const generation = useRef(0);
  const lastUpdate = useRef(0);
  const native = isTauri();
  const refresh = useCallback(async () => {
    if (!native) { setLoading(false); return; }
    setLoading(true);
    try { setDrives(await invoke<Drive[]>('list_drives')); }
    catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [native]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<Summary>('scan-progress', ({ payload }) => {
      if (disposed || payload.scanId !== activeId.current) return;
      const now = performance.now();
      if (payload.status !== 'scanning' || now - lastUpdate.current > 700) { lastUpdate.current = now; setSummary(old => !old || payload.revision > old.revision || (payload.revision === old.revision && payload.status !== old.status) ? payload : old); }
    }).then(fn => { if (disposed) fn(); else unlisten = fn; }).catch(e => setError(String(e)));
    return () => { disposed = true; unlisten?.(); };
  }, [native]);
  useEffect(() => {
    if (!summary || summary.status !== 'scanning') return;
    let disposed = false;
    const id = summary.scanId;
    let timer: number;
    const poll = async () => {
      try {
        const next = await invoke<Summary>('scan_status', { scanId: id });
        if (!disposed && activeId.current === id) setSummary(old => old && (next.revision > old.revision || (next.revision === old.revision && next.status !== old.status)) ? next : old);
      } catch (e) { if (!disposed) setError(String(e)); }
      if (!disposed) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [summary?.scanId, summary?.status]);
  const scan = useCallback(async (path: string) => {
    if (!native) { setError('Run the Windows application to access drives and scan folders.'); return false; }
    const request = ++generation.current;
    setStarting(true); setError(null);
    try {
      const initial = await invoke<Summary>('start_scan', { path });
      if (request !== generation.current) return;
      activeId.current = initial.scanId;
      lastUpdate.current = 0;
      setSummary(initial);
      const current = await invoke<Summary>('scan_status', { scanId: initial.scanId });
      if (request === generation.current) setSummary(old => old && old.scanId === current.scanId && old.revision > current.revision ? old : current);
      return true;
    } catch (e) { if (request === generation.current) setError(String(e)); }
    finally { if (request === generation.current) setStarting(false); }
  }, [native]);
  const cancel = useCallback(async () => {
    if (activeId.current !== null) {
      try { await invoke('cancel_scan', { scanId: activeId.current }); }
      catch (e) { setError(String(e)); }
    }
  }, []);
  const reveal = useCallback(async (id: number) => {
    if (activeId.current !== null) {
      try { await invoke('open_in_explorer', { scanId: activeId.current, id }); }
      catch (e) { setError(String(e)); }
    }
  }, []);
  return { drives, summary, error, loading, starting, native, refresh, scan, cancel, reveal, dismissError: () => setError(null), reportError: (e: unknown) => setError(String(e)) };
}
