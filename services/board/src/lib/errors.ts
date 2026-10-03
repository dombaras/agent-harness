/** A board rule was violated (bad transition, unknown row, invariant failure). */
export class BoardError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "BoardError";
    this.status = status;
  }
}

/** A row/id did not exist (404). */
export class NotFoundError extends BoardError {
  constructor(message: string) {
    super(message, 404);
  }
}

/** An illegal state transition / conflict (409). */
export class ConflictError extends BoardError {
  constructor(message: string) {
    super(message, 409);
  }
}

export function errorResponse(error: unknown): { status: number; body: { error: string } } {
  if (error instanceof BoardError) return { status: error.status, body: { error: error.message } };
  const message = error instanceof Error ? error.message : "Board action failed.";
  return { status: 500, body: { error: message } };
}
