import React from 'react';
import { useSearchParams } from 'react-router-dom';
import CodeEditor from '../components/CodeEditor';
import MediaControls from '../components/MediaControls';
import CursorComponent from '../components/Cursor';
import Preview from '../components/Preview';
import { useUrlQuery } from '../hooks/useUrlQuery';

const CSS_LESSONS = [
  {
    groupTitle: "Shadows",
    lessons: [
      {
        id: 1,
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
    <div className="w-80 bg-gray-850 border-l border-gray-700 flex flex-col" style={{ backgroundColor: '#1e293b' }}>
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-lg font-semibold text-white">CSS Course Lessons</h2>
      </div>
      <div className="flex-1 overflow-y-auto">
        {lessons.map((group) => (
          <div key={group.groupTitle}>
            {/* Group Header */}
            <div
              onClick={() => toggleGroup(group.groupTitle)}
              className="p-4 border-b border-gray-700 cursor-pointer hover:bg-gray-700 transition-colors flex items-center justify-between"
            >
              <h3 className="text-sm font-semibold text-white">{group.groupTitle}</h3>
              <div className={`transform transition-transform ${expandedGroups.includes(group.groupTitle) ? 'rotate-90' : ''}`}>
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    className={`pl-8 pr-4 py-3 border-b border-gray-700 cursor-pointer hover:bg-gray-700 transition-colors ${
                      currentLessonId === lesson.id ? 'bg-blue-600 hover:bg-blue-700' : ''
                    }`}
                  >
                    <h4 className="text-sm font-medium text-white">{lesson.title}</h4>
                    <p className="text-xs text-gray-400 mt-1">{lesson.scrimUrl}</p>
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
      <div className="flex-grow-1 w-auto h-screen bg-gray-900 text-white relative">
        <div className="bg-gray-800">
          <CodeEditor />
        </div>
        <Preview positioning="absolute" />
        <CursorComponent />
        <MediaControls showRecord={false} positioning="absolute" />
        
        {/* Loading overlay */}
        <div className={`absolute inset-0 bg-gray-900/80 flex items-center justify-center z-50 transition-opacity duration-300 ${isLoading ? 'opacity-100 delay-300' : 'opacity-0 pointer-events-none'}`}>
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <p className="text-white text-lg">Loading lesson...</p>
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