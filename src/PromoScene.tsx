import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  OffthreadVideo,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { clamp, darken, luminance, withAlpha, type DirectorProps } from "./DynamicDemoScene";

/**
 * Corporate-ad format. Same recorded scenes as the demo format, different direction:
 * clean gradient stage, floating browser window with camera moves, a zoomed call-out of the exact UI area the
 * action touched (cropped from the REAL recording — nothing is invented), word-by-word captions, end card.
 * Authored at 1920x1080 and scaled to the output size. No audio.
 */

const WIN_W = 1380;
const WIN_VIDEO_H = (WIN_W * 9) / 16; // 843.75
const WIN_BAR = 44;

const ease = Easing.bezier(0.22, 1, 0.36, 1);

/** Words appear one after another; the last words use the accent colour. */
const KineticText: React.FC<{
  text: string;
  frame: number;
  size: number;
  color: string;
  accent: string;
  weight?: number;
  stagger?: number;
  align?: "center" | "left";
  accentTail?: number;
}> = ({ text, frame, size, color, accent, weight = 800, stagger = 3, align = "center", accentTail = 0 }) => {
  const words = text.split(/\s+/).filter(Boolean);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: align === "center" ? "center" : "flex-start", gap: `0 ${size * 0.28}px`, lineHeight: 1.12 }}>
      {words.map((w, i) => {
        const t = clamp((frame - i * stagger) / 9, 0, 1);
        const isAccent = accentTail > 0 && i >= words.length - accentTail;
        return (
          <span
            key={i}
            style={{
              fontSize: size,
              fontWeight: weight,
              letterSpacing: "-0.02em",
              color: isAccent ? accent : color,
              opacity: ease(t),
              transform: `translateY(${(1 - ease(t)) * size * 0.45}px)`,
              display: "inline-block",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

export const PromoScene: React.FC<DirectorProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width: outWidth } = useVideoConfig();

  const accent = props.artDirection?.accentColor || "#6aa7ff";
  const secondary = props.artDirection?.secondaryColor || "#9b8cff";
  const bgStart = props.artDirection?.bgStart || "#0a1226";
  const bgEnd = props.artDirection?.bgEnd || "#101b3a";
  const light = luminance(bgStart) > 0.55;
  const text = light ? "#0f172a" : "#f8fafc";
  const muted = light ? "#475569" : "#a9b7d0";
  const cardBg = light ? "#ffffff" : "#ffffff";
  const cardInk = "#0f172a";
  const accentInk = light && luminance(accent) > 0.2 ? darken(accent, 0.5) : accent;

  const introFrames = Math.max(1, Math.round(props.introSec * fps));
  const uiFrames = Math.max(1, Math.round(props.uiUsedSec * fps));
  const uiStart = introFrames;
  const outroStart = Math.min(durationInFrames - 1, uiStart + uiFrames);
  const uiSec = Math.max(0.1, uiFrames / fps);
  const localSec = clamp((frame - uiStart) / fps, 0, uiSec);

  const beats = props.storyBeats && props.storyBeats.length > 0 ? props.storyBeats : props.chapters.map((c, i) => ({ id: `b${i}`, ...c }));
  const timings = props.sceneTimings && props.sceneTimings.length === beats.length ? props.sceneTimings : null;
  let activeIndex = clamp(Math.floor((localSec / uiSec) * beats.length), 0, beats.length - 1);
  if (timings) {
    activeIndex = 0;
    timings.forEach((t, i) => {
      if (localSec >= t.startSec) activeIndex = i;
    });
  }
  const beat = beats[activeIndex];
  const sceneStartSec = timings ? timings[activeIndex].startSec : (activeIndex / beats.length) * uiSec;
  const sceneEndSec = timings ? timings[activeIndex].endSec : ((activeIndex + 1) / beats.length) * uiSec;
  const sceneFrame = Math.max(0, Math.round((localSec - sceneStartSec) * fps));
  const sceneProgress = clamp((localSec - sceneStartSec) / Math.max(0.2, sceneEndSec - sceneStartSec), 0, 1);

  // ---- camera: focus on the real action (nearest focus point in time, inside this scene)
  const foci = props.focusPoints || [];
  let focus: (typeof foci)[number] | null = null;
  let best = 1e9;
  for (const f of foci) {
    const d = Math.abs(localSec - f.atSec);
    if (d < best && localSec >= f.atSec - 1.0 && localSec <= f.atSec + 2.4) {
      best = d;
      focus = f;
    }
  }
  const bump = focus
    ? interpolate(localSec - focus.atSec, [-1.0, -0.25, 1.2, 2.4], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) })
    : 0;
  const fx = focus ? clamp(focus.x + focus.w / 2, 0.08, 0.92) : 0.5;
  const fy = focus ? clamp(focus.y + focus.h / 2, 0.1, 0.9) : 0.5;
  const zoom = 1 + 0.42 * bump;

  // slow push-in over the scene + gentle float, plus a little "whoosh" when a new scene starts
  const enter = spring({ frame: sceneFrame, fps, config: { damping: 18, mass: 0.7 } });
  const tiltY = -7 + Math.sin(frame / 80) * 1.6 + sceneProgress * 3;
  const tiltX = 2.2 + Math.cos(frame / 95) * 0.8;
  const push = 1 + sceneProgress * 0.035;

  const uiProgress = clamp(frame / Math.max(1, durationInFrames - 1), 0, 1);
  const uiSrc = staticFile(props.uiVideoFile || "ui-capture.mp4");

  // ---- intro / outro envelopes
  const introVisible = frame < introFrames + 2;
  const introFade = interpolate(frame, [introFrames - 10, introFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const outroT = clamp((frame - outroStart) / 16, 0, 1);
  const productName = props.repoName || props.videoTitle;
  const fileHint = (props.uploadName || "").split(",")[0]?.trim() || "";
  const clip = (t: string, n: number) => {
    if (t.length <= n) return t;
    const cut = t.slice(0, n);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 12))}…`;
  };
  const summary = clip(props.repoSummary || props.introLine || "", 64);

  const float = (k: number, amp = 10) => Math.sin(frame / 28 + k) * amp;
  const stageStyle: React.CSSProperties = { width: 1920, height: 1080, transform: `scale(${outWidth / 1920})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0, overflow: "hidden" };

  return (
    <AbsoluteFill style={{ backgroundColor: bgStart, overflow: "hidden", fontFamily: "'Inter', -apple-system, 'Segoe UI', Roboto, sans-serif" }}>
      <div style={stageStyle}>
        {/* background: clean gradient with two slow glows */}
        <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 35%, ${withAlpha(accent, light ? 0.18 : 0.22)} 0%, rgba(0,0,0,0) 60%), linear-gradient(160deg, ${bgStart} 0%, ${bgEnd} 100%)` }} />
        <div style={{ position: "absolute", width: 1100, height: 1100, left: -300 + Math.sin(frame / 120) * 60, top: -380, borderRadius: "50%", background: `radial-gradient(circle, ${withAlpha(accent, 0.16)} 0%, rgba(0,0,0,0) 70%)`, filter: "blur(60px)" }} />
        <div style={{ position: "absolute", width: 1000, height: 1000, right: -280 - Math.cos(frame / 140) * 60, bottom: -420, borderRadius: "50%", background: `radial-gradient(circle, ${withAlpha(secondary, 0.14)} 0%, rgba(0,0,0,0) 70%)`, filter: "blur(70px)" }} />

        {/* progress */}
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 5, backgroundColor: withAlpha(text, 0.1), zIndex: 40 }}>
          <div style={{ height: "100%", width: `${uiProgress * 100}%`, background: `linear-gradient(90deg, ${accent}, ${secondary})` }} />
        </div>

        {/* ---------------- INTRO ---------------- */}
        {introVisible ? (
          <AbsoluteFill style={{ opacity: introFade, alignItems: "center", justifyContent: "center" }}>
            {fileHint ? (
              <div style={{ position: "absolute", left: 250, top: 230 + float(0), transform: `rotate(-3deg) scale(${0.9 + 0.1 * ease(clamp(frame / 14, 0, 1))})`, opacity: ease(clamp((frame - 6) / 12, 0, 1)), background: cardBg, color: cardInk, borderRadius: 22, padding: "18px 26px", boxShadow: "0 24px 60px rgba(0,0,0,0.35)", display: "flex", gap: 18, alignItems: "center" }}>
                <div style={{ width: 56, height: 56, borderRadius: 14, background: `linear-gradient(135deg, ${accent}, ${secondary})`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 900 }}>{productName.slice(0, 1).toUpperCase()}</div>
                <div>
                  <div style={{ fontSize: 15, letterSpacing: "0.16em", color: "#64748b", fontWeight: 700 }}>NEW FILE</div>
                  <div style={{ fontSize: 30, fontWeight: 800 }}>{fileHint.slice(0, 34)}</div>
                </div>
              </div>
            ) : null}
            <div style={{ position: "absolute", right: 250, top: 300 + float(2), transform: `rotate(2.5deg) scale(${0.9 + 0.1 * ease(clamp((frame - 10) / 14, 0, 1))})`, opacity: ease(clamp((frame - 12) / 12, 0, 1)), background: cardBg, color: cardInk, borderRadius: 26, padding: "16px 26px", fontSize: 30, fontWeight: 700, boxShadow: "0 24px 60px rgba(0,0,0,0.35)", maxWidth: 520 }}>
              {summary}
            </div>
            <div style={{ maxWidth: 1400, display: "flex", flexDirection: "column", alignItems: "center", gap: 26, marginTop: 70 }}>
              <KineticText text={props.videoTitle} frame={Math.max(0, frame - 4)} size={104} color={text} accent={accentInk} stagger={4} accentTail={1} />
              <div style={{ opacity: ease(clamp((frame - 22) / 14, 0, 1)), fontSize: 38, color: muted, textAlign: "center", maxWidth: 1100 }}>{props.introLine}</div>
            </div>
          </AbsoluteFill>
        ) : null}

        {/* ---------------- STAGE (real recording) ---------------- */}
        <Sequence from={uiStart} durationInFrames={uiFrames}>
          {/* step chip + dots */}
          <div style={{ position: "absolute", left: 80, top: 40, display: "flex", alignItems: "center", gap: 16, opacity: ease(clamp(sceneFrame / 10, 0, 1)), transform: `translateX(${(1 - ease(clamp(sceneFrame / 12, 0, 1))) * -40}px)` }}>
            <div style={{ padding: "9px 18px", borderRadius: 999, background: accent, color: light && luminance(accent) < 0.35 ? "#fff" : "#0b1020", fontWeight: 900, fontSize: 20, letterSpacing: "0.12em" }}>
              {String(activeIndex + 1).padStart(2, "0")} / {String(beats.length).padStart(2, "0")}
            </div>
            <div style={{ fontSize: 34, fontWeight: 800, color: text, letterSpacing: "-0.01em" }}>{beat?.title}</div>
          </div>
          <div style={{ position: "absolute", right: 80, top: 52, display: "flex", gap: 10 }}>
            {beats.map((_, i) => (
              <div key={i} style={{ width: i === activeIndex ? 44 : 14, height: 14, borderRadius: 7, background: i <= activeIndex ? accent : withAlpha(text, 0.22), transition: "none" }} />
            ))}
          </div>

          {/* floating browser window */}
          <div style={{ position: "absolute", left: (1920 - WIN_W) / 2, top: 104, width: WIN_W, perspective: 2200, transform: `translateY(${(1 - enter) * 26}px)` }}>
            <div style={{ transform: `rotateY(${tiltY * (1 - bump * 0.85)}deg) rotateX(${tiltX * (1 - bump * 0.85)}deg) scale(${push})`, transformStyle: "preserve-3d", borderRadius: 22, overflow: "hidden", background: "#0b1020", boxShadow: `0 50px 120px rgba(0,0,0,0.5), 0 0 0 1px ${withAlpha(accent, 0.35)}, 0 0 90px ${withAlpha(accent, 0.22)}` }}>
              <div style={{ height: WIN_BAR, background: light ? "#eef2f7" : "#141b2e", display: "flex", alignItems: "center", gap: 9, padding: "0 18px" }}>
                <i style={{ width: 12, height: 12, borderRadius: 6, background: "#ff5f57" }} /><i style={{ width: 12, height: 12, borderRadius: 6, background: "#febc2e" }} /><i style={{ width: 12, height: 12, borderRadius: 6, background: "#28c840" }} />
                <span style={{ marginLeft: 14, fontSize: 16, color: muted, fontWeight: 600 }}>{props.displayUrl}</span>
              </div>
              <div style={{ width: WIN_W, height: WIN_VIDEO_H, overflow: "hidden", position: "relative" }}>
                <div style={{ width: WIN_W, height: WIN_VIDEO_H, transformOrigin: `${fx * 100}% ${fy * 100}%`, transform: `scale(${zoom})` }}>
                  <OffthreadVideo src={uiSrc} endAt={uiFrames} muted style={{ width: WIN_W, height: WIN_VIDEO_H, objectFit: "cover", display: "block" }} />
                </div>
              </div>
            </div>
          </div>

          {/* call-out: zoomed crop of the exact UI area (real pixels) */}
          {focus && bump > 0.02 ? (
            <div style={{ position: "absolute", right: 70, bottom: 215, width: 580, opacity: clamp(bump * 1.6, 0, 1), transform: `translateY(${float(1, 7) + (1 - bump) * 30}px) scale(${0.92 + 0.08 * bump}) rotate(1.2deg)` }}>
              <div style={{ position: "absolute", left: 18, top: -22, zIndex: 3, padding: "7px 16px", borderRadius: 999, background: accent, color: light && luminance(accent) < 0.35 ? "#fff" : "#0b1020", fontWeight: 800, fontSize: 19 }}>{focus.label.slice(0, 28)}</div>
              <div style={{ width: 580, height: 326, borderRadius: 20, overflow: "hidden", background: "#fff", boxShadow: `0 30px 80px rgba(0,0,0,0.5), 0 0 0 3px ${accent}` }}>
                <div style={{ width: WIN_W, height: WIN_VIDEO_H, transformOrigin: "0 0", transform: `translate(${clamp(290 - fx * WIN_W * 2.3, 580 - WIN_W * 2.3, 0)}px, ${clamp(163 - fy * WIN_VIDEO_H * 2.3, 326 - WIN_VIDEO_H * 2.3, 0)}px) scale(2.3)` }}>
                  <OffthreadVideo src={uiSrc} endAt={uiFrames} muted style={{ width: WIN_W, height: WIN_VIDEO_H, objectFit: "cover", display: "block" }} />
                </div>
              </div>
            </div>
          ) : null}

          {/* caption */}
          <div key={activeIndex} style={{ position: "absolute", left: 120, right: 120, bottom: 38, display: "flex", justifyContent: "center" }}>
            <KineticText text={beat?.caption || ""} frame={sceneFrame} size={56} color={text} accent={accentInk} stagger={3} accentTail={2} weight={800} />
          </div>
        </Sequence>

        {/* ---------------- OUTRO ---------------- */}
        {frame >= outroStart - 2 ? (
          <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(bgStart, 0.94), opacity: ease(outroT) }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 26, transform: `translateY(${(1 - ease(outroT)) * 30}px) scale(${0.94 + 0.06 * ease(outroT)})` }}>
              <div style={{ width: 150, height: 150, borderRadius: 38, background: `linear-gradient(135deg, ${accent}, ${secondary})`, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 84, fontWeight: 900, boxShadow: `0 30px 80px ${withAlpha(accent, 0.45)}` }}>
                {productName.slice(0, 1).toUpperCase()}
              </div>
              <div style={{ fontSize: 108, fontWeight: 900, letterSpacing: "-0.03em", color: text }}>{productName}</div>
              <div style={{ fontSize: 42, color: muted, textAlign: "center", maxWidth: 1200 }}>{props.outroLine}</div>
              <div style={{ marginTop: 8, padding: "12px 28px", borderRadius: 999, border: `2px solid ${withAlpha(accent, 0.6)}`, color: accentInk, fontSize: 26, fontWeight: 700 }}>{props.displayUrl}</div>
            </div>
          </AbsoluteFill>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
