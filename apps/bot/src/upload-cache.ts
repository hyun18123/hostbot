interface PendingUpload {
  url: string;
  filename: string;
  size: number;
  guildId: string;
  userId: string;
  expiresAt: number;
}

const pending = new Map<string, PendingUpload>();
const TTL_MS = 15 * 60_000;

export function putPendingUpload(key: string, upload: Omit<PendingUpload, "expiresAt">): void {
  cleanup();
  pending.set(key, { ...upload, expiresAt: Date.now() + TTL_MS });
}

export function takePendingUpload(key: string): PendingUpload | null {
  cleanup();
  const value = pending.get(key);
  if (!value) return null;
  pending.delete(key);
  return value;
}

function cleanup(): void {
  const now = Date.now();
  for (const [key, value] of pending) {
    if (value.expiresAt <= now) pending.delete(key);
  }
}
