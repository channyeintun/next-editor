import { motion } from "motion/react";
import { Maximize, Minimize, SquareArrowOutUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import Navbar from "./Navbar";
import { useState, useEffect, useRef, useCallback } from "react";

const DEMO_IFRAME_WIDTH = 1440;
const DEMO_IFRAME_HEIGHT = 900;
const DEFAULT_IFRAME_SCALE = 0.4513888888888889;
const DEMO_URL = "/code?url=/introduction.ne";
const DEMO_IFRAME_SRC = `${DEMO_URL}&readOnly=true&deferRuntimeAutostart=true&largeControls=true`;

const LandingPage = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setDimensions({ width, height });
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const handleChange = () => {
      const current = doc.fullscreenElement ?? doc.webkitFullscreenElement;
      setIsFullscreen(current === containerRef.current);
    };
    document.addEventListener("fullscreenchange", handleChange);
    document.addEventListener("webkitfullscreenchange", handleChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleChange);
      document.removeEventListener("webkitfullscreenchange", handleChange);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    const node = containerRef.current as
      | (HTMLDivElement & { webkitRequestFullscreen?: () => void })
      | null;
    if (!node) return;
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => void;
    };
    if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
      (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc);
    } else {
      (node.requestFullscreen ?? node.webkitRequestFullscreen)?.call(node);
    }
  }, []);

  // Contain + center the fixed-size demo iframe within its (possibly fullscreen) container.
  const scale = dimensions
    ? Math.min(dimensions.width / DEMO_IFRAME_WIDTH, dimensions.height / DEMO_IFRAME_HEIGHT)
    : DEFAULT_IFRAME_SCALE;
  const offsetX = dimensions ? (dimensions.width - DEMO_IFRAME_WIDTH * scale) / 2 : 0;
  const offsetY = dimensions ? (dimensions.height - DEMO_IFRAME_HEIGHT * scale) / 2 : 0;

  return (
    <div className="min-h-screen bg-[#11141c] text-white overflow-hidden selection:bg-pinata-purple selection:text-white font-telegraf">
      <Navbar />

      {/* Hero Section */}
      <main className="relative pt-8 pb-20 px-6 max-w-7xl mx-auto sm:pt-10">
        {/* Background Colorful Blobs */}
        <div className="absolute top-0 left-0 -z-10 overflow-hidden pointer-events-none size-full">
          <div className="absolute top-[-10%] right-[-5%] size-87.5 md:size-175 bg-[radial-gradient(circle,hsla(248,100%,67%,0.3)_0%,hsla(248,100%,67%,0)_70%)] rounded-full will-change-transform" />
          <div className="absolute bottom-[10%] left-[-10%] size-75 md:size-150 bg-[radial-gradient(circle,hsla(174,76%,60%,0.2)_0%,hsla(174,76%,60%,0)_70%)] rounded-full will-change-transform" />
          <div className="absolute top-[40%] left-[30%] size-62.5 md:size-125 bg-[radial-gradient(circle,hsla(45,100%,66%,0.1)_0%,hsla(45,100%,66%,0)_70%)] rounded-full will-change-transform" />
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
              <div className="absolute -left-16 -top-16 bg-pinata-yellow rounded-full z-0 opacity-20 size-32" />
              <div className="absolute -right-20 bottom-10 bg-pinata-purple rounded-full z-0 opacity-20 size-40" />

              <div className="relative z-10 flex flex-col items-center gap-12 lg:flex-row">
                <div className="flex-1 text-left order-1">
                  <h1 className="text-5xl font-machina text-slate-950 leading-[0.9] mb-8 tracking-tight uppercase">
                    BUILD IT. <br />
                    RECORD IT. <br />
                    SHARE IT.
                  </h1>

                  <p className="text-xl md:text-2xl text-slate-600 font-telegraf max-w-xl leading-relaxed mb-10">
                    Turn real coding sessions into interactive tutorials with{" "}
                    <span className="relative inline-block whitespace-nowrap group-hover:text-slate-950 transition-colors">
                      built-in recording
                      <svg
                        className="absolute -bottom-3 left-0 w-[105%] h-5 text-pinata-cyan overflow-visible px-1"
                        viewBox="0 0 200 20"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                      >
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
                    </span>
                    . Replay every change, explain concepts step by step, and publish lessons
                    learners can explore directly in the browser.
                  </p>

                  <div className="flex flex-wrap gap-4">
                    <Link
                      to="/code"
                      className="px-10 py-4 rounded-full bg-slate-950 text-white text-lg font-semibold hover:scale-105 active:scale-95 transition-all shadow-xl"
                    >
                      Start creating
                    </Link>
                  </div>
                </div>

                {/* Mockup code terminal */}
                <div className="w-full lg:w-150 shrink-0 order-2">
                  <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#11141c] shadow-2xl">
                    <div className="flex min-h-14 items-center justify-between gap-3 border-b border-white/10 bg-slate-950 px-3 py-2 sm:px-4">
                      <div className="flex min-w-0 items-center gap-3 text-slate-400">
                        <div className="flex shrink-0 gap-1.5" aria-hidden="true">
                          <span className="size-2 rounded-full bg-[#ff5f57]" />
                          <span className="size-2 rounded-full bg-[#ffbd2e]" />
                          <span className="size-2 rounded-full bg-[#28c840]" />
                        </div>
                        <div className="min-w-0">
                          <span className="block truncate text-xs font-semibold uppercase tracking-[0.16em]">
                            introduction.ne
                          </span>
                          <span className="hidden truncate text-[11px] text-slate-500 sm:block">
                            Recorded editor session
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={toggleFullscreen}
                          aria-label={
                            isFullscreen ? "Exit full screen" : "View demo in full screen"
                          }
                          title={isFullscreen ? "Exit full screen" : "Full screen"}
                          className="inline-flex size-9 items-center justify-center rounded-full border border-white/10 text-slate-300 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
                        >
                          {isFullscreen ? (
                            <Minimize className="size-4" aria-hidden="true" />
                          ) : (
                            <Maximize className="size-4" aria-hidden="true" />
                          )}
                        </button>
                        <a
                          href={DEMO_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label="Open the demo in a new tab"
                          title="Open in new tab"
                          className="inline-flex size-9 items-center justify-center rounded-full border border-white/10 text-slate-300 transition-colors hover:border-white/20 hover:bg-white/10 hover:text-white"
                        >
                          <SquareArrowOutUpRight className="size-4" aria-hidden="true" />
                        </a>
                      </div>
                    </div>
                    <div
                      ref={containerRef}
                      className="relative w-full aspect-1440/900 overflow-hidden bg-[#11141c]"
                    >
                      <iframe
                        src={DEMO_IFRAME_SRC}
                        className="absolute border-0 origin-top-left"
                        style={{
                          width: DEMO_IFRAME_WIDTH,
                          height: DEMO_IFRAME_HEIGHT,
                          left: offsetX,
                          top: offsetY,
                          transform: `scale(${scale})`,
                        }}
                        title="Next Editor Live Demo"
                      />
                      {isFullscreen && (
                        <button
                          type="button"
                          onClick={toggleFullscreen}
                          aria-label="Exit full screen"
                          title="Exit full screen"
                          className="absolute left-4 top-4 z-10 inline-flex items-center justify-center rounded-full border border-white/15 bg-slate-950/80 p-2.5 text-white backdrop-blur transition-colors hover:bg-slate-950"
                        >
                          <Minimize className="size-4" aria-hidden="true" />
                        </button>
                      )}
                    </div>
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
              {
                title: "Live Coding Studio",
                desc: "Edit, run, and preview HTML, CSS, JavaScript, TypeScript, and Node.js projects in one live workspace built for prototyping, teaching, and presenting.",
                color: "#6D57FF",
                textColor: "white",
              },
              {
                title: "Interactive Slides",
                desc: (
                  <>
                    Powered by{" "}
                    <a
                      href="https://revealjs.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-pinata-cyan hover:underline decoration-pinata-cyan/30"
                    >
                      reveal.js
                    </a>
                    . Record your coding journey and instantly play it back as a stunning
                    presentation.
                  </>
                ),
                color: "#4DE5D6",
                textColor: "#020617",
              },
              {
                title: "Event-Based Efficiency",
                desc: (
                  <div className="space-y-4">
                    <p>
                      We record DOM events, not pixels. This makes .ne files 100x smaller than
                      videos while remaining fully interactive.
                    </p>
                    <div className="relative pt-2">
                      <div className="bg-white rounded-lg p-2 text-slate-900 font-mono text-xs flex items-center shadow-lg border border-slate-200">
                        <span className="text-slate-400">nexteditor.dev/code?</span>
                        <span className="relative inline-block text-slate-950 font-bold whitespace-nowrap">
                          url=intro.ne
                          <svg
                            className="absolute -bottom-2.5 left-0 w-full h-4 text-pinata-cyan overflow-visible px-0.5"
                            viewBox="0 0 100 20"
                            fill="none"
                            xmlns="http://www.w3.org/2000/svg"
                          >
                            <path
                              d="M2 12C20 13 40 13 60 12C80 11 92 9 98 5"
                              stroke="currentColor"
                              strokeWidth="4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="origin-left animate-[draw_1.3s_cubic-bezier(0.65,0,0.35,1)_forwards] will-change-[stroke-dasharray]"
                            />
                            <path
                              d="M5 16C25 18 50 18 70 17C85 16 95 14 97 10"
                              stroke="currentColor"
                              strokeWidth="2.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="origin-left animate-[draw_1.3s_cubic-bezier(0.65,0,0.35,1)_0.15s_forwards] will-change-[stroke-dasharray]"
                            />
                          </svg>
                        </span>
                      </div>
                    </div>
                  </div>
                ),
                color: "#FFD255",
                textColor: "#020617",
              },
            ].map((feature, i) => (
              <div
                key={i}
                className="bg-[#181d24]/90 border border-slate-800 p-8 rounded-4xl text-left hover:border-slate-700 transition-colors will-change-[border-color,background-color]"
              >
                <div
                  style={{ backgroundColor: feature.color, color: feature.textColor }}
                  className="rounded-2xl mb-6 flex items-center justify-center font-bold text-xl size-12"
                >
                  {i + 1}
                </div>
                <h3 className="text-2xl font-machina mb-4">{feature.title}</h3>
                <div className="text-slate-400 leading-relaxed">{feature.desc}</div>
              </div>
            ))}
          </motion.div>
        </div>
      </main>

      <footer className="border-t border-slate-900 py-12 px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="logo" className="object-contain size-6" />
            <span className="font-machina tracking-tight">next-editor</span>
          </div>
          <div className="flex flex-col md:flex-row items-center gap-6">
            <p className="text-slate-500 text-sm">© 2026 Next Editor</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
