import { fork } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export function startLoopPublishProcess(loopId: string, publishedByUserId: string) {
  const tsxCliPath = require.resolve("tsx/dist/cli.mjs");
  const childScriptPath = path.join(process.cwd(), "apps", "web", "src", "lib", "publish-loop-child.ts");

  const child = fork(tsxCliPath, [childScriptPath, loopId, publishedByUserId], {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  child.unref();
  return child.pid;
}
