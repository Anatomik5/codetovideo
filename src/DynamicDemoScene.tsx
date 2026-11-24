import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type UiEvent = {
  atSec: number;
  kind: string;
  label: string;
  title?: string;
};

export type StoryBeat = {
  id: string;
  title: string;
  caption: string;
  targetGoal?: string;
};

export type ArtDirection = {
  accentColor: string;
  secondaryColor: string;
  bgStart: string;
  bgEnd: string;
  isDark: boolean;
  backdropSvg?: string;
  backdropImage?: string;
};

export type DirectorProps = {
  videoTitle: string;
  introLine: string;
  outroLine: string;
  storyBeats?: StoryBeat[];
  sceneTimings?: { startSec: number; endSec: number }[];
  /** Output height in px (width follows 16:9). The layout is authored at 1920x1080 and scaled to this size. */
  outHeight?: number;
  /** File name (inside public/) of the assembled UI capture for this render. */
  uiVideoFile?: string;
  uploadName?: string;
  repoSummary?: string;
  /** "demo" (walkthrough) or "promo" (corporate ad). */
  format?: string;
  /** Where each action happened on screen (normalised 0..1) on the assembled UI timeline; drives promo zoom / call-outs. */
  focusPoints?: { atSec: number; x: number; y: number; w: number; h: number; label: string; kind: string }[];
  chapters: { title: string; caption: string }[];
  uiDurationSec: number;
  uiUsedSec: number;
  introSec: number;
  outroSec: number;
  durationInFrames: number;
  fps: number;
  displayUrl: string;
  repoName: string;
  artDirection?: ArtDirection | null;
  stopReason?: string | null;
  comment?: string | null;
  steps?: string[];
};

export const defaultDirectorProps: DirectorProps = {
  videoTitle: "Product Promo",
  introLine: "Visual product walkthrough",
  outroLine: "Ready to ship",
  storyBeats: [],
  chapters: [{ title: "Overview", caption: "Product walkthrough" }],
  uiDurationSec: 16,
  uiUsedSec: 16,
  introSec: 1.6,
  outroSec: 2.2,
  durationInFrames: 594,
  fps: 30,
  displayUrl: "http://localhost:3000",
  repoName: "app",
  stopReason: null,
  comment: null,
  steps: [],
  artDirection: {
    accentColor: "#f59e0b",
    secondaryColor: "#38bdf8",
    bgStart: "#0b0f17",
    bgEnd: "#131b2b",
    isDark: true,
    backdropSvg: "",
    backdropImage: "",
  },
};

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function withAlpha(hex: string, alpha: number): string {
  const clean = (hex || "#0b0f17").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16) || 0;
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function parseHex(hex: string): [number, number, number] {
  const clean = (hex || "#0b0f17").replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16) || 0;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/** WCAG relative luminance, 0 (black) .. 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Darken a colour toward black until it reads on a light background. */
export function darken(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex).map((v) => Math.round(v * (1 - amount)));
  return `rgb(${r}, ${g}, ${b})`;
}

/** SVG -> CSS mask url, so a light sweep can be clipped to exactly the drawn strokes. */
const svgToMaskUrl = (svg: string) => {
  try {
    // A mask image needs explicit pixel dimensions (percent sizes do not resolve inside a data URL).
    const sized = svg.replace(/<svg\b[^>]*>/i, (tag) =>
      tag.replace(/\s(width|height)="[^"]*"/gi, "").replace(/<svg\b/i, '<svg width="1280" height="720"'),
    );
    return `url("data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(sized)))}")`;
  } catch {
    return "";
  }
};

const AiGeneratedBackdrop: React.FC<{ art: ArtDirection; frame: number }> = ({ art, frame }) => {
  const driftX = Math.sin(frame / 45) * 26;
  const driftY = Math.cos(frame / 55) * 18;
  const breathe = 1 + Math.sin(frame / 70) * 0.018;
  const glow = 10 + Math.sin(frame / 18) * 8;
  const maskUrl = useMemo(() => (art.backdropSvg ? svgToMaskUrl(art.backdropSvg) : ""), [art.backdropSvg]);

  // Frame-driven (not CSS-time-driven) so every rendered frame is deterministic:
  // 1) strokes flicker in three phase-shifted groups, 2) two light sweeps travel through the artwork.
  const f = (k: number, speed: number) => (0.5 + 0.5 * Math.abs(Math.sin(frame / speed + k))).toFixed(3);
  const sweepX = 110 - ((frame % 150) / 150) * 120;
  const sweepY = 110 - (((frame + 60) % 210) / 210) * 120;
  const flicker = `
    .ctv-bd svg > :nth-child(3n+1), .ctv-bd svg > g > :nth-child(3n+1) { opacity: ${f(0, 22)}; }
    .ctv-bd svg > :nth-child(3n+2), .ctv-bd svg > g > :nth-child(3n+2) { opacity: ${f(2.1, 31)}; }
    .ctv-bd svg > :nth-child(3n),   .ctv-bd svg > g > :nth-child(3n)   { opacity: ${f(4.2, 17)}; }`;
  const sweepBase = { position: "absolute" as const, inset: 0, pointerEvents: "none" as const, mixBlendMode: "screen" as const };
  const maskStyle = maskUrl
    ? { WebkitMaskImage: maskUrl, maskImage: maskUrl, WebkitMaskSize: "100% 100%", maskSize: "100% 100%" }
    : {};

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(135deg, ${art.bgStart} 0%, ${art.bgEnd} 100%)`,
        overflow: "hidden",
      }}
    >
      {art.backdropImage ? (
        <Img
          src={staticFile(art.backdropImage)}
          style={{
            position: "absolute",
            inset: -24,
            width: "calc(100% + 48px)",
            height: "calc(100% + 48px)",
            objectFit: "cover",
            opacity: 0.8,
            transform: `translate3d(${driftX * 0.45}px, ${driftY * 0.45}px, 0) scale(1.03)`,
          }}
        />
      ) : null}

      {art.backdropSvg ? (
        <>
          <style>{flicker}</style>
          <div
            className="ctv-bd"
            style={{
              position: "absolute",
              inset: 0,
              opacity: art.backdropImage ? 0.35 : 0.92,
              filter: `drop-shadow(0 0 ${glow.toFixed(1)}px ${withAlpha(art.accentColor, 0.55)})`,
              transform: `translate3d(${driftX * 0.5}px, ${driftY * 0.5}px, 0) scale(${breathe})`,
              pointerEvents: "none",
            }}
            dangerouslySetInnerHTML={{ __html: art.backdropSvg }}
          />
          {maskUrl ? (
            <>
              <div
                style={{
                  ...sweepBase,
                  ...maskStyle,
                  transform: `translate3d(${driftX * 0.5}px, ${driftY * 0.5}px, 0) scale(${breathe})`,
                  background: `linear-gradient(100deg, transparent 0%, transparent 42%, ${art.accentColor} 47%, #ffffff 50%, ${art.secondaryColor} 53%, transparent 58%, transparent 100%)`,
                  backgroundSize: "300% 100%",
                  backgroundPosition: `${sweepX}% 0`,
                }}
              />
              <div
                style={{
                  ...sweepBase,
                  ...maskStyle,
                  transform: `translate3d(${driftX * 0.5}px, ${driftY * 0.5}px, 0) scale(${breathe})`,
                  background: `linear-gradient(180deg, transparent 0%, transparent 44%, ${art.secondaryColor} 48%, #ffffff 50%, ${art.accentColor} 52%, transparent 56%, transparent 100%)`,
                  backgroundSize: "100% 300%",
                  backgroundPosition: `0 ${sweepY}%`,
                }}
              />
            </>
          ) : null}
        </>
      ) : null}

      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at center, ${withAlpha(art.bgStart, 0.46)} 0%, ${withAlpha(art.bgStart, 0.12)} 65%, ${withAlpha(art.bgStart, 0.42)} 100%)`,
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          position: "absolute",
          width: 900,
          height: 900,
          left: -180 + driftX,
          top: -260 + driftY,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${withAlpha(art.accentColor, 0.2)} 0%, rgba(0,0,0,0) 70%)`,
          filter: "blur(70px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          width: 960,
          height: 960,
          right: -220 - driftX,
          bottom: -320 - driftY,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${withAlpha(art.secondaryColor, 0.16)} 0%, rgba(0,0,0,0) 70%)`,
          filter: "blur(80px)",
        }}
      />
    </AbsoluteFill>
  );
};

export const DynamicDemoScene: React.FC<DirectorProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width: outWidth } = useVideoConfig();

  const art: ArtDirection = {
    accentColor: props.artDirection?.accentColor || "#f59e0b",
    secondaryColor: props.artDirection?.secondaryColor || "#38bdf8",
    bgStart: props.artDirection?.bgStart || "#0b0f17",
    bgEnd: props.artDirection?.bgEnd || "#131b2b",
    isDark: props.artDirection?.isDark ?? true,
    backdropSvg: props.artDirection?.backdropSvg || "",
    backdropImage: props.artDirection?.backdropImage || "",
  };

  // Real background brightness decides text colours (art.isDark can disagree with the actual palette).
  const lightBg = luminance(art.bgStart) > 0.55;
  const textColor = lightBg ? "#0f172a" : "#f8fafc";
  const mutedColor = lightBg ? "#334155" : "#cbd5e1";
  const panelBg = lightBg ? "rgba(255, 255, 255, 0.92)" : "rgba(11, 16, 28, 0.86)";
  // Accent used as text/ink: darkened on light backgrounds so it stays readable.
  const accentInk = lightBg && luminance(art.accentColor) > 0.2 ? darken(art.accentColor, 0.55) : art.accentColor;
  const badgeBg = lightBg ? art.accentColor : withAlpha(art.accentColor, 0.18);
  const badgeInk = lightBg ? (luminance(art.accentColor) > 0.35 ? "#0f172a" : "#ffffff") : art.accentColor;
  const borderColor = withAlpha(art.accentColor, 0.38);

  const introFrames = Math.max(1, Math.round(props.introSec * fps));
  const uiFrames = Math.max(1, Math.round(props.uiUsedSec * fps));
  const uiStart = introFrames;
  const outroStart = Math.min(durationInFrames - 1, uiStart + uiFrames);
  const progress = clamp(frame / Math.max(1, durationInFrames - 1), 0, 1);

  const beats = props.storyBeats && props.storyBeats.length > 0 ? props.storyBeats : props.chapters;
  const maxUiSec = Math.max(0.1, uiFrames / fps);
  const localUiSec = clamp((frame - uiStart) / fps, 0, maxUiSec);
  const beatCount = Math.max(1, beats.length);
  const timings = props.sceneTimings && props.sceneTimings.length === beats.length ? props.sceneTimings : null;
  let activeIndex = clamp(Math.floor((localUiSec / maxUiSec) * beatCount), 0, beatCount - 1);
  if (timings) {
    // Scene manifest drives the active chapter: last scene whose start <= current time.
    activeIndex = 0;
    for (let i = 0; i < timings.length; i++) {
      if (localUiSec >= timings[i].startSec) activeIndex = i;
    }
  }
  const activeBeat = beats[activeIndex];
  const stopReason = props.stopReason || "";

  const settle = interpolate(localUiSec, [0, 2.0], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  const introEnter = spring({ frame, fps, config: { damping: 16, mass: 0.8 } });
  const introFade = interpolate(frame, [introFrames - 10, introFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const outroEnter = spring({ frame: frame - outroStart, fps, config: { damping: 18, mass: 0.8 } });

  // The layout is authored at 1920x1080 and scaled to the requested output size (480p … 4K).
  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: art.bgStart }}>
    <AbsoluteFill
      style={{
        width: 1920,
        height: 1080,
        transform: `scale(${outWidth / 1920})`,
        transformOrigin: "0 0",
        backgroundColor: art.bgStart,
        overflow: "hidden",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <AiGeneratedBackdrop art={art} frame={frame} />

      {/* Progress bar */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, zIndex: 50, backgroundColor: withAlpha(textColor, 0.12) }}>
        <div
          style={{
            height: "100%",
            width: `${progress * 100}%`,
            background: `linear-gradient(90deg, ${art.accentColor}, ${art.secondaryColor})`,
          }}
        />
      </div>

      {/* Intro */}
      {frame < introFrames + 2 && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: introFade, padding: 80 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 18,
              maxWidth: 1280,
              transform: `translateY(${(1 - introEnter) * 20}px) scale(${0.96 + introEnter * 0.04})`,
            }}
          >
            <div
              style={{
                padding: "6px 14px",
                borderRadius: 999,
                border: `1px solid ${borderColor}`,
                backgroundColor: panelBg,
                color: accentInk,
                fontSize: 13,
                fontWeight: 800,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
              }}
            >
              {props.repoName}
            </div>
            <div style={{ fontSize: 70, lineHeight: 1.05, fontWeight: 900, letterSpacing: "-0.03em", textAlign: "center", color: textColor }}>
              {props.videoTitle}
            </div>
            <div style={{ fontSize: 25, lineHeight: 1.4, color: mutedColor, textAlign: "center", maxWidth: 960 }}>
              {props.introLine}
            </div>
          </div>
        </AbsoluteFill>
      )}

      {/* Main UI Stage */}
      <Sequence from={uiStart} durationInFrames={uiFrames}>
        <AbsoluteFill style={{ padding: "24px 96px", justifyContent: "center" }}>
          {stopReason ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 14px",
                marginBottom: 10,
                borderRadius: 12,
                border: `1px solid ${withAlpha(art.accentColor, 0.55)}`,
                backgroundColor: panelBg,
                color: mutedColor,
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: art.accentColor, flexShrink: 0 }} />
              <span>{stopReason}</span>
            </div>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  backgroundColor: badgeBg,
                  border: `1px solid ${borderColor}`,
                  color: badgeInk,
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                }}
              >
                {activeBeat?.title || props.videoTitle}
              </span>
              <span style={{ fontSize: 24, fontWeight: 800, color: textColor, letterSpacing: "-0.02em" }}>
                {props.videoTitle}
              </span>
            </div>
            <span style={{ fontSize: 13, color: mutedColor, fontWeight: 700 }}>{props.displayUrl}</span>
          </div>

          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", perspective: settle > 0 ? 1400 : undefined }}>
            <div
              style={{
                width: "78%",
                height: "100%",
                maxHeight: 780,
                borderRadius: 20,
                overflow: "hidden",
                backgroundColor: lightBg ? "#ffffff" : "#080c16",
                border: `1px solid ${borderColor}`,
                boxShadow: `0 28px 80px rgba(0, 0, 0, 0.55), 0 0 60px ${withAlpha(art.accentColor, 0.24)}`,
                display: "flex",
                flexDirection: "column",
                transform: settle > 0 ? `scale(${1 + settle * 0.03}) rotateX(${settle * 1.4}deg) rotateY(${settle * 3.2}deg)` : "none",
              }}
            >
              <div
                style={{
                  height: 38,
                  backgroundColor: lightBg ? "#f1f5f9" : "#0d1322",
                  borderBottom: `1px solid ${borderColor}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 16px",
                }}
              >
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#ff5f57" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#febc2e" }} />
                <div style={{ width: 10, height: 10, borderRadius: "50%", backgroundColor: "#28c840" }} />
                <div style={{ marginLeft: 12, fontSize: 12, color: mutedColor, fontWeight: 600 }}>{props.displayUrl}</div>
              </div>

              <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
                <OffthreadVideo
                  src={staticFile(props.uiVideoFile || "ui-capture.mp4")}
                  endAt={uiFrames}
                  muted
                  style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                />
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 14,
              minHeight: 70,
              borderRadius: 16,
              border: `1px solid ${borderColor}`,
              backgroundColor: panelBg,
              padding: "14px 24px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 22, fontWeight: 700, color: textColor }}>{activeBeat?.caption || ""}</span>
            <span style={{ fontSize: 12, color: accentInk, fontWeight: 800, letterSpacing: "0.12em" }}>
              {activeIndex + 1} / {beatCount}
            </span>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Outro */}
      {frame >= outroStart - 2 && (
        <AbsoluteFill
          style={{
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: withAlpha(art.bgStart, 0.9),
            opacity: clamp(outroEnter, 0, 1),
            padding: 80,
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 16,
              textAlign: "center",
              transform: `translateY(${(1 - outroEnter) * 18}px)`,
            }}
          >
            <div style={{ fontSize: 13, letterSpacing: "0.2em", textTransform: "uppercase", color: accentInk, fontWeight: 800 }}>
              {props.repoName}
            </div>
            <div style={{ fontSize: 64, fontWeight: 900, letterSpacing: "-0.03em", color: textColor }}>
              {props.videoTitle}
            </div>
            <div style={{ fontSize: 26, color: mutedColor, maxWidth: 960 }}>{props.outroLine}</div>
            {stopReason ? (
              <div style={{ fontSize: 15, color: accentInk, maxWidth: 980, lineHeight: 1.45 }}>{stopReason}</div>
            ) : null}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
    </AbsoluteFill>
  );
};
