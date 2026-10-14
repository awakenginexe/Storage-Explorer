export type View = 'overview' | 'explorer' | 'largest' | 'map';
export type Category = 'videos' | 'audio' | 'games' | 'applications' | 'archives' | 'documents' | 'other';
export interface Drive { path: string; label: string; filesystem: string; kind: string; total: number; free: number; available: number; error: string | null; accountScoped: boolean }
export interface Summary {
  scanId: number; root: string; status: 'scanning' | 'complete' | 'cancelled' | 'failed' | 'limited';
  logical: number; physical: number | null; knownPhysical: number; files: number; folders: number;
  skipped: number; errorCount: number; unknownPhysical: number; errors: { path: string; message: string }[];
  currentPath: string; elapsedMs: number; revision: number;
}
export interface Entry {
  id: number; parent: number | null; name: string; path: string; directory: boolean; depth: number;
  logical: number; physical: number | null; knownPhysical: number; files: number; folders: number;
  modified: number; percentage: number; category: Category; duplicate: boolean; skipped: boolean; protected: boolean; entrySize: number;
}
export interface Page { rows: Entry[]; total: number; revision: number; breadcrumbs: Entry[] }
export interface Query {
  root: number; expanded: number[]; search: string; column: string; descending: boolean;
  largest: boolean; category: string | null; minSize: number; location: string; offset: number; limit: number;
  revision?: number;
}
export interface CategoryTotal { category: Category; bytes: number; files: number }
export interface MapEntry { entry: Entry | null; name: string; bytes: number }
export const categoryColors: Record<Category, string> = {
  videos: '#72a5ee', audio: '#96adc5', games: '#59bcb0', applications: '#9e9cda',
  archives: '#d5ac73', documents: '#7cb1c0', other: '#77828f',
};
export const categoryMapColors: Record<Category, string> = {
  videos: '#385d91', audio: '#465969', games: '#26645d', applications: '#53507c',
  archives: '#755835', documents: '#355f6a', other: '#414954',
};
export const categoryLabels: Record<Category, string> = { videos: 'Videos', audio: 'Audio', games: 'Games', applications: 'Applications', archives: 'Archives', documents: 'Documents', other: 'Other' };
