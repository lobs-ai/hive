# Hive: Implementation Plan

## What the developer writes

~150 lines across four files. That's it.

```
hive/
  package.json        # deps: @agentic/runner, tsx
  tsconfig.json       # NodeNext ESM
  constitution.md     # mission, values, constraints — the agent's north star
  src/bootstrap.ts    # register 4 tools, load agent tools, call runAgent
  scripts/setup.mjs   # build agentic packages, install hive deps
```

The developer does not design the infrastructure. The agent does.

## What the agent builds

The bootstrap agent starts with four primitive tools — `exec`, `read`, `write`, `ls` — and a constitution. It figures out the rest.

It will need to discover:
- What tools Hive needs (GitHub API, git, HTTP, memory, spawning)
- What the tool interface looks like (by reading the agentic source)
- How agents should coordinate (goal registry, messaging)
- How to contain itself (Docker, network policy)
- How to accumulate knowledge (playbooks, memory, ADRs)

Every tool it writes goes to `~/.hive/tools/` and is auto-loaded on the next run. Every decision gets an ADR in `~/.hive/decisions/`. Every playbook goes to `~/.hive/playbooks/`.

## What success looks like

The bootstrap agent reads the constitution, explores the agentic toolkit source, decides what it needs, builds it, and opens a PR on a real GitHub issue — without the developer writing any of that logic.

After that first run, the system has a tool library and a set of playbooks that the agent invented. Each subsequent run builds on what the last one produced.

## Constraints the developer enforces

- `exec` tool: blocks `rm -rf /`, `curl | bash`, and similar patterns
- Audit log: every tool call is written to `~/.hive/audit/YYYY-MM-DD.jsonl`
- Spend limit: `HIVE_SPEND_LIMIT_USD` env var, checked at startup
- The bootstrap system prompt does not prescribe architecture — it states the mission and points to examples
