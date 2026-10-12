import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import type { TermLine } from "./scenes";

// ── Typewriter effect ──
const Typewriter: React.FC<{ text: string; startFrame: number; color: string }> = ({
  text,
  startFrame,
  color,
}) => {
  const frame = useCurrentFrame();
  const elapsed = frame - startFrame;
  if (elapsed < 0) return null;

  // 2 chars per frame = fast but readable
  const charsToShow = Math.min(Math.floor(elapsed * 2), text.length);
  const shown = text.slice(0, charsToShow);
  const showCursor = charsToShow < text.length;

  return (
    <span style={{ color }}>
      {shown}
      {showCursor && (
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 20,
            backgroundColor: "#b3ff0c",
            marginLeft: 2,
            opacity: Math.sin(elapsed * 0.3) > 0 ? 1 : 0,
          }}
        />
      )}
    </span>
  );
};

// ── Spinner animation ──
const Spinner: React.FC<{ startFrame: number }> = ({ startFrame }) => {
  const frame = useCurrentFrame();
  const elapsed = frame - startFrame;
  if (elapsed < 0) return null;
  const chars = [".", "..", "...", "....", "...."];
  const idx = Math.floor(elapsed / 4) % chars.length;
  return <span style={{ color: "#b3ff0c" }}>{chars[idx]}</span>;
};

// ── Single terminal line ──
const Line: React.FC<{
  line: TermLine;
  sceneStartFrame: number;
}> = ({ line, sceneStartFrame }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const appearFrame = sceneStartFrame + (line.delay || 0);

  if (frame < appearFrame) return null;

  const fadeIn = spring({
    frame: frame - appearFrame,
    fps,
    config: { damping: 30, stiffness: 200 },
  });

  const color = line.color || "#e8e8e8";

  return (
    <div
      style={{
        opacity: line.typing ? 1 : fadeIn,
        transform: line.typing ? "none" : `translateY(${(1 - fadeIn) * 8}px)`,
        paddingLeft: (line.indent || 0) * 8,
        minHeight: 28,
        lineHeight: "28px",
        whiteSpace: "pre",
      }}
    >
      {line.typing ? (
        <Typewriter text={line.text} startFrame={appearFrame} color={color} />
      ) : (
        <>
          <span style={{ color }}>{line.text}</span>
          {line.spinner && frame < appearFrame + 30 && (
            <Spinner startFrame={appearFrame} />
          )}
        </>
      )}
    </div>
  );
};

// ── Terminal window chrome ──
export const Terminal: React.FC<{
  lines: TermLine[];
  sceneStartFrame: number;
  prompt?: string;
}> = ({ lines, sceneStartFrame, prompt }) => {
  return (
    <div
      style={{
        width: 1200,
        backgroundColor: "#0c0c0c",
        borderRadius: 12,
        border: "1px solid #222",
        overflow: "hidden",
        boxShadow: "0 25px 80px rgba(0,0,0,0.6), 0 0 120px rgba(179,255,12,0.03)",
      }}
    >
      {/* Title bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "12px 16px",
          backgroundColor: "#161616",
          borderBottom: "1px solid #222",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#3a3a3a" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#3a3a3a" }} />
          <div style={{ width: 12, height: 12, borderRadius: "50%", backgroundColor: "#3a3a3a" }} />
        </div>
        <div
          style={{
            flex: 1,
            textAlign: "center",
            color: "#555",
            fontSize: 13,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          agents-cli -- zsh
        </div>
        <div style={{ color: "#444", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
          80x24
        </div>
      </div>

      {/* Terminal content */}
      <div
        style={{
          padding: "20px 24px",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 15,
          minHeight: 420,
        }}
      >
        {lines.map((line, i) => (
          <Line key={i} line={line} sceneStartFrame={sceneStartFrame} />
        ))}
      </div>
    </div>
  );
};
