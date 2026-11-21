import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { LIMITS } from "@hostbot/shared";
import { AppError } from "../lib/errors.js";

export interface ZipLimits {
  maxBytes: number;
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  maxSingleFileUncompressedBytes: number;
  maxCompressionRatio: number;
  maxPackageJsonBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxBytes: LIMITS.zipBytes,
  maxEntries: LIMITS.zipEntries,
  maxTotalUncompressedBytes: LIMITS.zipTotalUncompressedBytes,
  maxSingleFileUncompressedBytes: LIMITS.zipSingleFileUncompressedBytes,
  maxCompressionRatio: LIMITS.zipCompressionRatio,
  maxPackageJsonBytes: LIMITS.packageJsonBytes,
};

interface EntryMeta {
  name: string;
  isDirectory: boolean;
  uncompressedSize: number;
  compressedSize: number;
}

export interface InspectionResult {
  packageName: string;
  entrypoint: string;
  nodeEngine: string | null;
  dependencies: string[];
  scripts: Record<string, string>;
  fileCount: number;
  uncompressedBytes: number;
  warnings: string[];
}

const ALLOWED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".json5",
  ".ts",
  ".map",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sql",
  ".prisma",
  ".graphql",
  ".gql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".ico",
  ".mp3",
  ".wav",
  ".ogg",
  ".opus",
  ".flac",
  ".mp4",
  ".webm",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".csv",
  ".xml",
  ".mdx",
  ".hbs",
  ".ejs",
  ".pug",
  ".lock",
]);

const DENIED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bat",
  ".cmd",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".js.exe",
  ".msi",
  ".msp",
  ".scr",
  ".com",
  ".cpl",
  ".jar",
  ".war",
  ".bin",
  ".node",
  ".wasm",
  ".apk",
  ".deb",
  ".rpm",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".py",
  ".pyc",
  ".rb",
  ".pl",
  ".php",
]);

const FORBIDDEN_ROOT_FILES = new Set([".env", ".npmrc", ".yarnrc", ".gitconfig", ".bashrc", ".profile"]);

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, validateEntrySizes: true, decodeStrings: true },
      (error, zipfile) => {
        if (error || !zipfile) {
          reject(new AppError("invalid_zip", "ZIP 파일을 열 수 없습니다. 손상되었거나 ZIP 형식이 아닙니다."));
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

function nextEntry(zipfile: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      zipfile.removeListener("entry", onEntry);
      zipfile.removeListener("end", onEnd);
      zipfile.removeListener("error", onError);
    };
    zipfile.once("entry", onEntry);
    zipfile.once("end", onEnd);
    zipfile.once("error", onError);
    zipfile.readEntry();
  });
}

function safeEntryName(rawName: string): string {
  if (!rawName || rawName.length > 240) {
    throw new AppError("invalid_zip_entry", "ZIP 안에 이름이 비정상적으로 긴 파일이 있습니다.");
  }
  if (rawName.includes("\0")) {
    throw new AppError("invalid_zip_entry", "ZIP 안에 허용되지 않는 파일 이름이 있습니다.");
  }
  if (rawName.includes("\\")) {
    throw new AppError("invalid_zip_entry", "ZIP 안에 역슬래시가 포함된 경로가 있습니다.");
  }
  if (/^[A-Za-z]:/.test(rawName)) {
    throw new AppError("invalid_zip_entry", "ZIP 안에 절대 경로가 포함되어 있습니다.");
  }
  const isDirectory = rawName.endsWith("/");
  const trimmed = isDirectory ? rawName.slice(0, -1) : rawName;
  if (trimmed.startsWith("/")) {
    throw new AppError("invalid_zip_entry", "ZIP 안에 절대 경로가 포함되어 있습니다.");
  }
  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new AppError("invalid_zip_entry", "ZIP 안에 상위 폴더로 이동하는 경로가 있습니다.");
  }
  if (normalized !== trimmed) {
    throw new AppError("invalid_zip_entry", "ZIP 안에 정규화되지 않은 경로가 있습니다.");
  }
  return normalized;
}

function unixMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function isSymlink(entry: yauzl.Entry): boolean {
  return (unixMode(entry) & 0o170000) === 0o120000;
}

function isIgnored(name: string): boolean {
  const first = name.split("/")[0];
  if (first === "__MACOSX" || first === ".git") return true;
  const base = name.split("/").pop() ?? "";
  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  return false;
}

function validateFileType(name: string): void {
  const base = name.split("/").pop() ?? "";
  const lower = base.toLowerCase();
  if (FORBIDDEN_ROOT_FILES.has(lower)) {
    throw new AppError(
      "forbidden_file",
      `보안상 ${base} 파일은 업로드할 수 없습니다. 비밀 값은 호스팅 환경변수로 주입하세요.`,
    );
  }
  const extension = path.posix.extname(lower);
  if (DENIED_EXTENSIONS.has(extension)) {
    throw new AppError("forbidden_file", `보안상 ${extension} 파일은 업로드할 수 없습니다. (${base})`);
  }
  if (!ALLOWED_EXTENSIONS.has(extension) && !lower.endsWith(".env.example")) {
    throw new AppError(
      "unsupported_file",
      `지원하지 않는 파일 형식입니다: ${base}. Node.js 봇 소스와 리소스 파일만 업로드할 수 있습니다.`,
    );
  }
}

async function collectEntries(zipfile: yauzl.ZipFile, limits: ZipLimits): Promise<EntryMeta[]> {
  const entries: EntryMeta[] = [];
  let totalUncompressed = 0;

  for (;;) {
    const entry = await nextEntry(zipfile);
    if (!entry) break;
    const name = safeEntryName(entry.fileName);
    if (isSymlink(entry)) {
      throw new AppError("invalid_zip_entry", "ZIP 안에 심볼릭 링크가 포함되어 있습니다.");
    }
    const isDirectory = entry.fileName.endsWith("/");
    if (!isDirectory && isIgnored(name)) continue;

    if (!isDirectory) {
      if (entries.filter((item) => !item.isDirectory).length >= limits.maxEntries) {
        throw new AppError("zip_too_many_files", `ZIP 파일은 ${limits.maxEntries}개 이하의 파일만 허용됩니다.`);
      }
      if (entry.uncompressedSize > limits.maxSingleFileUncompressedBytes) {
        throw new AppError("zip_file_too_large", "ZIP 안의 단일 파일이 허용 크기를 초과했습니다.");
      }
      totalUncompressed += entry.uncompressedSize;
      if (totalUncompressed > limits.maxTotalUncompressedBytes) {
        throw new AppError("zip_expands_too_large", "압축 해제 후 용량이 허용 범위를 초과합니다.");
      }
      if (
        entry.compressedSize > 0 &&
        entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
      ) {
        throw new AppError("zip_bomb_suspected", "압축률이 비정상적으로 높은 파일이 있습니다.");
      }
      validateFileType(name);
    }

    entries.push({
      name,
      isDirectory,
      uncompressedSize: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
    });
  }

  return entries;
}

function determinePrefix(entries: EntryMeta[]): string {
  const files = entries.filter((entry) => !entry.isDirectory);
  if (files.length === 0) {
    throw new AppError("empty_zip", "ZIP 파일에 파일이 없습니다.");
  }
  const firstSegments = new Set(files.map((entry) => entry.name.split("/")[0]));
  const hasRootFile = files.some((entry) => !entry.name.includes("/"));
  if (firstSegments.size === 1 && !hasRootFile) {
    const root = files[0]!.name.split("/")[0]!;
    // Only strip if there is at least one nested file.
    if (files.every((entry) => entry.name.startsWith(`${root}/`) && entry.name.length > root.length + 1)) {
      return `${root}/`;
    }
  }
  return "";
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("invalid_zip_entry", "ZIP 경로가 대상 폴더를 벗어났습니다.");
  }
}

async function extractEntries(
  zipPath: string,
  destDir: string,
  prefix: string,
  limits: ZipLimits,
): Promise<{ fileCount: number; uncompressedBytes: number }> {
  const zipfile = await openZip(zipPath);
  const root = path.resolve(destDir);
  let fileCount = 0;
  let written = 0;

  for (;;) {
    const entry = await nextEntry(zipfile);
    if (!entry) break;
    const name = safeEntryName(entry.fileName);
    if (isIgnored(name)) continue;

    const isDirectory = entry.fileName.endsWith("/");
    let relative = name;
    if (prefix) {
      if (!relative.startsWith(prefix)) continue;
      relative = relative.slice(prefix.length);
    }
    if (!relative) continue;

    const target = path.resolve(root, relative);
    assertInside(root, target);
    if (isDirectory) {
      await fs.mkdir(target, { recursive: true, mode: 0o755 });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => {
      zipfile.openReadStream(entry, (error, readStream) => {
        if (error || !readStream) {
          reject(new AppError("invalid_zip", "ZIP 항목을 읽을 수 없습니다."));
          return;
        }
        resolve(readStream);
      });
    });

    try {
      await pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o644 }));
      const stat = await fs.stat(target);
      // Defense in depth: the central directory may lie about sizes.
      if (stat.size > limits.maxSingleFileUncompressedBytes) {
        throw new AppError("zip_expands_too_large", "압축 해제된 파일이 허용 크기를 초과했습니다.");
      }
      written += stat.size;
      if (written > limits.maxTotalUncompressedBytes) {
        throw new AppError("zip_expands_too_large", "압축 해제 용량이 허용 범위를 초과했습니다.");
      }
    } catch (error) {
      await fs.rm(target, { force: true });
      if (error instanceof AppError) throw error;
      throw new AppError("extract_failed", "ZIP 압축 해제 중 오류가 발생했습니다.");
    }
    fileCount += 1;
  }

  return { fileCount, uncompressedBytes: written };
}

function validateDependencySpec(name: string, spec: string): void {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 200) {
    throw new AppError("invalid_package", `의존성 ${name}의 버전 형식이 올바르지 않습니다.`);
  }
  if (/^(git|github|gitlab|bitbucket|file|link|workspace|http|https|ssh|npm):/i.test(spec)) {
    throw new AppError(
      "unsafe_dependency",
      `의존성 ${name}에 허용되지 않는 설치 경로(${spec.slice(0, 30)})가 있습니다. npm 레지스트리 버전만 사용할 수 있습니다.`,
    );
  }
  if (/[:/\\]/.test(spec)) {
    throw new AppError("unsafe_dependency", `의존성 ${name}의 버전 형식이 허용되지 않습니다.`);
  }
}

interface PackageJsonShape {
  name?: unknown;
  main?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  engines?: unknown;
}

function validatePackageJson(raw: string, files: Set<string>): InspectionResult {
  let pkg: PackageJsonShape;
  try {
    pkg = JSON.parse(raw) as PackageJsonShape;
  } catch {
    throw new AppError("invalid_package", "package.json 형식이 올바르지 않습니다.");
  }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new AppError("invalid_package", "package.json 형식이 올바르지 않습니다.");
  }

  const scripts: Record<string, string> = {};
  if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
    for (const [key, value] of Object.entries(pkg.scripts)) {
      if (typeof value === "string") scripts[key] = value;
    }
  }

  const dependencies: string[] = [];
  for (const field of ["dependencies", "optionalDependencies", "devDependencies"] as const) {
    const value = pkg[field];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AppError("invalid_package", `package.json의 ${field} 형식이 올바르지 않습니다.`);
    }
    for (const [name, spec] of Object.entries(value)) {
      if (typeof spec !== "string") continue;
      validateDependencySpec(name, spec);
      if (field !== "devDependencies") dependencies.push(name);
    }
  }

  const warnings: string[] = [];
  if (typeof pkg.main !== "string" && !scripts.start) {
    warnings.push("package.json에 main 또는 start 스크립트가 없어 기본 진입점을 찾습니다.");
  }
  for (const hook of ["preinstall", "install", "postinstall", "prepare"]) {
    if (scripts[hook]) {
      warnings.push(`${hook} 스크립트는 보안상 실행되지 않습니다.`);
    }
  }

  const entrypoint = resolveEntrypoint(pkg, scripts, files);
  const nodeEngine =
    pkg.engines && typeof pkg.engines === "object" && !Array.isArray(pkg.engines)
      ? typeof (pkg.engines as Record<string, unknown>).node === "string"
        ? ((pkg.engines as Record<string, unknown>).node as string)
        : null
      : null;

  return {
    packageName: typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim().slice(0, 100) : "bot",
    entrypoint,
    nodeEngine,
    dependencies,
    scripts,
    fileCount: files.size,
    uncompressedBytes: 0,
    warnings,
  };
}

function resolveEntrypoint(
  pkg: PackageJsonShape,
  scripts: Record<string, string>,
  files: Set<string>,
): string {
  const candidates: Array<{ value: string; source: string }> = [];
  const start = scripts.start?.trim();
  if (start) {
    const tokens = start.split(/\s+/);
    const runner = tokens[0]?.toLowerCase();
    if (runner !== "node" && runner !== "nodejs") {
      throw new AppError(
        "unsupported_start_script",
        "start 스크립트는 `node <파일>` 형식이어야 합니다. (nodemon, tsx, pm2 등은 지원하지 않습니다)",
      );
    }
    const args = tokens.slice(1).filter((token) => !token.startsWith("-") && !token.startsWith("$"));
    const file = args.at(-1);
    if (file) candidates.push({ value: file, source: "scripts.start" });
  }

  if (typeof pkg.main === "string" && pkg.main.trim()) {
    candidates.push({ value: pkg.main.trim(), source: "main" });
  }

  for (const fallback of [
    "index.js",
    "src/index.js",
    "bot.js",
    "src/bot.js",
    "app.js",
    "src/app.js",
    "main.js",
    "dist/index.js",
  ]) {
    candidates.push({ value: fallback, source: "fallback" });
  }

  for (const candidate of candidates) {
    const normalized = path.posix.normalize(candidate.value.replace(/^\.\//, ""));
    if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) continue;
    if (files.has(normalized)) {
      const extension = path.posix.extname(normalized).toLowerCase();
      if (![".js", ".mjs", ".cjs"].includes(extension)) {
        throw new AppError(
          "unsupported_entrypoint",
          "진입점은 .js / .mjs / .cjs 파일이어야 합니다. TypeScript 봇은 빌드된 결과물을 업로드해 주세요.",
        );
      }
      return normalized;
    }
  }

  throw new AppError(
    "entrypoint_not_found",
    "봇의 실행 파일을 찾지 못했습니다. package.json의 start 또는 main을 확인해 주세요.",
  );
}

/**
 * Inspect the archive without writing files. Useful for quick validation.
 */
export async function inspectZip(
  zipPath: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<{ entries: EntryMeta[]; prefix: string }> {
  const stat = await fs.stat(zipPath);
  if (stat.size > limits.maxBytes) {
    throw new AppError(
      "zip_too_large",
      `ZIP 파일은 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 이하여야 합니다.`,
    );
  }
  const zipfile = await openZip(zipPath);
  const entries = await collectEntries(zipfile, limits);
  return { entries, prefix: determinePrefix(entries) };
}

/**
 * Validate and extract a bot ZIP into `destDir`, then inspect package.json.
 * The destination is expected to be empty; it is removed by the caller on failure.
 */
export async function extractAndInspectBotZip(
  zipPath: string,
  destDir: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<InspectionResult> {
  const { entries, prefix } = await inspectZip(zipPath, limits);
  const expectedFiles = new Set(
    entries
      .filter((entry) => !entry.isDirectory && !isIgnored(entry.name))
      .map((entry) => (prefix && entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name))
      .filter((name) => name.length > 0),
  );

  if (!expectedFiles.has("package.json")) {
    throw new AppError(
      "package_json_missing",
      "ZIP 최상위에 package.json이 필요합니다. (폴더 하나로 감싸진 ZIP은 자동으로 풀어서 검사합니다)",
    );
  }

  const { fileCount, uncompressedBytes } = await extractEntries(zipPath, destDir, prefix, limits);
  if (fileCount === 0) {
    throw new AppError("empty_zip", "ZIP 파일에 실행할 파일이 없습니다.");
  }

  const packagePath = path.join(destDir, "package.json");
  const packageStat = await fs.stat(packagePath);
  if (packageStat.size > limits.maxPackageJsonBytes) {
    throw new AppError("invalid_package", "package.json 파일이 너무 큽니다.");
  }
  const raw = await fs.readFile(packagePath, "utf8");

  const result = validatePackageJson(raw, expectedFiles);
  result.fileCount = fileCount;
  result.uncompressedBytes = uncompressedBytes;

  if (result.nodeEngine) {
    const major = Number(/(\d+)/.exec(result.nodeEngine)?.[1] ?? "0");
    if (major > 24) {
      throw new AppError(
        "unsupported_node_version",
        `요청한 Node.js 버전(${result.nodeEngine})은 호스팅 런타임에서 지원하지 않습니다. Node.js 18~24를 사용해 주세요.`,
      );
    }
  }

  return result;
}
