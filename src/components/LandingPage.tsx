import { motion } from 'motion/react';
import { Link } from 'react-router-dom';
import Navbar from './Navbar';
import { useState, useEffect } from 'react';

const TerminalMockup = () => {
    const codeSegments = [
        { text: "<html>", color: "#6D57FF" },
        { text: "\n  ", color: "#6D57FF" },
        { text: "<h1>", color: "#4DE5D6" },
        { text: "Hello world", color: "#fff" },
        { text: "</h1>", color: "#4DE5D6" },
        { text: "\n", color: "#6D57FF" },
        { text: "</html>", color: "#6D57FF" }
    ];

    const [visibleChars, setVisibleChars] = useState(0);
    const totalLength = codeSegments.reduce((acc, s) => acc + s.text.length, 0);

    useEffect(() => {
        const timer = setTimeout(() => {
            const interval = setInterval(() => {
                setVisibleChars(prev => {
                    if (prev >= totalLength) {
                        clearInterval(interval);
                        return prev;
                    }
                    return prev + 1;
                });
            }, 50);
            return () => clearInterval(interval);
        }, 1000);
        return () => clearTimeout(timer);
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
        <div className="min-h-screen bg-slate-950 text-white overflow-hidden selection:bg-pinata-purple selection:text-white font-telegraf">
            <Navbar />

            {/* Hero Section */}
            <main className="relative pt-32 pb-20 px-6 max-w-7xl mx-auto">
                {/* Background Colorful Blobs */}
                <div className="absolute top-0 left-0 w-full h-full -z-10 overflow-hidden pointer-events-none">
                    <div className="absolute top-[-10%] right-[-5%] w-[600px] h-[600px] bg-pinata-purple/30 rounded-full blur-[120px]" />
                    <div className="absolute bottom-[10%] left-[-10%] w-[500px] h-[500px] bg-pinata-cyan/20 rounded-full blur-[100px]" />
                    <div className="absolute top-[40%] left-[30%] w-[400px] h-[400px] bg-pinata-yellow/10 rounded-full blur-[100px]" />
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
                                        The robust HTML, CSS, and JavaScript playground with built-in recording.
                                        Turn your coding sessions into interactive, shareable presentations.
                                    </p>

                                    <div className="flex flex-wrap gap-4">
                                        <Link
                                            to="/code"
                                            className="px-10 py-4 rounded-full bg-slate-950 text-white text-lg font-semibold hover:scale-105 active:scale-95 transition-all shadow-xl"
                                        >
                                            Start Creating
                                        </Link>
                                    </div>
                                </div>

                                {/* Mockup code terminal */}
                                <div className="hidden lg:block w-[400px] shrink-0">
                                    <div className="bg-slate-900 rounded-3xl p-6 shadow-2xl border border-slate-800 rotate-2">
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
                                            <div className="flex items-center gap-2 px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/20">
                                                <motion.div
                                                    animate={{ opacity: [1, 0.4, 1] }}
                                                    transition={{ duration: 2, repeat: Infinity }}
                                                    className="w-2 h-2 rounded-full bg-red-500"
                                                />
                                                <span className="text-[10px] font-mono text-red-500 font-bold uppercase tracking-wider">REC</span>
                                            </div>
                                        </motion.div>
                                    </div>

                                    {/* Logo floating element */}
                                    <div className="mt-8 flex justify-end pr-8">
                                        <motion.div
                                            animate={{ y: [0, -10, 0] }}
                                            transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                                            className="w-32 h-32 relative"
                                        >
                                            <div className="absolute inset-0 bg-pinata-purple/10 rounded-3xl blur-xl" />
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
                                desc: "Your code and recordings live in a single .ne file. Host it anywhere and share via URL—absolutely zero backend required.",
                                color: "#FFD255",
                                textColor: "#020617"
                            }
                        ].map((feature, i) => (
                            <div key={i} className="bg-slate-900/50 backdrop-blur-xl border border-slate-800 p-8 rounded-[32px] text-left hover:border-slate-700 transition-colors">
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
