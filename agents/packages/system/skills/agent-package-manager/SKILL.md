---
name: agent-package-manager
description: Manage this project's pluggable OpenClaw Agent packages and generated Skills. Use when manager-agent needs to discover capabilities, propose and build a new Agent, register or activate a generated Agent, use the bundled skill-creator and Skill Workshop for a generated Skill, or remove a generated component after explicit user approval.
---

# Agent package manager

Operate from the project root and follow `docs/component-management.md`.

1. Run `scripts/manage-components.ps1 -Command List` before creating anything. Reuse an existing capability when possible.
2. Do not create MCP components in this version.
3. Never modify or delete `agents/packages/builtin/` or an original Agent workspace. Only component scripts may write under `agents/packages/generated/`.
4. Before build, create a component request and approval request that explains ID, purpose, capabilities, model, permissions, paths, risks, and the post-build delete option. Stop until the user explicitly selects `BUILD`.
5. Build an Agent with `NewAgent`. It must remain unregistered and inactive initially.
6. For Skill content, use the existing OpenClaw bundled `skill-creator`; do not recreate or copy it. Keep source under `agents/packages/generated/skills/<slug>/`, then use `ProposeSkill` and the native Skill Workshop.
7. After validation, request a second user decision: `ACTIVATE`, `KEEP_INACTIVE`, or `DELETE`. Do not infer approval from silence.
8. Apply generated Skills only to generated Agents. Never update an original Agent or its Skills.
9. Require a separate `DELETE` approval before `RemoveAgent` or `RemoveSkill`. Preserve the generated-component audit record.
10. Invoke only Agents that are registered, active, and present in the current manager allowlist; always pass the explicit Agent ID.

Use `scripts/manage-components.ps1 -Command Validate` after every lifecycle change. Treat any schema, path, OpenClaw config, or Skill check failure as HOLD.
