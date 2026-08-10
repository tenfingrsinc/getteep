import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { PollingState } from "./xPollingListener";

function validCursor(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

export async function loadPollingState(): Promise<PollingState> {
  try {
    const parsed = JSON.parse(await readFile(config.pollStatePath, "utf8")) as Record<string, unknown>;
    return {
      mentionsLastSeenId: validCursor(parsed.mentionsLastSeenId) ? parsed.mentionsLastSeenId : undefined,
      searchLastSeenId: validCursor(parsed.searchLastSeenId) ? parsed.searchLastSeenId : undefined,
    };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return {};
    console.warn(`[x-agent] Could not load poll cursors from ${config.pollStatePath}; using bounded startup lookback`);
    return {};
  }
}

export async function savePollingState(state: PollingState): Promise<void> {
  const destination = path.resolve(config.pollStatePath);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
