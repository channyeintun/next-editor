function IdleRecordButton({ size = 14 }: { size?: number }) {
  const ringWidth = Math.max(2, Math.round(size * 0.12));
  const dotSize = size * 0.5;

  return (
    <div
      className="relative flex items-center justify-center rounded-full border-red-500/70"
      style={{ width: size, height: size, borderWidth: ringWidth }}
    >
      <div className="rounded-full bg-red-500" style={{ width: dotSize, height: dotSize }} />
    </div>
  );
}

export default IdleRecordButton;
