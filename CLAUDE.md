# Know Which Machine You Are On

This repository is worked on from two very different machines. Check the platform before assuming any resource constraint:

- **macOS workstation** (`darwin`, Apple Silicon — `uname -s` prints `Darwin`). This is Chan's Mac, where Claude Code runs. It is a normal development machine: run the full verification suite here (`vp check`, `bun run typecheck`, `vp lint`, `vp test`, builds) before claiming work is done. None of the VPS constraints below apply.
- **Low-resource VPS** (`linux`, 1 × `x86_64` `DO-Regular` vCPU, ~961 MiB RAM — `uname -s` prints `Linux`). This is where Codex runs. The strict process and memory constraints in the next section are mandatory there and only there.

## VPS-Only: Process and Memory Safety (skip entirely on macOS)

On the VPS, this is the repository's highest-priority operational constraint. The VPS cannot safely absorb concurrent, lingering, or memory-heavy work:

- Never create or run subagents.
- Never run commands, tools, tests, or agents in the background, detached, or concurrently.
- Run exactly one bounded foreground operation at a time.
- Never use `&`, `nohup`, watch mode, detached servers, or leave a process running after a turn or interruption.
- Treat an interrupted command as potentially still running; stop only the specifically identified process before doing further work.
- Never run memory-heavy commands or tools, including full-repository builds, tests, typechecks, linters, browser automation, bundle analysis, or bulk code generation.
- Do not run a full-repo-wide typecheck or test command. Scope typecheck/test/lint runs to the specific file(s) or package(s) you changed, using the smallest targeted check possible (e.g. `tsc --noEmit <file>` or one test file) with a single worker/thread whenever supported.
- If verification cannot be performed on the VPS without a memory-heavy operation, do not run it there. Report the skipped check so it can be run on the workstation or in CI.

## Mandatory Workflow (all machines)

After completing the work, provide:

- A recommended Git commit message following the Conventional Commits specification (e.g., `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

### Default Principles

- Always finish by providing a recommended Git commit message
- After every successful commit, push the current branch to `origin`.
- For HTTPS pushes, use `channyeintun` as the GitHub username and the value of the `NE_GITHUB_TOKEN` environment variable as the password.
- Never print, log, commit, or embed `NE_GITHUB_TOKEN` in a Git remote URL. If the variable is unset or authentication fails, report that the push could not be completed without exposing the token.
