import { createRoot } from "react-dom/client";
import { DroidWebscrApp } from "./app.js";
import "./index.css";

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<DroidWebscrApp />);
}
