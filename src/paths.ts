import os from "node:os";
import path from "node:path";

/**
 * KiCode's own directory — sessions and the global config live here. Never the
 * project, so transcripts and server config do not end up committed by accident.
 */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.KICODE_HOME?.trim();
  return custom ? custom : path.join(os.homedir(), ".kicode");
}

export const CONFIG_FILENAME = "kicode.json";
