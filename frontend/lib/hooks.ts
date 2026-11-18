"use client";

import { useCallback, useEffect, useState } from "react";

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
 * Load data when `deps` change (deps must be JSON-serialisable primitives) and
 * optionally re-poll every `pollMs`. State is only set from async callbacks;
 * `loading` is derived, so a deps change never shows data for previous deps.
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
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: !(current && state.tick === tick),
    reload,
  };
}
