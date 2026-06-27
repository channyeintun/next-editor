import Header from "./components/Header";
import LessonGrid from "./components/LessonGrid";
import Footer from "./components/Footer";

export default function App() {
  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-white">
      <Header />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <LessonGrid />
      </main>
      <Footer />
    </div>
  );
}
