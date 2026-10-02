import { createRoot } from "react-dom/client";
import App from "../../src/App";
import "../../src/index.css";

declare global {
  interface Window {
    clerkSmoke: {
      seed: () => void;
      hasMarker: () => boolean;
      cachedAccessUsers: () => string[];
    };
  }
}
createRoot(document.getElementById("root")!).render(<App />);