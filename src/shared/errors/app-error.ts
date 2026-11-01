import { ZodError } from "zod";
import { ERROR_CODES, type AppErrorCode } from "./error-codes";

export interface AppErrorContract {
  code: AppErrorCode | string;
  message: string;
  details?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: AppErrorCode | string;
  readonly details?: Record<string, unknown>;

  constructor(code: AppErrorCode | string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  toJSON(): AppErrorContract {
    return this.details ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
  }

  static fromUnknown(error: unknown): AppError {
    if (error instanceof AppError) {
      return error;
    }

    if (error instanceof ZodError) {
      return new AppError(ERROR_CODES.validation, error.issues[0]?.message ?? error.message, {
        issues: error.issues
      });
    }

    if (error instanceof Error) {
      const details = "details" in error && typeof error.details === "object" && error.details
        ? (error.details as Record<string, unknown>)
        : undefined;
      const code = "code" in error && typeof error.code === "string"
        ? error.code
        : ERROR_CODES.internal;
      return new AppError(code, error.message, details);
    }

    return new AppError(ERROR_CODES.internal, String(error));
  }
}

