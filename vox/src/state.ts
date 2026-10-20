/** Tiny external store + React hook. */
import { useSyncExternalStore } from 'react';
import type { Pcm } from './audio/pcm';
import type { Project, Singer } from './project/types';
import type { ModelRecord } from './ml/modelStore';
import type { Caps } from './ml/caps';
import { newProject } from './project/defaults';

export interface Job { id: number; name: string; stage: string; progress: number; startedAt: number; error?: string; cancellable: boolean; done?: boolean; retry?: () => void; }
export interface Settings { memorySaving: boolean; backend: 'webgpu' | 'wasm'; defaultQuality: 'LIGHT' | 'BALANCED' | 'HIGH'; autoSave: boolean; }
export interface AppState {
  project: Project; assets: Map<string, Pcm>; singers: Singer[]; models: ModelRecord[]; caps: Caps | null;
  settings: Settings; job: Job | null; toasts: { id: number; msg: string; kind: 'ok' | 'err' | 'info' }[]; page: string; navOpen: boolean;
  network: { url: string; method: string; t: number; bytes: number }[];
}

let state: AppState = {
  project: newProject(), assets: new Map(), singers: [], models: [], caps: null,
  settings: { memorySaving: false, backend: 'webgpu', defaultQuality: 'BALANCED', autoSave: true },
  job: null, toasts: [], page: 'dashboard', navOpen: false, network: [],
};
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(p: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof p === 'function' ? p(state) : p) };
  for (const s of subs) s();
}
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => sel(state));
}
let tid = 0;
export function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
  const id = ++tid; setState((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'err' ? 9000 : 4500);
}
export function updateProject(fn: (p: Project) => Project | void) {
  setState((s) => { const copy = structuredClone(s.project); const r = fn(copy) ?? copy; r.updatedAt = Date.now(); return { project: r }; });
}
export function subscribe(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; }
