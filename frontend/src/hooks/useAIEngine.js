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

  // Export states
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStatus, setExportStatus] = useState("idle"); // idle, rendering, completed, error
  const [exportMessage, setExportMessage] = useState("");
  const [exportFilePath, setExportFilePath] = useState("");

  const wsRef = useRef(null);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let reconnectDelay = 1000; // Start at 1s, double on each failure
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      
      ws = new WebSocket(WS_URL);
      
      ws.onopen = () => {
        console.log('Connected to AI Engine Backend');
        setIsConnected(true);
        reconnectDelay = 1000; // reset on success
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
        } else if (data.status === "mask_update" || data.status === "received" || data.status === "tracking") {
          if (data.mask_base64 !== undefined) {
            setMaskImage(data.mask_base64);
          }
        }
      };

      ws.onclose = () => {
        console.log('Disconnected from AI Engine');
        setIsConnected(false);
        setIsTracking(false);
        wsRef.current = null;

        // Auto-reconnect
        if (isMounted) {
          console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
          reconnectTimer = setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 10000);
            connect();
          }, reconnectDelay);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this, which handles reconnect
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, []);

  const sendClick = useCallback((coords, mode, frameIdx) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'click',
        type: mode,
        coords: coords,
        frame_idx: frameIdx
      }));
    }
  }, []);

  const startTracking = useCallback((customFrames) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      setIsTracking(true);
      wsRef.current.send(JSON.stringify({
        action: 'track_forward',
        video_id: videoId || 'unknown',
        total_frames: customFrames || progressData.totalFrames
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
        total_frames: settings.total_frames
      }));
    }
  }, [videoId]);

  const requestMask = useCallback((frameIdx) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        action: 'get_mask',
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
        // Tell backend WebSocket handler which video this session is for
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            action: 'set_video_id',
            video_id: data.video_id
          }));
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
    requestMask
  };
};
