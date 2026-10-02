import { useState } from "react";
import { createRoot } from "react-dom/client";
import { notifyManager } from "@tanstack/react-query";
import App from "../../src/App";
import "../../src/index.css";
import { setTestIdentity } from "./clerk";

// Keep query observer notifications running while the browser clock is paused.
// Retry delays and countdown intervals still use the real, controlled timers.
notifyManager.setScheduler(queueMicrotask);

declare global {
  interface Window {
    accessTest: {
      identity: typeof setTestIdentity;
      remount: () => void;
    };
  }
}

function Fixture() {
  const [generation, setGeneration] = useState(0);
  window.accessTest = {
    identity: setTestIdentity,
    // App's module-level QueryClient survives, like a protected route remount.
    remount: () => setGeneration((previous) => previous + 1),
  };
  return <App key={generation} />;
}

createRoot(document.getElementById("root")!).render(<Fixture />);