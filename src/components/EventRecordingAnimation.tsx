import { useLottie } from 'lottie-react';
import eventAnimation from '../assets/animations/event-recording.json';
import { motion } from 'motion/react';

const EventRecordingAnimation = ({ variant = 'full' }: { variant?: 'full' | 'compact' }) => {
    const options = {
        animationData: eventAnimation,
        loop: true,
        autoplay: true,
    };

    const { View } = useLottie(options);

    const jsonExamples = [
        '{ "type": "keystroke", "key": "A" }',
        '{ "type": "cursor", "x": 102, "y": 45 }',
        '{ "type": "scroll", "top": 120 }',
        '{ "type": "selection", "len": 15 }'
    ];

    if (variant === 'compact') {
        return (
            <div className="relative flex items-center h-4 w-16 group overflow-visible">
                {/* Minimal Background Glow */}
                <div className="absolute inset-0 bg-pinata-cyan/10 blur-[10px] rounded-full scale-110 -translate-x-2" />

                {/* Lottie View - Tightly aligned to the left */}
                <div className="h-16 w-16 -my-6 relative z-10 origin-left flex items-center justify-center -ml-4">
                    <div className="w-full h-full scale-[1.5]">
                        {View}
                    </div>
                </div>

                {/* Horizontal floating tags - Streaming directly from the source */}
                {jsonExamples.map((text, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{
                            opacity: [0, 1, 0],
                            x: [0, 60],
                            y: i % 2 === 0 ? [-2, -12] : [2, 12]
                        }}
                        transition={{
                            duration: 3,
                            repeat: Infinity,
                            delay: i * 0.8,
                            ease: "easeOut"
                        }}
                        className="absolute left-4 bg-white/10 backdrop-blur-md border border-white/10 px-1.5 py-0.5 rounded text-[7px] font-mono text-pinata-cyan whitespace-nowrap pointer-events-none shadow-lg z-20"
                    >
                        {text.length > 25 ? text.substring(0, 20) + '...' : text}
                    </motion.div>
                ))}
            </div>
        );
    }

    return (
        <div className="relative w-full max-w-2xl mx-auto p-1">
            {/* Background Glows */}
            <div className="absolute top-1/2 left-1/4 -translate-y-1/2 w-64 h-64 bg-pinata-cyan/10 blur-[100px] rounded-full" />
            <div className="absolute top-1/2 right-1/4 -translate-y-1/2 w-64 h-64 bg-pinata-purple/10 blur-[100px] rounded-full" />

            <div className="relative bg-[#0d1117]/60 backdrop-blur-xl rounded-[40px] border border-white/5 p-8 md:p-12 overflow-hidden shadow-2xl">
                {/* Header/Status */}
                <div className="flex items-center justify-between mb-12">
                    <div className="flex gap-2">
                        <div className="w-3 h-3 rounded-full bg-[#FF5F56] shadow-[0_0_10px_rgba(255,95,86,0.5)]" />
                        <div className="w-3 h-3 rounded-full bg-[#FFBD2E]" />
                        <div className="w-3 h-3 rounded-full bg-[#27C93F]" />
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 border border-red-500/20 text-[10px] font-mono font-bold text-red-500 uppercase tracking-widest animate-pulse">
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                            Live Recording
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
                    {/* Visual Side */}
                    <div className="relative aspect-square group">
                        <div className="absolute inset-0 bg-linear-to-tr from-pinata-cyan/5 to-transparent rounded-3xl" />
                        <div className="w-full h-full scale-110">
                            {View}
                        </div>

                        {/* Floating Event Tags */}
                        {jsonExamples.map((text, i) => (
                            <motion.div
                                key={i}
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: [0, 1, 0], x: [20, 0, -20], y: [0, -40 - (i * 10)] }}
                                transition={{
                                    duration: 3,
                                    repeat: Infinity,
                                    delay: i * 0.8,
                                    ease: "linear"
                                }}
                                className="absolute top-1/2 right-0 bg-white/5 backdrop-blur-md border border-white/10 px-3 py-1.5 rounded-lg text-[10px] font-mono text-pinata-cyan whitespace-nowrap pointer-events-none shadow-xl"
                            >
                                {text}
                            </motion.div>
                        ))}
                    </div>

                    {/* Data Side */}
                    <div className="text-left space-y-8">
                        <div>
                            <h3 className="text-3xl font-machina text-white mb-4 uppercase tracking-tight">
                                Stream <span className="text-pinata-cyan">Events</span>
                            </h3>
                            <p className="text-lg text-slate-400 font-telegraf leading-relaxed">
                                We capture the raw interaction log. No heavy video frames—just a surgical stream of DOM and editor actions.
                            </p>
                        </div>

                        <div className="space-y-4">
                            <div className="flex items-center justify-between p-4 rounded-2xl bg-white/5 border border-white/10 group hover:bg-white/10 transition-colors">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-xl bg-pinata-cyan/20 flex items-center justify-center text-pinata-cyan">
                                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                        </svg>
                                    </div>
                                    <div>
                                        <div className="text-sm font-bold text-white">Interactive JSON</div>
                                        <div className="text-xs text-slate-500 font-mono">20 KB total size</div>
                                    </div>
                                </div>
                                <div className="text-pinata-cyan font-mono text-xs font-bold">OPTIMIZED</div>
                            </div>

                            <div className="flex items-center justify-between p-4 rounded-2xl bg-red-500/5 border border-red-500/10 opacity-50">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-xl bg-red-500/20 flex items-center justify-center text-red-500">
                                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                        </svg>
                                    </div>
                                    <div>
                                        <div className="text-sm font-bold text-white">Standard MP4</div>
                                        <div className="text-xs text-slate-500 font-mono">5.2 MB total size</div>
                                    </div>
                                </div>
                                <div className="text-red-500 font-mono text-xs font-bold">HEAVY</div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Bottom Badge */}
                <div className="mt-12 pt-8 border-t border-white/5 flex flex-wrap justify-between items-center gap-4">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Storage tech:</span>
                        <span className="px-2 py-0.5 rounded bg-white/5 text-[10px] font-mono text-slate-300">SUPERJSON</span>
                        <span className="px-2 py-0.5 rounded bg-white/5 text-[10px] font-mono text-slate-300">PAKO (ZLIB)</span>
                    </div>
                    <div className="text-[10px] font-mono text-pinata-yellow italic">
                        "Small enough to be shared in a URL"
                    </div>
                </div>
            </div>
        </div>
    );
};

export default EventRecordingAnimation;
