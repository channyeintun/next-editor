## Highest-Risk Constraint: VPS Process and Memory Safety

This is the repository's highest-priority operational constraint. The VPS cannot safely absorb concurrent, lingering, or memory-heavy work:

- Never create or run subagents.
- Never run commands, tools, tests, or agents in the background, detached, or concurrently.
- Run exactly one bounded foreground operation at a time.
- Never use `&`, `nohup`, watch mode, detached servers, or leave a process running after a turn or interruption.
- Treat an interrupted command as potentially still running; stop only the specifically identified process before doing further work.
- Never run memory-heavy commands or tools; obey all additional resource limits below.

## Mandatory Workflow

After completing the work, provide:

- A recommended Git commit message following the Conventional Commits specification (e.g., `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

### Default Principles

- Always finish by providing a recommended Git commit message
- After every successful commit, push the current branch to `origin`.
- For HTTPS pushes, use `channyeintun` as the GitHub username and the value of the `NE_GITHUB_TOKEN` environment variable as the password.
- Never print, log, commit, or embed `NE_GITHUB_TOKEN` in a Git remote URL. If the variable is unset or authentication fails, report that the push could not be completed without exposing the token.

### Resource Constraints

This environment currently exposes 984,560 kB (about 961 MiB) of total RAM and 1 `x86_64` vCPU identified as `DO-Regular`. The following are strict, non-optional constraints. Do not relax them for speed or convenience:

- Do not create or run subagents. Complete all work in the primary agent only.
- Do not run background, detached, or concurrent agents, tools, or commands. Run only one bounded foreground operation at a time; never use `&`, `nohup`, watch mode, or leave a dev server running.
- Do not run memory-heavy commands or tools, including full-repository builds, tests, typechecks, linters, browser automation, bundle analysis, or bulk code generation.
- Do not run a full-repo-wide typecheck or test command. Scope typecheck/test/lint runs to the specific file(s) or package(s) you changed.
- Use the smallest targeted check possible (e.g. `tsc --noEmit <file>` or one test file), with a single worker/thread whenever supported.
- If verification cannot be performed without a memory-heavy operation, do not run it. Report the skipped check and the resource constraint instead.
