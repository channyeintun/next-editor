import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import Navbar from './Navbar';
import { useState, useEffect } from 'react';

const TerminalMockup = () => {
    const codeSegments = [
        { text: "<html>", color: "#e9e19b" },
        { text: "\n  ", color: "#e9e19b" },
        { text: "<h1>", color: "#e9e19b" },
        { text: "Hello world", color: "#fff" },
        { text: "</h1>", color: "#e9e19b" },
        { text: "\n", color: "#e9e19b" },
        { text: "</html>", color: "#e9e19b" }
    ];

    const [visibleChars, setVisibleChars] = useState(0);
    const totalLength = codeSegments.reduce((acc, s) => acc + s.text.length, 0);

    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;
        const timer = setTimeout(() => {
            interval = setInterval(() => {
                setVisibleChars(prev => {
                    if (prev >= totalLength) {
                        clearInterval(interval);
                        return prev;
                    }
                    return prev + 1;
                });
            }, 50);
        }, 1000);
        return () => {
            clearTimeout(timer);
            if (interval) clearInterval(interval);
        };
    }, [totalLength]);

    const renderedSegments = [];
    let remaining = visibleChars;

    for (let i = 0; i < codeSegments.length; i++) {
        if (remaining <= 0) break;
        const segment = codeSegments[i];
        const textToShow = segment.text.slice(0, remaining);
        renderedSegments.push(
            <span key={i} style={{ color: segment.color }}>
                {textToShow}
            </span>
        );
        remaining -= segment.text.length;
    }

    return (
        <div className="font-mono text-sm leading-relaxed min-h-[140px] text-left whitespace-pre">
            {renderedSegments}
            <span className="terminal-caret text-pinata-cyan">▋</span>
        </div>
    );
};

const LandingPage = () => {
    return (
        <div className="min-h-screen bg-[#11141c] text-white overflow-hidden selection:bg-pinata-purple selection:text-white font-telegraf">
            <Navbar />

            {/* Hero Section */}
            <main className="relative pt-32 pb-20 px-6 max-w-7xl mx-auto">
                {/* Background Colorful Blobs */}
                <div className="absolute top-0 left-0 w-full h-full -z-10 overflow-hidden pointer-events-none">
                    <div className="absolute top-[-10%] right-[-5%] w-[350px] h-[350px] md:w-[700px] md:h-[700px] bg-[radial-gradient(circle,hsla(248,100%,67%,0.3)_0%,hsla(248,100%,67%,0)_70%)] rounded-full will-change-transform" />
                    <div className="absolute bottom-[10%] left-[-10%] w-[300px] h-[300px] md:w-[600px] md:h-[600px] bg-[radial-gradient(circle,hsla(174,76%,60%,0.2)_0%,hsla(174,76%,60%,0)_70%)] rounded-full will-change-transform" />
                    <div className="absolute top-[40%] left-[30%] w-[250px] h-[250px] md:w-[500px] md:h-[500px] bg-[radial-gradient(circle,hsla(45,100%,66%,0.1)_0%,hsla(45,100%,66%,0)_70%)] rounded-full will-change-transform" />
                </div>

                <div className="flex flex-col items-center">
                    <motion.div
                        initial={{ opacity: 0, y: 30 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                        className="w-full"
                    >
                        {/* Main Hero Card */}
                        <div className="relative bg-white rounded-[40px] p-8 md:p-16 mb-12 overflow-hidden shadow-2xl">
                            {/* Decorative side shapes */}
                            <div className="absolute -left-16 -top-16 w-32 h-32 bg-pinata-yellow rounded-full z-0 opacity-20" />
                            <div className="absolute -right-20 bottom-10 w-40 h-40 bg-pinata-purple rounded-full z-0 opacity-20" />

                            <div className="relative z-10 flex flex-col md:flex-row items-center gap-12">
                                <div className="flex-1 text-left">
                                    <h1 className="text-5xl md:text-8xl font-machina text-slate-950 leading-[0.9] mb-8 tracking-tight uppercase">
                                        CODE'S <br />
                                        NEXT LEVEL
                                    </h1>

                                    <p className="text-xl md:text-2xl text-slate-600 font-telegraf max-w-xl leading-relaxed mb-10">
                                        The robust HTML, CSS, and JavaScript playground with{' '}
                                        <span className="relative inline-block whitespace-nowrap group-hover:text-slate-950 transition-colors">
                                            built-in recording
                                            <svg className="absolute -bottom-3 left-0 w-[105%] h-5 text-pinata-cyan overflow-visible px-1" viewBox="0 0 200 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                <path
                                                    d="M2 12C40 13 80 13 120 12C160 11 185 9 198 5"
                                                    stroke="currentColor"
                                                    strokeWidth="4"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    className="origin-left animate-[draw_1.3s_cubic-bezier(0.65,0,0.35,1)_forwards] will-change-[stroke-dasharray]"
                                                />
                                                <path
                                                    d="M5 16C50 18 100 18 140 17C170 16 190 14 195 10"
                                                    stroke="currentColor"
                                                    strokeWidth="2.5"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    className="origin-left animate-[draw_1.3s_cubic-bezier(0.65,0,0.35,1)_0.15s_forwards] will-change-[stroke-dasharray]"
                                                    opacity="0.8"
                                                />
                                            </svg>
                                        </span>.
                                        Turn your coding sessions into interactive, shareable presentations.
                                    </p>

                                    <div className="flex flex-wrap gap-4">
                                        <Link
                                            to="/code"
                                            className="px-10 py-4 rounded-full bg-slate-950 text-white text-lg font-semibold hover:scale-105 active:scale-95 transition-all shadow-xl"
                                        >
                                            Start creating
                                        </Link>
                                        <Link
                                            to="/code?url=/introduction.ne"
                                            className="px-10 py-4 rounded-full bg-[#4de5a6] text-slate-950 text-lg font-semibold hover:bg-[#3cd495] transition-all flex items-center gap-2 shadow-xl"
                                        >
                                            <div className="relative">
                                                <svg viewBox="0 0 256 256" className="w-5 h-5 overflow-visible">
                                                    <path
                                                        d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"
                                                        className="fill-[#3b82f6]"
                                                    />
                                                    <defs>
                                                        <linearGradient id="larvaGradient" gradientUnits="userSpaceOnUse">
                                                            <stop offset="0%" stopColor="white" stopOpacity="1" />
                                                            <stop offset="20%" stopColor="white" stopOpacity="0.8" />
                                                            <stop offset="60%" stopColor="white" stopOpacity="0.2" />
                                                            <stop offset="100%" stopColor="white" stopOpacity="0" />
                                                        </linearGradient>
                                                    </defs>
                                                    <g style={{ transform: 'scale(1.2)', transformOrigin: 'center' }}>
                                                        <motion.path
                                                            d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z"
                                                            fill="none"
                                                            stroke="url(#larvaGradient)"
                                                            strokeWidth="12"
                                                            strokeLinecap="round"
                                                            strokeDasharray="100 200"
                                                            animate={{ strokeDashoffset: [-300, 0] }}
                                                            transition={{ duration: 2.5, repeat: Infinity, ease: "linear" }}
                                                            className="will-change-[stroke-dashoffset]"
                                                        />
                                                    </g>
                                                </svg>
                                            </div>
                                            Watch demo
                                        </Link>
                                    </div>
                                </div>

                                {/* Mockup code terminal */}
                                <div className="hidden lg:block w-[400px] shrink-0">
                                    <div className="bg-[#181d24] rounded-3xl p-6 shadow-2xl border border-slate-800 rotate-2 will-change-transform">
                                        <div className="flex gap-1.5 mb-6">
                                            <div className="w-3 h-3 rounded-full bg-[#FF5F56]" />
                                            <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
                                            <div className="w-3 h-3 rounded-full bg-[#27C93F]" />
                                        </div>

                                        <TerminalMockup />

                                        <motion.div
                                            initial={{ opacity: 0, y: 10 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{ delay: 0.2 }}
                                            className="pt-4 mt-4 border-t border-slate-800 flex items-center justify-start"
                                        >
                                            <div className="p-1 rounded-full bg-red-500/10 border border-red-500/20">
                                                <motion.div
                                                    animate={{ opacity: [1, 0.4, 1] }}
                                                    transition={{ duration: 2, repeat: Infinity }}
                                                    className="w-2 h-2 rounded-full bg-red-500 will-change-opacity"
                                                />
                                            </div>
                                        </motion.div>
                                    </div>

                                    {/* Logo floating element */}
                                    <div className="mt-8 flex justify-end pr-8">
                                        <motion.div
                                            animate={{ y: [0, -10, 0] }}
                                            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                                            className="w-32 h-32 relative will-change-transform"
                                        >
                                            <div className="absolute inset-0 bg-[radial-gradient(circle,hsla(248,100%,67%,0.15)_0%,hsla(248,100%,67%,0)_70%)] rounded-3xl" />
                                            <img src="/logo.png" alt="Logo" className="w-full h-full object-contain relative z-10" />
                                        </motion.div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </motion.div>

                    <motion.div
                        initial={{ opacity: 0 }}
                        whileInView={{ opacity: 1 }}
                        viewport={{ once: true }}
                        transition={{ delay: 0.4, duration: 1 }}
                        className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full max-w-6xl mt-12"
                    >
                        {[
                            { title: "Live Playground", desc: "A high-fidelity, live version of CodePen. Prototype and experiment with HTML, CSS, and JS in a distraction-free environment.", color: "#6D57FF", textColor: "white" },
                            {
                                title: "Interactive Slides",
                                desc: (
                                    <>
                                        Powered by <a href="https://revealjs.com/" target="_blank" rel="noopener noreferrer" className="text-pinata-cyan hover:underline decoration-pinata-cyan/30">reveal.js</a>.
                                        Record your coding journey and instantly play it back as a stunning presentation.
                                    </>
                                ),
                                color: "#4DE5D6",
                                textColor: "#020617"
                            },
                            {
                                title: "Unique Portability",
                                desc: "Your code and recordings live in a single .ne file. Host it anywhere and share via URL.",
                                color: "#FFD255",
                                textColor: "#020617"
                            }
                        ].map((feature, i) => (
                            <div key={i} className="bg-[#181d24]/90 border border-slate-800 p-8 rounded-[32px] text-left hover:border-slate-700 transition-colors will-change-[border-color,background-color]">
                                <div
                                    style={{ backgroundColor: feature.color, color: feature.textColor }}
                                    className="w-12 h-12 rounded-2xl mb-6 flex items-center justify-center font-bold text-xl"
                                >
                                    {i + 1}
                                </div>
                                <h3 className="text-2xl font-machina mb-4">{feature.title}</h3>
                                <p className="text-slate-400 leading-relaxed">
                                    {feature.desc}
                                </p>
                            </div>
                        ))}
                    </motion.div>
                </div>
            </main>

            <footer className="border-t border-slate-900 py-12 px-6">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
                    <div className="flex items-center gap-2">
                        <img src="/logo.png" alt="logo" className="w-6 h-6 object-contain" />
                        <span className="font-machina tracking-tight">next-editor</span>
                    </div>
                    <div className="flex flex-col md:flex-row items-center gap-6">
                        <a
                            href="https://github.com/channyeintun"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-slate-500 hover:text-white transition-colors flex items-center gap-1.5 text-sm"
                        >
                            <span>GitHub</span>
                            <span className="font-medium">/channyeintun</span>
                        </a>
                        <p className="text-slate-500 text-sm">© 2026 Next Editor</p>
                    </div>
                </div>
            </footer>
        </div>
    );
};

export default LandingPage;
