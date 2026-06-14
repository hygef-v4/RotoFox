import { useState, useEffect, useCallback, useRef } from 'react';

const WS_URL = 'ws://127.0.0.1:8000/ws/editor';

export function useAIEngine() {
  const [isConnected, setIsConnected] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [maskImage, setMaskImage] = useState(null);
  
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
    // Khởi tạo kết nối WebSockets
    const ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      console.log('Connected to AI Engine Backend');
      setIsConnected(true);
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
      } else if (data.mask_base64) {
        setMaskImage(data.mask_base64);
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from AI Engine');
      setIsConnected(false);
      setIsTracking(false);
    };

    wsRef.current = ws;

    return () => {
      ws.close();
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
        video_id: 'test_video',
        total_frames: customFrames || progressData.totalFrames
      }));
    }
  }, [progressData.totalFrames]);

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
      setExportMessage("Starting export...");
      setExportFilePath("");
      wsRef.current.send(JSON.stringify({
        action: 'export',
        settings
      }));
    }
  }, []);

  const resetExport = useCallback(() => {
    setExportStatus("idle");
    setExportProgress(0);
    setExportMessage("");
    setExportFilePath("");
  }, []);

  return {
    isConnected,
    isTracking,
    maskImage,
    progressData,
    sendClick,
    startTracking,
    cancelTracking,
    
    // Export values
    exportProgress,
    exportStatus,
    exportMessage,
    exportFilePath,
    startExport,
    resetExport
  };
}
