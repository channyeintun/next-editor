## Mandatory Workflow

After completing the work, provide:

- A recommended Git commit message following the Conventional Commits specification (e.g., `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

### Default Principles

- Always finish by providing a recommended Git commit message

### Resource Constraints

This environment runs on a low-memory (900MB RAM) VPS. To avoid OOM kills and hangs:

- Do not run background agents, background tools, or background/detached commands (no `&`, `nohup`, watch/dev servers left running, etc.).
- Do not run a full-repo-wide typecheck or test command. Scope typecheck/test/lint runs to the specific file(s) or package(s) you changed.
- Prefer targeted commands (e.g. `tsc --noEmit <file>`, running a single test file) over workspace-wide equivalents.
