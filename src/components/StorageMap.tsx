import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useReducedMotion } from 'motion/react';
import * as echarts from 'echarts/core';
import { TreemapChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { Boxes, LoaderCircle } from 'lucide-react';
import { type Entry, type MapEntry, type Summary } from '../lib/types';
import { formatBytes, percentage, sizeTier } from '../lib/format';

const mapColors = { normal: '#265766', large: '#705329', huge: '#79403e' };

echarts.use([TreemapChart, TooltipComponent, CanvasRenderer]);
export default function StorageMap({ summary, root, onNavigate, onSelect }: { summary: Summary; root: number; onNavigate: (id: number) => void; onSelect: (row: Entry) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const reduced = useReducedMotion();
  const chartRef = useRef<echarts.ECharts | null>(null);
  const handlers = useRef({ onNavigate, onSelect }); handlers.current = { onNavigate, onSelect };
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current, null, { renderer: 'canvas' });
    chartRef.current = chart;
    chart.on('click', params => {
      const entry = (params.data as { entry?: Entry }).entry;
      if (!entry) return;
      handlers.current.onSelect(entry);
      if (entry.directory && !entry.skipped) handlers.current.onNavigate(entry.id);
    });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); chart.dispose(); chartRef.current = null; };
  }, []);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let disposed = false;
    setLoading(true); setError(null);
    void invoke<MapEntry[]>('treemap_entries', { scanId: summary.scanId, root }).then(entries => {
      if (disposed) return;
      setLoading(false); setEmpty(!entries.length);
      const total = entries.reduce((sum, n) => sum + n.bytes, 0);
      chart.setOption({
        animation: !reduced, animationDuration: 250, animationDurationUpdate: 200,
        tooltip: { renderMode: 'richText', backgroundColor: '#202630', borderColor: '#394454', textStyle: { color: '#edf1f6', fontFamily: 'Segoe UI', fontSize: 12 }, formatter: (params: unknown) => {
          const data = (params as { data: { entry: Entry | null; value: number; name: string } }).data;
          return `${data.entry?.path || data.name}\n${formatBytes(data.value)} · ${percentage(data.value, total).toFixed(1)}% of this folder${data.entry?.directory ? '\nClick to browse folder' : ''}`;
        } },
        series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, left: 0, right: 0, top: 0, bottom: 0, visibleMin: 4,
          label: { show: true, color: '#f5f7fb', fontSize: 13, fontFamily: 'Segoe UI', overflow: 'truncate', formatter: (params: { name: string; value: number }) => `${params.name}\n${formatBytes(params.value)}`, lineHeight: 21 },
          itemStyle: { borderColor: '#13171e', borderWidth: 3, gapWidth: 3, borderRadius: 4 }, emphasis: { itemStyle: { borderColor: '#b6e8f0', borderWidth: 2 }, label: { color: '#fff' } },
          data: entries.map(n => ({ name: n.name, value: n.bytes, entry: n.entry, itemStyle: { color: n.entry ? mapColors[sizeTier(n.bytes)] : '#414954' } })),
        }],
      });
    }).catch(e => { if (!disposed) { setError(String(e)); setLoading(false); } });
    return () => { disposed = true; };
  }, [summary.scanId, root, reduced, summary.status, Math.floor(summary.elapsedMs / 5000)]);
  return <div className="map-panel surface"><div className="map-toolbar"><span>Rectangle area represents logical size</span><span className="muted">Click a folder to zoom in</span></div><div className="map-canvas" ref={element} role="img" aria-label="Storage treemap. The folder table provides keyboard accessible navigation of the same files." />{(loading || empty || error) && <div className="map-empty">{loading ? <LoaderCircle className="spin" size={28} /> : <Boxes size={30} />}<h3>{error ? 'Unable to load storage map' : loading ? 'Preparing storage map…' : 'No file sizes to visualize yet'}</h3>{error && <p>{error}</p>}</div>}
    <div className="map-legend" aria-label="Logical size colors">
      <span><i style={{ background: mapColors.normal }} />Below 1 GiB</span>
      <span><i className="size-large" />Large: ≥ 1 GiB</span>
      <span><i className="size-huge" />Very large: ≥ 10 GiB</span>
      <span><i style={{ background: '#414954' }} />Grouped remaining entries</span>
    </div>
    <div className="table-footer"><span>Up to 400 entries per folder; remaining sizes are grouped.</span><span>Use the table for every entry.</span></div></div>;
}
