import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "./shared";

/**
 * Pure Haskell lesson starter: a single-file console program that compiles and
 * runs remotely through the Haskell Playground proxy on an explicit Run action
 * (GHC 9.12.4, -O1). The upstream compiles one module named Main from one text
 * body, so the whole lesson lives in Main.hs — there is no .cabal file for the
 * sandbox to read and no way to import a second file of your own, so structure
 * comes from types and functions instead. No package.json, dev server, or
 * WebContainer boot — the workspace stays local until Run.
 *
 * Unlike the Go, Rust and Zig starters, there is no Format button to open
 * against: the playground exposes no formatter endpoint, so the layout below
 * is the layout a learner sees forever. It is verified against the real
 * service on GHC 9.12.4: exit code 0, an empty diagnostics stream (so not one
 * warning), and the output quoted in the README.
 *
 * The file name is capitalized because GHC names it: a diagnostic reads
 * `Main.hs:12:1: error:`, and a learner matching that against a file called
 * `main.hs` is a needless first puzzle.
 */
export function createStarterHaskellWorkspace(): WorkspaceProject {
  const files = {
    "Main.hs": createWorkspaceFile(
      "Main.hs",
      `-- Haskell lesson workspace
--
-- Press Run to compile this file on the Haskell Playground (GHC 9.12.4) and
-- print the program's output in the Haskell Runner below. There is no Format
-- button: the playground has no formatter, so the layout here is yours to
-- keep. There is no network, filesystem, or stdin — everything happens in
-- memory.
--
-- The whole lesson lives in this one file. The playground compiles a single
-- module named Main, so there is no .cabal file and no package manager: use
-- types and functions to keep larger programs tidy.

module Main where

-- A data type lists every shape a value can take. An Event is exactly one of
-- these three, and each constructor carries its own fields.
data Event
  = SignedIn String
  | SignedOut String
  | FailedLogin String Int
  deriving (Show)

-- A type signature reads left to right: describe takes an Event and gives
-- back a String. GHC could work that out on its own; writing it down anyway
-- is how Haskell is normally read.
describe :: Event -> String
describe (SignedIn user) = user ++ " signed in"
describe (SignedOut user) = user ++ " signed out"
describe (FailedLogin user attempts) =
  user ++ " failed to sign in " ++ plural attempts "time"

-- Patterns are tried top to bottom, and a plain literal is a pattern too, so
-- the one-attempt case gets its own line instead of an if.
plural :: Int -> String -> String
plural 1 word = "1 " ++ word
plural count word = show count ++ " " ++ word ++ "s"

-- Pattern matching is not only for your own types: [] is the empty list, and
-- (first : rest) splits a non-empty one into its head and its tail.
failedAttempts :: [Event] -> Int
failedAttempts [] = 0
failedAttempts (FailedLogin _ attempts : rest) = attempts + failedAttempts rest
failedAttempts (_ : rest) = failedAttempts rest

events :: [Event]
events =
  [ SignedIn "Ada"
  , FailedLogin "Grace" 2
  , SignedOut "Ada"
  ]

-- IO () is the type of a step that talks to the outside world, and do runs
-- the steps in order. Everything above is pure: same input, same answer.
main :: IO ()
main = do
  putStrLn "Sign-in log"
  mapM_ (putStrLn . describe) events
  putStrLn ("Failed attempts: " ++ show (failedAttempts events))
  -- describe is our wording; show is the one deriving (Show) wrote for us.
  putStrLn ("Raw value: " ++ show (FailedLogin "Grace" 2))
`,
    ),
    "README.md": createWorkspaceFile(
      "README.md",
      `# Haskell Lesson

1. Open \`Main.hs\` and press **Run** — the program compiles on the Haskell
   Playground (GHC 9.12.4) and its output appears in the Haskell Runner:

   \`\`\`
   Sign-in log
   Ada signed in
   Grace failed to sign in 2 times
   Ada signed out
   Failed attempts: 2
   Raw value: FailedLogin "Grace" 2
   \`\`\`

2. There is no **Format** button. The playground has no formatter, so nothing
   will re-lay-out this file for you — Haskell code is indentation-sensitive,
   and the indentation you type is the indentation that compiles.
3. The whole lesson lives in \`Main.hs\`. The playground compiles one module
   named \`Main\`, so there is no \`.cabal\` file, no package manager, and no way
   to import a second file of your own: structure larger programs with types
   and functions here.
4. Only the packages that ship with GHC are available — \`base\`, \`containers\`
   and \`text\` among them. Nothing from Hackage can be installed.
5. The sandbox has no network and no filesystem, stdin is empty (so
   \`getLine\` and \`getContents\` have nothing to read), and programs that run
   too long are stopped.

## Two things that surprise newcomers

- Nothing here is a statement. \`events\` and \`describe\` are definitions, not
  instructions, and the order they appear in the file does not matter —
  \`describe\` may call \`plural\` before the file has mentioned it. Only \`main\`
  says what actually happens, and only when something needs a value is it
  computed.
- Warnings and errors are different streams from your program's output. A
  program that compiles with warnings still runs and still prints; the runner
  shows the compiler's warnings first, then stdout, then stderr — which is
  where an uncaught error's report appears.
`,
    ),
  };

  return {
    id: "haskell-workspace",
    name: "Haskell Lesson",
    lessonType: "haskell",
    entryFilePath: "Main.hs",
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}
