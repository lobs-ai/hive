import { execSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hiveDir = join(__dirname, "..");
const agenticDir = join(hiveDir, "..", "agentic");

function run(cmd, cwd) {
  console.log(`\n$ ${cmd}  (in ${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

console.log("=== Setting up Hive ===\n");

// Install and build each agentic package individually (avoids the memory
// package pulling in better-sqlite3 which fails to compile on Node 25+).
for (const pkg of ["llm", "tools", "runner"]) {
  const pkgDir = join(agenticDir, "packages", pkg);
  const built = existsSync(join(pkgDir, "dist", "index.js"));
  if (built) {
    console.log(`@agentic/${pkg}: already built, skipping`);
  } else {
    console.log(`Installing @agentic/${pkg} deps...`);
    run("npm install --ignore-scripts", pkgDir);
    console.log(`Building @agentic/${pkg}...`);
    run("npm run build", pkgDir);
  }
}

// Symlink inter-package deps so runner can resolve @agentic/llm and @agentic/tools
// at runtime without a full workspace install.
const runnerNM = join(agenticDir, "packages", "runner", "node_modules", "@agentic");
mkdirSync(runnerNM, { recursive: true });
for (const dep of ["llm", "tools"]) {
  const link = join(runnerNM, dep);
  const target = join(agenticDir, "packages", dep);
  if (!existsSync(link)) {
    symlinkSync(target, link, "dir");
    console.log(`Linked @agentic/${dep} → runner/node_modules`);
  }
}

// Install hive deps (npm will symlink the file: references above)
console.log("\nInstalling hive dependencies...");
run("npm install", hiveDir);

console.log("\n=== Setup complete ===");
console.log("Set ANTHROPIC_API_KEY, then run: npm start");
