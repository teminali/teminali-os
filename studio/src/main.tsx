import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { useStudioStore } from "./store/studioStore";

if (typeof window !== "undefined") {
  (window as unknown as { __studioStore: typeof useStudioStore }).__studioStore = useStudioStore;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
