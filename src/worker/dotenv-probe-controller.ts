/**
 * TEST-ONLY fixture controller for the dotenv hermeticity regression
 * (issue #105, P1). The sandbox test spawns this file as a real process from
 * a temporary HOSTILE cwd that contains a `.env` with Slack secrets, then
 * reads this controller's stdout. Driving `probeChildProcessSandbox` from
 * that hostile cwd is the only faithful reproduction: under the OLD child
 * lane the sandbox child inherited the controller's hostile cwd (and ran
 * without `--no-env-file`), so Bun eagerly auto-loaded the `.env` and the
 * checked-in child self-reported the leaked Slack tokens. The fixed lane
 * re-spawns the child from its own EMPTY temp cwd, so this controller must
 * observe no forbidden environment crossing.
 *
 * This is a process fixture, never part of the production boundary.
 */
import { probeChildProcessSandbox } from "./run-job-test-fabric";

function argValue(name: string): string {
  const prefix = `--${name}=`;
  const match = process.argv.find((a) => a.startsWith(prefix));
  if (match === undefined) throw new Error(`missing required arg --${name}=`);
  return match.slice(prefix.length);
}

const dbPath = argValue("dbPath");
const transcriptDir = argValue("transcriptDir");

const probe = await probeChildProcessSandbox({ dbPath, transcriptDir });
process.stdout.write(JSON.stringify(probe));