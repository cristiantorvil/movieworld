import React from "react";
import { createRoot } from "react-dom/client";
import CineElo from "./cine-elo.jsx";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {};
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Cine Elo error:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            padding: "24px",
            background: "#101116",
            color: "#EDEAE3",
            fontFamily: "sans-serif",
            textAlign: "center",
          }}
        >
          <p style={{ fontSize: "18px", fontWeight: 700 }}>
            Algo se rompió 🎬💥
          </p>
          <p style={{ fontSize: "13px", color: "#8A8D98", maxWidth: "320px" }}>
            Tu progreso sigue guardado. Recargá la página para volver a
            intentarlo.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: "#F2C14E",
              color: "#14151A",
              border: "none",
              fontWeight: 700,
              fontSize: "14px",
              padding: "12px 20px",
              borderRadius: "8px",
              cursor: "pointer",
            }}
          >
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <CineElo />
    </ErrorBoundary>
  );
}

window.storage = {
  async get(key, shared) {
    const v = localStorage.getItem(key);
    return v === null ? null : { key, value: v, shared: !!shared };
  },
  async set(key, value, shared) {
    localStorage.setItem(key, value);
    return { key, value, shared: !!shared };
  },
  async delete(key, shared) {
    localStorage.removeItem(key);
    return { key, deleted: true, shared: !!shared };
  },
  async list(prefix, shared) {
    return {
      keys: Object.keys(localStorage).filter(
        (k) => !prefix || k.startsWith(prefix)
      ),
      prefix,
      shared: !!shared,
    };
  },
};

const root = createRoot(document.getElementById("root"));
root.render(<App />);
