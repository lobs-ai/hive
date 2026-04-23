import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
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

// When running locally, build any unbuilt agentic packages first.
// In Docker the dist/ folders are pre-copied so this is a no-op.
if (existsSync(join(agenticDir, "package.json"))) {
  if (!existsSync(join(agenticDir, "node_modules", "@agentic"))) {
    console.log("Installing agentic workspace dependencies...");
    run("npm install --ignore-scripts", agenticDir);
  }
  for (const pkg of ["llm", "tools", "runner"]) {
    const pkgDir = join(agenticDir, "packages", pkg);
    if (existsSync(join(pkgDir, "dist", "index.js"))) {
      console.log(`@agentic/${pkg}: already built, skipping`);
    } else {
      console.log(`Building @agentic/${pkg}...`);
      run("npm run build", pkgDir);
    }
  }
}

// In Docker there is no workspace install, so each package's external deps
// (e.g. @anthropic-ai/sdk inside llm) must be installed individually.
// Node resolves from the real file path, not the symlink, so they must live
// inside the package's own node_modules.
if (!existsSync(join(agenticDir, "package.json"))) {
  for (const pkg of ["llm", "tools"]) {
    const pkgDir = join(agenticDir, "packages", pkg);
    if (!existsSync(join(pkgDir, "node_modules"))) {
      console.log(`Installing @agentic/${pkg} deps...`);
      run("npm install --ignore-scripts", pkgDir);
    }
  }
}

// Symlink @agentic/llm and @agentic/tools into runner/node_modules so the
// runner can resolve them at runtime regardless of workspace setup.
const runnerNM = join(agenticDir, "packages", "runner", "node_modules", "@agentic");
mkdirSync(runnerNM, { recursive: true });
for (const dep of ["llm", "tools"]) {
  const link = join(runnerNM, dep);
  // lstatSync doesn't follow symlinks, so it returns stat of the link itself
  const linkExists = (() => { try { lstatSync(link); return true; } catch { return false; } })();
  if (!linkExists) {
    symlinkSync(join(agenticDir, "packages", dep), link, "dir");
    console.log(`Linked @agentic/${dep} → runner/node_modules`);
  }
}

// Install hive deps (npm symlinks the file: references and installs their transitive deps).
console.log("\nInstalling hive dependencies...");
run("npm install", hiveDir);

console.log("\n=== Setup complete ===");
console.log("Set MINIMAX_API_KEY, then run: npm start");
