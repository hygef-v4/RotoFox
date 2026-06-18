import React, { useRef } from 'react';
import { Upload, Download, Plus, Minus, Square, RotateCcw, RectangleHorizontal, Settings, Trash2, Undo, Redo } from 'lucide-react';
import logo from '../../assets/rotofox_logo.png';
const Toolbar = ({ clickMode, setClickMode, onVideoImport, onExportClick, onClearClicks, onUndoClick, onRedoClick, viewMode, setViewMode, objects, activeObjectId, setActiveObjectId, handleAddObject, handleDeleteObject, onSettingsClick }) => {
  const fileInputRef = useRef(null);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('video/')) {
      const videoUrl = URL.createObjectURL(file);
      onVideoImport(videoUrl, file);
    }
  };

  const aiTools = [
    {
      mode: 'add',
      label: 'Include',
      desc: 'Click to mark object area',
      icon: <Plus size={15} className="text-green-400" />,
      activeClass: 'bg-green-500/20 text-green-400 border-green-500/60 shadow-[0_0_12px_rgba(34,197,94,0.2)]',
    },
    {
      mode: 'remove',
      label: 'Exclude',
      desc: 'Click to remove from mask',
      icon: <Minus size={15} className="text-red-400" />,
      activeClass: 'bg-red-500/10 text-red-400 border-red-500/35 shadow-[0_0_12px_rgba(239,68,68,0.12)]',
    },
    {
      mode: 'box',
      label: 'Box',
      desc: 'Drag to define object bounds',
      icon: <RectangleHorizontal size={15} className="text-orange-400" />,
      activeClass: 'bg-orange-500/10 text-orange-400 border-orange-500/35 shadow-[0_0_12px_rgba(249,115,22,0.12)]',
    },
  ];

  return (
    <div className="p-4 flex flex-col min-h-full gap-4">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-6">
          <img src={logo} alt="RotoFox AI Video Segmentation Workspace" className="w-8 h-8 rounded-lg object-cover" />
          <h2 className="text-xl font-bold tracking-tight text-orange-500">RotoFox</h2>
        </div>
        <div className="space-y-2">
          <input 
            type="file" 
            accept="video/mp4,video/webm,video/ogg,video/quicktime" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            className="hidden" 
          />
          <button 
            onClick={handleImportClick}
            aria-label="Import video file"
            className="w-full flex items-center justify-center gap-2 bg-blue-600/80 hover:bg-blue-500 text-white px-4 py-2 rounded-md transition-all font-semibold text-sm border border-blue-400/20 shadow-lg shadow-blue-950/20 hover:shadow-blue-500/10 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-blue-500/50 focus-visible:outline-none"
            title="Import an MP4, WebM, Ogg or QuickTime video file"
          >
            <Upload size={16} />
            Import
          </button>
        </div>
      </div>

      {/* OBJECT MANAGEMENT */}
      <div className="mb-6">
        <h3 className="text-[11px] font-bold text-textSecondary/60 uppercase tracking-widest mb-3">Objects</h3>
        <div className="space-y-1.5">
          {objects && objects.map(obj => (
            <div 
              key={obj.id}
              onClick={() => setActiveObjectId(obj.id)}
              tabIndex={0}
              role="button"
              aria-label={`Select object ${obj.name}`}
              aria-pressed={activeObjectId === obj.id}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setActiveObjectId(obj.id);
                }
              }}
              className={`flex items-center justify-between p-2 rounded-lg cursor-pointer transition-all duration-200 border focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
                activeObjectId === obj.id 
                  ? 'bg-white/[0.08] border-orange-500/40 shadow-[0_0_12px_rgba(249,115,22,0.06)]' 
                  : 'bg-white/[0.01] border-white/[0.03] hover:bg-white/[0.04] hover:border-white/[0.08]'
              }`}
            >
              <div className="flex items-center gap-3">
                <div 
                  className="w-3.5 h-3.5 rounded-md shadow-sm" 
                  style={{ backgroundColor: obj.color }}
                >
                </div>
                <span className="text-xs font-semibold text-textPrimary">{obj.name}</span>
              </div>
              {objects.length > 1 && (
                <button 
                  onClick={(e) => handleDeleteObject(e, obj.id)}
                  aria-label={`Remove object ${obj.name}`}
                  className="text-textSecondary hover:text-red-400 p-1 rounded-md hover:bg-white/[0.06] transition-colors focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:outline-none"
                  title="Remove object"
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
          <button 
            onClick={handleAddObject}
            disabled={objects.length >= 7}
            aria-label="Add new object"
            className={`w-full flex items-center justify-center gap-2 p-2 mt-2 border border-dashed rounded-lg transition-all duration-200 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
              objects.length < 7 
                ? "border-white/[0.1] text-textSecondary hover:text-textPrimary hover:border-white/[0.2] hover:bg-white/[0.03] cursor-pointer" 
                : "border-white/[0.04] text-textSecondary/20 cursor-not-allowed"
            }`}
            title={objects.length < 7 ? "Add a new track object for multi-object tracking" : "Maximum of 7 objects reached"}
          >
            <Plus size={15} />
            <span className="text-xs font-semibold">Add Object</span>
          </button>
        </div>
      </div>

      {/* AI TOOLS */}
      <div className="mb-6">
        <h3 className="text-[11px] font-bold text-textSecondary/60 uppercase tracking-widest mb-3">AI Tools</h3>
        <div className="space-y-1.5">
          {aiTools.map(({ mode, label, desc, icon, activeClass }) => (
            <button
              key={mode}
              onClick={() => setClickMode(mode)}
              role="button"
              aria-label={`${label} tool: ${desc}`}
              aria-pressed={clickMode === mode}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-200 text-left border focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${
                clickMode === mode
                  ? activeClass
                  : 'bg-white/[0.01] border-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.08] text-textSecondary hover:text-textPrimary'
              }`}
              title={desc}
            >
              <span className="flex-shrink-0">{icon}</span>
              <span className="text-xs font-semibold leading-none">{label}</span>
            </button>
          ))}

          <div className="grid grid-cols-3 gap-1.5 mt-2">
            <button 
              onClick={onUndoClick}
              aria-label="Undo last point or box"
              className="flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg bg-white/[0.01] border border-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.08] transition-all duration-200 text-[10px] font-semibold text-textSecondary hover:text-textPrimary focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none cursor-pointer"
              title="Undo last point/box (Ctrl+Z)"
            >
              <Undo size={12} className="flex-shrink-0 text-orange-400/90" />
              <span className="leading-none mt-0.5">Undo</span>
            </button>
            <button 
              onClick={onRedoClick}
              aria-label="Redo last undone point or box"
              className="flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg bg-white/[0.01] border border-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.08] transition-all duration-200 text-[10px] font-semibold text-textSecondary hover:text-textPrimary focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none cursor-pointer"
              title="Redo last undone point/box"
            >
              <Redo size={12} className="flex-shrink-0 text-orange-400/90" />
              <span className="leading-none mt-0.5">Redo</span>
            </button>
            <button 
              onClick={onClearClicks}
              aria-label="Reset all selected points and boxes"
              className="flex flex-col items-center justify-center gap-1 py-1.5 rounded-lg bg-white/[0.01] border border-white/[0.03] hover:bg-white/[0.05] hover:border-white/[0.08] transition-all duration-200 text-[10px] font-semibold text-textSecondary hover:text-textPrimary focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none cursor-pointer"
              title="Reset selection (Clear all points/boxes)"
            >
              <RotateCcw size={12} className="flex-shrink-0 text-orange-400/90" />
              <span className="leading-none mt-0.5">Reset</span>
            </button>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-[11px] font-bold text-textSecondary/60 uppercase tracking-widest mb-3">View Mode</h3>
        <div className="flex bg-black/45 rounded-lg p-0.5 border border-white/[0.04] backdrop-blur-sm">
          <button
            onClick={() => setViewMode('overlay')}
            aria-label="Set view mode to Overlay"
            aria-pressed={viewMode === 'overlay'}
            className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all duration-200 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${viewMode === 'overlay' ? 'bg-orange-500/95 text-white shadow-md border border-orange-400/20' : 'text-textSecondary hover:text-textPrimary'}`}
          >
            Overlay
          </button>
          <button
            onClick={() => setViewMode('isolated')}
            aria-label="Set view mode to Isolated"
            aria-pressed={viewMode === 'isolated'}
            className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all duration-200 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none ${viewMode === 'isolated' ? 'bg-orange-500/95 text-white shadow-md border border-orange-400/20' : 'text-textSecondary hover:text-textPrimary'}`}
          >
            Isolated
          </button>
        </div>
      </div>

      <div className="mt-auto space-y-2 pt-4 border-t border-white/[0.04]">
        <button 
          onClick={onExportClick}
          aria-label="Export generated mask"
          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-orange-500/90 to-red-500/90 hover:from-orange-500 hover:to-red-500 text-white px-4 py-2 rounded-lg font-semibold text-xs border border-orange-400/20 shadow-lg shadow-orange-950/20 hover:shadow-orange-500/20 active:scale-[0.98] transition-all duration-200 animate-pulse-subtle focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none"
          title="Render and export mask to file"
        >
          <Download size={15} />
          Export
        </button>
        <button 
          onClick={onSettingsClick}
          aria-label="Open settings configuration dialog"
          className="w-full flex items-center justify-center gap-2 bg-white/[0.02] hover:bg-white/[0.07] text-[11px] font-semibold text-textSecondary hover:text-textPrimary px-4 py-2 rounded-lg border border-white/[0.04] transition-all duration-200 focus-visible:ring-2 focus-visible:ring-orange-500/50 focus-visible:outline-none"
          title="Configure folder, resolution and frame rate for export"
        >
          <Settings size={13} />
          Settings
        </button>
      </div>
    </div>
  );
};

export default Toolbar;

