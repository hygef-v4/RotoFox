import React from 'react';
import { FolderOpen, Settings, X } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

/** Output destination, resolution and frame rate for exports. */
export default function SettingsModal({ open, settings, onChange, onClose }) {
  if (!open) return null;

  const browse = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Choose Export Folder',
      });
      if (selected) onChange({ exportPath: selected });
    } catch (err) {
      // Raised when running in a plain browser rather than the Tauri shell.
      console.warn('Folder picker unavailable:', err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
      <div className="bg-[#171717] border border-[#333] rounded-xl w-[450px] p-6 shadow-2xl relative">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="absolute top-4 right-4 text-textSecondary hover:text-textPrimary transition-colors"
        >
          <X size={20} />
        </button>

        <h3 className="text-xl font-bold mb-6 text-textPrimary flex items-center gap-2">
          <Settings size={22} className="text-orange-500" />
          Output Settings
        </h3>

        <div className="space-y-5">
          <div>
            <label className="block text-xs font-semibold text-textSecondary uppercase mb-1">Export Folder</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.exportPath}
                readOnly
                placeholder="Click Browse to choose a folder..."
                className="flex-1 bg-[#222] border border-[#333] rounded-lg p-2 text-sm text-textPrimary placeholder-[#555] cursor-default"
              />
              <button
                type="button"
                onClick={browse}
                className="flex items-center gap-1.5 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/25 text-orange-400 text-[11px] font-bold px-3 py-2 rounded-lg transition-colors flex-shrink-0"
              >
                <FolderOpen size={13} />
                Browse
              </button>
              {settings.exportPath && (
                <button
                  type="button"
                  onClick={() => onChange({ exportPath: '' })}
                  className="text-textSecondary hover:text-red-400 transition-colors flex-shrink-0"
                  title="Clear path"
                  aria-label="Clear export path"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <p className="text-[10px] text-textSecondary mt-1">
              If blank, exports are saved to Downloads/RotoFox Exports.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-textSecondary uppercase mb-1" htmlFor="resolution">
              Resolution
            </label>
            <select
              id="resolution"
              value={settings.resolution}
              onChange={(event) => onChange({ resolution: event.target.value })}
              className="w-full bg-[#222] border border-[#333] rounded-lg p-2 text-sm text-textPrimary focus:border-orange-500 focus:outline-none transition-colors"
            >
              <option value="original">Original (match source)</option>
              <option value="1080p">1080p (1920x1080)</option>
              <option value="720p">720p (1280x720)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-textSecondary uppercase mb-1" htmlFor="fps">
              Framerate
            </label>
            <select
              id="fps"
              value={settings.fps}
              onChange={(event) => onChange({ fps: event.target.value })}
              className="w-full bg-[#222] border border-[#333] rounded-lg p-2 text-sm text-textPrimary focus:border-orange-500 focus:outline-none transition-colors"
            >
              <option value="original">Original (match source)</option>
              <option value="24">24 FPS (Cinematic)</option>
              <option value="30">30 FPS</option>
              <option value="60">60 FPS</option>
            </select>
          </div>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full mt-6 bg-white hover:bg-gray-200 text-black font-semibold py-2 rounded-lg transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}
