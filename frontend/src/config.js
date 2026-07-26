/**
 * Backend connection configuration.
 *
 * The host, port and session token were previously hard-coded in four separate
 * places (`useAIEngine.js` and three `fetch` calls in `App.jsx`). Centralising
 * them means the port can move when 8000 is taken, and the session token — which
 * the backend now requires — is attached in exactly one place.
 *
 * The desktop shell injects `window.__ROTOFOX__ = { port, token }` before the
 * app boots. In a browser dev session neither exists, so we fall back to the
 * defaults and the backend accepts us because it was started with `--no-auth`.
 */

const injected = typeof window !== 'undefined' ? window.__ROTOFOX__ : undefined;

export const BACKEND_HOST = injected?.host ?? '127.0.0.1';
export const BACKEND_PORT = injected?.port ?? 8000;
export const SESSION_TOKEN = injected?.token ?? '';

export const HTTP_BASE = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

export const WS_URL = SESSION_TOKEN
  ? `ws://${BACKEND_HOST}:${BACKEND_PORT}/ws/editor?token=${encodeURIComponent(SESSION_TOKEN)}`
  : `ws://${BACKEND_HOST}:${BACKEND_PORT}/ws/editor`;

/** Headers carrying the session token for REST calls. */
export function authHeaders(extra = {}) {
  return SESSION_TOKEN ? { ...extra, 'X-RotoFox-Token': SESSION_TOKEN } : { ...extra };
}

/** Build an absolute backend URL for a path. */
export function apiUrl(path) {
  return `${HTTP_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Maximum mask frames kept in the client cache. */
export const MASK_CACHE_LIMIT = 180;

/** Maximum concurrently tracked mask layers. */
export const MAX_OBJECTS = 7;

/** Colours assigned to mask layers, matching the backend PALETTE. */
export const OBJECT_COLORS = [
  '#FF3B30', // Red
  '#007AFF', // Blue
  '#34C759', // Green
  '#FF9500', // Orange
  '#AF52DE', // Purple
  '#5AC8FA', // Cyan
  '#FFCC00', // Yellow
];
