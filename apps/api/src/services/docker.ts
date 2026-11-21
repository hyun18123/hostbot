import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Dockerode from "dockerode";
import type { HostedBotRow } from "@hostbot/shared";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { botPaths, chownBotTree, directorySizeBytes, pathExists, readMeta, writeMeta } from "./storage.js";

const INSTALL_MARKER = "install.json";
const CONTAINER_USER = "10001:10001";

interface InstallMarker {
  packageHash: string;
  installedAt: string;
  image: string;
}

export interface StartResult {
  containerId: string;
  containerName: string;
}

export interface ContainerState {
  exists: boolean;
  running: boolean;
  exitCode: number | null;
  status: string;
}

function containerName(botId: string): string {
  return `hostbot-${botId}`;
}

function demoMode(): boolean {
  return !config().DOCKER_ENABLED;
}

let docker: Dockerode | null = null;

function client(): Dockerode {
  if (!docker) {
    docker = new Dockerode({ socketPath: config().DOCKER_SOCKET_PATH });
  }
  return docker;
}

async function ensureImage(): Promise<void> {
  const cfg = config();
  try {
    await client().getImage(cfg.BOT_RUNTIME_IMAGE).inspect();
  } catch {
    throw new AppError(
      "runtime_image_missing",
      `봇 런타임 이미지(${cfg.BOT_RUNTIME_IMAGE})를 찾을 수 없습니다. VPS에서 infra/runtime-node 이미지를 먼저 빌드해 주세요.`,
      503,
    );
  }
}

async function ensureNetwork(): Promise<string> {
  const networkName = process.env.BOT_DOCKER_NETWORK?.trim() || "hostbot-bots";
  try {
    await client().getNetwork(networkName).inspect();
  } catch {
    try {
      await client().createNetwork({
        Name: networkName,
        Driver: "bridge",
        Options: {
          "com.docker.network.bridge.enable_icc": "false",
          "com.docker.network.bridge.enable_ip_masquerade": "true",
        },
        Labels: { "hostbot.managed": "true" },
      });
      logger.info({ networkName }, "created isolated bot network");
    } catch (error) {
      throw new AppError(
        "docker_network_error",
        `봇 격리 네트워크(${networkName})를 준비하지 못했습니다.`,
        503,
        String(error),
      );
    }
  }
  return networkName;
}

/** Verify Docker connectivity and required resources once at startup. */
export async function initDocker(): Promise<void> {
  if (demoMode()) {
    logger.warn("DOCKER_ENABLED=false - container operations are simulated");
    return;
  }
  try {
    await client().ping();
  } catch (error) {
    throw new Error(`Docker daemon is not reachable: ${String(error)}`);
  }
  await ensureNetwork();
  await ensureImage();
  logger.info({ image: config().BOT_RUNTIME_IMAGE }, "docker runner ready");
}

async function packageHash(appDir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json"]) {
    try {
      hash.update(file);
      hash.update(await fs.readFile(path.join(appDir, file)));
    } catch {
      hash.update(`${file}:missing`);
    }
  }
  return hash.digest("hex");
}

async function collectContainerLogs(container: Dockerode.Container, tail = 80): Promise<string> {
  try {
    const buffer = (await container.logs({ stdout: true, stderr: true, tail })) as Buffer;
    return demuxBuffer(buffer);
  } catch {
    return "";
  }
}

/**
 * Docker's non-TTY log stream is framed as:
 *   [stream:1][padding:3][size:4 BE][payload:size]
 * Parsing it directly avoids async demux races.
 */
function demuxBuffer(buffer: Buffer): string {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (size === 0 || end > buffer.length) break;
    chunks.push(buffer.subarray(start, end));
    offset = end;
  }
  if (chunks.length === 0) return buffer.toString("utf8");
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForContainer(container: Dockerode.Container, timeoutMs: number): Promise<number> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      container.kill().catch(() => undefined);
      reject(new AppError("container_timeout", "컨테이너 작업이 시간 초과되었습니다.", 504));
    }, timeoutMs);
    timer.unref();
  });
  const result = (await Promise.race([container.wait(), timeout])) as { StatusCode?: number };
  return result.StatusCode ?? -1;
}

async function removeContainerQuietly(botId: string): Promise<void> {
  if (demoMode()) return;
  const name = containerName(botId);
  try {
    const container = client().getContainer(name);
    try {
      await container.stop({ t: 10 });
    } catch {
      // already stopped
    }
    await container.remove({ force: true });
  } catch {
    // not found
  }
}

async function findContainer(bot: Pick<HostedBotRow, "id" | "container_id" | "container_name">): Promise<Dockerode.Container | null> {
  if (demoMode()) return null;
  const candidates = [bot.container_id, bot.container_name, containerName(bot.id)].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      const container = client().getContainer(candidate);
      await container.inspect();
      return container;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Installs production dependencies inside a disposable container.
 * `--ignore-scripts` is mandatory: npm lifecycle hooks are arbitrary code and
 * must not run with the API host's privileges.
 */
export async function installBotDependencies(botId: string, force = false): Promise<{ installed: boolean; log: string }> {
  const cfg = config();
  const paths = botPaths(botId);
  if (!(await pathExists(path.join(paths.app, "package.json")))) {
    throw new AppError("source_missing", "봇 소스 파일이 없습니다. 다시 등록해 주세요.");
  }

  const hash = await packageHash(paths.app);
  const marker = await readMeta<InstallMarker>(botId, INSTALL_MARKER);
  if (!force && marker && marker.packageHash === hash && marker.image === cfg.BOT_RUNTIME_IMAGE) {
    return { installed: false, log: "dependencies already installed" };
  }

  if (demoMode()) {
    await writeMeta(botId, INSTALL_MARKER, {
      packageHash: hash,
      installedAt: new Date().toISOString(),
      image: cfg.BOT_RUNTIME_IMAGE,
    } satisfies InstallMarker);
    return { installed: true, log: "[docker disabled] dependency installation simulated" };
  }

  await ensureImage();
  await chownBotTree(botId);
  const networkName = await ensureNetwork();

  const container = await client().createContainer({
    Image: cfg.BOT_RUNTIME_IMAGE,
    name: `hostbot-install-${botId}`,
    Cmd: ["npm", "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"],
    WorkingDir: "/app",
    User: CONTAINER_USER,
    Env: [
      "HOME=/tmp",
      "npm_config_cache=/tmp/npm-cache",
      "npm_config_update_notifier=false",
      "npm_config_fund=false",
      "npm_config_audit=false",
      "npm_config_ignore_scripts=true",
      "NODE_ENV=production",
    ],
    Labels: { "hostbot.managed": "true", "hostbot.bot_id": botId, "hostbot.role": "install" },
    HostConfig: {
      Binds: [`${paths.app}:/app:rw`],
      Memory: Math.max(cfg.BOT_MEMORY_MB, 512) * 1024 * 1024,
      NanoCpus: 1_000_000_000,
      PidsLimit: 256,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=256m" },
      NetworkMode: networkName,
      AutoRemove: false,
    },
  });

  let log = "";
  try {
    await container.start();
    const exitCode = await waitForContainer(container, cfg.INSTALL_TIMEOUT_MS);
    log = await collectContainerLogs(container, 200);
    if (exitCode !== 0) {
      throw new AppError(
        "dependency_install_failed",
        "봇 의존성 설치에 실패했습니다. package.json과 네트워크 상태를 확인해 주세요.",
        422,
        log.slice(-3000),
      );
    }
    await writeMeta(botId, INSTALL_MARKER, {
      packageHash: hash,
      installedAt: new Date().toISOString(),
      image: cfg.BOT_RUNTIME_IMAGE,
    } satisfies InstallMarker);
    return { installed: true, log: log.slice(-3000) };
  } finally {
    await container.remove({ force: true }).catch(() => undefined);
  }
}

export async function startBotContainer(
  bot: HostedBotRow,
  token: string,
  entrypoint: string,
): Promise<StartResult> {
  const cfg = config();
  const paths = botPaths(bot.id);
  if (!(await pathExists(path.join(paths.app, entrypoint)))) {
    throw new AppError("source_missing", "봇 실행 파일이 없습니다. 소스를 다시 등록해 주세요.");
  }

  const size = await directorySizeBytes(paths.root);
  if (size > cfg.BOT_STORAGE_MB * 1024 * 1024) {
    throw new AppError(
      "storage_exceeded",
      `봇 저장공간 사용량이 제한(${cfg.BOT_STORAGE_MB}MB)을 초과했습니다. 불필요한 파일을 정리해 주세요.`,
    );
  }

  if (demoMode()) {
    return { containerId: `sim-${randomUUID()}`, containerName: containerName(bot.id) };
  }

  await ensureImage();
  await ensureNetwork();
  await removeContainerQuietly(bot.id);

  const name = containerName(bot.id);
  const container = await client().createContainer({
    Image: cfg.BOT_RUNTIME_IMAGE,
    name,
    Cmd: ["node", entrypoint],
    WorkingDir: "/app",
    User: CONTAINER_USER,
    Env: [
      `TOKEN=${token}`,
      `DISCORD_TOKEN=${token}`,
      `BOT_TOKEN=${token}`,
      `HOSTBOT_BOT_ID=${bot.id}`,
      "NODE_ENV=production",
      "HOME=/tmp",
    ],
    Labels: { "hostbot.managed": "true", "hostbot.bot_id": bot.id, "hostbot.role": "bot" },
    HostConfig: {
      Binds: [`${paths.app}:/app:rw`],
      Memory: cfg.BOT_MEMORY_MB * 1024 * 1024,
      MemorySwap: cfg.BOT_MEMORY_MB * 1024 * 1024,
      NanoCpus: Math.round(cfg.BOT_CPU_LIMIT * 1_000_000_000),
      PidsLimit: cfg.BOT_PIDS_LIMIT,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
      NetworkMode: process.env.BOT_DOCKER_NETWORK?.trim() || "hostbot-bots",
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
      AutoRemove: false,
    },
  });

  await container.start();
  const started = await waitForContainerStart(container, cfg.START_TIMEOUT_MS);
  if (!started.running) {
    const log = await collectContainerLogs(container, 80);
    await container.remove({ force: true }).catch(() => undefined);
    throw new AppError(
      "bot_crashed_on_start",
      "봇이 시작 직후 종료되었습니다. 토큰과 코드를 확인해 주세요.",
      422,
      log.slice(-3000),
    );
  }

  return { containerId: container.id, containerName: name };
}

async function waitForContainerStart(
  container: Dockerode.Container,
  timeoutMs: number,
): Promise<{ running: boolean }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const info = await container.inspect();
    if (!info.State.Running) return { running: false };
    // Give the process a moment to crash if it is going to.
    if (Date.now() - new Date(info.State.StartedAt).getTime() > 2500) {
      return { running: true };
    }
  }
  const info = await container.inspect();
  return { running: Boolean(info.State.Running) };
}

export async function stopBotContainer(bot: HostedBotRow): Promise<void> {
  if (demoMode()) return;
  await removeContainerQuietly(bot.id);
}

export async function removeBotContainer(bot: HostedBotRow): Promise<void> {
  if (demoMode()) return;
  const container = await findContainer(bot);
  if (container) {
    try {
      await container.stop({ t: 5 });
    } catch {
      // ignore
    }
    await container.remove({ force: true }).catch(() => undefined);
  }
  await removeContainerQuietly(bot.id);
}

export async function getContainerState(bot: HostedBotRow): Promise<ContainerState> {
  if (demoMode()) {
    return {
      exists: true,
      running: bot.status === "running" || bot.status === "starting",
      exitCode: 0,
      status: "simulated",
    };
  }
  const container = await findContainer(bot);
  if (!container) return { exists: false, running: false, exitCode: null, status: "missing" };
  try {
    const info = await container.inspect();
    return {
      exists: true,
      running: Boolean(info.State.Running),
      exitCode: typeof info.State.ExitCode === "number" ? info.State.ExitCode : null,
      status: String(info.State.Status ?? "unknown"),
    };
  } catch {
    return { exists: false, running: false, exitCode: null, status: "missing" };
  }
}

export async function getBotLogs(bot: HostedBotRow, tail = 150): Promise<string> {
  if (demoMode()) {
    return "[docker disabled] 컨테이너 로그는 DOCKER_ENABLED=true 인 VPS에서만 확인할 수 있습니다.";
  }
  const container = await findContainer(bot);
  if (!container) return "(실행 중인 컨테이너가 없습니다)";
  return collectContainerLogs(container, tail);
}

export async function cleanupInstallContainer(botId: string): Promise<void> {
  if (demoMode()) return;
  try {
    const container = client().getContainer(`hostbot-install-${botId}`);
    await container.remove({ force: true });
  } catch {
    // not found
  }
}
