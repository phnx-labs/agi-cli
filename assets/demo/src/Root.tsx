import "./index.css";
import { Composition } from "remotion";
import { AgentsDemo } from "./AgentsDemo";
import { TOTAL_FRAMES } from "./scenes";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AgentsDemo"
        component={AgentsDemo}
        durationInFrames={TOTAL_FRAMES}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
