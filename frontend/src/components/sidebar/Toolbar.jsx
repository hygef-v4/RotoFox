import React, { useRef } from 'react';
import { Upload, Download, MousePointer2, Plus, Minus, Settings, Play, Square, Trash2 } from 'lucide-react';
import logo from '../../assets/rotofox_logo.png';
const Toolbar = ({ clickMode, setClickMode, onVideoImport, onExportClick, onClearClicks, viewMode, setViewMode, objects, activeObjectId, setActiveObjectId, handleAddObject, handleDeleteObject }) => {
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

  return (
    <div className="p-4 flex flex-col min-h-full gap-4">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-6">
          <img src={logo} alt="RotoFox Logo" className="w-8 h-8 rounded-lg object-cover" />
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
            className="w-full flex items-center justify-center gap-2 bg-primary hover:bg-primaryHover text-white px-4 py-2 rounded-md transition-colors font-medium text-sm"
          >
            <Upload size={16} />
            Import Video
          </button>
        </div>
      </div>

      {/* OBJECT MANAGEMENT */}
      <div className="mb-6">
        <h3 className="text-sm font-semibold text-textSecondary uppercase tracking-wider mb-3">Objects</h3>
        <div className="space-y-2">
          {objects && objects.map(obj => (
            <div 
              key={obj.id}
              onClick={() => setActiveObjectId(obj.id)}
              className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors border ${
                activeObjectId === obj.id 
                  ? 'bg-surfaceHover border-primary' 
                  : 'bg-transparent border-transparent hover:bg-surfaceHover hover:border-border'
              }`}
            >
              <div className="flex items-center gap-3">
                <div 
                  className="w-4 h-4 rounded-sm" 
                  style={{ backgroundColor: obj.color }}
                ></div>
                <span className="text-sm font-medium text-textPrimary">{obj.name}</span>
              </div>
              {objects.length > 1 && (
                <button 
                  onClick={(e) => handleDeleteObject(e, obj.id)}
                  className="text-textSecondary hover:text-red-400 p-1 rounded-md hover:bg-surface transition-colors"
                  title="Remove object"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
          <button 
            onClick={handleAddObject}
            className="w-full flex items-center justify-center gap-2 p-2 mt-2 border border-dashed border-border rounded text-textSecondary hover:text-textPrimary hover:border-textSecondary hover:bg-surfaceHover transition-colors"
          >
            <Plus size={16} />
            <span className="text-sm font-medium">Add another object</span>
          </button>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-textSecondary uppercase tracking-wider mb-3">AI Tools</h3>
        <div className="space-y-2">
          <button 
            onClick={() => setClickMode('add')}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md transition-colors text-sm ${clickMode === 'add' ? 'bg-green-500/20 text-green-400 font-semibold' : 'hover:bg-surfaceHover text-textPrimary'}`}
          >
            <Plus size={16} className="text-green-500" />
            Select (Add Point)
          </button>
          <button 
            onClick={() => setClickMode('remove')}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md transition-colors text-sm ${clickMode === 'remove' ? 'bg-red-500/20 text-red-400 font-semibold' : 'hover:bg-surfaceHover text-textPrimary'}`}
          >
            <Minus size={16} className="text-red-500" />
            Deselect (Remove Point)
          </button>
          <button 
            onClick={() => setClickMode('box')}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-md transition-colors text-sm ${clickMode === 'box' ? 'bg-orange-500/20 text-orange-400 font-semibold' : 'hover:bg-surfaceHover text-textPrimary'}`}
          >
            <Square size={16} className="text-orange-500" />
            Select Region (Box)
          </button>
          <button 
            onClick={onClearClicks}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md hover:bg-surfaceHover transition-colors text-sm text-textSecondary hover:text-textPrimary"
          >
            <MousePointer2 size={16} />
            Clear Clicks
          </button>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-sm font-semibold text-textSecondary uppercase tracking-wider mb-3">View Mode</h3>
        <div className="flex bg-[#222] rounded-md p-1 border border-[#333]">
          <button
            onClick={() => setViewMode('overlay')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-sm transition-colors ${viewMode === 'overlay' ? 'bg-orange-500 text-white' : 'text-textSecondary hover:text-textPrimary'}`}
          >
            Overlay
          </button>
          <button
            onClick={() => setViewMode('isolated')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-sm transition-colors ${viewMode === 'isolated' ? 'bg-orange-500 text-white' : 'text-textSecondary hover:text-textPrimary'}`}
          >
            Isolated
          </button>
        </div>
      </div>

      <div className="mt-auto space-y-2">
        <h3 className="text-sm font-semibold text-textSecondary uppercase tracking-wider mb-3">Export</h3>
        <button 
          onClick={onExportClick}
          className="w-full flex items-center justify-center gap-2 bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-md transition-colors font-semibold text-sm"
        >
          <Download size={16} />
          Export Alpha Video
        </button>
        <button className="w-full flex items-center justify-center gap-2 bg-surfaceHover hover:bg-[#333] px-4 py-2 rounded-md transition-colors text-xs text-textSecondary">
          <Settings size={14} />
          Output Settings
        </button>
      </div>
    </div>
  );
};

export default Toolbar;
