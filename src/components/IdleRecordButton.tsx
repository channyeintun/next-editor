import { memo, useId } from 'react';
import { motion } from 'motion/react';
import { Circle } from 'lucide-react';

const IdleRecordButton = memo(function IdleRecordButton() {
  const corgiId = useId().replace(/:/g, '');
  const furGradientId = `${corgiId}-fur`;
  const creamGradientId = `${corgiId}-cream`;
  const backGradientId = `${corgiId}-back`;

  return (
    <div className="relative flex items-center justify-center overflow-visible size-6">
      <motion.svg
        aria-hidden="true"
        viewBox="0 0 34 32"
        className="pointer-events-none absolute -left-2.5 -top-1 z-0 overflow-visible size-8"
        animate={{
          x: [-9, -2, -3, -9],
          y: [6, -1, 0, 6],
          rotate: [-9, 2, 0, -9],
          scale: [0.95, 1.02, 1, 0.95],
        }}
        transition={{
          duration: 3.2,
          delay: 0.5,
          ease: [0.77, 0, 0.175, 1],
          repeat: Infinity,
        }}
      >
        <defs>
          <linearGradient id={furGradientId} x1="9" y1="7" x2="24" y2="28" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#ffd7a0" />
            <stop offset="55%" stopColor="#efab5a" />
            <stop offset="100%" stopColor="#bf6c2f" />
          </linearGradient>
          <linearGradient id={creamGradientId} x1="12" y1="13" x2="23" y2="28" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#fffaf2" />
            <stop offset="100%" stopColor="#f2e2c7" />
          </linearGradient>
          <linearGradient id={backGradientId} x1="2" y1="16" x2="15" y2="27" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#c97335" />
            <stop offset="100%" stopColor="#8d4c23" />
          </linearGradient>
        </defs>

        <motion.g
          style={{ transformBox: 'fill-box', transformOrigin: 'left center' }}
          animate={{
            rotate: [10, 18, 10],
            y: [0, -0.4, 0],
          }}
          transition={{
            duration: 2,
            ease: 'easeInOut',
            repeat: Infinity,
          }}
        >
          <path
            d="M3.4 23.6c1.7-2.2 4.2-3.4 6.5-3.4 1.1 0 1.8.2 2.6.7-2 .8-3.5 2.3-4.5 4.3-.8.2-1.5.3-2.2.3-1 0-1.8-.7-2.4-1.9Z"
            fill={`url(#${backGradientId})`}
            opacity="0.95"
          />
          <path
            d="M2.9 23.6c.9-1.1 2.1-1.8 3.4-2.1-.3.7-.4 1.4-.4 2.2 0 .6.1 1.1.2 1.6-1.3-.1-2.3-.6-3.2-1.7Z"
            fill="#fff8ea"
          />
        </motion.g>
        <path
          d="M5.9 24.8c1.3-4.5 4.6-7.2 9.2-7.2h3.2c-1.8 1.3-3 3.2-3.3 5.4-.2 1.3.1 2.6.7 3.8h-2.2c-4.1 0-6.5-.4-7.6-2Z"
          fill={`url(#${backGradientId})`}
          opacity="0.95"
        />
        <motion.g
          style={{ transformBox: 'fill-box', transformOrigin: 'center bottom' }}
          animate={{
            y: [0, -0.6, 0],
            scaleY: [1, 1.04, 1],
            rotate: [-2, 2, -2],
          }}
          transition={{
            duration: 2.4,
            ease: 'easeInOut',
            repeat: Infinity,
          }}
        >
          <path
            d="M9.1 14.2 10.9 5.5 16.7 12.8c-2.1.7-4.6 1.2-7.6 1.4Z"
            fill={`url(#${furGradientId})`}
          />
          <path
            d="M16.9 12.8 22.7 5.5 24.5 14.2c-3-.2-5.5-.7-7.6-1.4Z"
            fill={`url(#${furGradientId})`}
          />
          <path d="M11.4 12.3 12.8 8.7 14.8 11.4Z" fill="#fffaf2" />
          <path d="M18.8 11.4 20.8 8.7 22.2 12.3Z" fill="#fffaf2" />
        </motion.g>
        <path
          d="M7.4 20.9c0-6 4.4-10.8 9.8-10.8S27 14.9 27 20.9c0 4.2-3.4 7.4-7.5 7.4h-4.6c-4.1 0-7.5-3.2-7.5-7.4Z"
          fill={`url(#${furGradientId})`}
        />
        <path d="M6.3 25.5c.8.3 1.7.5 2.7.5h5.5" fill="none" opacity="0.28" stroke="#fff1dd" strokeLinecap="round" strokeWidth="1.1" />
        <path d="M12.4 15c1.4-1.3 3.1-1.9 4.9-1.9 1.9 0 3.7.7 5.1 2.1" fill="none" opacity="0.4" stroke="#fff4dd" strokeLinecap="round" strokeWidth="1.3" />
        <path
          d="M10.6 19.1c1.1-3.1 3.9-4.9 6.7-4.9s5.6 1.8 6.7 4.9c.8 2.4-.8 5.1-3.5 6.3-1.6.7-3.4 1-5.2.8-2.3-.3-4.4-1.4-5.1-3.6-.4-1-.3-2.2.4-3.5Z"
          fill={`url(#${creamGradientId})`}
        />
        <path
          d="M14.7 12.2h5.1l-1.1 4.5h-2.9l-1.1-4.5Z"
          fill="#fff8ef"
          opacity="0.97"
        />
        <path d="M11.8 18.3c1.2-.9 2.6-1.4 4.2-1.4" fill="none" opacity="0.15" stroke="#6e3f1b" strokeLinecap="round" strokeWidth="1.15" />
        <path d="M22.8 18.3c-1.2-.9-2.6-1.4-4.2-1.4" fill="none" opacity="0.15" stroke="#6e3f1b" strokeLinecap="round" strokeWidth="1.15" />
        <circle cx="12.7" cy="21.6" r="1.2" fill="#f6b1ab" opacity="0.9" />
        <circle cx="21.9" cy="21.6" r="1.2" fill="#f6b1ab" opacity="0.9" />
        <motion.rect
          x="14.1"
          y="18.2"
          width="1.6"
          height="2"
          rx="0.8"
          fill="#1f2937"
          style={{ transformBox: 'fill-box', transformOrigin: 'center center' }}
          animate={{ scaleY: [1, 1, 0.62, 1, 1] }}
          transition={{
            duration: 3.04,
            ease: 'easeInOut',
            times: [0, 0.33, 0.38, 0.42, 1],
            repeat: Infinity,
          }}
        />
        <motion.rect
          x="18.9"
          y="18.2"
          width="1.6"
          height="2"
          rx="0.8"
          fill="#1f2937"
          style={{ transformBox: 'fill-box', transformOrigin: 'center center' }}
          animate={{ scaleY: [1, 1, 0.62, 1, 1] }}
          transition={{
            duration: 3.04,
            ease: 'easeInOut',
            times: [0, 0.33, 0.38, 0.42, 1],
            repeat: Infinity,
          }}
        />
        <path d="M15 19.1c.8-.7 1.7-1 2.7-1s2 .3 2.7 1" fill="none" opacity="0.22" stroke="#6e3f1b" strokeLinecap="round" strokeWidth="1.15" />
        <path d="M15.8 21.2c.2-.8.9-1.3 1.8-1.3.8 0 1.6.5 1.9 1.3-.2 1-.9 1.6-1.9 1.6-.9 0-1.7-.6-1.8-1.6Z" fill="#2b1e1a" />
        <path d="M17.7 22.6v1" fill="none" stroke="#2b1e1a" strokeLinecap="round" strokeWidth="0.95" />
        <path d="M16.2 23.7c.4.5 1 .8 1.5.8.6 0 1.1-.3 1.6-.8" fill="none" stroke="#2b1e1a" strokeLinecap="round" strokeWidth="0.95" />
        <path d="M11.5 23.1c-.9.3-1.8.8-2.4 1.6" fill="none" opacity="0.55" stroke="#fff7ea" strokeLinecap="round" strokeWidth="0.95" />
        <path d="M23.9 23.1c.9.3 1.8.8 2.4 1.6" fill="none" opacity="0.55" stroke="#fff7ea" strokeLinecap="round" strokeWidth="0.95" />
        <ellipse cx="7.8" cy="26.4" rx="1.3" ry="0.9" fill="#f5e7d0" opacity="0.95" />
        <ellipse cx="10.4" cy="26.6" rx="1.35" ry="0.95" fill="#f5e7d0" opacity="0.95" />
        <ellipse cx="14.1" cy="26.6" rx="2.4" ry="1.4" fill="#fff8ea" opacity="0.98" />
        <ellipse cx="21.3" cy="26.6" rx="2.4" ry="1.4" fill="#fff8ea" opacity="0.98" />
      </motion.svg>

      <Circle size={14} className="relative z-10 fill-red-500 text-red-500 drop-shadow-sm" />
    </div>
  );
});

export default IdleRecordButton;