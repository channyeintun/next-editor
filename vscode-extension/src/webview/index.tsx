import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("webview root element missing");
}
createRoot(container).render(<App />);
