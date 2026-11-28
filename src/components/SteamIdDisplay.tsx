import { useState, useCallback, useRef } from "react";

interface Props {
  steamId: string | null;
}

export function SteamIdDisplay({ steamId }: Props) {
  if (steamId === null) return null;
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const reveal = useCallback(() => setRevealed(true), []);
  const hide = useCallback(() => setRevealed(false), []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(steamId);
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }, [steamId]);

  const masked = "•".repeat(steamId.length);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="monospace-value">{revealed ? steamId : masked}</span>
      <button
        type="button"
        title="Révéler le Steam ID (maintenir)"
        aria-label="Révéler le Steam ID"
        onMouseDown={reveal}
        onMouseUp={hide}
        onMouseLeave={hide}
        onBlur={hide}
        onTouchStart={reveal}
        onTouchEnd={hide}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#ffffff", fontSize: 20 }}
      >
        {revealed ? "🙈" : "👁"}
      </button>
      <button
        type="button"
        title="Copier le SteamID64"
        aria-label="Copier le SteamID64"
        onClick={copy}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "#ffffff", fontSize: 20 }}
      >
        {copied ? "✓" : "📋"}
      </button>
    </span>
  );
}
