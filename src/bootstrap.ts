import { runAgent, registerTool, getHookRegistry } from "@agentic/runner";
import {
  readToolDefinition, readTool,
  writeToolDefinition, writeTool,
  execToolDefinition, execTool,
  lsToolDefinition, lsTool,
} from "@agentic/tools";
import type { ToolExecutorResult } from "@agentic/tools";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";

// ── Directories ───────────────────────────────────────────────────────────────

const HIVE_DIR = path.join(os.homedir(), ".hive");
const WORK_DIR = process.env.HIVE_WORK_DIR ?? path.join(HIVE_DIR, "workspace");
const TOOLS_DIR = path.join(HIVE_DIR, "tools");
const AUDIT_DIR = path.join(HIVE_DIR, "audit");
const AUDIT_FILE = path.join(AUDIT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
const PROJECT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENTIC_DIR = path.join(PROJECT_DIR, "..", "agentic");

for (const dir of [WORK_DIR, TOOLS_DIR, AUDIT_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Spend guard ───────────────────────────────────────────────────────────────

const spendLimit = parseFloat(process.env.HIVE_SPEND_LIMIT_USD ?? "10");
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

function audit(entry: Record<string, unknown>) {
  fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

// ── Tool adapter ──────────────────────────────────────────────────────────────

function wrap(executor: (p: Record<string, unknown>, cwd: string) => Promise<ToolExecutorResult>) {
  return async (params: Record<string, unknown>, cwd: string) => {
    const r = await executor(params, cwd);
    return { output: typeof r === "string" ? r : r.result };
  };
}

// ── Primitive tools ───────────────────────────────────────────────────────────

// @agentic/tools ToolDefinition.input_schema is Record<string,unknown> while
// @agentic/runner expects @agentic/llm's stricter ToolInputSchema — same shape
// at runtime, cast to satisfy the registry's type.
type AnyDef = Parameters<typeof registerTool>[1]["definition"];
registerTool("read",  { definition: readToolDefinition  as AnyDef, execute: wrap(readTool)  });
registerTool("write", { definition: writeToolDefinition as AnyDef, execute: wrap(writeTool) });
registerTool("exec",  { definition: execToolDefinition  as AnyDef, execute: wrap(execTool)  });
registerTool("ls",    { definition: lsToolDefinition    as AnyDef, execute: wrap(lsTool)    });

const activeTools = ["read", "write", "exec", "ls"];

// ── Load agent-built tools from ~/.hive/tools/ ────────────────────────────────

async function loadAgentTools() {
  const files = fs.readdirSync(TOOLS_DIR).filter(f => f.endsWith(".ts") || f.endsWith(".js"));
  for (const file of files) {
    try {
      const filePath = path.join(TOOLS_DIR, file);
      const mod = await import(pathToFileURL(filePath).href);
      const tool = mod.tool ?? mod.default?.tool;
      if (tool?.name && tool.input_schema && tool.handler) {
        registerTool(tool.name, {
          definition: { name: tool.name, description: tool.description, input_schema: tool.input_schema },
          execute: async (params, cwd) => {
            const r = await tool.handler(params, { cwd });
            return { output: typeof r === "string" ? r : JSON.stringify(r) };
          },
        });
        activeTools.push(tool.name);
        console.log(`  loaded: ${tool.name}`);
      }
    } catch (err) {
      console.warn(`  failed to load ${file}:`, err instanceof Error ? err.message : err);
    }
  }
}

if (fs.readdirSync(TOOLS_DIR).length > 0) {
  console.log("Loading agent tools from ~/.hive/tools/...");
  await loadAgentTools();
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

const hooks = getHookRegistry();

hooks.register("before_tool_call", (event) => {
  audit({ type: "tool_call", tool: event.data["toolName"], input: event.data["toolInput"] });
  return event;
});

hooks.register("after_tool_call", (event) => {
  audit({ type: "tool_result", tool: event.data["toolName"], isError: event.data["isError"] });
  return event;
});

hooks.register("after_agent_end", (event) => {
  const cost = (event.data["costUsd"] as number) ?? 0;
  audit({ type: "agent_end", succeeded: event.data["succeeded"], costUsd: cost });
  if (cost > spendLimit) {
    console.warn(`WARNING: run cost $${cost.toFixed(4)} exceeded limit of $${spendLimit}`);
  }
  return event;
});

// ── System prompt ─────────────────────────────────────────────────────────────

const constitution = fs.readFileSync(path.join(PROJECT_DIR, "constitution.md"), "utf8");

const SYSTEM_PROMPT = `${constitution}

---

## Environment

- Hive project: ${PROJECT_DIR}
- Agentic toolkit source: ${AGENTIC_DIR}
- Your tool library: ${TOOLS_DIR}  (auto-loaded at startup each run)
- Your workspace: ${WORK_DIR}
- Your decisions: ${path.join(HIVE_DIR, "decisions")}
- Your playbooks: ${path.join(HIVE_DIR, "playbooks")}
- Audit log: ${AUDIT_FILE}

Currently available tools: ${activeTools.join(", ")}

Tools you write this session are available on the NEXT run. Within this run, test them
by executing them as scripts via the exec tool.`;

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\nStarting bootstrap agent`);
console.log(`Tools: ${activeTools.join(", ")}`);
console.log(`Spend limit: $${spendLimit}\n`);

const result = await runAgent({
  agent: "bootstrap",
  model: "anthropic/claude-sonnet-4-6",
  task: `Read the constitution (it is embedded in your system prompt). Then explore the agentic toolkit source at ${AGENTIC_DIR} to understand the tool interface and agent loop. Then decide what Hive needs and start building it. Your deliverables: tools in ~/.hive/tools/, playbooks in ~/.hive/playbooks/, ADRs in ~/.hive/decisions/, and at least one real GitHub issue fixed.`,
  cwd: WORK_DIR,
  tools: activeTools,
  timeout: 7200,
  maxTurns: 200,
  systemPrompt: SYSTEM_PROMPT,
  onProgress: (update) => {
    const label = update.toolName ? `[${update.type}] ${update.toolName}` : `[${update.type}]`;
    process.stdout.write(label + "\n");
  },
});

console.log("\n=== Run complete ===");
console.log(`Succeeded: ${result.succeeded}`);
console.log(`Cost:      $${result.costUsd.toFixed(4)}`);
console.log(`Turns:     ${result.turns}`);
if (!result.succeeded && result.error) console.log(`Error:     ${result.error}`);
audit({ type: "run_summary", ...result });
