import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const npmBin = isWin ? "cmd.exe" : "npm";

function launch(name, args) {
  const fullArgs = isWin ? ["/c", "npm", ...args] : args;
  const child = spawn(npmBin, fullArgs, {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });
  return child;
}

const server = launch("server", ["--workspace=server", "run", "dev"]);
const web = launch("web", ["--workspace=web", "run", "dev"]);

function shutdown() {
  server.kill();
  web.kill();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
