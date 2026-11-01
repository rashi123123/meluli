export const ERROR_CODES = {
  internal: "INTERNAL_ERROR",
  validation: "VALIDATION_ERROR",
  canceled: "CANCELED",
  security: "SECURITY_ERROR"
} as const;

export type AppErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
