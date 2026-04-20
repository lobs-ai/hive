# Hive

Hive is an autonomous agent ecosystem — a continuously running network of AI agents that discover, analyze, and solve real problems (initially TypeScript/JS open-source GitHub issues) while also improving the ecosystem itself (tools, playbooks, workflows).

The core idea: agents collaborate, specialize, spawn specialists, and accumulate shared knowledge over time. Collective intelligence emerges from the system, not from any single agent.

## Stack

Node.js 22, TypeScript, Docker, Redis, SQLite, React/Vite, lobs-core, lobs-memory

## Key Concepts

**Agents** have persistent identity (ed25519 keypairs), memory, goals, and can spawn specialists (up to 5 children each). Roles — Explorer, Implementer, Debugger, Toolsmith, Librarian, Architect — emerge organically.

**Goals** are claimed before work starts to prevent duplication. They flow: `proposed → active → blocked → completed/failed`.

**Knowledge** accumulates in `/workspace/tools/` (reusable scripts) and playbooks (Markdown strategies). Retrieval uses lobs-memory hybrid search (vector + BM25).

**Containment**: each agent runs in Docker with isolated filesystem, controlled network (GitHub API, LLM APIs, npm only), and compute budgets. Dead-man switch halts everything if spend/agent-count thresholds are exceeded.

## Phases

0. Infrastructure (Docker, audit, messaging, runtime)
1. Single agent + basic solve workflow
2. Knowledge (tools, playbooks, memory retrieval)
3. Goal system (registry, claiming, delegation)
4. Discovery (GitHub issue monitoring)
5. Multi-agent (spawning, coordination, messaging)
6. Ecosystem (specialization, adaptive behavior)
