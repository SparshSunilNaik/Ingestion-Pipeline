"use client";

/** Last-resort boundary when the root layout itself fails; it must render its own <html>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#101218", color: "#e9eef5", fontFamily: "system-ui, sans-serif" }}>
        <main role="alert" style={{ maxWidth: 520, padding: 24 }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>The application failed to start in the browser</h1>
          <p style={{ color: "#a3acbc", fontSize: 14, lineHeight: 1.5 }}>
            {error.message || "An unexpected error occurred."} Reloading usually helps. Your data is stored by the backend and is not affected.
          </p>
          {error.digest && <p style={{ color: "#a3acbc", fontSize: 12, fontFamily: "monospace" }}>Reference: {error.digest}</p>}
          <button onClick={reset} style={{ marginTop: 12, padding: "8px 14px", borderRadius: 6, border: 0, background: "#d4fa73", color: "#101218", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
