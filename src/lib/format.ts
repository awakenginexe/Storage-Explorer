export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Unavailable';
  if (bytes <= 0) return '0 B';
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 5);
  return `${unit === 0 ? bytes : (bytes / 1024 ** unit).toFixed(2)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][unit]}`;
}
export function percentage(part: number, total: number): number {
  return total > 0 ? Math.min(100, Math.max(0, part / total * 100)) : 0;
}
export const sizeTier = (bytes: number) => bytes >= 10 * 1024 ** 3 ? 'huge' : bytes >= 1024 ** 3 ? 'large' : 'normal';
const countFormatter = new Intl.NumberFormat();
const dateFormatter = new Intl.DateTimeFormat();
export const formatCount = (value: number) => countFormatter.format(value);
export const formatDate = (seconds: number) => seconds ? dateFormatter.format(new Date(seconds * 1000)) : 'Unavailable';
export const formatDuration = (ms: number) => ms < 1000 ? '<1s' : ms < 60000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms % 60000 / 1000)}s`;
