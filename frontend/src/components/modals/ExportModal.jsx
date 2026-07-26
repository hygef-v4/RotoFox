import React from 'react';
import { AlertCircle, CheckCircle, Copy, Download, Film, X } from 'lucide-react';

/**
 * Export dialog.
 *
 * Format and render-type options are now constrained by what the backend can
 * actually produce. Previously the UI offered MOV and an "Alpha Matte" while
 * the backend wrote every format through `cv2.VideoWriter` with the `mp4v`
 * fourcc — no ProRes, no alpha channel anywhere, and a grey 150/255 matte.
 */

const FORMATS = [
  { id: 'mp4', label: 'MP4', hint: 'H.264 — no transparency' },
  { id: 'mov', label: 'MOV', hint: 'ProRes 4444 — supports alpha' },
  { id: 'webm', label: 'WebM', hint: 'VP9 — supports alpha' },
  { id: 'png', label: 'PNG Seq', hint: 'Numbered frames' },
];

const RENDER_TYPES = [
  { id: 'solid', label: 'Solid Color', desc: 'Subject over a flat background' },
  { id: 'alpha', label: 'Luma Matte', desc: 'White subject on black' },
  { id: 'transparent', label: 'Transparent', desc: 'Real alpha channel' },
  { id: 'overlay', label: 'Video Overlay', desc: 'Mask tinted on the plate' },
];

const BG_COLORS = [
  { id: 'green', color: '#00FF00', label: 'Green' },
  { id: 'blue', color: '#0000FF', label: 'Blue' },
  { id: 'black', color: '#000000', label: 'Black' },
  { id: 'white', color: '#FFFFFF', label: 'White' },
];

/** Formats that can carry a real alpha channel. */
const ALPHA_CAPABLE = new Set(['mov', 'webm', 'png']);

export default function ExportModal({
  open,
  exportState,
  settings,
  onChange,
  onStart,
  onCancel,
  onClose,
}) {
  const [copied, setCopied] = React.useState(false);

  if (!open) return null;

  const { format, type, bgColor } = settings;
  const transparencyUnsupported = type === 'transparent' && !ALPHA_CAPABLE.has(format);

  const copyPath = () => {
    if (!exportState.filePath) return;
    navigator.clipboard.writeText(exportState.filePath);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const start = () => onStart({
    format,
    type,
    bg_color: bgColor,
    export_path: settings.exportPath,
    resolution: settings.resolution,
    fps: settings.fps,
  });

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-[#171717] border border-[#333] rounded-xl w-[520px] p-6 shadow-2xl relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close export dialog"
          className="absolute top-4 right-4 text-textSecondary hover:text-textPrimary transition-colors"
        >
          <X size={20} />
        </button>

        <h3 className="text-xl font-bold mb-4 text-orange-500 flex items-center gap-2">
          <Download size={22} />
          Export RotoFox Project
        </h3>

        {exportState.status === 'idle' && (
          <div className="space-y-4">
            <p className="text-xs text-textSecondary">
              Render your mask frames into a production-ready matte or transparent clip.
            </p>

            <div>
              <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Export Format</label>
              <div className="grid grid-cols-4 gap-2">
                {FORMATS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChange({ format: item.id })}
                    title={item.hint}
                    className={`px-2 py-2 rounded-md border text-xs font-semibold transition-all ${
                      format === item.id
                        ? 'bg-orange-500/20 border-orange-500 text-orange-400'
                        : 'bg-[#222] border-[#333] hover:border-[#444] text-textSecondary'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-textSecondary/70 mt-1">
                {FORMATS.find((f) => f.id === format)?.hint}
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Render Type</label>
              <div className="grid grid-cols-4 gap-2">
                {RENDER_TYPES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onChange({ type: item.id })}
                    className={`p-2 rounded-lg border text-left transition-all ${
                      type === item.id
                        ? 'bg-orange-500/20 border-orange-500'
                        : 'bg-[#222] border-[#333] hover:border-[#444]'
                    }`}
                  >
                    <div className="text-[11px] font-semibold text-textPrimary">{item.label}</div>
                    <div className="text-[9px] mt-0.5 opacity-70 text-textSecondary">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {transparencyUnsupported && (
              <div className="flex items-start gap-2 text-[11px] text-orange-300 bg-orange-500/10 border border-orange-500/25 rounded-lg px-3 py-2">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                <span>
                  MP4 cannot store transparency. Choose MOV, WebM or PNG Sequence
                  for a transparent export.
                </span>
              </div>
            )}

            {type === 'solid' && (
              <div>
                <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Background Color</label>
                <div className="grid grid-cols-4 gap-2">
                  {BG_COLORS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onChange({ bgColor: item.id })}
                      className={`py-1.5 rounded-md border flex flex-col items-center justify-center transition-all ${
                        bgColor === item.id ? 'border-orange-500 bg-[#333]' : 'border-[#333] hover:border-[#555] bg-[#222]'
                      }`}
                    >
                      <div
                        className="w-3 h-3 rounded-full border border-[#555] mb-1"
                        style={{ backgroundColor: item.color }}
                      />
                      <div className="text-[9px] font-semibold text-textSecondary">{item.label}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={start}
              disabled={transparencyUnsupported}
              className={`w-full font-semibold py-2.5 rounded-lg transition-colors mt-2 ${
                transparencyUnsupported
                  ? 'bg-white/[0.05] text-textSecondary cursor-not-allowed'
                  : 'bg-orange-500 hover:bg-orange-600 text-white'
              }`}
            >
              Start Exporting
            </button>
          </div>
        )}

        {exportState.status === 'rendering' && (
          <div className="py-6 flex flex-col items-center justify-center text-center">
            <div className="relative w-16 h-16 mb-4 flex items-center justify-center">
              <div className="absolute inset-0 border-4 border-orange-500/20 border-t-orange-500 rounded-full animate-spin" />
              <Film className="text-orange-500 animate-pulse" size={24} />
            </div>

            <h4 className="font-semibold text-textPrimary mb-1">Rendering Project...</h4>
            <p className="text-xs text-textSecondary mb-4">{exportState.message}</p>

            {exportState.warning && (
              <p className="text-[11px] text-orange-300 bg-orange-500/10 border border-orange-500/25 rounded-lg px-3 py-2 mb-3">
                {exportState.warning}
              </p>
            )}

            <div className="w-full bg-[#222] rounded-full h-2 overflow-hidden mb-2">
              <div
                className="bg-orange-500 h-full transition-all duration-300 ease-out"
                style={{ width: `${exportState.progress}%` }}
              />
            </div>
            <span className="text-sm font-mono text-orange-400 font-semibold mb-4">{exportState.progress}%</span>

            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-textSecondary hover:text-red-400 transition-colors underline"
            >
              Cancel export
            </button>
          </div>
        )}

        {exportState.status === 'completed' && (
          <div className="py-6 flex flex-col items-center justify-center text-center">
            <CheckCircle className="text-green-500 mb-4" size={48} />
            <h4 className="font-bold text-textPrimary text-lg mb-1">Export Successful</h4>
            <p className="text-xs text-textSecondary mb-6">{exportState.message}</p>

            <div className="w-full flex items-center justify-between gap-3 bg-[#222] border border-[#333] rounded-lg p-3 mb-6">
              <div className="text-left font-mono text-[10px] text-textSecondary overflow-x-auto select-all flex-1 pr-2">
                <span className="block mb-1 uppercase font-sans font-bold tracking-wider">Saved to:</span>
                {exportState.filePath}
              </div>
              <button
                type="button"
                onClick={copyPath}
                aria-label="Copy export path to clipboard"
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[10px] font-bold transition-all border flex-shrink-0 ${
                  copied
                    ? 'bg-green-500/10 border-green-500/30 text-green-400'
                    : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.08] text-textSecondary hover:text-textPrimary'
                }`}
              >
                <Copy size={11} />
                {copied ? 'Copied' : 'Copy Path'}
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="w-full bg-white hover:bg-gray-200 text-black font-semibold py-2.5 rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        )}

        {(exportState.status === 'error' || exportState.status === 'cancelled') && (
          <div className="py-6 flex flex-col items-center justify-center text-center">
            <AlertCircle className={exportState.status === 'error' ? 'text-red-500 mb-4' : 'text-orange-400 mb-4'} size={48} />
            <h4 className="font-bold text-textPrimary text-lg mb-1">
              {exportState.status === 'error' ? 'Export Failed' : 'Export Cancelled'}
            </h4>
            <p className="text-xs text-textSecondary mb-6 max-w-sm">{exportState.message}</p>

            <button
              type="button"
              onClick={start}
              className="w-full bg-orange-500 hover:bg-orange-600 text-white font-semibold py-2.5 rounded-lg transition-colors mb-2"
            >
              Try Again
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full bg-surfaceHover hover:bg-[#333] text-textPrimary font-semibold py-2.5 rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
