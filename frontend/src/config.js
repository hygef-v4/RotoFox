import { invoke } from '@tauri-apps/api/core';

/**
 * Backend connection configuration.
 *
 * The desktop shell injects `window.__ROTOFOX__ = { host, port, token }` via
 * Tauri's initialization script and also exposes `get_backend_info` over IPC.
 * In a browser dev session neither exists, so we fall back to `127.0.0.1:8000`
 * and empty token (accepted when the backend runs with `--no-auth`).
 */

function readInjectedConfig() {
  const injected = typeof window !== 'undefined' ? window.__ROTOFOX__ : undefined;
  return {
    host: injected?.host || '127.0.0.1',
    port: injected?.port || 8000,
    token: injected?.token || '',
  };
}

/**
 * Ensure `window.__ROTOFOX__` is populated when running inside the Tauri shell.
 */
export async function initBackendConfig() {
  if (typeof window === 'undefined') return readInjectedConfig();
  if (window.__ROTOFOX__?.token) return readInjectedConfig();

  if (window.__TAURI_INTERNALS__) {
    try {
      const info = await invoke('get_backend_info');
      if (info && info.port) {
        window.__ROTOFOX__ = info;
      }
    } catch {
      // Ignore when running outside Tauri or before IPC is ready.
    }
  }
  return readInjectedConfig();
}

const initial = readInjectedConfig();
export const BACKEND_HOST = initial.host;
export const BACKEND_PORT = initial.port;
export const SESSION_TOKEN = initial.token;
export const HTTP_BASE = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

/** Return the live WebSocket URL including the current session token. */
export function getWsUrl() {
  const { host, port, token } = readInjectedConfig();
  return token
    ? `ws://${host}:${port}/ws/editor?token=${encodeURIComponent(token)}`
    : `ws://${host}:${port}/ws/editor`;
}

export const WS_URL = getWsUrl();

/** Headers carrying the session token for REST calls. */
export function authHeaders(extra = {}) {
  const { token } = readInjectedConfig();
  return token ? { ...extra, 'X-RotoFox-Token': token } : { ...extra };
}

/** Build an absolute backend URL for a path. */
export function apiUrl(path) {
  const { host, port } = readInjectedConfig();
  const base = `http://${host}:${port}`;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** File extensions supported by the backend video loader (`video_io.py`). */
export const SUPPORTED_VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.webm',
  '.ogv',
  '.ogg',
  '.avi',
  '.mkv',
  '.m4v',
];

export const ACCEPTED_VIDEO_ATTR = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  ...SUPPORTED_VIDEO_EXTENSIONS,
].join(',');

/**
 * Check whether a selected/dropped File is a supported video.
 * On Windows, `.mkv` and `.avi` files often have an empty `file.type`, so we
 * check both the MIME prefix and the file extension.
 */
export function isAcceptedVideoFile(file) {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.startsWith('video/')) {
    return true;
  }
  const name = (file.name || '').toLowerCase();
  return SUPPORTED_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
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
