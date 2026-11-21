export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 400, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "요청한 대상을 찾을 수 없습니다.") {
    super("not_found", message, 404);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "이 작업을 수행할 권한이 없습니다.") {
    super("forbidden", message, 403);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; message?: string };
  return (
    candidate.code === "23505" ||
    candidate.code === "23P01" ||
    Boolean(candidate.message?.includes("duplicate key value"))
  );
}
