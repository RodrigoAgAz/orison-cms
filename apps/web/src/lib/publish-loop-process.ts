import { fork } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export function startLoopPublishProcess(loopId: string, publishedByUserId: string) {
  // Resolve tsx's bin entry (dist/cli.mjs) by finding the package root via its
  // package.json, which is always resolvable, then appending the known bin path.
  // We cannot use require.resolve("tsx/dist/cli.mjs") directly because that path
  // is not listed in tsx's package exports map.
  const tsxPkgDir = path.dirname(require.resolve("tsx/package.json"));
  const tsxCliPath = path.join(tsxPkgDir, "dist", "cli.mjs");
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
