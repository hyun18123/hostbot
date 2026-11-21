import { z, type ZodTypeAny } from "zod";
import { AppError } from "./errors.js";

export function parseInput<T extends ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      "validation_error",
      result.error.issues[0]?.message ?? "입력값이 올바르지 않습니다.",
      400,
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}

export function requireString(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AppError("validation_error", `${field} 값이 필요합니다.`);
  }
  return value.trim().slice(0, max);
}

export function optionalString(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

export function requireNumber(value: unknown, field: string, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new AppError("validation_error", `${field} 값이 올바르지 않습니다.`);
  }
  return number;
}
