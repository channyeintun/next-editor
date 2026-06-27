import {
  Maximize,
  Minimize,
  Play,
  SquareArrowOutUpRight,
  BookOpen,
  GraduationCap,
  FileText,
  Users,
  Presentation,
  Bug,
  Star,
} from "lucide-react";
import { Link } from "react-router";
import Navbar from "./Navbar";
import { useState, useEffect, useRef } from "react";
import { isMobileBrowser } from "../utils/isMobileBrowser";

const FRAMEWORKS = [
  "React",
  "Vue",
  "Solid",
  "Svelte",
  "HTMX",
  "Express",
  "TypeScript",
  "JavaScript",
  "HTML/CSS",
  "Node.js",
  "any JS/TS framework",
] as const;

const FRAMEWORK_COLORS: Record<string, string> = {
  React: "#4de5d6",
  Vue: "#3ace8c",
  Solid: "#6d57ff",
  Svelte: "#ff8f33",
  HTMX: "#ffd255",
  Express: "#ff8f33",
  TypeScript: "#4de5d6",
  JavaScript: "#ffd255",
  "HTML/CSS": "#3ace8c",
  "Node.js": "#6d57ff",
  "any JS/TS framework": "#6d57ff",
};

const USE_CASES = [
  {
    icon: BookOpen,
    title: "Interactive Tutorials",
    desc: "Turn a real coding session into a step-through lesson learners can explore directly in the browser.",
    color: "#6d57ff",
  },
  {
    icon: GraduationCap,
    title: "Courses & Workshops",
    desc: "Build replayable lessons with synced audio narration, captions, and slides — no video editing needed.",
    color: "#4de5d6",
  },
  {
    icon: FileText,
    title: "Documentation & Guides",
    desc: "Embed a live recording instead of static GIFs. Viewers replay every edit and preview in context.",
    color: "#3ace8c",
  },
  {
    icon: Users,
    title: "Onboarding",
    desc: "Walk new teammates through a codebase change exactly as it happened — every file, every keystroke.",
    color: "#ff8f33",
  },
  {
    icon: Presentation,
    title: "Conference Talks & Demos",
    desc: "Present with synced reveal.js slides, live runtime preview, and narration — all from one .ne file.",
    color: "#ffd255",
  },
  {
    icon: Bug,
    title: "Code Reviews & Bug Repros",
    desc: "Record the exact edits and runtime state, share a link. Reviewers replay the full context.",
    color: "#6d57ff",
  },
] as const;

function useInView(threshold = 0.1) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [threshold]);
  return { ref, inView };
}

function formatStarCount(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(count);
}

const GITHUB_SVG_PATH =
  "M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z";

const DEMO_IFRAME_WIDTH = 1440;
const DEMO_IFRAME_HEIGHT = 900;
const DEFAULT_IFRAME_SCALE = 0.4513888888888889;
const DEMO_URL = "/code?url=/introduction.ne";
const DEMO_IFRAME_SRC = `${DEMO_URL}&readOnly=true&deferRuntimeAutostart=true&largeControls=true`;

const LandingPage = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // The demo iframe boots a SECOND full copy of the editor (Monaco + recording
  // decode + rrweb replay + audio). On mobile that runs alongside this page and
  // its replay buffers grow until iOS Safari reloads then kills the tab. Render a
  // static tap-to-open card there instead, so the landing page stays light.
  const [isMobile] = useState(() => isMobileBrowser());
  const [frameworkIndex, setFrameworkIndex] = useState(0);
  const [starCount, setStarCount] = useState<number | null>(null);

  // Reveal each section once it scrolls into view (replaces motion's whileInView).
  const featuresSection = useInView();
  const stacksSection = useInView();
  const useCasesSection = useInView();
  const licenseSection = useInView();
  const starSection = useInView();

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) return;
    const id = setInterval(() => {
      setFrameworkIndex((i) => (i + 1) % FRAMEWORKS.length);
    }, 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("https://api.github.com/repos/channyeintun/next-editor")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && typeof data.stargazers_count === "number") {
          setStarCount(data.stargazers_count);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  const toggleFullscreen = () => {
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
  };

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
          <div className="w-full opacity-0 animate-[fade-up_0.8s_cubic-bezier(0.22,1,0.36,1)_forwards] motion-reduce:animate-none motion-reduce:opacity-100">
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
                        {!isMobile && (
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
                        )}
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
                      className={`relative w-full overflow-hidden bg-[#11141c] ${
                        isMobile ? "" : "aspect-1440/900"
                      }`}
                    >
                      {isMobile ? (
                        <a
                          href={DEMO_URL}
                          className="group flex flex-col items-center justify-center gap-5 px-8 py-14 text-center"
                          aria-label="Open the interactive demo"
                        >
                          <span className="flex size-16 items-center justify-center rounded-full bg-pinata-purple shadow-[0_10px_35px_-5px_rgba(109,87,255,0.6)] ring-1 ring-white/20 transition-transform group-active:scale-95">
                            <Play
                              className="size-6 translate-x-0.5 fill-white text-white"
                              aria-hidden="true"
                            />
                          </span>
                          <div className="space-y-1.5">
                            <p className="text-lg font-semibold text-white">
                              Play the interactive demo
                            </p>
                            <p className="text-sm text-slate-400">Tap to open the full editor</p>
                          </div>
                        </a>
                      ) : (
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
                      )}
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
          </div>

          <div
            ref={featuresSection.ref}
            className={`grid grid-cols-1 md:grid-cols-3 gap-8 w-full max-w-6xl mt-12 transition-opacity duration-1000 delay-400 motion-reduce:transition-none ${
              featuresSection.inView ? "opacity-100" : "opacity-0"
            }`}
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
          </div>
        </div>
      </main>

      {/* Section 1 — Works with any stack */}
      <section
        ref={stacksSection.ref}
        className={`relative py-24 px-6 text-center transition-opacity duration-1000 motion-reduce:transition-none ${
          stacksSection.inView ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
          <div className="absolute top-[20%] left-[50%] -translate-x-1/2 size-100 md:size-175 bg-[radial-gradient(circle,hsla(248,100%,67%,0.15)_0%,hsla(248,100%,67%,0)_70%)] rounded-full" />
        </div>
        <div className="max-w-4xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-machina uppercase tracking-tight mb-6">
            <span className="block">Works with</span>
            <span
              key={frameworkIndex}
              className="block text-pinata-cyan animate-[fade-up_0.4s_cubic-bezier(0.22,1,0.36,1)_forwards] motion-reduce:animate-none"
              style={{ color: FRAMEWORK_COLORS[FRAMEWORKS[frameworkIndex]] }}
            >
              {FRAMEWORKS[frameworkIndex]}
            </span>
          </h2>
          <p className="text-lg md:text-xl text-slate-400 font-telegraf mb-12 max-w-2xl mx-auto">
            Record lessons for any stack — or even with vanilla HTML, CSS, and JavaScript.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {FRAMEWORKS.map((name) => (
              <span
                key={name}
                className="px-4 py-2 rounded-full border border-slate-700 bg-[#181d24]/90 text-sm font-telegraf text-slate-300 hover:border-slate-500 transition-colors"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Section 2 — Use Cases */}
      <section
        ref={useCasesSection.ref}
        className={`py-24 px-6 transition-opacity duration-1000 motion-reduce:transition-none ${
          useCasesSection.inView ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-5xl font-machina uppercase tracking-tight text-center mb-4">
            Use Cases
          </h2>
          <p className="text-lg text-slate-400 font-telegraf text-center mb-16 max-w-2xl mx-auto">
            From interactive tutorials to async code reviews — Next Editor fits wherever you need to
            show, not just tell.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {USE_CASES.map((uc) => (
              <div
                key={uc.title}
                className="bg-[#181d24]/90 border border-slate-800 p-8 rounded-4xl text-left hover:border-slate-700 transition-colors will-change-[border-color,background-color]"
              >
                <div
                  style={{ backgroundColor: uc.color }}
                  className="rounded-2xl mb-6 flex items-center justify-center size-12"
                >
                  <uc.icon className="size-6 text-slate-950" />
                </div>
                <h3 className="text-2xl font-machina mb-4">{uc.title}</h3>
                <p className="text-slate-400 leading-relaxed">{uc.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 3 — MIT Licensed / Free for everyone, forever */}
      <section
        ref={licenseSection.ref}
        className={`relative py-24 px-6 text-center transition-opacity duration-1000 motion-reduce:transition-none ${
          licenseSection.inView ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
          <div className="absolute top-[30%] left-[20%] size-75 md:size-125 bg-[radial-gradient(circle,hsla(174,76%,60%,0.12)_0%,hsla(174,76%,60%,0)_70%)] rounded-full" />
          <div className="absolute bottom-[20%] right-[15%] size-62.5 md:size-100 bg-[radial-gradient(circle,hsla(248,100%,67%,0.12)_0%,hsla(248,100%,67%,0)_70%)] rounded-full" />
        </div>
        <div className="max-w-3xl mx-auto">
          <h2 className="text-4xl md:text-6xl font-machina uppercase tracking-tight mb-6">
            Free for everyone,
            <br />
            forever
          </h2>
          <p className="text-lg md:text-xl text-slate-400 font-telegraf mb-10 max-w-xl mx-auto">
            Open source under the MIT License. No account required. Self-hostable.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {[
              { label: "MIT License", color: "border-pinata-purple text-pinata-purple" },
              { label: "Open Source", color: "border-pinata-cyan text-pinata-cyan" },
              { label: "No Sign-up", color: "border-pinata-green text-pinata-green" },
              { label: "Self-hostable", color: "border-pinata-orange text-pinata-orange" },
            ].map((badge) => (
              <span
                key={badge.label}
                className={`px-5 py-2 rounded-full border text-sm font-semibold font-telegraf ${badge.color}`}
              >
                {badge.label}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Section 4 — Star on GitHub */}
      <section
        ref={starSection.ref}
        className={`py-24 px-6 text-center transition-opacity duration-1000 motion-reduce:transition-none ${
          starSection.inView ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-machina uppercase tracking-tight mb-4">
            Like what you see?
          </h2>
          <p className="text-lg text-slate-400 font-telegraf mb-10">
            Star us on GitHub and help spread the word.
          </p>
          <a
            href="https://github.com/channyeintun/next-editor"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-3 px-10 py-4 rounded-full bg-white text-slate-950 text-lg font-semibold hover:scale-105 active:scale-95 transition-all shadow-xl"
          >
            <svg className="size-6" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path fillRule="evenodd" d={GITHUB_SVG_PATH} clipRule="evenodd" />
            </svg>
            <span>Star on GitHub</span>
            <Star className="size-5 fill-pinata-yellow text-pinata-yellow" />
            {starCount !== null && (
              <span className="ml-1 px-2.5 py-0.5 rounded-full bg-slate-950/10 text-sm font-bold">
                {formatStarCount(starCount)}
              </span>
            )}
          </a>
        </div>
      </section>

      <footer className="border-t border-slate-900 py-12 px-6">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" alt="logo" className="object-contain size-6" />
            <span className="font-machina tracking-tight">next-editor</span>
          </div>
          <div className="flex flex-col md:flex-row items-center gap-6">
            <a
              href="mailto:chanyeintun@gmail.com"
              className="text-slate-400 hover:text-white transition-colors text-sm"
            >
              Contact: chanyeintun@gmail.com
            </a>
            <p className="text-slate-500 text-sm">© 2026 Next Editor</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default LandingPage;
