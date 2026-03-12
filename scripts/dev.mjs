import { spawn } from "node:child_process";

const children = [];

function run(command, args, name, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      console.error(`${name} exited with code ${code ?? 1}`);
      process.exitCode = code ?? 1;
      shutdown();
    }
  });

  children.push(child);
}

function shutdown() {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", shutdown);

run("node", ["server/index.mjs"], "server");
run("npm", ["run", "dev:ui"], "ui");
