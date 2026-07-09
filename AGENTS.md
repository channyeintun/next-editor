## Mandatory Workflow

For every task except trivial one-line requests:

1. First, decompose the task into the smallest reasonable atomic subtasks.
2. Identify which subtasks can be executed independently and in parallel.
3. Spawn Haiku subagents for every independent subtask by default, unless a more capable model is clearly required.
4. Keep each subagent focused on a single, well-defined objective with clear inputs and expected outputs.
5. Once all subagents complete, consolidate their outputs, resolve conflicts, and perform final integration and validation.
6. Prefer many small, composable tasks over large monolithic changes.
7. Before implementation, briefly state the decomposition and delegation plan unless the task is trivial.
8. After completing the work, provide:
   - A concise summary of the changes made.
   - Any important caveats or follow-up work.
   - A recommended Git commit message following the Conventional Commits specification (e.g., `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`).

### Default Principles

- Think atomically.
- Parallelize aggressively.
- Delegate independent work to Haiku subagents whenever practical.
- Reserve the primary agent for planning, architecture, integration, and final review.
- Optimize for correctness, maintainability, and low latency through concurrent execution.
- Never perform a large multi-file implementation without first considering whether it can be decomposed into parallel subtasks.
- Always finish by providing a recommended Git commit message.
