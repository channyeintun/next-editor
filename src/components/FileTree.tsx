import React, { useState } from 'react';
import { File, FilePlus, Trash2, ChevronDown, Edit2 } from 'lucide-react';
import { useNextEditorContext } from '../hooks/useNextEditorContext';

interface FileTreeProps {
    className?: string;
}

const FileTree: React.FC<FileTreeProps> = ({ className = '' }) => {
    const {
        files,
        activeFile,
        switchFile,
        addFile,
        deleteFile,
        renameFile,
        isRecording,
        isPlaying
    } = useNextEditorContext();

    const [isNewFileFocused, setIsNewFileFocused] = useState(false);
    const [newFileName, setNewFileName] = useState('');
    const [renamingPath, setRenamingPath] = useState<string | null>(null);
    const [newName, setNewName] = useState('');

    const handleAddFile = () => {
        if (newFileName && !files[newFileName]) {
            addFile(newFileName, '');
            setNewFileName('');
            setIsNewFileFocused(false);
        }
    };

    const handleDeleteFile = (e: React.MouseEvent, path: string) => {
        e.stopPropagation();
        if (Object.keys(files).length > 1) {
            deleteFile(path);
        }
    };

    const startRenaming = (e: React.MouseEvent, path: string) => {
        e.stopPropagation();
        setRenamingPath(path);
        setNewName(path);
    };

    const handleRename = () => {
        if (renamingPath && newName && newName !== renamingPath && !files[newName]) {
            renameFile(renamingPath, newName);
        }
        setRenamingPath(null);
        setNewName('');
    };

    const fileList = Object.keys(files).sort();

    return (
        <div className={`flex flex-col bg-slate-900 border-r border-slate-800 ${className}`} style={{ width: '240px' }}>
            <div className="p-3 flex items-center justify-between border-b border-slate-800">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Explorer</span>
                <div className="flex gap-1">
                    <button
                        onClick={() => setIsNewFileFocused(true)}
                        className="p-1 hover:bg-slate-800 rounded text-slate-400 hover:text-white transition-colors"
                        title="New File"
                    >
                        <FilePlus size={14} />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto py-2">
                <div className="flex items-center px-3 py-1 text-slate-300 font-medium text-sm">
                    <ChevronDown size={14} className="mr-1" />
                    <span>Files</span>
                </div>

                <div className="mt-1">
                    {fileList.map((path) => (
                        <div key={path}>
                            {renamingPath === path ? (
                                <div className="px-3 py-1">
                                    <div className="flex items-center bg-slate-800 rounded px-2 py-1 border border-indigo-500">
                                        <File size={14} className="mr-2 text-indigo-400" />
                                        <input
                                            autoFocus
                                            type="text"
                                            value={newName}
                                            onChange={(e) => setNewName(e.target.value)}
                                            onBlur={handleRename}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter') handleRename();
                                                if (e.key === 'Escape') setRenamingPath(null);
                                            }}
                                            className="bg-transparent border-none outline-none text-sm text-slate-200 w-full"
                                        />
                                    </div>
                                </div>
                            ) : (
                                <div
                                    onClick={() => switchFile(path)}
                                    onDoubleClick={(e) => startRenaming(e, path)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            startRenaming(e as unknown as React.MouseEvent, path);
                                        }
                                    }}
                                    tabIndex={0}
                                    className={`group flex items-center px-3 py-1 cursor-pointer transition-colors outline-none focus:bg-slate-800 ${activeFile === path ? 'bg-indigo-600/30 text-indigo-300' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                                        }`}
                                >
                                    <File size={14} className="mr-2" />
                                    <span className="flex-1 text-sm truncate">{path}</span>
                                    <div className="flex opacity-0 group-hover:opacity-100 transition-all">
                                        <button
                                            onClick={(e) => startRenaming(e, path)}
                                            className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white mr-1"
                                            title="Rename File"
                                        >
                                            <Edit2 size={12} />
                                        </button>
                                        <button
                                            onClick={(e) => handleDeleteFile(e, path)}
                                            className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-red-400"
                                            title="Delete File"
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {isNewFileFocused && (
                    <div className="px-3 py-1">
                        <div className="flex items-center bg-slate-800 rounded px-2 py-1 border border-indigo-500">
                            <File size={14} className="mr-2 text-indigo-400" />
                            <input
                                autoFocus
                                type="text"
                                value={newFileName}
                                onChange={(e) => setNewFileName(e.target.value)}
                                onBlur={handleAddFile}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddFile();
                                    if (e.key === 'Escape') setIsNewFileFocused(false);
                                }}
                                className="bg-transparent border-none outline-none text-sm text-slate-200 w-full"
                                placeholder="file.html"
                            />
                        </div>
                    </div>
                )}
            </div>

            {(isRecording || isPlaying) && (
                <div className="p-2 border-t border-slate-800">
                    <div className={`text-[10px] uppercase font-bold px-2 py-1 rounded text-center ${isRecording ? 'bg-red-500/20 text-red-400' : 'bg-indigo-500/20 text-indigo-400'
                        }`}>
                        {isRecording ? 'Recording Session' : 'Playback Mode'}
                    </div>
                </div>
            )}
        </div>
    );
};

export default FileTree;
