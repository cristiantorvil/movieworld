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

// Modo inicial desde la URL: index.html?modo=watchlist (watchlist.html
// redirige acá). El selector del header cambia de modo sin recargar y deja
// la URL al día, así recargar o compartir el link mantiene el modo.
function readModeFromUrl() {
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get("modo") === "watchlist" ? "watchlist" : "vistas";
  } catch (e) {
    return "vistas";
  }
}

function App() {
  const [mode, setMode] = React.useState(readModeFromUrl);
  const changeMode = React.useCallback((next) => {
    setMode(next);
    try {
      const url = new URL(window.location.href);
      if (next === "watchlist") url.searchParams.set("modo", "watchlist");
      else url.searchParams.delete("modo");
      window.history.replaceState(null, "", url.toString());
    } catch (e) {
      // URL no actualizable (file://, sandbox): el modo cambia igual
    }
    document.title = next === "watchlist" ? "Watchlist — Cine Elo" : "Cine Elo";
    window.scrollTo(0, 0);
  }, []);
  React.useEffect(() => {
    document.title = mode === "watchlist" ? "Watchlist — Cine Elo" : "Cine Elo";
  }, []);
  return (
    <ErrorBoundary>
      <CineElo mode={mode} onModeChange={changeMode} />
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
