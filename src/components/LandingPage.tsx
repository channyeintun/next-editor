import { motion } from "motion/react";
import { Link } from "react-router-dom";
import Navbar from "./Navbar";
import { useState, useEffect, useRef } from "react";

const LandingPage = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.46875);

  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const width = entry.contentRect.width;
        setScale(width > 0 ? width / 1280 : 0.46875);
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-[#11141c] text-white overflow-hidden selection:bg-pinata-purple selection:text-white font-telegraf">
      <Navbar />

      {/* Hero Section */}
      <main className="relative pt-32 pb-20 px-6 max-w-7xl mx-auto">
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
                  <h1 className="text-5xl md:text-8xl font-machina text-slate-950 leading-[0.9] mb-8 tracking-tight uppercase">
                    CODE'S <br />
                    NEXT LEVEL
                  </h1>

                  <p className="text-xl md:text-2xl text-slate-600 font-telegraf max-w-xl leading-relaxed mb-10">
                    The live coding studio for HTML, CSS, JavaScript, TypeScript, and Node.js with{" "}
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
                    . Build, run, explain, and publish interactive coding sessions as shareable
                    presentations.
                  </p>

                  <div className="flex flex-wrap gap-4">
                    <Link
                      to="/code"
                      className="px-10 py-4 rounded-full bg-slate-950 text-white text-lg font-semibold hover:scale-105 active:scale-95 transition-all shadow-xl"
                    >
                      Start creating
                    </Link>
                    <Link
                      to="/code?url=/introduction.ne&deferRuntimeAutostart=true"
                      className="px-10 py-4 rounded-full bg-[#4de5a6] text-slate-950 text-lg font-semibold hover:bg-[#3cd495] transition-all flex items-center gap-2 shadow-xl"
                    >
                      <div className="relative">
                        <svg viewBox="0 0 256 256" className="overflow-visible size-5">
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
                          <g style={{ transform: "scale(1.2)", transformOrigin: "center" }}>
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
                <div className="w-full lg:w-150 shrink-0 order-2">
                  <div
                    ref={containerRef}
                    className="relative w-full aspect-video overflow-hidden border border-slate-800 rounded-xl bg-[#11141c] shadow-2xl"
                  >
                    <iframe
                      src="/code?url=/introduction.ne&readOnly=true&deferRuntimeAutostart=true"
                      className="absolute top-0 left-0 border-0 origin-top-left"
                      style={{
                        width: "1280px",
                        height: "720px",
                        transform: `scale(${scale})`,
                      }}
                      title="Next Editor Live Demo"
                    />
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
            <img src="/logo.png" alt="logo" className="object-contain size-6" />
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
