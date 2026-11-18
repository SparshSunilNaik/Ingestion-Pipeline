"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

interface Settled<T> {
  key: string;
  tick: number;
  data?: T;
  error?: unknown;
}

/**
 * Load data when `deps` change (JSON-serialisable) and optionally re-poll every `pollMs`.
 * State is only set from async callbacks; `loading` is derived so stale data never shows for new deps.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number | null): AsyncState<T> {
  const key = JSON.stringify(deps);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Settled<T>>({ key: "", tick: -1 });
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    fn().then(
      (data) => alive && setState({ key, tick, data }),
      (error) => alive && setState((prev) => ({ key, tick, data: prev.key === key ? prev.data : undefined, error })),
    );
    return () => {
      alive = false;
    };
    // `fn` is intentionally excluded: callers express its inputs through `deps`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => setTick((t) => t + 1), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);

  const current = state.key === key;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: !(current && state.tick === tick), reload };
}

// ---------------------------------------------------------------- persistent preferences
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = () => cb();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode); preference is not persisted */
  }
  listeners.forEach((l) => l());
}

/** A string preference stored in localStorage; server render uses `fallback`. */
export function usePref(key: string, fallback: string): [string, (v: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key) ?? fallback,
    () => fallback,
  );
  const set = useCallback((v: string) => writePref(key, v), [key]);
  return [value, set];
}

// ---------------------------------------------------------------- keyboard shortcuts
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Register a global shortcut such as "mod+k", "alt+2", "/", "?" or "escape". */
export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, opts: { allowInInputs?: boolean } = {}) {
  useEffect(() => {
    const parts = combo.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    const needMod = parts.includes("mod");
    const needAlt = parts.includes("alt");
    const needShift = parts.includes("shift");
    const onKey = (e: KeyboardEvent) => {
      if (!opts.allowInInputs && !needMod && isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (needMod !== mod || needAlt !== e.altKey) return;
      if (needShift && !e.shiftKey) return;
      const k = e.key.toLowerCase();
      const code = e.code.toLowerCase();
      if (k === key || code === `digit${key}` || code === `key${key}`) {
        e.preventDefault();
        handler(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [combo, handler, opts.allowInInputs]);
}

// ---------------------------------------------------------------- clock
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
function subscribeMinute(cb: () => void) {
  minuteListeners.add(cb);
  if (!minuteTimer) minuteTimer = setInterval(() => minuteListeners.forEach((l) => l()), 30_000);
  return () => {
    minuteListeners.delete(cb);
    if (!minuteListeners.size && minuteTimer) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}

/** Current time rounded to 30s on the client; 0 during server render (callers show absolute times then). */
export function useNow(): number {
  return useSyncExternalStore(subscribeMinute, () => Math.floor(Date.now() / 30_000) * 30_000, () => 0);
}
