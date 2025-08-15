import React from 'react';
import { useSearchParams } from 'react-router-dom';
import CodeEditor from '../components/CodeEditor';
import MediaControls from '../components/MediaControls';
import CursorComponent from '../components/Cursor';
import Preview from '../components/Preview';
import { useUrlQuery } from '../hooks/useUrlQuery';

const CSS_LESSONS = [
  {
    id: 1,
    title: "Text Shadow",
    scrimUrl: "/lessons/text-shadow.scrimba"
  },
];

interface LessonsPanelProps {
  lessons: typeof CSS_LESSONS;
  currentLessonId?: number;
  onLessonSelect: (lesson: typeof CSS_LESSONS[0]) => void;
}

const LessonsPanel: React.FC<LessonsPanelProps> = ({ lessons, currentLessonId, onLessonSelect }) => {
  return (
    <div className="w-80 bg-gray-800 border-l border-gray-700 flex flex-col">
      <div className="p-4 border-b border-gray-700">
        <h2 className="text-lg font-semibold text-white">CSS Course Lessons</h2>
      </div>
      <div className="flex-1 overflow-y-auto">
        {lessons.map((lesson) => (
          <div
            key={lesson.id}
            onClick={() => onLessonSelect(lesson)}
            className={`p-4 border-b border-gray-700 cursor-pointer hover:bg-gray-700 transition-colors ${currentLessonId === lesson.id ? 'bg-blue-600 hover:bg-blue-700' : ''
              }`}
          >
            <h3 className="text-sm font-medium text-white">{lesson.title}</h3>
            <p className="text-xs text-gray-400 mt-1">{lesson.scrimUrl}</p>
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
  const currentLessonId = CSS_LESSONS.find(lesson => lesson.scrimUrl === currentScrimUrl)?.id;

  const handleLessonSelect = (lesson: typeof CSS_LESSONS[0]) => {
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