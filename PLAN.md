# Hive: Implementation Plan

## Vision

Success looks like a running ecosystem where a developer writes fewer than 500 lines of hand-authored code to start, then watches a single bootstrap agent read its own constitution, decide what infrastructure it needs, write that infrastructure, spawn specialists to tackle GitHub issues, accumulate a library of tools and playbooks it invented itself, and self-correct when things break — all while a dashboard shows the activity in real time and a dead-man switch ensures the whole thing stays within spending and containment bounds the developer set. The system is not pre-designed; it is self-discovered, and the design docs in the repo are its starting constitution, not its blueprint.

---

## Phase 0: Bare Infrastructure

**Goal**: The thinnest possible scaffolding a developer writes by hand so that one agent can start, execute tools, persist its outputs, and be observed. Nothing more.

**What the developer writes by hand**: Everything in this phase. This is the last phase where the developer writes code.

**What agents build**: Nothing yet.

### Key Files to Create

```
hive/
  package.json                     # monorepo root
  tsconfig.base.json
  constitution.md                  # the agent's values, constraints, mission
  packages/
    core/
      src/
        bootstrap.ts               # entry point: starts the one agent
        agent-runner.ts            # thin wrapper around agentic runAgent
        primitive-tools.ts         # exec, read, write, ls — nothing else
        identity.ts                # ed25519 keypair generation + persistence
        audit-log.ts               # append-only JSONL, no delete method exposed
        config.ts                  # env-driven: model, spend limit, max agents
      package.json
      tsconfig.json
    db/
      src/
        schema.sql                 # SQLite schema: agents, goals, messages, audit
        db.ts                      # better-sqlite3 wrapper, migrations on startup
      package.json
```

### Implementation Steps

**Step 1: Repo scaffold**

Initialize a pnpm monorepo. Copy the `agentic` package's `runAgent` loop and tool registry verbatim — do not reinvent it. The runner is already battle-tested. Add it as a workspace dependency.

**Step 2: `identity.ts`**

On first run, generate an ed25519 keypair using Node's built-in `crypto.generateKeyPairSync('ed25519')`. Persist to `~/.hive/agents/<id>/keypair.json` (private key encrypted with a passphrase from env). The agent's `id` is the SHA-256 of its public key, hex-encoded, first 16 chars. Every message the agent emits is signed with this key.

```
identity.ts exports:
  loadOrCreateIdentity(agentId?: string): Promise<AgentIdentity>
  signPayload(identity: AgentIdentity, payload: string): string
  verifyPayload(pubkey: string, payload: string, sig: string): boolean
```

**Step 3: `audit-log.ts`**

A class with one method: `append(entry: AuditEntry): void`. Writes JSONL to `~/.hive/audit/YYYY-MM-DD.jsonl`. No `read`, no `delete`, no `truncate` methods on the class. The file is append-only by construction — pass `-a` flag to the fd. The bootstrap agent receives this as an internal side-effect, not as an exposed tool.

**Step 4: `primitive-tools.ts`**

Exactly four tools, registered in the agentic tool registry format:

- `exec`: runs a shell command in a sandboxed working directory, captures stdout/stderr/exitCode, appends to audit log
- `read`: reads a file path, returns content
- `write`: writes content to a file path (creates dirs), appends to audit log
- `ls`: lists a directory, returns JSON array of entries

No GitHub tool. No HTTP tool. No memory tool. The agent must build what it needs.

**Step 5: `config.ts`**

Reads from env: `ANTHROPIC_API_KEY`, `HIVE_SPEND_LIMIT_USD` (default 5.0), `HIVE_MAX_AGENTS` (default 3), `HIVE_MAX_CONTAINERS` (default 10), `HIVE_WORK_DIR` (default `~/.hive/workspace`). Exposes a `getConfig()` function. The dead-man switch in later phases reads from this.

**Step 6: `schema.sql` and `db.ts`**

SQLite schema with four tables created at startup if absent:

```sql
agents(id TEXT PK, pubkey TEXT, spawned_by TEXT, status TEXT, created_at INTEGER)
goals(id TEXT PK, title TEXT, status TEXT, claimed_by TEXT, created_at INTEGER, updated_at INTEGER)
messages(id TEXT PK, channel TEXT, sender_id TEXT, payload TEXT, sig TEXT, ts INTEGER)
audit(id INTEGER PK AUTOINCREMENT, agent_id TEXT, event_type TEXT, payload TEXT, ts INTEGER)
```

**Step 7: `bootstrap.ts`**

The entry point. Loads config, creates identity for agent `bootstrap-0`, instantiates the four primitive tools, calls `runAgent` from the agentic package with the bootstrap spec. Registers a `before_tool_call` hook that writes to the audit log. Registers an `after_agent_start` hook that inserts the agent row into SQLite.

Also includes the dynamic tool loader: on startup, glob `~/.hive/tools/compiled/*.js`; for each file, `require()` it and call `tool-registry.register(tool.tool)`. This is the bridge that loads the agent's self-written tools on subsequent runs.

### Verification

- `pnpm run start` starts one agent process with no errors
- The agent receives the four tools and the constitution
- Identity file is created at `~/.hive/agents/bootstrap-0/keypair.json`
- Audit log file is created and receives entries on every tool call
- The agent runs its first LLM loop and produces at least one tool call

---

## Phase 1: Bootstrap Agent Self-Builds

**Goal**: The bootstrap agent, given only primitive tools and `constitution.md`, reasons about what infrastructure Hive needs, writes that infrastructure, and documents its decisions. No developer code in this phase.

**What the developer writes by hand**: Only `constitution.md` and the bootstrap agent spec.

**What agents build**: Tool library, playbooks, initial GitHub integration scaffold, memory schema extensions, a self-description of the architecture they chose.

### What the Bootstrap Agent Must Produce

1. `~/.hive/tools/` — tool definitions it wrote, each as a `.ts` file with a standard export shape the runner knows how to load dynamically
2. `~/.hive/playbooks/` — markdown playbooks for recurring tasks (e.g., `solve-github-issue.md`, `spawn-specialist.md`, `write-new-tool.md`)
3. `~/.hive/decisions/` — decision records (ADRs) for every significant architectural choice it made
4. `~/.hive/workspace/README.md` — the agent's own description of the system it built

### Key Tool Shape (the bootstrap agent must discover and implement this)

The agent discovers through `ls` and `read` of the agentic package what a tool registration looks like, then adopts that shape for all tools it writes. The dynamic loader expects:

```typescript
// Each file in ~/.hive/tools/*.ts must export:
export const tool: ToolDefinition = {
  name: string,
  description: string,
  input_schema: JSONSchema,
  handler: (input: unknown, context: ToolContext) => Promise<ToolResult>
}
```

### Tools the Bootstrap Agent Is Expected to Invent

The bootstrap agent will not be told what tools to write. Based on the task (discover and solve GitHub issues), it will likely converge on:

- `http-get`: fetch a URL, return body
- `git-clone`: clone a repo to a work dir
- `git-branch`: create and checkout a branch
- `git-commit`: stage and commit changes
- `git-push`: push a branch to origin
- `github-search-issues`: search GitHub for open issues by label/language
- `github-create-pr`: open a PR via GitHub API
- `npm-install` / `npm-test`: run package installs and test suites
- `spawn-agent`: request that the runner start a child agent
- `remember`: write a memory entry to SQLite
- `recall`: query SQLite memory by semantic content

### Tool Compilation

When an agent writes a tool file, the `write` tool's post-write hook immediately runs `esbuild ~/.hive/tools/<name>.ts --outfile=~/.hive/tools/compiled/<name>.js`. If esbuild exits 0, the tool is registered immediately and the agent receives `"Tool <name> registered successfully"`. If not, the agent receives the compile error and can fix it.

### Implementation Steps

1. Developer writes `constitution.md` (see content outline below)
2. Developer writes the bootstrap spec (see Bootstrap Agent Spec section)
3. Run `pnpm start`. Watch. Do not intervene unless the agent loops or errors
4. After the agent completes or pauses, inspect `~/.hive/tools/`, `~/.hive/playbooks/`, `~/.hive/decisions/`

### Verification

- `~/.hive/tools/` contains at least 5 tool files the agent wrote
- `~/.hive/playbooks/` contains at least 2 playbooks
- `~/.hive/decisions/` contains at least 1 ADR
- The agent successfully calls `http-get` (or equivalent it invented) to fetch a GitHub API response
- `pnpm start` on a second run loads the agent-written tools automatically

---

## Phase 2: Communication and Multi-Agent

**Goal**: Agents can communicate via Redis pub/sub, propose and claim goals, and spawn children. The ecosystem is now multi-agent.

**What the developer writes by hand**: Redis connection setup, the goal registry module, the spawning controller. These are structural — they cannot be safely delegated to the bootstrap agent because they involve the security boundary between agents.

**What agents build**: Their own communication protocols, their own goal decomposition strategies, their own specialist roles.

### Key Files to Create

```
packages/
  messaging/
    src/
      redis-client.ts              # ioredis wrapper, connection pooling
      pub-sub.ts                   # publish(channel, payload, identity), subscribe(channel, cb)
      message-schema.ts            # zod schemas for all message types
      signed-message.ts            # sign on publish, verify on receive, drop invalid
  goal-registry/
    src/
      registry.ts                  # CRUD on goals table: propose, claim, unclaim, complete, block
      claim-lock.ts                # optimistic locking: UPDATE goals SET claimed_by=? WHERE claimed_by IS NULL
      goal-types.ts                # GoalStatus enum, GoalRecord type
  spawner/
    src/
      spawner.ts                   # SpawnRequest handler: validates limits, forks child process
      limits.ts                    # reads HIVE_MAX_AGENTS, HIVE_MAX_CONTAINERS from config
      child-manifest.ts            # writes agent row to SQLite on spawn
```

### Implementation Steps

**Step 1: Redis setup**

Add `ioredis` to the core package. `redis-client.ts` reads `REDIS_URL` from env (default `redis://localhost:6379`). Provide `getRedisClient(): Redis` singleton.

**Step 2: Signed pub/sub**

`publish(channel, payload, identity)` signs `JSON.stringify(payload)` with the agent's private key, publishes `{ sender: id, payload, sig, ts }` to the channel.

`subscribe(channel, handler)` receives messages, verifies signature against the sender's pubkey (looked up from the `agents` SQLite table), drops messages with invalid signatures, calls handler.

**Step 3: Goal registry**

`proposeGoal(title, description, proposedBy): GoalRecord` inserts with status `proposed`.

`claimGoal(goalId, agentId): boolean` executes `UPDATE goals SET claimed_by=?, status='active', updated_at=? WHERE id=? AND claimed_by IS NULL` and returns whether the row was updated. Deterministic — no LLM involved.

**Step 4: Spawn controller**

`requestSpawn(parentId, spec): Promise<string>` validates that the parent has fewer than 5 children and global count is under `HIVE_MAX_AGENTS`. If valid, forks a new Node process running `bootstrap.ts` with the child's spec as a JSON env var. Returns the new agent's id.

**Step 5: Channel conventions**

- `agent:<id>`: messages directed at a specific agent
- `broadcast`: all agents receive, used for goal announcements
- `task-delegation`: parent delegating a subtask to a child
- `results`: completed work summaries

### Verification

- Two agent processes can run simultaneously
- Agent A proposes a goal; Agent B claims it (no race condition — claim-lock test)
- Agent A spawns Agent B; the child agent row appears in SQLite
- Attempting to spawn a 6th child is rejected
- A message with an invalid signature is dropped and logged

---

## Phase 3: Containment and Safety

**Goal**: Each agent runs in a Docker container with a restricted network. A dead-man switch halts the system if spend, agent count, or container count exceed configured limits.

**What the developer writes by hand**: Everything. Agents must not be able to modify their own containment.

### Key Files to Create

```
packages/
  containment/
    src/
      dockerfile.ts                # generates per-agent Dockerfile (or uses a base image)
      container-manager.ts         # dockerode wrapper: create, start, stop, inspect
      network-policy.ts            # allowlist: api.github.com, registry.npmjs.org, redis host
      dead-man-switch.ts           # polling loop: checks spend + agent + container counts
    Dockerfile.agent               # base image for all agents
  spend-tracker/
    src/
      tracker.ts                   # intercepts LLM client calls, accumulates token costs
      cost-model.ts                # model → cost per token lookup table
```

### Implementation Steps

**Step 1: Base Dockerfile**

`Dockerfile.agent` is a minimal Node 22 Alpine image with the hive packages installed. The container runs `node dist/bootstrap.js` with the agent spec as env.

**Step 2: Container manager**

`containerManager.ts` uses `dockerode`. `startAgent(spec): Promise<ContainerHandle>` creates a container from the base image, sets env vars, applies network policy, starts it.

**Step 3: Network policy**

Create a Docker network `hive-net` with `--internal` (no external access by default). Add iptables egress rules that allow outbound to `api.github.com:443`, `registry.npmjs.org:443`, and the Redis host only.

**Step 4: Dead-man switch**

`dead-man-switch.ts` runs every 30 seconds:

```
checkLimits():
  totalSpendUSD = spend-tracker accumulated cost
  activeAgents = SELECT COUNT(*) FROM agents WHERE status='active'
  runningContainers = docker.listContainers({ filters: { label: ['hive=true'] } }).length
  if any > configured limit:
    broadcast HALT on Redis
    stop all containers
    write HALT entry to audit log
    process.exit(1)
```

**Step 5: Spend tracker**

Wraps the agentic LLM client's `after_llm_call` hook. Accumulates cost in SQLite `spend` table. Fires a warning to the audit log at 50% of limit and injects a system message to the running agent at 80%.

### Verification

- `docker ps` shows agent containers with label `hive=true`
- From inside the container, `curl https://evil.com` fails; `curl https://api.github.com` succeeds
- Set `HIVE_SPEND_LIMIT_USD=0.001`; verify the dead-man switch halts after one LLM call

---

## Phase 4: GitHub Integration

**Goal**: Agents discover real open-source GitHub issues, clone repos, fix them, test the fix, and open PRs.

**What the developer writes by hand**: The issue discovery seed (search query or set of repo targets). A `HIVE_DRY_RUN=true` mode that prevents actual PR creation until quality is verified.

**What agents build**: The actual fix strategies, the test-and-verify loop, the PR descriptions.

### Key Files to Create

```
packages/
  github/
    src/
      issue-discovery.ts           # search GitHub API for open issues by criteria
      issue-filter.ts              # score issues by solvability
      repo-manager.ts              # clone, branch, push operations
      pr-creator.ts                # GitHub API: create PR, add labels, link issue
      github-client.ts             # Octokit wrapper with rate-limit awareness
  solver/
    src/
      solve-coordinator.ts         # orchestrates the full solve workflow
      test-runner.ts               # runs npm test / jest / vitest, parses results
      diff-analyzer.ts             # reads git diff, produces structured summary for LLM
```

### The Solve Workflow

1. `issue-discovery` fetches candidate issues (TypeScript, label `good first issue` or `bug`, open, no assignee, repo has tests)
2. `issue-filter` scores candidates; pick highest-scored one not already in the `goals` table
3. Propose and claim a goal in the goal registry
4. `repo-manager.clone(repoUrl, workDir)` — clone to `~/.hive/workspace/<goalId>/`
5. `repo-manager.branch('hive/fix-issue-N')` — create a branch
6. Agent reads the issue body, reads relevant source files, forms a plan
7. Agent writes the fix using `write` and `edit` tools
8. `test-runner.run(workDir)` — execute tests, capture results
9. If tests fail: loop back to step 6 with failure context (max 3 iterations)
10. `git-commit`, `git-push`
11. `pr-creator.create(...)` — open PR from fork referencing the issue (use a dedicated `hive-bot` GitHub account)
12. `completeGoal(goalId, result: prUrl)`
13. Write a memory entry: what worked, what didn't, the repo's testing setup

### Verification

- Run with `HIVE_DRY_RUN=true`; verify it discovers issues, scores them, clones the repo, creates a branch — but does not push or open a PR
- Run without dry run on a personal fork; verify a real PR is opened with test results in the body
- Check that the PR references the issue number

---

## Phase 5: Self-Improvement

**Goal**: Agents accumulate memory, write new tools when they encounter capability gaps, refine their playbooks, and can modify their own prompts — all gated by safety constraints.

**What the developer writes by hand**: The self-modification gate (the policy for when self-modification is allowed). The git versioning wrapper that ensures every self-modification is committed and can be rolled back. The protected file deny list.

**What agents build**: New tools, refined playbooks, prompt improvements, specialist agent definitions.

### Key Files to Create

```
packages/
  self-improvement/
    src/
      tool-author.ts               # agent writes a new tool, validates schema, registers it
      playbook-author.ts           # agent writes or refines a playbook
      prompt-modifier.ts           # agent proposes a system prompt change (gated)
      modification-gate.ts         # policy: max N modifications per M tasks, requires peer review
      git-versioned-store.ts       # wraps ~/.hive/tools and ~/.hive/playbooks as a git repo
      memory-consolidator.ts       # periodically consolidates memories, prunes low-confidence ones
  specialists/
    src/
      specialist-registry.ts       # registry of specialist agent roles agents have defined
      specialist-spawner.ts        # spawn a specialist given a role definition
```

### Self-Modification Gate Policy

`modification-gate.ts` enforces:

- Maximum 3 tool writes per 10 tasks completed (tracked in SQLite)
- Maximum 1 prompt modification per 50 tasks
- Playbook writes are ungated (agents can write playbooks freely)
- Every write to `~/.hive/tools/` or `~/.hive/playbooks/` goes through `git-versioned-store.ts`
- Rollback: `revertModification(commitHash)` runs `git revert` in the store repo
- An agent cannot modify a tool another agent is currently using

Protected file deny list (path prefix matching — enforced in developer-written code, not modifiable by agents):
- `/packages/containment/`
- `/packages/core/src/audit-log`
- `/packages/core/src/dead-man-switch` (once extracted)
- `/packages/self-improvement/src/modification-gate`

### Memory Consolidation

`memory-consolidator.ts` runs after every 20 task completions: groups memories by topic, asks the LLM to synthesize a consolidated memory per group, writes with higher confidence, marks originals as `consolidated=true` (does not delete — the audit log principle applies here too).

### Specialist Roles

A specialist is defined by:
- A role name (e.g., `typescript-type-error-specialist`)
- A system prompt focused on that domain
- A list of tools the specialist gets access to
- A set of goals it is eligible to claim (matched by goal title patterns)

Track per-specialist PR merge rate. After 5 PRs, if merge rate is below 20%, mark as `deprecated` and stop spawning.

### Verification

- After 10 task completions, inspect `~/.hive/tools/` — verify new tools were written by agents
- Verify `~/.hive/store/` is a git repo with commits for each tool write
- Trigger a rollback; verify the tool file reverts and the running system picks up the old version on next restart
- Verify the modification gate rejects a 4th tool write within the same 10-task window

---

## Phase 6: Creator Dashboard

**Goal**: A React/Vite UI that lets the developer watch agent activity, inspect goals, read the audit log, and intervene (halt, spawn, assign a goal).

**What the developer writes by hand**: The entire dashboard. Agents do not write UI code.

### Key Files to Create

```
packages/
  dashboard/
    index.html
    vite.config.ts
    src/
      main.tsx
      App.tsx
      api/
        client.ts                  # fetch wrapper for the local API server
      components/
        AgentGrid.tsx              # card per agent: status, current goal, spend
        GoalBoard.tsx              # kanban: proposed → active → completed
        AuditLog.tsx               # live-streaming JSONL tail (SSE)
        SpendMeter.tsx             # bar chart of cumulative spend vs limit
        HaltButton.tsx             # sends HALT to Redis broadcast channel
  api-server/
    src/
      server.ts                    # Hono server
      routes/
        agents.ts                  # GET /agents, GET /agents/:id
        goals.ts                   # GET /goals, POST /goals, PATCH /goals/:id
        audit.ts                   # GET /audit (SSE stream)
        spawn.ts                   # POST /spawn (developer-initiated agent spawn)
        halt.ts                    # POST /halt
```

The `AuditLog` connects to `GET /audit` as an EventSource — the server tails the JSONL file with `fs.watch` and pushes new lines to connected clients. `HaltButton` calls `POST /halt`, which publishes `HALT` to Redis and stops all containers.

### Verification

- `pnpm run dev --filter dashboard` starts the UI on localhost:5173
- The UI shows live agents when the hive is running
- The halt button stops all agent containers and the UI shows them as stopped
- The audit log streams in real time without page refresh

---

## Bootstrap Agent Spec

### System Prompt

```
You are the bootstrap agent for Hive — a self-improving ecosystem of autonomous agents
that discover and solve real open-source GitHub issues.

You are starting from almost nothing. You have four tools: exec, read, write, ls.
You do not yet have a GitHub tool, a memory tool, or a spawning tool.
Your first job is to build what you need.

Read /Users/rafe/other/lobs/hive/constitution.md first.
Then read the agentic package source to understand the tool registration pattern.
Start by reading packages/runner/src/tool-registry.ts and packages/tools/src/read.ts
as examples of how tools are structured — then decide what you need and write it.

Rules:
- Every significant decision must be documented in ~/.hive/decisions/ as a markdown ADR
- Every tool you write must be in ~/.hive/tools/ and conform to the ToolDefinition export shape
- Every playbook you write must be in ~/.hive/playbooks/
- You must not write to /packages/core/, /packages/containment/, or any developer-written file
- You must not spend more than $HIVE_SPEND_LIMIT_USD total

Your mission: build the infrastructure Hive needs, document your decisions, then find and
fix one real GitHub issue to prove the infrastructure works.
```

### Initial Tools

- `exec(command: string, cwd?: string): { stdout, stderr, exitCode }` — cwd locked to `~/.hive/workspace/`; blocks `rm -rf /`, `curl | bash`, and similar patterns
- `read(path: string): { content: string }`
- `write(path: string, content: string): { success: boolean }` — triggers esbuild compilation if path ends in `.ts` under `~/.hive/tools/`
- `ls(path: string): { entries: Array<{ name, type, size }> }`

### Initial Task

```
1. Read constitution.md
2. Read the agentic package source (ls + read the key files)
3. Decide what tools you need to find and fix a GitHub issue
4. Write those tools to ~/.hive/tools/
5. Write playbooks to ~/.hive/playbooks/ for your recurring workflows
6. Document every significant decision in ~/.hive/decisions/
7. Find one good TypeScript GitHub issue, clone the repo, fix it, run tests, open a PR
8. Write a final summary to ~/.hive/workspace/README.md describing what you built and why
```

### Completion Criteria

| Output | Path | Minimum |
|--------|------|---------|
| Tool files | `~/.hive/tools/*.ts` | 5 files |
| Compiled tools | `~/.hive/tools/compiled/*.js` | Same count |
| Playbooks | `~/.hive/playbooks/*.md` | 2 files |
| Decision records | `~/.hive/decisions/*.md` | 1 file |
| Architecture summary | `~/.hive/workspace/README.md` | Must exist |
| PR URL | Written to audit log | 1 PR |

---

## `constitution.md` Content Outline

```markdown
# Hive Constitution

## Mission
Find and fix real problems in real open-source software. Build tools that help you do this better over time.

## Values
- Prefer simple, working solutions over elegant but broken ones
- Document decisions — future agents (including yourself) need to understand why you made choices
- Do not modify infrastructure that contains you (containment, audit log, dead-man switch)
- When in doubt, write a playbook instead of hardcoding behavior
- A failing test you wrote is more valuable than no test at all

## Constraints
- Never commit secrets to git
- Never open a PR without running the existing tests first
- Every tool you write must have a description accurate enough that another agent can use it without reading its source
- Spend budget: $HIVE_SPEND_LIMIT_USD total across all tasks

## On Self-Improvement
You may write new tools. You may refine playbooks. You may spawn child agents.
You may not modify the files that contain you. You may not disable the audit log.
When you modify something that affects other agents, document it.
```

---

## Critical Architectural Decisions

### SQLite vs Postgres for the goal registry

**Choice**: SQLite. The claim-lock is a single atomic `UPDATE WHERE claimed_by IS NULL` — sufficient for the concurrency level. If Hive ever scales to multiple machines this changes, but that is explicitly out of scope.

### Redis for messaging vs SQLite polling

**Choice**: Redis pub/sub for real-time messaging, SQLite for durable state. Agents degrade gracefully if Redis goes down — they check their SQLite goal registry independently and continue working on already-claimed goals.

### Dynamic tool loading via esbuild

**Choice**: When an agent writes a `.ts` tool file, immediately compile it with esbuild to `~/.hive/tools/compiled/<name>.js`, then `require()` the compiled output. Agents must write syntactically valid TypeScript. Compile errors are returned as tool feedback so the agent can fix them.

### Self-modification scope

**Choice**: Agents can write new tools and playbooks freely; can modify existing tools with the gate; cannot modify files in the protected deny list. The deny list uses path prefix matching and lives in developer-written code that agents cannot reach.

### GitHub account for PRs

**Choice**: A dedicated `hive-bot` GitHub account (not the developer's personal account). The developer creates this account and generates a `GITHUB_TOKEN` for it before Phase 4. PRs use the fork-and-PR workflow: fork the repo, push to the fork, open PR from fork to original.

---

## Open Questions and Risks

**Risk: Bootstrap agent loops without making progress**
The agentic loop detector handles generic repetition. Additionally, the `before_tool_call` hook counts unique tool calls; if the same tool is called 5 times with identical arguments, it injects: "You have called this tool 5 times with the same arguments. Try a different approach."

**Risk: Agent-written tools are unsafe (pre-Phase 3)**
In Phase 1 and 2, tools run on the host. The `exec` tool enforces a `cwd` allowlist and blocks commands matching a deny pattern. This is a rough filter, not a security boundary — Phase 3 is required for real containment.

**Risk: LLM costs spiral**
The spend tracker fires a warning at 50% of the limit and injects a system message to the running agent at 80%. The dead-man switch handles the rest.

**Risk: GitHub rate limits**
`github-client.ts` checks `x-ratelimit-remaining` before every call and waits if below 100. Agents are told in their playbooks to batch reads.

**Risk: Agent-opened PRs are low quality**
`HIVE_DRY_RUN=true` mode goes through the full workflow but logs the PR body instead of creating it. Run in dry-run mode for the first several issues. Only disable after manually reviewing a few PR drafts.

**Open: How to handle repos with non-standard test setups?**
Recommendation: decision tree first (check `package.json` scripts, check `Makefile`, check for `jest.config.*`), fall back to LLM only if the tree produces no match.

**Open: What if a specialist performs worse than the generalist?**
Track per-specialist PR merge rate. After 5 PRs from a specialist, if merge rate is below 20%, mark as `deprecated` and stop spawning.
