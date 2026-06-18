import { useState, useEffect, useCallback, useRef } from 'react';

const WS_URL = 'ws://127.0.0.1:8000/ws/editor';

export function useAIEngine() {
  const [isConnected, setIsConnected] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [maskImage, setMaskImage] = useState(null);
  const [videoId, setVideoId] = useState(null);
  
  const videoIdRef = useRef(null);
  useEffect(() => {
    videoIdRef.current = videoId;
  }, [videoId]);
  
  const [progressData, setProgressData] = useState({
    currentFrame: 0,
    totalFrames: 100, // Hardcode để test ban đầu
    progress: 0
  });

  const [trackedFrames, setTrackedFrames] = useState([]);

  // Export states
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState("idle"); // idle, rendering, completed, error
  const [exportMessage, setExportMessage] = useState("");
  const [exportFilePath, setExportFilePath] = useState("");

  const wsRef = useRef(null);
  const maskCacheRef = useRef(new Map());  // frame_idx -> base64 mask

  useEffect(() => {
    let reconnectTimer = null;
    let reconnectDelay = 1000;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      
      // Close any existing connection before creating a new one
      if (wsRef.current) {
        try { wsRef.current.close(); } catch(e) { /* ignore */ }
        wsRef.current = null;
      }
      
      const ws = new WebSocket(WS_URL);
      
      ws.onopen = () => {
        console.log('Connected to AI Engine Backend');
        wsRef.current = ws;  // Only set ref when actually OPEN
        setIsConnected(true);
        reconnectDelay = 1000;
        if (videoIdRef.current) {
          console.log('Restoring video session on reconnect:', videoIdRef.current);
          ws.send(JSON.stringify({
            action: 'set_video_id',
            video_id: videoIdRef.current
          }));
        }
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("WS Received:", data);
        
        if (data.status === "tracking") {
          setProgressData(prev => ({
            ...prev,
            currentFrame: data.frame,
            progress: data.progress
          }));
          if (data.mask_base64) {
            maskCacheRef.current.set(data.frame, data.mask_base64);
            setTrackedFrames(Array.from(maskCacheRef.current.keys()));
            setMaskImage(data.mask_base64);
          }
        } else if (data.status === "completed" || data.status === "cancelled") {
          setIsTracking(false);
        } else if (data.status === "export_progress") {
          setExportStatus("rendering");
          setExportProgress(data.progress);
          setExportMessage(data.message || "");
        } else if (data.status === "export_completed") {
          setExportStatus("completed");
          setExportProgress(100);
          setExportFilePath(data.file_path);
          setExportMessage("Project exported successfully!");
        } else if (data.status === "export_error") {
          setExportStatus("error");
          setExportMessage(data.message || "Failed to export");
        } else if (data.status === "error") {
          console.error("AI Engine Error:", data.message);
        } else if (data.status === "mask_update" || data.status === "received") {
          if (data.mask_base64 !== undefined) {
            const frameIdx = data.frame ?? data.echo?.frame_idx;
            if (frameIdx !== undefined && data.mask_base64) {
              maskCacheRef.current.set(frameIdx, data.mask_base64);
              setTrackedFrames(Array.from(maskCacheRef.current.keys()));
            }
            setMaskImage(data.mask_base64);
          }
        }
      };

      ws.onclose = () => {
        console.log('Disconnected from AI Engine');
        // Only clear ref if this WS is still the current one
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        setIsConnected(false);
        setIsTracking(false);

        // Auto-reconnect
        if (isMounted) {
          console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 10000);
            connect();
          }, reconnectDelay);
        }
      };

      ws.onerror = (err) => {
        console.warn('WebSocket error, will reconnect on close');
        // onclose will fire after this
      };
    }

    connect();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch(e) { /* ignore */ }
        wsRef.current = null;
      }
    };
  }, []);

  const sendClick = useCallback((pointsData, boxesData, frameIdx, objId = 1) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      const payload = {
        action: 'click',
        frame_idx: frameIdx,
        obj_id: objId,
        points: pointsData.map(p => [p.x, p.y]),
        labels: pointsData.map(p => p.mode === 'add' ? 1 : 0),
        box: boxesData.length > 0 ? [boxesData[0].x1, boxesData[0].y1, boxesData[0].x2, boxesData[0].y2] : null
      };
      console.log('Sending click payload:', JSON.stringify(payload));
      wsRef.current.send(JSON.stringify(payload));
    } else {
      console.warn('WebSocket not open, cannot send click');
    }
  }, []);

  const startTracking = useCallback((customFrames, startFrame) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setIsTracking(true);
      wsRef.current.send(JSON.stringify({
        action: 'track_forward',
        video_id: videoId || 'unknown',
        total_frames: customFrames || progressData.totalFrames,
        start_frame: startFrame
      }));
    }
  }, [videoId, progressData.totalFrames]);

  const cancelTracking = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'cancel_tracking'
      }));
      setIsTracking(false);
    }
  }, []);

  const startExport = useCallback((settings) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setExportStatus("rendering");
      setExportProgress(0);
      setExportMessage("Initializing export...");
      wsRef.current.send(JSON.stringify({
        action: 'export',
        video_id: videoId || 'unknown',
        format: settings.format,
        type: settings.type,
        bg_color: settings.bg_color,
        total_frames: settings.total_frames,
        export_path: settings.export_path
      }));
    }
  }, [videoId]);

  const requestMask = useCallback((frameIdx) => {
    // Check local cache first (instant, no network)
    const cached = maskCacheRef.current.get(frameIdx);
    if (cached) {
      setMaskImage(cached);
      return;
    }
    // Cache miss - fetch from backend
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'get_mask',
        frame_idx: frameIdx
      }));
    }
  }, []);

  const clearMaskCache = useCallback(() => {
    maskCacheRef.current.clear();
    setTrackedFrames([]);
    setMaskImage(null);
  }, []);

  const clearBackendState = useCallback((frameIdx) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'clear_clicks',
        frame_idx: frameIdx
      }));
    }
  }, []);

  const removeObject = useCallback((objId, frameIdx) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'remove_object',
        obj_id: objId,
        frame_idx: frameIdx
      }));
    }
  }, []);

  const resetExport = useCallback(() => {
    setExportStatus("idle");
    setExportProgress(0);
    setExportMessage("");
    setExportFilePath("");
  }, []);

  // Upload video file to backend, extract frames, and load into SAM 2
  const uploadVideo = useCallback(async (file) => {
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('http://127.0.0.1:8000/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (data.status === 'success') {
        console.log(`Backend ready: ${data.frames_count} frames extracted. Video ID: ${data.video_id}`);
        setVideoId(data.video_id);
        videoIdRef.current = data.video_id;  // Update ref immediately for reconnect
        
        // Send set_video_id to WebSocket, retry if not open yet
        const sendVideoId = () => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              action: 'set_video_id',
              video_id: data.video_id
            }));
            console.log('Sent set_video_id to WebSocket');
            return true;
          }
          return false;
        };
        
        if (!sendVideoId()) {
          // WS not open yet, retry a few times
          let retries = 0;
          const retryInterval = setInterval(() => {
            retries++;
            if (sendVideoId() || retries >= 10) {
              clearInterval(retryInterval);
              if (retries >= 10) console.warn('Could not send set_video_id after 10 retries');
            }
          }, 500);
        }
        
        return data;
      } else {
        console.error("Backend upload failed:", data.message);
        return null;
      }
    } catch (err) {
      console.error("Failed to reach backend for upload:", err);
      return null;
    }
  }, []);

  return {
    isConnected,
    isTracking,
    maskImage,
    progressData,
    sendClick,
    startTracking,
    cancelTracking,
    uploadVideo,
    exportProgress,
    exportStatus,
    exportMessage,
    exportFilePath,
    startExport,
    resetExport,
    requestMask,
    clearMaskCache,
    clearBackendState,
    removeObject,
    trackedFrames
  };
};
