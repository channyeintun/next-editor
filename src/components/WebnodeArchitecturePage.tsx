import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  ArchitectureSheetNav,
  architectureSheetNumber,
  architectureSheetStyles,
} from "./architectureSheet";
import FlowPlayer, { flowPlayerStyles } from "./webnodeArchitecture/FlowPlayer";
import { DESIGN_NOTES, MESSAGE_CHANNELS, PARTS } from "./webnodeArchitecture/parts";
import Prose from "./webnodeArchitecture/Prose";

// What this sheet adds to the shared one: the notes here carry code and name
// their source files.
const styles = `
.arch-page .note code{ font-size:12px; }
.arch-page .note .src{ font-family:var(--font-mono); font-size:11px; color:var(--ink-faint); }
.arch-page .source-line{ margin:18px 0 0; font-size:12px; color:var(--ink-faint); }
.arch-page .source-line a{ color:var(--blue); text-decoration:underline; text-underline-offset:3px; }
`;

const SOURCE_URL = "https://github.com/channyeintun/next-editor/tree/main/src/core/webnode";

/** Design notes are lettered, so a letter is never taken for a part's number. */
const noteLetter = (index: number) => String.fromCharCode(65 + index);

export default function WebnodeArchitecturePage() {
  useDocumentTitle("next-editor — webnode runtime");

  return (
    <div className="arch-page">
      <style>{architectureSheetStyles}</style>
      <style>{flowPlayerStyles}</style>
      <style>{styles}</style>
      <div className="page-inner">
        <div className="sheet">
          <div className="titleblock">
            <div>
              <h1>webnode — how it works</h1>
              <p className="sub">
                The Node.js runtime of Next Editor, inside the browser. It runs npm packages as they
                are published (the Vite dev server, Vitest, Express) in Web Workers, on a file
                system in shared memory, and serves the preview through a service worker.
              </p>
            </div>
            <div className="meta">
              <div>
                <b>sheet</b>
                <span>{architectureSheetNumber("webnode")}</span>
              </div>
              <div>
                <b>scale</b>
                <span>nts</span>
              </div>
              <div>
                <b>rev</b>
                <span>A</span>
              </div>
              <div>
                <b>date</b>
                <span>2026-11-22</span>
              </div>
            </div>
          </div>

          <ArchitectureSheetNav current="webnode" />

          <FlowPlayer />

          <div className="notes">
            <h2>Parts</h2>
            <ol className="notes-grid" role="list">
              {PARTS.map((part, index) => (
                <li className="note" key={part.id}>
                  <span className="n">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <b>{part.noteTitle ?? part.title} —</b>{" "}
                    <span className="d">
                      <Prose text={part.detail} />
                    </span>{" "}
                    <span className="src">{part.source}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>

          <div className="notes">
            <h2>Design notes</h2>
            <ul className="notes-grid" role="list">
              {DESIGN_NOTES.map((note, index) => (
                <li className="note" key={note.title}>
                  <span className="n">{noteLetter(index)}</span>
                  <span>
                    <b>{note.title} —</b>{" "}
                    <span className="d">
                      <Prose text={note.detail} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <div className="build">
            <h2 id="wn-messages-heading">Messages</h2>
            <table className="spec-table" aria-labelledby="wn-messages-heading">
              <tbody>
                {MESSAGE_CHANNELS.map((row) => (
                  <tr key={row.channel}>
                    <th scope="row">{row.channel}</th>
                    <td>
                      {row.messages.map((message) => (
                        <code key={message}>{message}</code>
                      ))}{" "}
                      <span className="note-inline">— {row.note}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="source-line">
              Every statement on this sheet is read from the code:{" "}
              <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
                src/core/webnode on GitHub
              </a>
              .
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
