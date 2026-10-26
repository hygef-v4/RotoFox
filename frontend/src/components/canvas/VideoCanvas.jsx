import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Upload, RotateCcw } from 'lucide-react';
import { ACCEPTED_VIDEO_ATTR, isAcceptedVideoFile } from '../../config';

const DOT_RADIUS = 6;

/**
 * Interactive canvas: video frame, AI mask overlay, click points and box drags.
 *
 * Changes from the original implementation:
 *
 * - Receives a decoded `maskBitmap` instead of a base64 string, so it no longer
 *   keeps a second 200-entry cache keyed by megabyte-sized strings.
 * - The marching-ants animation loop only runs while a box is on screen. It
 *   previously ran 60 times a second for the whole session, even before a video
 *   was imported, preventing the CPU from idling.
 * - Object URLs created for imported files are revoked, instead of pinning
 *   every previously imported video in memory for the life of the session.
 */
const VideoCanvas = ({
  videoUrl,
  clickMode,
  onCanvasClick,
  maskBitmap,
  isPlaying,
  currentFrame,
  videoOffsetFrame = 0,
  totalFrames,
  onVideoMetadataLoaded,
  onFrameChange,
  onPlayToggle,
  clearSignal,
  undoSignal,
  redoSignal,
  uploadProgress = { phase: 'idle', percent: 0, detail: '' },
  viewMode = 'overlay',
  onRequestMask,
  objects = [],
  activeObjectId,
  deleteObjectSignal,
  onVideoImport,
}) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);

  const [isDragActive, setIsDragActive] = useState(false);
  const [showUndoToast, setShowUndoToast] = useState(false);
  const [pointCount, setPointCount] = useState(0);

  const isUploading = uploadProgress.phase !== 'idle';

  const clickPointsRef = useRef([]);
  const boxesRef = useRef([]);
  const redoHistoryRef = useRef([]);
  const toastTimeoutRef = useRef(null);
  const prevFrameRef = useRef(currentFrame);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef(null);
  const dragEndRef = useRef(null);
  const dashOffsetRef = useRef(0);

  // Refs mirroring props that stable callbacks need to read at call time.
  const clickModeRef = useRef(clickMode);
  const isPlayingRef = useRef(isPlaying);
  const onCanvasClickRef = useRef(onCanvasClick);
  const onPlayToggleRef = useRef(onPlayToggle);
  const onRequestMaskRef = useRef(onRequestMask);
  const maskBitmapRef = useRef(maskBitmap);

  useEffect(() => { clickModeRef.current = clickMode; }, [clickMode]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { onCanvasClickRef.current = onCanvasClick; }, [onCanvasClick]);
  useEffect(() => { onPlayToggleRef.current = onPlayToggle; }, [onPlayToggle]);
  useEffect(() => { onRequestMaskRef.current = onRequestMask; }, [onRequestMask]);
  useEffect(() => { maskBitmapRef.current = maskBitmap; }, [maskBitmap]);

  // ── Draw ────────────────────────────────────────────────────────────────
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (videoRef.current && videoRef.current.readyState >= 2) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    }

    const bitmap = maskBitmapRef.current;
    if (bitmap) {
      if (viewMode === 'isolated') {
        // Keep only the pixels the mask covers.
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      }
    }

    boxesRef.current.forEach(({ x1, y1, x2, y2, objId }) => {
      if (!objects.find((o) => o.id === objId)) return;

      const px1 = x1 * canvas.width;
      const py1 = y1 * canvas.height;
      const width = (x2 - x1) * canvas.width;
      const height = (y2 - y1) * canvas.height;
      const isActive = objId === activeObjectId;

      ctx.globalAlpha = isActive ? 1.0 : 0.4;
      ctx.lineWidth = isActive ? 2.5 : 1.5;
      if (isActive) {
        ctx.setLineDash([8, 4]);
        ctx.lineDashOffset = -dashOffsetRef.current;
      } else {
        ctx.setLineDash([4, 3]);
        ctx.lineDashOffset = 0;
      }
      ctx.strokeStyle = '#f97316';
      ctx.strokeRect(px1, py1, width, height);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.fillStyle = isActive ? 'rgba(249,115,22,0.14)' : 'rgba(249,115,22,0.06)';
      ctx.fillRect(px1, py1, width, height);
      ctx.globalAlpha = 1.0;
    });

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

    clickPointsRef.current.forEach(({ x, y, mode, objId }) => {
      const obj = objects.find((o) => o.id === objId);
      if (!obj) return;

      const px = x * canvas.width;
      const py = y * canvas.height;
      const isAdd = mode === 'add';
      const baseColor = obj.color;

      ctx.globalAlpha = objId === activeObjectId ? 1.0 : 0.4;

      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS + 3, 0, Math.PI * 2);
      ctx.fillStyle = isAdd ? `${baseColor}40` : 'rgba(239,68,68,0.25)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = isAdd ? baseColor : '#ef4444';
      ctx.fill();
      ctx.strokeStyle = isAdd ? baseColor : '#dc2626';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      ctx.globalAlpha = 1.0;
    });
  }, [viewMode, activeObjectId, objects]);

  // Redraw whenever a new mask arrives.
  useEffect(() => { drawCanvas(); }, [maskBitmap, drawCanvas]);

  // ── Canvas sizing from video metadata ───────────────────────────────────
  useLayoutEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !videoUrl) return undefined;

    const applyDimensions = () => {
      if (video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        drawCanvas();
      }
    };

    video.addEventListener('loadedmetadata', applyDimensions);
    if (video.readyState >= 1) applyDimensions();
    return () => video.removeEventListener('loadedmetadata', applyDimensions);
  }, [videoUrl, drawCanvas]);

  useEffect(() => {
    if (isUploading) return undefined;
    const id = requestAnimationFrame(() => drawCanvas());
    return () => cancelAnimationFrame(id);
  }, [isUploading, drawCanvas]);

  // ── Prompt history signals ──────────────────────────────────────────────
  useEffect(() => {
    clickPointsRef.current = [];
    boxesRef.current = [];
    redoHistoryRef.current = [];
    setPointCount(0);
    drawCanvas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal]);

  const resendPrompts = useCallback(() => {
    const points = clickPointsRef.current.filter((p) => p.objId === activeObjectId);
    const boxes = boxesRef.current.filter((b) => b.objId === activeObjectId);
    if (points.length === 0 && boxes.length === 0) return;
    onCanvasClickRef.current?.(points, boxes);
  }, [activeObjectId]);

  useEffect(() => {
    if (!undoSignal) return;

    setShowUndoToast(true);
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = setTimeout(() => setShowUndoToast(false), 2000);

    const boxIndex = boxesRef.current
      .map((box, index) => ({ box, index }))
      .reverse()
      .find(({ box }) => box.objId === activeObjectId);

    if (boxIndex !== undefined) {
      redoHistoryRef.current.push({ type: 'box', data: boxesRef.current[boxIndex.index] });
      boxesRef.current = boxesRef.current.filter((_, i) => i !== boxIndex.index);
    } else {
      const points = clickPointsRef.current;
      for (let i = points.length - 1; i >= 0; i -= 1) {
        if (points[i].objId === activeObjectId) {
          redoHistoryRef.current.push({ type: 'point', data: points[i] });
          clickPointsRef.current = [...points.slice(0, i), ...points.slice(i + 1)];
          break;
        }
      }
    }

    drawCanvas();
    resendPrompts();
    setPointCount(clickPointsRef.current.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoSignal]);

  useEffect(() => {
    if (!redoSignal || redoHistoryRef.current.length === 0) return;

    const item = redoHistoryRef.current.pop();
    if (item.type === 'box') {
      boxesRef.current = [...boxesRef.current, item.data];
    } else {
      clickPointsRef.current = [...clickPointsRef.current, item.data];
    }

    drawCanvas();
    resendPrompts();
    setPointCount(clickPointsRef.current.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redoSignal]);

  useEffect(() => {
    if (deleteObjectSignal?.id === undefined) return;
    clickPointsRef.current = clickPointsRef.current.filter((p) => p.objId !== deleteObjectSignal.id);
    boxesRef.current = boxesRef.current.filter((b) => b.objId !== deleteObjectSignal.id);
    setPointCount(clickPointsRef.current.length);
    drawCanvas();
  }, [deleteObjectSignal, drawCanvas]);

  useEffect(() => {
    if (prevFrameRef.current === currentFrame) return;
    prevFrameRef.current = currentFrame;
    clickPointsRef.current = [];
    boxesRef.current = [];
    setPointCount(0);
    drawCanvas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame]);

  // ── Marching-ants animation, only while a box exists ────────────────────
  const [hasBoxes, setHasBoxes] = useState(false);
  useEffect(() => {
    if (!hasBoxes || isPlaying) return undefined;
    let animId;
    const tick = () => {
      dashOffsetRef.current = (dashOffsetRef.current + 0.5) % 24;
      drawCanvas();
      animId = requestAnimationFrame(tick);
    };
    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [hasBoxes, isPlaying, drawCanvas]);

  // ── Playback ────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.play().catch((err) => console.warn('Playback blocked:', err));
    } else {
      video.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isPlaying || !video.duration) return;
    const effectiveFps = totalFrames > 0 ? totalFrames / video.duration : 30;
    video.currentTime = (currentFrame + videoOffsetFrame) / effectiveFps;
  }, [currentFrame, videoOffsetFrame, isPlaying, totalFrames]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    let animId;
    let lastFrame = -1;

    const loop = () => {
      const video = videoRef.current;
      if (!video) return;

      const effectiveFps = (totalFrames > 0 && video.duration) ? totalFrames / video.duration : 30;
      const frame = Math.floor(video.currentTime * effectiveFps) - videoOffsetFrame;
      const lastValidFrame = Math.max(0, totalFrames - 1);

      if (frame > lastValidFrame) {
        onPlayToggle(false);
        onFrameChange(0);
      } else if (frame >= 0 && frame !== lastFrame) {
        lastFrame = frame;
        onFrameChange(frame);
        onRequestMaskRef.current?.(frame + videoOffsetFrame);
      }

      drawCanvas();
      animId = requestAnimationFrame(loop);
    };

    animId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, totalFrames, videoOffsetFrame, onFrameChange, onPlayToggle]);

  useEffect(() => {
    isDraggingRef.current = false;
    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [clickMode, drawCanvas]);

  // ── File import ─────────────────────────────────────────────────────────
  const importFile = useCallback((file) => {
    if (!isAcceptedVideoFile(file)) return;
    // The caller owns the URL and is responsible for revoking the previous one.
    onVideoImport?.(URL.createObjectURL(file), file);
  }, [onVideoImport]);

  const handleDrag = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'dragenter' || event.type === 'dragover') setIsDragActive(true);
    else if (event.type === 'dragleave') setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);
    importFile(event.dataTransfer?.files?.[0]);
  }, [importFile]);

  const handleBrowseClick = () => fileInputRef.current?.click();

  const handleFileChange = (event) => {
    importFile(event.target.files?.[0]);
    // Allow re-selecting the same file.
    event.target.value = '';
  };

  // ── Pointer interaction ─────────────────────────────────────────────────
  const getCoords = (event) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handleMouseDown = useCallback((event) => {
    event.preventDefault();
    if (!videoUrl) return;
    if (isPlayingRef.current) {
      onPlayToggleRef.current?.(false);
      return;
    }

    const { x, y } = getCoords(event);
    const mode = clickModeRef.current;

    if (mode === 'add' || mode === 'remove') {
      clickPointsRef.current = [...clickPointsRef.current, { x, y, mode, objId: activeObjectId }];
      redoHistoryRef.current = [];
      setPointCount(clickPointsRef.current.length);
      drawCanvas();
      onCanvasClickRef.current?.(
        clickPointsRef.current.filter((p) => p.objId === activeObjectId),
        boxesRef.current.filter((b) => b.objId === activeObjectId),
      );
    } else {
      isDraggingRef.current = true;
      dragStartRef.current = { x, y, objId: activeObjectId };
      dragEndRef.current = { x, y };
      drawCanvas();
    }
  }, [drawCanvas, activeObjectId, videoUrl]);

  const handleMouseMove = useCallback((event) => {
    if (!isDraggingRef.current) return;
    dragEndRef.current = getCoords(event);
    drawCanvas();
  }, [drawCanvas]);

  const handleMouseUp = useCallback((event) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    const { x, y } = getCoords(event);
    const start = dragStartRef.current ?? { x, y };

    if (Math.hypot(x - start.x, y - start.y) > 0.01) {
      boxesRef.current = [...boxesRef.current, {
        x1: Math.min(start.x, x),
        y1: Math.min(start.y, y),
        x2: Math.max(start.x, x),
        y2: Math.max(start.y, y),
        objId: activeObjectId,
      }];
      redoHistoryRef.current = [];
      setHasBoxes(true);
      onCanvasClickRef.current?.(
        clickPointsRef.current.filter((p) => p.objId === activeObjectId),
        boxesRef.current.filter((b) => b.objId === activeObjectId),
      );
    }

    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [drawCanvas, activeObjectId]);

  const handleMouseLeave = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    dragStartRef.current = null;
    dragEndRef.current = null;
    drawCanvas();
  }, [drawCanvas]);

  useEffect(() => { setHasBoxes(boxesRef.current.length > 0); }, [clearSignal, undoSignal, redoSignal, currentFrame]);

  const handleLoadedMetadata = useCallback((event) => {
    const video = event.target;
    onVideoMetadataLoaded?.({
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    });
  }, [onVideoMetadataLoaded]);

  const uploadLabel = {
    uploading: 'Uploading video file...',
    extracting: 'Extracting frames...',
    initializing: 'Initializing SAM 2 AI model...',
  }[uploadProgress.phase] ?? '';

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
          onSeeked={drawCanvas}
        />
      ) : (
        <div className={`absolute inset-0 flex flex-col items-center justify-center p-8 transition-all duration-300 ${
          isDragActive ? 'scale-102 bg-blue-500/[0.02]' : ''
        }`}
        >
          <div
            onClick={handleBrowseClick}
            tabIndex={0}
            role="button"
            aria-label="Drag and drop zone to upload video files. Click or press Enter to choose a file."
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handleBrowseClick();
              }
            }}
            className={`max-w-md w-full border-2 border-dashed rounded-2xl p-10 flex flex-col items-center text-center transition-all duration-300 cursor-pointer focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
              isDragActive
                ? 'border-blue-500 bg-blue-500/[0.04] shadow-[0_0_40px_rgba(59,130,246,0.14)] scale-102'
                : 'border-white/[0.08] bg-white/[0.01] hover:border-white/[0.15] hover:bg-white/[0.02]'
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
              accept={ACCEPTED_VIDEO_ATTR}
              ref={fileInputRef}
              onChange={handleFileChange}
              className="hidden"
            />

            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); handleBrowseClick(); }}
              aria-label="Select video file"
              className="px-5 py-2.5 bg-gradient-to-r from-orange-500/90 to-red-500/90 hover:from-orange-500 hover:to-red-500 text-white text-xs font-bold rounded-lg border border-orange-400/20 shadow-lg shadow-orange-950/20 active:scale-[0.98] transition-all duration-200 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none"
            >
              Select Video
            </button>

            <span className="text-[10px] text-textSecondary/30 mt-6 font-mono uppercase tracking-widest">
              MP4, WebM, MOV, MKV supported
            </span>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={1280}
        height={720}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        tabIndex={videoUrl ? 0 : -1}
        aria-label="Video segmentation workspace canvas. Click to place points or drag to draw boxes."
        className={`absolute inset-0 w-full h-full object-contain z-10 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${!videoUrl ? 'pointer-events-none' : ''}`}
        style={{
          cursor: !videoUrl ? 'default' : (clickMode === 'box' ? 'crosshair' : 'cell'),
          touchAction: 'none',
        }}
      />

      {showUndoToast && (
        <div className="absolute top-4 right-4 z-20 flex items-center gap-2 bg-[#17171a]/95 border border-white/[0.1] backdrop-blur-md px-3.5 py-2 rounded-xl shadow-lg shadow-black/50 text-xs font-semibold text-textPrimary">
          <RotateCcw size={14} className="text-orange-500" />
          <span>Action Undone</span>
        </div>
      )}

      {videoUrl && !isUploading && (
        <div className="absolute bottom-2 right-2 z-20 flex items-center gap-2 bg-black/60 backdrop-blur-sm px-2 py-1 rounded text-[10px] font-mono text-textSecondary pointer-events-none select-none">
          <span className={
            clickMode === 'add' ? 'text-green-400'
              : clickMode === 'remove' ? 'text-red-400'
                : 'text-orange-400'
          }
          >
            {clickMode === 'add' ? '● ADD' : clickMode === 'remove' ? '● REMOVE' : '□ BOX'}
          </span>
          {pointCount > 0 && <span>{pointCount} pts</span>}
        </div>
      )}

      {isUploading && (
        <div className="absolute inset-0 z-30 bg-[#0a0a0c]/80 backdrop-blur-md flex flex-col items-center justify-center pointer-events-none select-none">
          <div className="w-12 h-12 border-4 border-orange-500/10 border-t-orange-500 rounded-full animate-spin mb-4" />

          <span className="font-mono text-xs font-bold tracking-wider text-orange-400 uppercase">
            {uploadLabel}
          </span>

          <div className="w-64 h-1.5 bg-white/[0.08] rounded-full overflow-hidden mt-3.5 mb-2 shadow-inner border border-white/[0.03]">
            <div
              className="h-full bg-gradient-to-r from-orange-500 to-red-500 transition-all duration-200 ease-out"
              style={{ width: `${uploadProgress.percent}%` }}
            />
          </div>

          <span className="text-[10px] font-mono text-textSecondary font-semibold tracking-wider">
            {uploadProgress.detail || `${uploadProgress.percent}%`}
          </span>
        </div>
      )}
    </div>
  );
};

export default VideoCanvas;
