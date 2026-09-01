import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { AgentRuntimeError } from "./errors.js";

const RUN_ID_PATTERN = /^[a-zA-Z0-9._-]{1,80}$/;

export class StateStore {
  constructor(workspace, directory = join(workspace, ".frontier-agent", "runs")) {
    const root = resolve(workspace);
    this.directory = resolve(directory);
    if (this.directory !== root && !this.directory.startsWith(`${root}${sep}`)) {
      throw new AgentRuntimeError("STATE_PATH_ESCAPE", "Agent state must be stored inside the workspace.");
    }
  }

  pathFor(runId) {
    if (!RUN_ID_PATTERN.test(runId)) throw new AgentRuntimeError("INVALID_RUN_ID", "Run IDs may contain only letters, numbers, dots, underscores, and hyphens.");
    return join(this.directory, `${runId}.json`);
  }

  async load(runId) {
    try {
      return JSON.parse(await readFile(this.pathFor(runId), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new AgentRuntimeError("CORRUPT_STATE", "The persisted agent state is not valid JSON.");
      throw error;
    }
  }

  async save(state) {
    const path = this.pathFor(state.runId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }
}
