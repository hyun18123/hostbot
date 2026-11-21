import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface BotPaths {
  root: string;
  app: string;
  meta: string;
}

export async function ensureDataDirs(): Promise<void> {
  const cfg = config();
  await fs.mkdir(cfg.dataDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(cfg.botsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(cfg.tempDir, { recursive: true, mode: 0o700 });
}

export function botPaths(botId: string): BotPaths {
  if (!/^[0-9a-f-]{36}$/i.test(botId)) throw new Error("Invalid bot id");
  const root = path.join(config().botsDir, botId);
  return { root, app: path.join(root, "app"), meta: path.join(root, "meta") };
}

export async function prepareBotDirs(botId: string): Promise<BotPaths> {
  const paths = botPaths(botId);
  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.app, { recursive: true, mode: 0o750 });
  await fs.mkdir(paths.meta, { recursive: true, mode: 0o700 });
  return paths;
}

export async function removeBotDir(botId: string): Promise<void> {
  const paths = botPaths(botId);
  await fs.rm(paths.root, { recursive: true, force: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function directorySizeBytes(root: string): Promise<number> {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          // file disappeared; ignore
        }
      }
    }
  }
  return total;
}

export async function writeMeta(botId: string, name: string, value: unknown): Promise<void> {
  const paths = botPaths(botId);
  await fs.mkdir(paths.meta, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(paths.meta, name), JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function readMeta<T>(botId: string, name: string): Promise<T | null> {
  try {
    const paths = botPaths(botId);
    const raw = await fs.readFile(path.join(paths.meta, name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Recursively chown a bot directory so the unprivileged container user (10001)
 * can install dependencies and write its own files. Only meaningful on Linux.
 */
export async function chownBotTree(botId: string, uid = 10_001, gid = 10_001): Promise<void> {
  if (process.platform !== "linux") return;
  const paths = botPaths(botId);
  const stack = [paths.root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    try {
      await fs.chown(current, uid, gid);
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else await fs.lchown(full, uid, gid);
      }
    } catch {
      // best effort
    }
  }
}
