# Research: remote agentic coding and DAG-based approaches

Research conducted March 2026 to inform skill composition, dependency handling, and agent communication patterns for telegram-minions.

## Landscape overview

The agentic coding space has matured rapidly. As of early 2026, 57% of companies run AI agents in production. The dominant pattern has shifted from single-agent pair programming to multi-agent orchestration, where a coordinator decomposes work, spawns specialized agents in parallel, and synthesizes results.

Three categories of tooling have emerged:

1. **Single-session subagents** — Claude Code's Agent Teams, oh-my-claudecode — one terminal, multiple subagents sharing a task list with dependency tracking, peer-to-peer messaging, and file locking.
2. **Isolated parallel agents** — Cursor 2.0 parallel agents, VS Code Copilot background agents, Emdash, ComposioHQ agent-orchestrator — each agent gets its own git worktree, branch, and PR, coordinated by a supervisor.
3. **DAG-based orchestrators** — LangGraph, Flyte 2.0/Union.ai, telegram-minions — dependency graphs with topological scheduling, fan-in merges, and failure propagation.

telegram-minions sits in category 3 with elements of category 2 (worktree isolation, per-agent PRs).

## Key frameworks and approaches

### ComposioHQ agent-orchestrator

The closest comparable system. A TypeScript orchestrator that manages fleets of parallel coding agents. Each agent gets its own git worktree, branch, and PR. The orchestrator reads the codebase, decomposes features into parallelizable tasks, spawns agents, monitors progress, and autonomously handles CI fixes and merge conflicts. Built 40,000 lines of TypeScript with 3,288 tests in 8 days — largely self-built by the agents it orchestrates.

**Relevance to telegram-minions**: Nearly identical architecture (worktree isolation, CI babysitting, merge conflict handling). Key difference: Composio uses a web dashboard while telegram-minions uses Telegram forum topics as the coordination surface.

### LangGraph

The leading framework for complex agent workflows. Uses a directed acyclic graph structure where nodes represent agents, functions, or decision points, and edges dictate data flow. Supports conditional branching, hierarchical control, and state persistence across nodes.

**Relevance**: telegram-minions already implements similar patterns in `dag.ts` (Kahn's algorithm, topological sort, status tracking) and `dag-orchestrator.ts` (scheduling, fan-in merges). LangGraph's state-passing model (each node receives and returns a typed state object) is a pattern worth considering for richer inter-node communication.

### Flyte 2.0 / Union.ai

A planner agent system with parallel execution. Decomposes tasks into a DAG, then executes nodes with Flyte's production-grade task runner. Strong typing, automatic retry, and caching at the node level.

**Relevance**: The separation of planning (DAG construction) from execution (node scheduling) mirrors telegram-minions' `extractDagItems()` → `DagOrchestrator.startDag()` flow. Flyte's per-node caching could inspire caching of agent outputs for retry scenarios.

### Anthropic Agent Skills standard

Announced December 18, 2025 as an open standard. Skills are directories containing instructions, scripts, and resources that AI agents discover and load dynamically. Each skill has a `SKILL.md` with metadata. Uses "progressive disclosure" — skills take only a few dozen tokens when summarized, with full details loading on demand.

Adopted by Microsoft, OpenAI, Atlassian, Figma, Cursor, GitHub, and 16+ other tools including Goose. The specification and SDK live at agentskills.io.

**Relevance**: This is the standard telegram-minions should adopt for packaging skills that travel with the npm package. Skills can be injected into child workspaces alongside agents.

### Goose extensions and recipes

Goose uses `.goosehints` for directory-scoped agent instructions and recipes (YAML) for structured workflow definitions. Key features:

- **Hierarchical hints**: Root `.goosehints` for global guidance, subdirectory files for scoped conventions.
- **Global hints**: `~/.config/goose/.goosehints` applies across all sessions.
- **Recipes**: YAML definitions with typed parameters, environment extensions, and explicit MCP server pinning. Version-controlled and composable.
- **Subagents**: Since Goose v1.10.0, subagents are stable and don't require feature flags.

**Relevance**: telegram-minions spawns Goose sessions but injects no `.goosehints`. Adding workspace-level hints would give Goose sessions the same guidance that Claude sessions get from `CLAUDE.md` and agent definitions.

## Design patterns

### Git worktrees as isolation primitive

Git worktrees are the universal isolation mechanism across all major multi-agent systems. Each agent gets its own working directory on its own branch, all linked to the same `.git` directory. This prevents agents from stepping on each other's changes.

- Cursor 2.0 supports up to 8 parallel agents, each in its own worktree.
- VS Code 1.107 auto-creates worktrees for background Copilot agents.
- telegram-minions already uses this pattern in `prepareWorkspace()`.

**Best practice**: One branch per worktree, descriptive branch names, quality gates that block unsafe merges.

### Kahn's algorithm for scheduling

The standard algorithm for topological scheduling in DAG-based systems. Repeatedly selects nodes with in-degree zero (no unmet dependencies), processes them, and decrements the in-degree of downstream nodes. Naturally identifies parallelizable work (all zero-in-degree nodes can run concurrently).

telegram-minions implements this correctly in `dag.ts:topologicalSort()` and `dag-orchestrator.ts:scheduleDagNodes()`.

### Fan-in merges for multi-dependency nodes

When a node depends on multiple upstream nodes, their branches must be merged before the node can start. telegram-minions handles this in `prepareFanInBranch()` using `git merge-tree` to check for conflicts before attempting the merge.

**Industry approach**: Most systems either require linear dependencies (avoiding fan-in entirely) or use a "merge train" that sequentially merges upstream branches. telegram-minions' merge-tree pre-check is more sophisticated than most.

### Failure propagation and recovery

When a DAG node fails, all transitive dependents should be skipped. telegram-minions implements this via BFS in `failNode()`, with `resetFailedNode()` for retry.

**LangGraph pattern**: Nodes can define fallback handlers that transform failures into partial results, allowing downstream nodes to proceed with degraded input. This is more nuanced than binary skip/retry.

### CI babysitting

Both telegram-minions and ComposioHQ agent-orchestrator implement automated CI fix loops: detect failure → spawn fix agent → push update → re-check. telegram-minions configures this per-DAG via `dagCiPolicy` with retry limits.

### Progressive context loading

The Agent Skills standard's "progressive disclosure" pattern — summarize capabilities in a few tokens, load full details only when needed — is critical for multi-agent systems where context windows are shared or constrained.

telegram-minions currently injects full system prompts into each session. Adopting a skill-based approach where detailed guidance loads on demand would reduce token usage and allow richer skill libraries.

## Recommendations for telegram-minions

### 1. Adopt the Agent Skills standard for Claude skills

Package reusable guidance as Agent Skills (`SKILL.md` + supporting files) rather than raw markdown. This makes skills portable across Claude Code, Cursor, and other adopting tools.

Recommended skills to create:
- **post-task-routing** — when and how to route completed work
- **ci-fix** — diagnosing and fixing CI failures
- **git-workflow** — branching conventions, commit style, PR creation
- **code-quality** — TypeScript patterns, lint rules, test conventions
- **dag-awareness** — understanding scope constraints and upstream/downstream relationships

### 2. Create .goosehints for Goose sessions

Goose sessions currently get no workspace-level guidance. Add:
- Root `.goosehints` with project conventions, tech stack, testing patterns
- Scoped hints in key directories (e.g., `src/.goosehints` for code conventions)
- Inject hints into child workspaces via `prepareWorkspace()`

### 3. Wire up the unused agentDefs config

The `AgentDefinitions` type exists in `config-types.ts` but is never consumed at runtime. Implement the injection:
- Resolve asset paths using `import.meta.url` for npm package consumers
- Copy agent files into child workspace `.claude/agents/` during `prepareWorkspace()`
- Never overwrite existing files — repo-owned config takes precedence
- Add `.goosehints` generation from the same source

### 4. Enrich inter-node communication

Currently DAG nodes communicate only through git branches (code changes). Consider:
- A shared state object per DAG (like LangGraph's typed state) stored as JSON in the parent workspace
- Node output summaries that downstream nodes receive in their prompts
- Structured metadata (files changed, APIs added, test results) rather than raw branch diffs

### 5. Consider conditional DAG edges

LangGraph supports conditional edges where the next node depends on the output of the current node. This would allow:
- Skip optional nodes when prerequisites aren't needed
- Route to different implementation strategies based on upstream results
- Dynamic DAG modification during execution

### 6. Add retry with partial results

Instead of binary success/failure, allow nodes to produce partial results that downstream nodes can work with. This prevents a single flaky test from cascading failures through the entire DAG.

## Comparable systems summary

| System | Isolation | Scheduling | CI handling | Communication | Skills/hints |
|--------|-----------|------------|-------------|---------------|-------------|
| telegram-minions | Git worktrees | Kahn's algorithm | Auto babysit + fix | Branch merges | CLAUDE.md, agents |
| ComposioHQ orchestrator | Git worktrees | Parallel dispatch | Auto fix + conflict resolution | Dashboard + PR | Custom prompts |
| LangGraph | Node state | DAG with conditionals | N/A (not coding-specific) | Typed state objects | Node configs |
| Claude Agent Teams | Shared workspace | Task list + deps | N/A | Peer messaging + file locks | Agent Skills |
| Cursor 2.0 | Git worktrees (up to 8) | Parallel | N/A | Shared codebase | Rules files |
| Flyte 2.0 / Union.ai | Container isolation | DAG + caching | Built-in retry | Typed artifacts | Task configs |

## Sources

- [2026 Agentic Coding Trends Report — Anthropic](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf)
- [The State of AI Coding Agents (2026) — Dave Patten](https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a)
- [AI Coding Agents in 2026: Coherence Through Orchestration — Mike Mason](https://mikemason.ca/writing/ai-coding-agents-jan-2026/)
- [The Future of Agentic Coding: Conductors to Orchestrators — Addy Osmani](https://addyosmani.com/blog/future-agentic-coding/)
- [The Code Agent Orchestra — Addy Osmani](https://addyosmani.com/blog/code-agent-orchestra/)
- [A Practical Perspective on Orchestrating AI Agent Systems with DAGs — Arpit Nath](https://medium.com/@arpitnath42/a-practical-perspective-on-orchestrating-ai-agent-systems-with-dags-c9264bf38884)
- [DAG-based Task Planner Overview — Emergent Mind](https://www.emergentmind.com/topics/dag-based-task-planner)
- [Equipping Agents for the Real World with Agent Skills — Anthropic](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Agent Skills: Anthropic's Next Bid to Define AI Standards — The New Stack](https://thenewstack.io/agent-skills-anthropics-next-bid-to-define-ai-standards/)
- [ComposioHQ agent-orchestrator — GitHub](https://github.com/ComposioHQ/agent-orchestrator)
- [Orchestrate Teams of Claude Code Sessions — Claude Code Docs](https://code.claude.com/docs/en/agent-teams)
- [Claude Code Multiple Agent Systems: Complete 2026 Guide — eesel.ai](https://www.eesel.ai/blog/claude-code-multiple-agent-systems-complete-2026-guide)
- [Using Git Worktrees for Multi-Feature Development with AI Agents — Nick Mitchinson](https://www.nrmitchi.com/2025/10/using-git-worktrees-for-multi-feature-development-with-ai-agents/)
- [Agentmaxxing: Run Multiple AI Agents in Parallel (2026)](https://vibecoding.app/blog/agentmaxxing)
- [Using .goosehints Files with Goose — DEV Community](https://dev.to/lymah/using-goosehints-files-with-goose-304m)
- [Planning With .goosehints — Nick Taylor](https://www.nickyt.co/blog/advent-of-ai-2025-day-16-planning-with-goosehints-875/)
- [Build a Planner Agent System with Parallel Execution — Union.ai](https://www.union.ai/blog-post/build-a-planner-agent-system-with-parallel-execution-flyte-2-0-multi-agent-orchestration-with-union-ai)
- [LangGraph Multi-Agent Orchestration Guide — Latenode](https://latenode.com/blog/ai-frameworks-technical-infrastructure/langgraph-multi-agent-orchestration/langgraph-multi-agent-orchestration-complete-framework-guide-architecture-analysis-2025)
- [Shipyard: Multi-agent orchestration for Claude Code in 2026](https://shipyard.build/blog/claude-code-multi-agent/)
- [oh-my-claudecode: Multi-Agent Orchestration — byteiota](https://byteiota.com/oh-my-claudecode-multi-agent-orchestration-for-claude-code/)
- [AI Agent Skills Guide 2026 — Serenities AI](https://serenitiesai.com/articles/agent-skills-guide-2026)
- [Top 5 Open-Source Agentic AI Frameworks in 2026 — AIM](https://aimultiple.com/agentic-frameworks)
