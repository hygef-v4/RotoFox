import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_URL, apiUrl, authHeaders } from '../config';
import { useMaskCache } from './useMaskCache';

/**
 * WebSocket client for the RotoFox backend.
 *
 * Notable changes from the original implementation:
 *
 * - Masks are decoded once into `ImageBitmap` objects held in a bounded LRU
 *   cache instead of accumulating base64 strings without limit.
 * - `trackedFrames` updates are throttled. Previously every propagated frame
 *   rebuilt the whole array and re-rendered the tree, so the UI degraded
 *   steadily as tracking progressed.
 * - Per-object tracking coverage is recorded, so the timeline can show each
 *   layer separately rather than repeating one identical band per object.
 * - Real upload and extraction progress replaces the previous random animation.
 */

const TRACKED_FRAMES_FLUSH_MS = 250;

export function useAIEngine() {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  const [maskBitmap, setMaskBitmap] = useState(null);
  const [videoId, setVideoId] = useState(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [lastError, setLastError] = useState(null);

  const [progressData, setProgressData] = useState({
    currentFrame: 0,
    totalFrames: 0,
    progress: 0,
  });

  const [uploadProgress, setUploadProgress] = useState({
    phase: 'idle',   // idle | uploading | extracting | initializing
    percent: 0,
    detail: '',
  });

  const [trackedFrames, setTrackedFrames] = useState([]);
  const [objectCoverage, setObjectCoverage] = useState({});   // objId -> frame[]

  const [systemInfo, setSystemInfo] = useState({
    gpu_available: false,
    gpu_name: 'CPU',
    total_vram_gb: null,
    system_ram_gb: null,
    recommended_model: 'tiny',
    active_model: null,
    checkpoints_dir: '',
    is_custom_dir: false,
    models: [],
  });

  const [downloadStatus, setDownloadStatus] = useState({
    model_id: null,
    progress: 0,
    status: 'idle',
    message: '',
  });

  const [exportState, setExportState] = useState({
    status: 'idle',   // idle | rendering | completed | error | cancelled
    progress: 0,
    message: '',
    filePath: '',
    warning: '',
  });

  const wsRef = useRef(null);
  const videoIdRef = useRef(null);
  const masks = useMaskCache();

  // Coverage is mutated per frame during tracking but flushed to state on a
  // timer, keeping React out of the hot path.
  const coverageRef = useRef(new Map());
  const flushTimerRef = useRef(null);

  useEffect(() => { videoIdRef.current = videoId; }, [videoId]);

  const scheduleCoverageFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      setTrackedFrames(masks.getTrackedFrames());
      const snapshot = {};
      coverageRef.current.forEach((frames, objId) => {
        snapshot[objId] = Array.from(frames);
      });
      setObjectCoverage(snapshot);
    }, TRACKED_FRAMES_FLUSH_MS);
  }, [masks]);

  const recordCoverage = useCallback((frameIdx, objIds) => {
    if (!Array.isArray(objIds)) return;
    objIds.forEach((objId) => {
      let frames = coverageRef.current.get(objId);
      if (!frames) {
        frames = new Set();
        coverageRef.current.set(objId, frames);
      }
      frames.add(frameIdx);
    });
  }, []);

  // ── Connection ──────────────────────────────────────────────────────────
  useEffect(() => {
    let reconnectTimer = null;
    let reconnectDelay = 1000;
    let mounted = true;

    async function handleMessage(event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn('Ignoring malformed message from backend');
        return;
      }

      switch (data.status) {
        case 'tracking': {
          setProgressData((prev) => ({
            ...prev,
            currentFrame: data.frame,
            progress: data.progress,
          }));
          recordCoverage(data.frame, data.obj_ids);
          const bitmap = await masks.store(data.frame, data.mask_base64);
          if (bitmap) setMaskBitmap(bitmap);
          scheduleCoverageFlush();
          break;
        }

        case 'completed':
        case 'cancelled':
          setIsTracking(false);
          setTrackedFrames(masks.getTrackedFrames());
          scheduleCoverageFlush();
          break;

        case 'extract_progress':
          setUploadProgress({
            phase: 'extracting',
            percent: data.progress ?? 0,
            detail: `Extracting frame ${data.current} of ${data.total}`,
          });
          break;

        case 'mask_update':
        case 'received': {
          const frameIdx = data.frame;
          if (data.mask_base64) {
            const bitmap = await masks.store(frameIdx, data.mask_base64);
            setMaskBitmap(bitmap);
            if (data.obj_id !== undefined) recordCoverage(frameIdx, [data.obj_id]);
            scheduleCoverageFlush();
          } else {
            await masks.store(frameIdx, null);
            setMaskBitmap(null);
            if (data.cleared) {
              masks.clear();
              coverageRef.current.clear();
              setTrackedFrames([]);
              setObjectCoverage({});
            }
          }
          break;
        }

        case 'video_loaded':
          if (data.frames_count) {
            setProgressData((prev) => ({ ...prev, totalFrames: data.frames_count }));
          }
          break;

        case 'system_info':
          setSystemInfo(data.system_info);
          break;

        case 'download_progress':
          setDownloadStatus({
            model_id: data.model_id,
            progress: data.progress,
            status: 'downloading',
            message: data.total_mb
              ? `Downloading ${data.downloaded_mb} / ${data.total_mb} MB`
              : `Downloading... ${data.progress}%`,
          });
          break;

        case 'download_completed':
          setDownloadStatus({
            model_id: data.model_id,
            progress: 100,
            status: 'completed',
            message: 'Download complete.',
          });
          wsRef.current?.send(JSON.stringify({ action: 'get_system_info' }));
          break;

        case 'download_cancelled':
          setDownloadStatus({
            model_id: data.model_id, progress: 0, status: 'idle', message: 'Download cancelled.',
          });
          wsRef.current?.send(JSON.stringify({ action: 'get_system_info' }));
          break;

        case 'download_error':
          setDownloadStatus({
            model_id: data.model_id,
            progress: 0,
            status: 'error',
            message: data.message || 'Download failed.',
          });
          break;

        case 'model_loaded':
          wsRef.current?.send(JSON.stringify({ action: 'get_system_info' }));
          break;

        case 'export_progress':
          setExportState((prev) => ({
            ...prev,
            status: 'rendering',
            progress: data.progress ?? prev.progress,
            message: data.message || prev.message,
          }));
          break;

        case 'export_warning':
          setExportState((prev) => ({ ...prev, warning: data.message || '' }));
          break;

        case 'export_completed':
          setExportState({
            status: 'completed',
            progress: 100,
            message: 'Project exported successfully.',
            filePath: data.file_path,
            warning: '',
          });
          break;

        case 'export_cancelled':
          setExportState((prev) => ({ ...prev, status: 'cancelled', message: 'Export cancelled.' }));
          break;

        case 'export_error':
          setExportState((prev) => ({
            ...prev,
            status: 'error',
            message: data.message || 'Export failed.',
          }));
          break;

        case 'engine_ready':
          setEngineBusy(false);
          break;

        case 'error':
          console.error('Backend error:', data.message);
          setLastError(data.message || 'Unknown backend error');
          if (data.code === 'session_in_use') {
            setConnectionError(data.message);
          }
          break;

        default:
          break;
      }
    }

    function connect() {
      if (!mounted) return;

      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
        wsRef.current = null;
      }

      const socket = new WebSocket(WS_URL);

      socket.onopen = () => {
        wsRef.current = socket;
        setIsConnected(true);
        setConnectionError(null);
        reconnectDelay = 1000;
        socket.send(JSON.stringify({ action: 'get_system_info' }));
        if (videoIdRef.current) {
          socket.send(JSON.stringify({ action: 'set_video_id', video_id: videoIdRef.current }));
        }
      };

      socket.onmessage = (event) => { handleMessage(event); };

      socket.onclose = (event) => {
        if (wsRef.current === socket) wsRef.current = null;
        setIsConnected(false);
        setIsTracking(false);

        // 1008 (policy violation) and 1013 (try again later) are deliberate
        // refusals — bad token, blocked origin, or another editor already
        // connected. Reconnecting in a loop would only hammer the backend.
        if (event.code === 1008) {
          setConnectionError('The backend refused this connection. Restart RotoFox.');
          return;
        }
        if (event.code === 1013) {
          setConnectionError('Another RotoFox window is already connected to the backend.');
          return;
        }

        if (mounted) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 10000);
            connect();
          }, reconnectDelay);
        }
      };

      socket.onerror = () => { /* onclose always follows; handled there */ };
    }

    connect();

    return () => {
      mounted = false;
      clearTimeout(reconnectTimer);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* ignore */ }
        wsRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
      return true;
    }
    console.warn('Backend is not connected; dropping', payload.action);
    return false;
  }, []);

  // ── Prompting ───────────────────────────────────────────────────────────
  const sendClick = useCallback((points, boxes, frameIdx, objId = 1) => {
    send({
      action: 'click',
      frame_idx: frameIdx,
      obj_id: objId,
      points: points.map((p) => [p.x, p.y]),
      labels: points.map((p) => (p.mode === 'add' ? 1 : 0)),
      box: boxes.length > 0
        ? [boxes[0].x1, boxes[0].y1, boxes[0].x2, boxes[0].y2]
        : null,
    });
  }, [send]);

  const startTracking = useCallback((totalFrames, startFrame, reverse = false) => {
    const ok = send({
      action: 'track_forward',
      video_id: videoIdRef.current,
      total_frames: totalFrames,
      start_frame: startFrame,
      reverse,
    });
    if (ok) setIsTracking(true);
  }, [send]);

  const cancelTracking = useCallback(() => {
    send({ action: 'cancel_tracking' });
  }, [send]);

  const clearBackendState = useCallback((frameIdx) => {
    send({ action: 'clear_clicks', frame_idx: frameIdx });
  }, [send]);

  const removeObject = useCallback((objId, frameIdx) => {
    coverageRef.current.delete(objId);
    send({ action: 'remove_object', obj_id: objId, frame_idx: frameIdx });
  }, [send]);

  // ── Masks ───────────────────────────────────────────────────────────────
  const requestMaskTimerRef = useRef(null);

  const requestMask = useCallback((frameIdx) => {
    const cached = masks.get(frameIdx);
    if (cached !== undefined) {
      setMaskBitmap(cached);
      return;
    }
    // Clear immediately so the previous frame's overlay does not linger over an
    // untracked frame during playback.
    setMaskBitmap(null);

    if (requestMaskTimerRef.current) clearTimeout(requestMaskTimerRef.current);
    requestMaskTimerRef.current = setTimeout(() => {
      send({ action: 'get_mask', frame_idx: frameIdx });
    }, 100);
  }, [masks, send]);

  const clearMaskCache = useCallback(() => {
    masks.clear();
    coverageRef.current.clear();
    setTrackedFrames([]);
    setObjectCoverage({});
    setMaskBitmap(null);
  }, [masks]);

  // ── Export ──────────────────────────────────────────────────────────────
  const startExport = useCallback((settings) => {
    setExportState({
      status: 'rendering', progress: 0, message: 'Preparing export...', filePath: '', warning: '',
    });
    setEngineBusy(true);
    send({
      action: 'export',
      video_id: videoIdRef.current,
      format: settings.format,
      type: settings.type,
      bg_color: settings.bg_color,
      export_path: settings.export_path || '',
      resolution: settings.resolution || 'original',
      fps: settings.fps || 'original',
    });
  }, [send]);

  const cancelExport = useCallback(() => { send({ action: 'cancel_export' }); }, [send]);

  const resetExport = useCallback(() => {
    setExportState({ status: 'idle', progress: 0, message: '', filePath: '', warning: '' });
  }, []);

  // ── Upload ──────────────────────────────────────────────────────────────
  /**
   * Upload a video with real byte-level progress.
   *
   * `fetch` cannot report upload progress, which is why the previous UI faked a
   * progress bar with `Math.random()`. XMLHttpRequest can.
   */
  const uploadVideo = useCallback((file) => new Promise((resolve) => {
    setUploadProgress({ phase: 'uploading', percent: 0, detail: 'Uploading video...' });

    const formData = new FormData();
    formData.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', apiUrl('/upload'));

    const headers = authHeaders();
    Object.entries(headers).forEach(([key, value]) => request.setRequestHeader(key, value));

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      setUploadProgress({
        phase: 'uploading',
        percent: Math.round((event.loaded / event.total) * 100),
        detail: `Uploading ${(event.loaded / 1024 ** 2).toFixed(0)} / ${(event.total / 1024 ** 2).toFixed(0)} MB`,
      });
    };

    request.upload.onload = () => {
      setUploadProgress({ phase: 'extracting', percent: 0, detail: 'Extracting frames...' });
    };

    request.onload = () => {
      let data = null;
      try { data = JSON.parse(request.responseText); } catch { /* handled below */ }

      if (request.status >= 400 || !data || data.status !== 'success') {
        const message = data?.message || data?.detail || `Upload failed (HTTP ${request.status})`;
        setUploadProgress({ phase: 'idle', percent: 0, detail: '' });
        setLastError(message);
        resolve(null);
        return;
      }

      setUploadProgress({ phase: 'initializing', percent: 100, detail: 'Initializing SAM 2...' });
      setVideoId(data.video_id);
      videoIdRef.current = data.video_id;
      setProgressData((prev) => ({ ...prev, totalFrames: data.frames_count }));
      send({ action: 'set_video_id', video_id: data.video_id });

      if (data.warning) setLastError(data.warning);
      setTimeout(() => setUploadProgress({ phase: 'idle', percent: 0, detail: '' }), 400);
      resolve(data);
    };

    request.onerror = () => {
      setUploadProgress({ phase: 'idle', percent: 0, detail: '' });
      setLastError('Could not reach the backend. Is it still running?');
      resolve(null);
    };

    request.send(formData);
  }), [send]);

  // ── Model hub ───────────────────────────────────────────────────────────
  const getSystemInfo = useCallback(() => { send({ action: 'get_system_info' }); }, [send]);

  const downloadModel = useCallback((modelId) => {
    setDownloadStatus({
      model_id: modelId, progress: 0, status: 'downloading', message: 'Starting download...',
    });
    send({ action: 'download_model', model_id: modelId });
  }, [send]);

  const cancelDownload = useCallback(() => { send({ action: 'cancel_download' }); }, [send]);

  const loadModel = useCallback((modelId) => {
    send({ action: 'load_model', model_id: modelId });
  }, [send]);

  const resetDownloadStatus = useCallback(() => {
    setDownloadStatus({ model_id: null, progress: 0, status: 'idle', message: '' });
  }, []);

  const setCheckpointsDir = useCallback((dir) => {
    send({ action: 'set_checkpoints_dir', checkpoints_dir: dir });
  }, [send]);

  const openDirectory = useCallback((path = '') => {
    send({ action: 'open_directory', directory: path });
  }, [send]);

  const dismissError = useCallback(() => setLastError(null), []);

  return {
    isConnected,
    connectionError,
    isTracking,
    engineBusy,
    lastError,
    dismissError,
    maskBitmap,
    progressData,
    uploadProgress,
    trackedFrames,
    objectCoverage,
    videoId,

    sendClick,
    startTracking,
    cancelTracking,
    clearBackendState,
    removeObject,
    requestMask,
    clearMaskCache,
    uploadVideo,

    exportState,
    startExport,
    cancelExport,
    resetExport,

    systemInfo,
    downloadStatus,
    getSystemInfo,
    downloadModel,
    cancelDownload,
    loadModel,
    resetDownloadStatus,
    setCheckpointsDir,
    openDirectory,
  };
}
