import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Upload, RotateCcw } from 'lucide-react';

const DOT_RADIUS = 6; // px on the 1280×720 canvas

const VideoCanvas = ({
  videoUrl,
  clickMode,
  onCanvasClick,
  maskImageBase64,
  isPlaying,
  currentFrame,
  videoOffsetFrame = 0,
  totalFrames,
  onVideoMetadataLoaded,
  onFrameChange,
  onPlayToggle,
  clearSignal,           // increments from parent to trigger clearing all dots
  undoSignal,            // increments from parent to undo last point/box
  redoSignal,            // increments from parent to redo last point/box
  isUploading = false,
  viewMode = 'overlay',  // overlay, isolated
  onRequestMask,         // called during playback to sync mask with frame
  objects = [],          // Add objects prop
  activeObjectId,        // Add activeObjectId prop
  deleteObjectSignal,    // Signal to delete a specific object's points
  onVideoImport,         // Receive onVideoImport prop
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const maskImageObjRef = useRef(null);

  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const redoHistoryRef = useRef([]);

  const [showUndoToast, setShowUndoToast] = useState(false);
  const toastTimeoutRef = useRef(null);
  const [uploadProgress, setUploadProgress] = useState(0);

  // Simulated progress logic when isUploading transitions to true
  useEffect(() => {
    if (isUploading) {
      setUploadProgress(10);
      const interval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev < 40) {
            return prev + Math.floor(Math.random() * 5) + 2; // quick jump in upload
          } else if (prev < 80) {
            return prev + Math.floor(Math.random() * 3) + 1; // frame extraction
          } else if (prev < 98) {
            return prev + 1; // model initialization (slowest)
          }
          return prev;
        });
      }, 150);
      return () => clearInterval(interval);
    } else {
      setUploadProgress(0);
    }
  }, [isUploading]);

  // Stores all committed click points: [{x, y, mode}] in normalized coords
  const clickPointsRef = useRef([]);
  // Stores committed selection boxes: [{x1,y1,x2,y2}]
  const boxesRef = useRef([]);

  // Track previous frame to detect actual frame changes
  const prevFrameRef = useRef(currentFrame);

  // Always-current refs so stable callbacks never go stale
  const clickModeRef = useRef(clickMode);
  useEffect(() => { clickModeRef.current = clickMode; }, [clickMode]);

  const onCanvasClickRef = useRef(onCanvasClick);
  useEffect(() => { onCanvasClickRef.current = onCanvasClick; }, [onCanvasClick]);

  // FIX Bug 3: isPlaying & onPlayToggle refs to avoid stale closure in handleMouseDown
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  const onPlayToggleRef = useRef(onPlayToggle);
  useEffect(() => { onPlayToggleRef.current = onPlayToggle; }, [onPlayToggle]);

  // Drag state
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef(null);
  const dragEndRef = useRef(null);

  // Marching ants animation offset
  const dashOffsetRef = useRef(0);

  // ── Stable draw function ──────────────────────────────────────────────────
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 0. Always draw the video frame on the canvas first (ensures sync with mask)
    if (videoRef.current && videoRef.current.readyState >= 2) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    }

    // 1. Mask overlay from AI backend
    if (viewMode === 'isolated') {
      if (maskImageObjRef.current) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(maskImageObjRef.current, 0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      // Overlay mode - draw mask on top of video
      if (maskImageObjRef.current) {
        ctx.drawImage(maskImageObjRef.current, 0, 0, canvas.width, canvas.height);
      }
    }

    // 2. Committed selection boxes – active box uses marching ants (Rotobrush-style)
    boxesRef.current.forEach(({ x1, y1, x2, y2, objId }) => {
      const px1 = x1 * canvas.width;
      const py1 = y1 * canvas.height;
      const pw  = (x2 - x1) * canvas.width;
      const ph  = (y2 - y1) * canvas.height;
      const isActive = objId === activeObjectId;

      ctx.globalAlpha = isActive ? 1.0 : 0.4;
      ctx.lineWidth = isActive ? 2.5 : 1.5;

      if (isActive) {
        // Marching ants animated dashes
        ctx.setLineDash([8, 4]);
        ctx.lineDashOffset = -dashOffsetRef.current;
      } else {
        ctx.setLineDash([4, 3]);
        ctx.lineDashOffset = 0;
      }

      ctx.strokeStyle = '#f97316';
      ctx.strokeRect(px1, py1, pw, ph);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.fillStyle = isActive ? 'rgba(249,115,22,0.14)' : 'rgba(249,115,22,0.06)';
      ctx.fillRect(px1, py1, pw, ph);
      ctx.globalAlpha = 1.0;
    });

    // 3. Live drag box (box mode only)
    if (clickModeRef.current === 'box' && isDraggingRef.current && dragStartRef.current && dragEndRef.current) {
      const x1 = dragStartRef.current.x * canvas.width;
      const y1 = dragStartRef.current.y * canvas.height;
      const x2 = dragEndRef.current.x * canvas.width;
      const y2 = dragEndRef.current.y * canvas.height;
      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(249,115,22,0.1)';
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    }

    // 4. Click point dots (match object color, or red for remove)
    clickPointsRef.current.forEach(({ x, y, mode, objId }) => {
      const px = x * canvas.width;
      const py = y * canvas.height;

      const isAdd = mode === 'add';
      
      // Find object color
      const obj = objects.find(o => o.id === objId);
      const baseColor = obj ? obj.color : '#22c55e'; // Fallback to green
      
      // If mode is 'remove', we can use red, or just the object's color but maybe smaller/different shape.
      // But the SAM 2 UI usually just uses Red for negative points.
      const fill   = isAdd ? baseColor : '#ef4444';
      const stroke = isAdd ? baseColor : '#dc2626';

      // Draw faint ring if not the active object
      ctx.globalAlpha = (objId === activeObjectId) ? 1.0 : 0.4;

      // Outer glow
      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS + 3, 0, Math.PI * 2);
      ctx.fillStyle = isAdd ? `${baseColor}40` : 'rgba(239,68,68,0.25)'; // 40 is hex for 25% opacity
      ctx.fill();

      // Solid dot
      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.stroke();

      // White center
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      
      ctx.globalAlpha = 1.0;
    });
  }, [viewMode, activeObjectId, objects]); // Re-draw when view mode, active object, or objects array changes

  // ── FIX Bug 1: Set canvas dimensions directly from video metadata ──────────
  // Prevents React from clearing the canvas when width/height props change
  useLayoutEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !videoUrl) return;

    const applyDimensions = () => {
      if (video.videoWidth > 0) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
        drawCanvas();
      }
    };

    video.addEventListener('loadedmetadata', applyDimensions);
    // In case metadata is already loaded (e.g. same video re-mounted)
    if (video.readyState >= 1) applyDimensions();

    return () => video.removeEventListener('loadedmetadata', applyDimensions);
  }, [videoUrl, drawCanvas]);

  // ── FIX Bug 2: Redraw canvas when upload finishes (overlay disappears) ──────
  useEffect(() => {
    if (!isUploading) {
      // Use rAF so React has flushed DOM updates before we draw
      const id = requestAnimationFrame(() => drawCanvas());
      return () => cancelAnimationFrame(id);
    }
  }, [isUploading, drawCanvas]);

  // ── Clear all points when clearSignal fires ────────────────────────────────
  useEffect(() => {
    clickPointsRef.current = [];
    boxesRef.current = [];
    redoHistoryRef.current = [];
    drawCanvas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal]);

  // ── Undo last point/box when undoSignal fires ────────────────────────────
  useEffect(() => {
    if (!undoSignal) return; // skip initial mount (undoSignal = 0)

    // Trigger undo toast
    setShowUndoToast(true);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => {
      setShowUndoToast(false);
    }, 2000);

    // Priority: undo last box of activeObject, then last click point
    const lastBoxIdx = [...boxesRef.current].map((b, i) => ({ b, i })).reverse().find(({ b }) => b.objId === activeObjectId);
    if (lastBoxIdx !== undefined) {
      const undoneBox = boxesRef.current[lastBoxIdx.i];
      redoHistoryRef.current = [...redoHistoryRef.current, { type: 'box', data: undoneBox }];
      boxesRef.current = boxesRef.current.filter((_, i) => i !== lastBoxIdx.i);
    } else {
      // Undo last click point of active object
      const pts = clickPointsRef.current;
      let undonePt = null;
      for (let i = pts.length - 1; i >= 0; i--) {
        if (pts[i].objId === activeObjectId) {
          undonePt = pts[i];
          clickPointsRef.current = [...pts.slice(0, i), ...pts.slice(i + 1)];
          break;
        }
      }
      if (undonePt) {
        redoHistoryRef.current = [...redoHistoryRef.current, { type: 'point', data: undonePt }];
      }
    }

    drawCanvas();
    // Re-send remaining points to backend so mask is recomputed
    const filteredPoints = clickPointsRef.current.filter(p => p.objId === activeObjectId);
    const filteredBoxes  = boxesRef.current.filter(b => b.objId === activeObjectId);
    onCanvasClickRef.current?.(filteredPoints, filteredBoxes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoSignal]);

  // ── Redo last undone point/box when redoSignal fires ──────────────────────
  useEffect(() => {
    if (!redoSignal) return; // skip initial mount (redoSignal = 0)

    if (redoHistoryRef.current.length === 0) return;

    // Pop the last item from redo history
    const lastHistoryItem = redoHistoryRef.current[redoHistoryRef.current.length - 1];
    redoHistoryRef.current = redoHistoryRef.current.slice(0, -1);

    if (lastHistoryItem.type === 'box') {
      boxesRef.current = [...boxesRef.current, lastHistoryItem.data];
    } else if (lastHistoryItem.type === 'point') {
      clickPointsRef.current = [...clickPointsRef.current, lastHistoryItem.data];
    }

    drawCanvas();
    // Re-send remaining points to backend so mask is recomputed
    const filteredPoints = clickPointsRef.current.filter(p => p.objId === activeObjectId);
    const filteredBoxes  = boxesRef.current.filter(b => b.objId === activeObjectId);
    onCanvasClickRef.current?.(filteredPoints, filteredBoxes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redoSignal]);

  // ── Marching ants animation loop (runs always, drives dashOffsetRef) ────────
  useEffect(() => {
    let animId;
    const tick = () => {
      dashOffsetRef.current = (dashOffsetRef.current + 0.5) % 24;
      // Only force-redraw when not playing (playback rAF already calls drawCanvas)
      if (boxesRef.current.length > 0 && !isPlayingRef.current) {
        drawCanvas();
      }
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [drawCanvas]);

  // ── Remove points for a specific object when deleteObjectSignal fires ──────
  useEffect(() => {
    if (deleteObjectSignal && deleteObjectSignal.id !== undefined) {
      clickPointsRef.current = clickPointsRef.current.filter(p => p.objId !== deleteObjectSignal.id);
      boxesRef.current = boxesRef.current.filter(b => b.objId !== deleteObjectSignal.id);
      drawCanvas();
    }
  }, [deleteObjectSignal, drawCanvas]);

  // ── Clear points when user navigates to a different frame ─────────────────
  useEffect(() => {
    if (prevFrameRef.current !== currentFrame) {
      clickPointsRef.current = [];
      boxesRef.current = [];
      prevFrameRef.current = currentFrame;
      drawCanvas();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame]);

  // ── Sync video play / pause ───────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.play().catch(err => console.warn('Playback blocked:', err));
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // ── Seek to frame while paused ────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying) return;
    
    // Calculate effective FPS based on true totalFrames vs video duration
    const effectiveFps = (totalFrames && video.duration) ? (totalFrames / video.duration) : 30;
    
    const targetTime = (currentFrame + videoOffsetFrame) / effectiveFps;
    // FIX Bug 4: Always set currentTime (no threshold) so onSeeked always fires
    video.currentTime = targetTime;
  }, [currentFrame, videoOffsetFrame, isPlaying, totalFrames]);

  // ── rAF loop while playing ────────────────────────────────────────────────
  const onRequestMaskRef = useRef(onRequestMask);
  useEffect(() => { onRequestMaskRef.current = onRequestMask; }, [onRequestMask]);

  useEffect(() => {
    if (!isPlaying) return;
    let animId;
    let lastFrame = -1;
    const loop = () => {
      const video = videoRef.current;
      if (!video) return;
      
      const effectiveFps = (totalFrames && video.duration) ? (totalFrames / video.duration) : 30;
      const frame = Math.floor(video.currentTime * effectiveFps) - videoOffsetFrame;
      
      if (frame >= totalFrames) {
        onPlayToggle(false);
        onFrameChange(0);
      } else if (frame >= 0) {
        if (frame !== lastFrame) {
          lastFrame = frame;
          onFrameChange(frame);
          // Sync mask from cache during playback
          onRequestMaskRef.current?.(frame + videoOffsetFrame);
        }
      }
      // Always redraw canvas to sync video frame with mask
      drawCanvas();
      animId = requestAnimationFrame(loop);
    };
    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, totalFrames, videoOffsetFrame, onFrameChange, onPlayToggle]);

  // ── Mask image ────────────────────────────────────────────────────────────
  const imageCacheRef = useRef(new Map()); // base64 -> Image obj

  useEffect(() => {
    if (!maskImageBase64) {
      maskImageObjRef.current = null;
      drawCanvas();
      return;
    }

    // Check if we already created an Image for this base64
    if (imageCacheRef.current.has(maskImageBase64)) {
      maskImageObjRef.current = imageCacheRef.current.get(maskImageBase64);
      drawCanvas();
      return;
    }

    const img = new Image();
    img.onload = () => {
      // Cache it for instant retrieval next time
      imageCacheRef.current.set(maskImageBase64, img);
      maskImageObjRef.current = img;
      drawCanvas();
    };
    img.src = `data:image/png;base64,${maskImageBase64}`;
  }, [maskImageBase64, drawCanvas]);

  // Re-draw canvas on seek to sync video frame
  // (no longer need isolated-only rAF since we always draw video on canvas)

  // Clear live drag on mode switch
  useEffect(() => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [clickMode, drawCanvas]);

  // ── Drag & drop handlers ──────────────────────────────────────────────────
  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      const validTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'];
      if (validTypes.includes(file.type) || file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file);
        onVideoImport?.(url, file);
      }
    }
  }, [onVideoImport]);

  const handleBrowseClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const url = URL.createObjectURL(file);
      onVideoImport?.(url, file);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getCoords = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  // ── Mouse handlers ────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    if (!videoUrl) return; // Block clicks if no video is imported
    // FIX Bug 3: Use isPlayingRef to avoid stale closure (isPlaying not in deps)
    if (isPlayingRef.current) {
      onPlayToggleRef.current?.(false);
      return;
    }
    const { x, y } = getCoords(e);
    const mode = clickModeRef.current;

    if (mode === 'add' || mode === 'remove') {
      // Immediately place a visual dot
      clickPointsRef.current = [...clickPointsRef.current, { x, y, mode, objId: activeObjectId }];
      redoHistoryRef.current = []; // Clear redo history on new action
      drawCanvas();
      // Notify parent (sends to WebSocket)
      const filteredPoints = clickPointsRef.current.filter(p => p.objId === activeObjectId);
      const filteredBoxes = boxesRef.current.filter(b => b.objId === activeObjectId);
      onCanvasClickRef.current?.(filteredPoints, filteredBoxes);
    } else {
      // box mode: start drag
      isDraggingRef.current = true;
      dragStartRef.current = { x, y, objId: activeObjectId };
      dragEndRef.current = { x, y };
      drawCanvas();
    }
  }, [drawCanvas, activeObjectId, videoUrl]);

  const handleMouseMove = useCallback((e) => {
    if (!isDraggingRef.current) return;
    const { x, y } = getCoords(e);
    dragEndRef.current = { x, y };
    drawCanvas();
  }, [drawCanvas]);

  const handleMouseUp = useCallback((e) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    const { x, y } = getCoords(e);
    const start = dragStartRef.current ?? { x, y };
    const dist = Math.hypot(x - start.x, y - start.y);

      if (dist > 0.01) {
      const box = {
        x1: Math.min(start.x, x),
        y1: Math.min(start.y, y),
        x2: Math.max(start.x, x),
        y2: Math.max(start.y, y),
        objId: activeObjectId
      };
      // Save box visually
      boxesRef.current = [...boxesRef.current, box];
      redoHistoryRef.current = []; // Clear redo history on new action
      // Notify parent
      const filteredPoints = clickPointsRef.current.filter(p => p.objId === activeObjectId);
      const filteredBoxes = boxesRef.current.filter(b => b.objId === activeObjectId);
      onCanvasClickRef.current?.(filteredPoints, filteredBoxes);
    }

    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [drawCanvas, activeObjectId]);

  const handleMouseLeave = useCallback(() => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      dragStartRef.current = null;
      dragEndRef.current = null;
      drawCanvas();
    }
  }, [drawCanvas]);

  const handleLoadedMetadata = useCallback((e) => {
    const video = e.target;
    onVideoMetadataLoaded?.({
      duration: video.duration,
      totalFrames: Math.floor(video.duration * 30),
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }, [onVideoMetadataLoaded]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full bg-[#040406] overflow-hidden transition-all duration-300 ${
        isDragActive ? 'bg-blue-600/[0.03]' : ''
      }`}
      onDragEnter={!videoUrl ? handleDrag : undefined}
      onDragOver={!videoUrl ? handleDrag : undefined}
      onDragLeave={!videoUrl ? handleDrag : undefined}
      onDrop={!videoUrl ? handleDrop : undefined}
    >
      {videoUrl ? (
        <video
          ref={videoRef}
          src={videoUrl}
          className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none opacity-0"
          controls={false}
          muted
          loop={false}
          onLoadedMetadata={handleLoadedMetadata}
          onLoadedData={drawCanvas}
          onSeeked={() => {
            // Need to re-draw canvas when video frame seeks, especially for isolated mode
            drawCanvas();
          }}
        />
      ) : (
        <div className={`absolute inset-0 flex flex-col items-center justify-center p-8 transition-all duration-300 ${
          isDragActive ? 'scale-102 bg-blue-500/[0.02]' : ''
        }`}>
          <div 
            onClick={handleBrowseClick}
            tabIndex={0}
            role="button"
            aria-label="Drag and drop zone to upload video files. Click or press Enter to choose a file."
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleBrowseClick();
              }
            }}
            className={`max-w-md w-full border-2 border-dashed rounded-2xl p-10 flex flex-col items-center text-center transition-all duration-300 cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
              isDragActive 
                ? 'border-blue-500 bg-blue-500/[0.04] shadow-[0_0_40px_rgba(59,130,246,0.14)] scale-102' 
                : 'border-white/[0.08] bg-white/[0.01] hover:border-white/[0.15] hover:bg-white/[0.02] hover:shadow-[0_0_20px_rgba(255,255,255,0.02)]'
            }`}
          >
            <div className="w-14 h-14 rounded-2xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center text-orange-500 mb-6 shadow-md">
              <Upload size={24} />
            </div>
            
            <h3 className="text-base font-bold text-textPrimary mb-1.5">Import Video File</h3>
            <p className="text-xs text-textSecondary/70 mb-6 max-w-[280px] leading-relaxed">
              Drag &amp; drop video here, or select a file from your computer
            </p>
            
            <input 
              type="file" 
              accept="video/mp4,video/webm,video/ogg,video/quicktime" 
              ref={fileInputRef} 
              onChange={handleFileChange} 
              className="hidden" 
            />
            
            <button
              onClick={(e) => { e.stopPropagation(); handleBrowseClick(); }}
              tabIndex={0}
              aria-label="Select video file"
              className="px-5 py-2.5 bg-gradient-to-r from-orange-500/90 to-red-500/90 hover:from-orange-500 hover:to-red-500 text-white text-xs font-bold rounded-lg border border-orange-400/20 shadow-lg shadow-orange-950/20 hover:shadow-orange-500/20 active:scale-[0.98] transition-all duration-200 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none"
            >
              Select Video
            </button>
            
            <span className="text-[10px] text-textSecondary/30 mt-6 font-mono uppercase tracking-widest">
              MP4, WebM, MOV, Ogg supported
            </span>
          </div>
        </div>
      )}

      {/* Canvas: mask + dots + drag box */}
      {/* FIX Bug 1: Static fallback width/height; actual dims set by useLayoutEffect via video metadata */}
      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        tabIndex={videoUrl ? 0 : -1}
        aria-label="Video segmentation workspace canvas. Use click to place points or drag to draw boxes."
        className={`absolute inset-0 w-full h-full object-contain z-10 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${!videoUrl ? 'pointer-events-none' : ''}`}
        style={{
          cursor: !videoUrl ? 'default' : (clickMode === 'box' ? 'crosshair' : 'cell'),
          touchAction: 'none',
        }}
      />


      {/* Undo Toast: temporary notification for Ctrl+Z */}
      {showUndoToast && (
        <div className="absolute top-4 right-4 z-20 flex items-center gap-2 bg-[#17171a]/95 border border-white/[0.1] backdrop-blur-md px-3.5 py-2 rounded-xl shadow-lg shadow-black/50 text-xs font-semibold text-textPrimary animate-in fade-in slide-in-from-top-2 duration-300">
          <RotateCcw size={14} className="text-orange-500" />
          <span>Action Undone</span>
        </div>
      )}

      {/* HUD: show current mode and point count */}
      {videoUrl && !isUploading && (
        <div className="absolute bottom-2 right-2 z-20 flex items-center gap-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-[10px] font-mono text-textSecondary pointer-events-none select-none">
          <span className={
            clickMode === 'add' ? 'text-green-400' :
            clickMode === 'remove' ? 'text-red-400' :
            'text-orange-400'
          }>
            {clickMode === 'add' ? '● ADD' : clickMode === 'remove' ? '● REMOVE' : '□ BOX'}
          </span>
          {clickPointsRef.current.length > 0 && (
            <span>{clickPointsRef.current.length} pts</span>
          )}
        </div>
      )}

      {/* Loading Overlay with progress bar and staged status text */}
      {isUploading && (
        <div className="absolute inset-0 z-30 bg-[#0a0a0c]/80 backdrop-blur-md flex flex-col items-center justify-center pointer-events-none select-none">
          <div className="w-12 h-12 border-4 border-orange-500/10 border-t-orange-500 rounded-full animate-spin mb-4"></div>
          
          <span className="font-mono text-xs font-bold tracking-wider text-orange-400 uppercase">
            {uploadProgress < 40 ? "Uploading video file..." : 
             uploadProgress < 80 ? "Extracting frames..." : 
             "Initializing SAM 2 AI model..."}
          </span>
          
          <div className="w-64 h-1.5 bg-white/[0.08] rounded-full overflow-hidden mt-3.5 mb-2 shadow-inner border border-white/[0.03]">
            <div 
              className="h-full bg-gradient-to-r from-orange-500 to-red-500 transition-all duration-300 ease-out shadow-[0_0_10px_rgba(249,115,22,0.4)]"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          
          <span className="text-[10px] font-mono text-textSecondary font-semibold tracking-wider">
            {uploadProgress}% Complete
          </span>
        </div>
      )}
    </div>
  );
};

export default VideoCanvas;
