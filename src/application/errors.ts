// Defines business errors that route adapters can translate into speakable responses.
// Typed errors keep expected call outcomes separate from infrastructure failures.
export class ToolBusinessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "ToolBusinessError";
  }
}

export class IdempotencyConflictError extends ToolBusinessError {
  constructor() {
    super(
      "idempotency_key_reused",
      "That request key was already used for different appointment details. Please start a new booking request.",
    );
    this.name = "IdempotencyConflictError";
  }
}

export function getPostgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
