import React from "react";
import { Composition } from "remotion";
import { defaultDirectorProps, DynamicDemoScene, type DirectorProps } from "./DynamicDemoScene";
import { PromoScene } from "./PromoScene";

// The pipeline passes the real capture length and the director script through --props.
// calculateMetadata makes the composition duration follow those props instead of a fixed value.
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="DemoScene"
        component={DynamicDemoScene}
        durationInFrames={defaultDirectorProps.durationInFrames}
        fps={defaultDirectorProps.fps}
        width={1280}
        height={720}
        defaultProps={defaultDirectorProps}
        calculateMetadata={({ props }: { props: DirectorProps }) => {
          const fps = Number(props.fps) || defaultDirectorProps.fps;
          // Dynamic duration: only the trimmed capture + intro + outro.
          const usedDuration =
            Number(props.uiUsedSec) ||
            Number(props.uiDurationSec) ||
            defaultDirectorProps.uiUsedSec;
          const introSec = Number(props.introSec) || defaultDirectorProps.introSec;
          const outroSec = Number(props.outroSec) || defaultDirectorProps.outroSec;
          const durationInFrames = Math.max(1, Math.round((usedDuration + introSec + outroSec) * fps));
          // Output size follows the requested quality (480p … 4K); layout scales inside the composition.
          const height = Math.min(2160, Math.max(480, Math.round(Number(props.outHeight) || 720)));
          const width = 2 * Math.round((height * 16) / 9 / 2);
          return {
            durationInFrames,
            fps,
            width,
            height,
          };
        }}
      />
      <Composition
        id="PromoScene"
        component={PromoScene}
        durationInFrames={defaultDirectorProps.durationInFrames}
        fps={defaultDirectorProps.fps}
        width={1280}
        height={720}
        defaultProps={defaultDirectorProps}
        calculateMetadata={({ props }: { props: DirectorProps }) => {
          const fps = Number(props.fps) || defaultDirectorProps.fps;
          // Dynamic duration: only the trimmed capture + intro + outro.
          const usedDuration =
            Number(props.uiUsedSec) ||
            Number(props.uiDurationSec) ||
            defaultDirectorProps.uiUsedSec;
          const introSec = Number(props.introSec) || defaultDirectorProps.introSec;
          const outroSec = Number(props.outroSec) || defaultDirectorProps.outroSec;
          const durationInFrames = Math.max(1, Math.round((usedDuration + introSec + outroSec) * fps));
          // Output size follows the requested quality (480p … 4K); layout scales inside the composition.
          const height = Math.min(2160, Math.max(480, Math.round(Number(props.outHeight) || 720)));
          const width = 2 * Math.round((height * 16) / 9 / 2);
          return {
            durationInFrames,
            fps,
            width,
            height,
          };
        }}
      />
    </>
  );
};
