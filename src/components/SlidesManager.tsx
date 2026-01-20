import { useState, useCallback } from 'react';
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Edit3,
  Play,
  X,
  Code,
  FileText,
  Save,
  RotateCcw,
  Monitor
} from 'lucide-react';
import type { Slide, SlideContentType } from '../types/slides';

interface SlidesManagerProps {
  slides: Slide[];
  onSlidesChange: (slides: Slide[]) => void;
  onStartPresentation?: () => void;
  onClose?: () => void;
}

const DEFAULT_HTML_CONTENT = `<h1>Welcome</h1>
<p>Your slide content here</p>`;

const DEFAULT_MARKDOWN_CONTENT = `# Welcome

Your slide content here`;

export default function SlidesManager({ slides, onSlidesChange, onStartPresentation, onClose }: SlidesManagerProps) {
  const [newSlideContent, setNewSlideContent] = useState('');
  const [contentType, setContentType] = useState<SlideContentType>('markdown');
  const [editingSlideId, setEditingSlideId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');

  const addSlide = useCallback(() => {
    const content = newSlideContent.trim() || (contentType === 'html' ? DEFAULT_HTML_CONTENT : DEFAULT_MARKDOWN_CONTENT);

    const newSlide: Slide = {
      id: Date.now().toString(),
      content,
      contentType,
      order: slides.length,
    };

    onSlidesChange([...slides, newSlide]);
    setNewSlideContent('');
  }, [newSlideContent, contentType, slides, onSlidesChange]);

  const removeSlide = useCallback((slideId: string) => {
    const updatedSlides = slides
      .filter(slide => slide.id !== slideId)
      .map((slide, index) => ({ ...slide, order: index }));
    onSlidesChange(updatedSlides);
  }, [slides, onSlidesChange]);

  const moveSlide = useCallback((slideId: string, direction: 'up' | 'down') => {
    const slideIndex = slides.findIndex(slide => slide.id === slideId);
    if (slideIndex === -1) return;

    const newIndex = direction === 'up' ? slideIndex - 1 : slideIndex + 1;
    if (newIndex < 0 || newIndex >= slides.length) return;

    const updatedSlides = [...slides];
    [updatedSlides[slideIndex], updatedSlides[newIndex]] = [updatedSlides[newIndex], updatedSlides[slideIndex]];

    // Update order numbers
    updatedSlides.forEach((slide, index) => {
      slide.order = index;
    });

    onSlidesChange(updatedSlides);
  }, [slides, onSlidesChange]);

  const startEditing = useCallback((slide: Slide) => {
    setEditingSlideId(slide.id);
    setEditContent(slide.content);
  }, []);

  const saveEdit = useCallback(() => {
    if (!editingSlideId) return;

    const updatedSlides = slides.map(slide =>
      slide.id === editingSlideId
        ? { ...slide, content: editContent }
        : slide
    );
    onSlidesChange(updatedSlides);
    setEditingSlideId(null);
    setEditContent('');
  }, [editingSlideId, editContent, slides, onSlidesChange]);

  const cancelEdit = useCallback(() => {
    setEditingSlideId(null);
    setEditContent('');
  }, []);

  const getPreviewText = (content: string): string => {
    // Extract first meaningful line for preview
    const lines = content.split('\n').filter(line => line.trim());
    const firstLine = lines[0] || 'Empty slide';
    // Strip HTML/Markdown formatting for preview
    return firstLine
      .replace(/<[^>]*>/g, '')
      .replace(/^#+\s*/, '')
      .substring(0, 40) + (firstLine.length > 40 ? '...' : '');
  };

  return (
    <div className="flex flex-col bg-slate-900/95 backdrop-blur-xl rounded-2xl border border-slate-700/50 w-full sm:w-[420px] max-h-[calc(100dvh-120px)] sm:max-h-[600px] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-gradient-to-r from-slate-900 via-slate-800/50 to-slate-900">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30">
            <Monitor className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 tracking-tight">Presentation Slides</h3>
            <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">Reveal.js Powered</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-full text-slate-400 hover:text-white hover:bg-white/10 transition-all duration-200"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
        {/* Add Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between p-1 bg-slate-800/80 rounded-xl border border-white/5">
            <button
              onClick={() => setContentType('markdown')}
              className={`flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-xs font-medium transition-all duration-300 ${contentType === 'markdown'
                ? 'bg-indigo-500 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200'
                }`}
            >
              <FileText className="w-3.5 h-3.5" />
              Markdown
            </button>
            <button
              onClick={() => setContentType('html')}
              className={`flex-1 flex items-center justify-center gap-2 py-1.5 px-3 rounded-lg text-xs font-medium transition-all duration-300 ${contentType === 'html'
                ? 'bg-indigo-500 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200'
                }`}
            >
              <Code className="w-3.5 h-3.5" />
              HTML
            </button>
          </div>

          <div className="relative group">
            <textarea
              value={newSlideContent}
              onChange={(e) => setNewSlideContent(e.target.value)}
              placeholder={contentType === 'html'
                ? '<h1>Title</h1>\n<p>Content</p>'
                : '# Title\n\nContent here...'}
              className="w-full h-32 px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-xl text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 font-mono resize-none transition-all duration-300"
            />
          </div>

          <button
            onClick={addSlide}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all duration-300 shadow-md active:scale-[0.98]"
          >
            <Plus className="w-4 h-4" />
            Create Slide
          </button>
        </div>

        {/* List Section */}
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Your Presentation</h4>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-white/5">
              {slides.length} {slides.length === 1 ? 'slide' : 'slides'}
            </span>
          </div>

          {slides.length === 0 ? (
            <div className="bg-slate-800/30 border border-dashed border-slate-700/50 rounded-2xl py-10 px-6 text-center">
              <div className="w-12 h-12 bg-slate-800 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-white/5">
                <Monitor className="w-6 h-6 text-slate-600" />
              </div>
              <p className="text-slate-400 text-xs font-medium leading-relaxed">
                Your presentation deck is empty.<br />
                Craft your first slide above.
              </p>
            </div>
          ) : (
            <div className="space-y-3 pb-4">
              {slides.map((slide, index) => (
                <div
                  key={slide.id}
                  className="group relative overflow-hidden bg-slate-800/50 border border-white/5 rounded-2xl p-4 transition-all duration-300 hover:bg-slate-800/80 hover:border-slate-600/50"
                >
                  {editingSlideId === slide.id ? (
                    <div className="space-y-3">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="w-full h-32 px-3 py-2 bg-slate-900/50 border border-slate-700 rounded-xl text-xs text-slate-200 font-mono resize-none focus:outline-none focus:border-indigo-500/50"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={saveEdit}
                          className="flex-1 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all"
                        >
                          <Save className="w-3 h-3" />
                          Update
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg text-xs font-medium transition-all"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4">
                      {/* Left: Thumbnail area */}
                      <div
                        className="relative w-14 h-11 flex-shrink-0 bg-slate-900 rounded-lg border border-white/5 overflow-hidden group/thumb cursor-pointer hover:ring-2 hover:ring-indigo-500/50 transition-all"
                        onClick={() => startEditing(slide)}
                      >
                        <div className="absolute inset-0 flex items-center justify-center">
                          {slide.contentType === 'html' ? (
                            <Code className="w-4 h-4 text-indigo-400/40" />
                          ) : (
                            <FileText className="w-4 h-4 text-emerald-400/40" />
                          )}
                        </div>
                        <div className="absolute top-0 right-0 px-1 py-0.5 bg-indigo-500/10 text-[6px] font-bold text-indigo-300 uppercase leading-none border-b border-l border-white/5">
                          {slide.contentType}
                        </div>
                        <div className="absolute inset-0 bg-indigo-600/20 opacity-0 group-hover/thumb:opacity-100 flex items-center justify-center transition-opacity py-1">
                          <Edit3 className="w-3 h-3 text-white" />
                        </div>
                      </div>

                      {/* Center: Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-bold text-slate-500">#{index + 1}</span>
                          <span className="h-px flex-1 bg-white/5"></span>
                        </div>
                        <p className="text-xs font-bold text-slate-200 truncate group-hover:text-indigo-400 transition-colors">
                          {getPreviewText(slide.content)}
                        </p>
                      </div>

                      {/* Right: Actions */}
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => moveSlide(slide.id, 'up')}
                          disabled={index === 0}
                          className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg disabled:opacity-0 transition-all"
                          title="Move Up"
                        >
                          <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => moveSlide(slide.id, 'down')}
                          disabled={index === slides.length - 1}
                          className="p-1.5 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg disabled:opacity-0 transition-all"
                          title="Move Down"
                        >
                          <ChevronDown className="w-3.5 h-3.5" />
                        </button>
                        <div className="w-px h-4 bg-white/5 mx-1"></div>
                        <button
                          onClick={() => removeSlide(slide.id)}
                          className="p-1.5 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition-all"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer / CTA */}
      <div className="p-5 bg-slate-900 border-t border-white/5">
        <button
          onClick={onStartPresentation}
          disabled={slides.length === 0}
          className="group w-full py-4 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed text-white rounded-2xl text-sm font-black flex items-center justify-center gap-3 transition-all duration-500 shadow-lg active:scale-[0.98]"
        >
          <Play className="w-5 h-5 fill-current group-enabled:group-hover:translate-x-0.5 transition-transform" />
          START PRESENTATION
        </button>
      </div>

      <style dangerouslySetInnerHTML={{
        __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}} />
    </div>
  );
}