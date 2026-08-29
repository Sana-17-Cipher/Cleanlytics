'use client';

import { useEffect, useState, type DependencyList } from 'react';

import { ApiError } from './api';

export type AsyncState<T> =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: T | null; error: string };

/**
 * Load something from the API and track its state.
 *
 * Two deliberate properties:
 *
 * - No state is set synchronously while the effect body runs. Every update
 *   happens after an await, which avoids the cascading re-render that React
 *   warns about when an effect writes state during the commit it was triggered by.
 *
 * - When the dependencies change, the previous result stays on screen until the
 *   new one arrives. Paging through a table therefore updates in place instead
 *   of blanking out and snapping back, and `isStale` is exposed for callers
 *   that want to show a quiet refreshing indicator.
 *
 * A cancellation flag stops a slow response from overwriting a newer one, which
 * is the classic out-of-order fetch bug when someone clicks through pages fast.
 */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> & { isStale: boolean } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading', data: null, error: null });
  const [settledFor, setSettledFor] = useState<string>('');

  const key = JSON.stringify(deps);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const data = await load();
        if (cancelled) return;
        setState({ status: 'ready', data, error: null });
      } catch (cause) {
        if (cancelled) return;
        setState((previous) => ({
          status: 'error',
          data: previous.data,
          error: cause instanceof ApiError ? cause.message : 'Something went wrong.',
        }));
      } finally {
        if (!cancelled) setSettledFor(key);
      }
    };

    void run();
    return () => { cancelled = true; };
    // `load` is intentionally excluded: callers pass an inline closure, and the
    // dependency list they supply is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { ...state, isStale: settledFor !== key };
}
