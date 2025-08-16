import React from 'react';
import { useSearchParams } from 'react-router-dom';
import CodeEditor from '../components/CodeEditor';
import MediaControls from '../components/MediaControls';
import CursorComponent from '../components/Cursor';
import Preview from '../components/Preview';
import { useUrlQuery } from '../hooks/useUrlQuery';

const CSS_LESSONS = [
  {
    groupTitle: "Box Model",
    lessons: [
      {
        id: 1,
        title: "Introduction to the Box Model",
        scrimUrl: "/lessons/introduction-to-box-model.scrimba"
      },
      {
        id: 2,
        title: "Content and Sizing",
        scrimUrl: "/lessons/content-and-sizing.scrimba"
      },
       {
        id: 3,
        title: "The Areas of the Box Model",
        scrimUrl: "/lessons/the-areas-of-the-box-model.scrimba"
      },
      {
        id: 4,
        title: "Debug the Box Model",
        scrimUrl: "/lessons/debug-the-box-model.scrimba"
      },
    ]
  },
  {
    groupTitle: "Shadows",
    lessons: [
      {
        id: 6,
        title: "Text Shadow",
        scrimUrl: "/lessons/text-shadow.scrimba"
      },
    ]
  },
];

type Lesson = {
  id: number;
  title: string;
  scrimUrl: string;
};

interface LessonsPanelProps {
  lessons: typeof CSS_LESSONS;
  currentLessonId?: number;
  onLessonSelect: (lesson: Lesson) => void;
  isOpen: boolean;
  onClose: () => void;
}

const LessonsPanel: React.FC<LessonsPanelProps> = ({ lessons, currentLessonId, onLessonSelect, isOpen, onClose }) => {
  const [expandedGroups, setExpandedGroups] = React.useState<string[]>(['Box Model']);

  const toggleGroup = (groupTitle: string) => {
    setExpandedGroups(prev => 
      prev.includes(groupTitle) 
        ? prev.filter(g => g !== groupTitle)
        : [...prev, groupTitle]
    );
  };

  const handleLessonClick = (lesson: Lesson) => {
    onLessonSelect(lesson);
    // Close panel on mobile after selecting a lesson
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={onClose}
        />
      )}
      
      {/* Panel */}
      <div className={`
        fixed md:relative top-0 right-0 h-full z-50 md:z-auto
        w-80 md:w-80 lg:w-96
        bg-slate-900 border-l border-slate-700 flex flex-col shadow-xl
        transform transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}
      `}>
      <div className="p-4 border-b border-slate-700 bg-gradient-to-r from-slate-800 to-slate-900 flex justify-between items-center">
        <h2 className="text-lg font-semibold text-white">CSS Course Lessons</h2>
        {/* Close button for mobile */}
        <button
          onClick={onClose}
          className="md:hidden p-1 rounded-lg hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
          aria-label="Close lessons panel"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto bg-slate-900">
        {lessons.map((group) => (
          <div key={group.groupTitle}>
            {/* Group Header */}
            <div
              onClick={() => toggleGroup(group.groupTitle)}
              className="p-4 border-b border-slate-700 cursor-pointer hover:bg-slate-800 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-inset text-slate-100 transition-all duration-200 flex items-center justify-between group"
              tabIndex={0}
              role="button"
              aria-expanded={expandedGroups.includes(group.groupTitle)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleGroup(group.groupTitle);
                }
              }}
            >
              <h3 className="text-sm font-semibold group-hover:text-indigo-300 transition-colors">{group.groupTitle}</h3>
              <div className={`transform transition-transform duration-200 ${expandedGroups.includes(group.groupTitle) ? 'rotate-90' : ''}`}>
                <svg className="w-4 h-4 text-slate-400 group-hover:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </div>
            </div>
            
            {/* Group Lessons */}
            {expandedGroups.includes(group.groupTitle) && (
              <div>
                {group.lessons.map((lesson) => (
                  <div
                    key={lesson.id}
                    onClick={() => handleLessonClick(lesson)}
                    className={`pl-8 pr-4 py-3 border-b border-slate-700 cursor-pointer hover:bg-slate-800 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-inset text-slate-100 transition-all duration-200 group ${
                      currentLessonId === lesson.id ? 'bg-gradient-to-r from-indigo-900 to-indigo-800 hover:from-indigo-800 hover:to-indigo-700 border-l-4 border-l-indigo-400' : ''
                    }`}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleLessonClick(lesson);
                      }
                    }}
                  >
                    <h4 className={`text-sm font-medium group-hover:text-indigo-300 transition-colors ${
                      currentLessonId === lesson.id ? 'text-indigo-200' : ''
                    }`}>{lesson.title}</h4>
                    <p className={`text-xs mt-1 transition-colors ${
                      currentLessonId === lesson.id ? 'text-indigo-400' : 'text-slate-400'
                    }`}>{lesson.scrimUrl}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
    </>
  );
};

const CssCourse: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isLoading } = useUrlQuery();
  const [isLessonsPanelOpen, setIsLessonsPanelOpen] = React.useState(false);
  const currentScrimUrl = searchParams.get('scrimUrl');
  
  // Find current lesson across all groups
  const currentLessonId = CSS_LESSONS
    .flatMap(group => group.lessons)
    .find(lesson => lesson.scrimUrl === currentScrimUrl)?.id;

  const handleLessonSelect = (lesson: Lesson) => {
    setSearchParams({ scrimUrl: lesson.scrimUrl });
  };

  const toggleLessonsPanel = () => {
    setIsLessonsPanelOpen(prev => !prev);
  };

  return (
    <div className='flex h-svh overflow-auto'>
      <div className="flex-1 bg-slate-900 text-slate-100 relative">
        {/* Mobile lessons toggle button */}
        <button
          onClick={toggleLessonsPanel}
          className="md:hidden fixed top-4 right-4 z-30 p-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-lg transition-colors"
          aria-label="Toggle lessons panel"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        <div className="bg-slate-800 h-full">
          <CodeEditor  
            defaultContent={`<html>
  <h1>Based on web.dev's CSS course.</h1>
  <img src="./web-dev-css.webp" width="100%" style="object-fit: contain;" />
</html>
              `}
            showImportExport={false} />
        </div>
        <Preview positioning="absolute" />
        <CursorComponent hasParent />
        <MediaControls showRecord={false} positioning="absolute" />
        
        {/* Loading overlay */}
        <div className={`absolute inset-0 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center z-50 transition-opacity duration-300 ${isLoading ? 'opacity-100 delay-300' : 'opacity-0 pointer-events-none'}`}>
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500 mx-auto mb-4"></div>
            <p className="text-slate-100 text-lg">Loading lesson...</p>
          </div>
        </div>
      </div>
      
      <LessonsPanel
        lessons={CSS_LESSONS}
        currentLessonId={currentLessonId}
        onLessonSelect={handleLessonSelect}
        isOpen={isLessonsPanelOpen}
        onClose={() => setIsLessonsPanelOpen(false)}
      />
    </div>
  );
};

export default CssCourse;