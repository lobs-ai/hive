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
const SESSIONS_DIR = path.join(HIVE_DIR, "sessions");
const AUDIT_FILE = path.join(AUDIT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
const PROJECT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

for (const dir of [WORK_DIR, TOOLS_DIR, AUDIT_DIR, SESSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!process.env.MINIMAX_API_KEY) {
  console.error("MINIMAX_API_KEY is not set.");
  process.exit(1);
}

const spendLimit = parseFloat(process.env.HIVE_SPEND_LIMIT_USD ?? "999");

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

- Your source: ${PROJECT_DIR}/src  (editable — changes take effect next run)
- Your constitution: ${PROJECT_DIR}/constitution.md  (editable directly)
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
  model: "minimax/minimax-m2.7",
  task: `Read the constitution embedded in your system prompt. Read the audit log and ADRs to understand what prior runs did and what slowed them down. Then make Hive better: fix friction, fill gaps in the tool library, improve playbooks, reduce the amnesia tax. Do real external work (fix bugs, build things) to exercise and prove capability — but the primary deliverable is a more capable Hive.`,
  cwd: WORK_DIR,
  tools: activeTools,
  timeout: 86400,
  maxTurns: 2000,
  systemPrompt: SYSTEM_PROMPT,
  // MiniMax emits chain-of-thought inside <think>…</think> tags in the text.
  // Strip them before storing in message history to keep context lean.
  sanitizeResponseContent: (blocks) =>
    blocks.map((b) =>
      b.type === "text"
        ? { ...b, text: b.text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "").trim() }
        : b
    ),
  onProgress: (update) => {
    const label = update.toolName ? `[${update.type}] ${update.toolName}` : `[${update.type}]`;
    process.stdout.write(label + "\n");
    // Record full agent text responses for blog/review purposes
    if (update.type === "agent_response" && update.content) {
      fs.appendFileSync(
        path.join(SESSIONS_DIR, `${RUN_ID}.jsonl`),
        JSON.stringify({ ts: Date.now(), type: "agent_response", content: update.content }) + "\n"
      );
    }
    if (update.type === "tool_call" && update.toolName && update.toolInput) {
      fs.appendFileSync(
        path.join(SESSIONS_DIR, `${RUN_ID}.jsonl`),
        JSON.stringify({ ts: Date.now(), type: "tool_call", tool: update.toolName, input: update.toolInput }) + "\n"
      );
    }
  },
});

console.log("\n=== Run complete ===");
console.log(`Succeeded: ${result.succeeded}`);
console.log(`Cost:      $${result.costUsd.toFixed(4)}`);
console.log(`Turns:     ${result.turns}`);
if (!result.succeeded && result.error) console.log(`Error:     ${result.error}`);
audit({ type: "run_summary", ...result });
// Save full session summary for blog/review
fs.writeFileSync(
  path.join(SESSIONS_DIR, `${RUN_ID}-summary.json`),
  JSON.stringify({ runId: RUN_ID, ...result }, null, 2)
);
