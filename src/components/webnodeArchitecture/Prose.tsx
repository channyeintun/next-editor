/** `text` with each run between backticks set as code. */
export default function Prose({ text }: { text: string }) {
  return (
    <>
      {text
        .split("`")
        .map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part))}
    </>
  );
}
