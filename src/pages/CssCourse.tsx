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
}

const LessonsPanel: React.FC<LessonsPanelProps> = ({ lessons, currentLessonId, onLessonSelect }) => {
  const [expandedGroups, setExpandedGroups] = React.useState<string[]>(['Introduction']);

  const toggleGroup = (groupTitle: string) => {
    setExpandedGroups(prev => 
      prev.includes(groupTitle) 
        ? prev.filter(g => g !== groupTitle)
        : [...prev, groupTitle]
    );
  };

  return (
    <div className="w-80 bg-slate-900 border-l border-slate-700 flex flex-col shadow-xl">
      <div className="p-4 border-b border-slate-700 bg-gradient-to-r from-slate-800 to-slate-900">
        <h2 className="text-lg font-semibold text-white">CSS Course Lessons</h2>
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
                    onClick={() => onLessonSelect(lesson)}
                    className={`pl-8 pr-4 py-3 border-b border-slate-700 cursor-pointer hover:bg-slate-800 focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-inset text-slate-100 transition-all duration-200 group ${
                      currentLessonId === lesson.id ? 'bg-gradient-to-r from-indigo-900 to-indigo-800 hover:from-indigo-800 hover:to-indigo-700 border-l-4 border-l-indigo-400' : ''
                    }`}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onLessonSelect(lesson);
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
  );
};

const CssCourse: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isLoading } = useUrlQuery();
  const currentScrimUrl = searchParams.get('scrimUrl');
  
  // Find current lesson across all groups
  const currentLessonId = CSS_LESSONS
    .flatMap(group => group.lessons)
    .find(lesson => lesson.scrimUrl === currentScrimUrl)?.id;

  const handleLessonSelect = (lesson: Lesson) => {
    setSearchParams({ scrimUrl: lesson.scrimUrl });
  };

  return (
    <div className='flex'>
      <div className="flex-grow-1 w-auto h-screen bg-slate-900 text-slate-100 relative">
        <div className="bg-slate-800">
          <CodeEditor showImportExport={false} />
        </div>
        <Preview positioning="absolute"  />
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
      />
    </div>
  );
};

export default CssCourse;