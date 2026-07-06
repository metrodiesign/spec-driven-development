// Console SPA shell. Views are populated by task 8; the third-party disclaimer
// is a spec requirement (REQ-12.7) and present from the first render.
export function App() {
  return (
    <main>
      <h1>Platform Console</h1>
      <p role="note">
        Third-party tool operating on your local Claude Code installation — not an
        Anthropic product.
      </p>
    </main>
  );
}
