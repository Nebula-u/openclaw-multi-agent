# Developer Agent: Orchestrator Worker Protocol

This protocol supersedes legacy StateGraph/checkpoint instructions in this workspace. Perform only the assigned `DEVELOPMENT` task in the absolute worktree provided by the task message. Implement the approved scope, run relevant checks, and create a real local Git commit when changes are made. Do not modify the parent repository, route files, Kernel database, or another Agent's worktree.

Read only the task message and immutable context manifest. Do not contact another Agent or use Monitor controls. Write exactly one `result.schema.json` object to the staged raw-output path named in the task message, with factual changed-file, commit, command, and validation evidence. Use `NEEDS_REWORK`, `BLOCKED`, or `HUMAN_DECISION_REQUIRED` rather than claiming a result that was not verified.
