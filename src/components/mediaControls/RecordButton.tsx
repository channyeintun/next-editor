import { Circle, Plus, Square } from "lucide-react";
import IdleRecordButton from "../IdleRecordButton";

/** What a press does: stop the running take, clear a finished one to start over, or start one. */
type RecordButtonAction = "stop" | "new" | "start";

const TITLES: Record<RecordButtonAction, string> = {
  stop: "Stop Recording",
  new: "New Recording",
  start: "Start Recording",
};

function recordButtonAction(isRecording: boolean, hasRecording: boolean): RecordButtonAction {
  if (isRecording) return "stop";
  if (hasRecording) return "new";
  return "start";
}

const RecordButtonIcon = ({
  action,
  isRecordingPaused,
  size,
  plusSize,
}: {
  action: RecordButtonAction;
  isRecordingPaused: boolean;
  size: number;
  plusSize: number;
}) => {
  if (action === "stop") {
    return (
      <Square
        size={size}
        className={`fill-red-500 text-red-500 ${isRecordingPaused ? "" : "animate-pulse"}`}
      />
    );
  }
  if (action === "new") {
    return (
      <div className="relative">
        <Circle size={size} className="fill-red-500 text-red-500" />
        <div className="absolute -top-1 -right-1.5 bg-[#202732] rounded-full p-[0.5px]">
          <Plus size={plusSize} className="text-red-500 stroke-[3px]" />
        </div>
      </div>
    );
  }
  return <IdleRecordButton size={size} />;
};

/** The player bar's record button: starts a take, stops it, or clears it for a new one. */
const RecordButton = ({
  isRecording,
  isRecordingPaused,
  hasRecording,
  disabled,
  iconSize,
  plusSize,
  onClick,
}: {
  isRecording: boolean;
  isRecordingPaused: boolean;
  /** A finished take is loaded, which a press clears. */
  hasRecording: boolean;
  disabled: boolean;
  iconSize: number;
  plusSize: number;
  onClick: () => void;
}) => {
  const action = recordButtonAction(isRecording, hasRecording);
  return (
    <button
      data-tour="record"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center transition-colors relative pointer-events-auto ${disabled ? "opacity-50 cursor-not-allowed" : "hover:opacity-80 cursor-pointer"}`}
      title={TITLES[action]}
    >
      <RecordButtonIcon
        action={action}
        isRecordingPaused={isRecordingPaused}
        size={iconSize}
        plusSize={plusSize}
      />
    </button>
  );
};

export default RecordButton;
