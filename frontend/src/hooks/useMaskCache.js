import { useCallback, useRef } from 'react';
import { MASK_CACHE_LIMIT } from '../config';

/**
 * Bounded LRU cache mapping frame index to a decoded mask bitmap.
 *
 * The previous implementation kept two unbounded-ish caches of base64 strings:
 * one in `useAIEngine` that was never evicted, and one in `VideoCanvas` keyed by
 * the base64 string itself. For a 3,000 frame clip that is roughly 165-330 MB of
 * JavaScript strings plus a second copy of 200 of them, which made long sessions
 * progressively slower and eventually crashed the WebView.
 *
 * Here each mask is decoded once into an `ImageBitmap` (GPU-side, and drawable
 * without a decode step), the base64 payload is dropped immediately, and only
 * the most recently used frames are retained.
 */
export function useMaskCache(limit = MASK_CACHE_LIMIT) {
  // Map preserves insertion order, which gives us LRU for free: re-inserting a
  // key moves it to the end, so the oldest entry is always the first key.
  const cacheRef = useRef(new Map());
  const trackedRef = useRef(new Set());

  const dispose = useCallback((bitmap) => {
    // ImageBitmap holds GPU memory until closed; letting GC handle it is
    // unreliable and slow.
    if (bitmap && typeof bitmap.close === 'function') {
      try { bitmap.close(); } catch { /* already closed */ }
    }
  }, []);

  const get = useCallback((frameIdx) => {
    const cache = cacheRef.current;
    const entry = cache.get(frameIdx);
    if (entry === undefined) return undefined;
    // Refresh recency.
    cache.delete(frameIdx);
    cache.set(frameIdx, entry);
    return entry;
  }, []);

  const has = useCallback((frameIdx) => cacheRef.current.has(frameIdx), []);

  const set = useCallback((frameIdx, bitmap) => {
    const cache = cacheRef.current;
    const previous = cache.get(frameIdx);
    if (previous && previous !== bitmap) dispose(previous);

    cache.delete(frameIdx);
    cache.set(frameIdx, bitmap);

    while (cache.size > limit) {
      const oldestKey = cache.keys().next().value;
      dispose(cache.get(oldestKey));
      cache.delete(oldestKey);
    }
  }, [dispose, limit]);

  /**
   * Decode a base64 PNG into an ImageBitmap and store it.
   * Returns the bitmap, or null when the payload is empty or undecodable.
   */
  const store = useCallback(async (frameIdx, base64) => {
    if (!base64) {
      const previous = cacheRef.current.get(frameIdx);
      if (previous) dispose(previous);
      cacheRef.current.delete(frameIdx);
      return null;
    }

    try {
      const response = await fetch(`data:image/png;base64,${base64}`);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      set(frameIdx, bitmap);
      trackedRef.current.add(frameIdx);
      return bitmap;
    } catch (err) {
      console.warn('Could not decode mask for frame', frameIdx, err);
      return null;
    }
  }, [dispose, set]);

  const markTracked = useCallback((frameIdx) => {
    trackedRef.current.add(frameIdx);
  }, []);

  /** Frame indices that have a mask on the backend, whether cached or not. */
  const getTrackedFrames = useCallback(() => Array.from(trackedRef.current), []);

  const clear = useCallback(() => {
    cacheRef.current.forEach(dispose);
    cacheRef.current.clear();
    trackedRef.current.clear();
  }, [dispose]);

  return { get, has, set, store, clear, markTracked, getTrackedFrames };
}
