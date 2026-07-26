import { useEffect, useRef } from 'react';

/**
 * Global editor keyboard shortcuts.
 *
 * PageUp, PageDown, Home and End are documented in the README as application
 * shortcuts, but they were only bound to the timeline `<div>`'s own `onKeyDown`.
 * That meant they did nothing unless the user had first tabbed or clicked onto
 * the timeline bar — so for most users they simply appeared broken.
 *
 * Handlers are read through a ref so the listener can be registered once
 * without going stale, replacing the eight mirror refs the previous
 * implementation maintained by hand in `App.jsx`.
 */
export function useKeyboardShortcuts(handlers, { enabled = true } = {}) {
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; }, [handlers]);

  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!enabledRef.current) return;

      // Never hijack typing.
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable) {
        return;
      }

      const api = handlersRef.current;
      const ctrl = event.ctrlKey || event.metaKey;

      if (ctrl && event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        api.onRedo?.();
        return;
      }
      if (ctrl && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        api.onUndo?.();
        return;
      }
      if (ctrl && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        api.onRedo?.();
        return;
      }
      if (ctrl) return;

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          api.onStepFrame?.(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          api.onStepFrame?.(1);
          break;
        case 'PageDown':
          event.preventDefault();
          api.onStepFrame?.(-10);
          break;
        case 'PageUp':
          event.preventDefault();
          api.onStepFrame?.(10);
          break;
        case 'Home':
          event.preventDefault();
          api.onSeekToStart?.();
          break;
        case 'End':
          event.preventDefault();
          api.onSeekToEnd?.();
          break;
        case ' ':
          event.preventDefault();
          api.onTogglePlay?.();
          break;
        case 'Escape':
          api.onEscape?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
