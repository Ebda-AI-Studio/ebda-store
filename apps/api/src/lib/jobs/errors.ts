/** A failure a retry cannot fix: the run stops at once (replaces the Inngest SDK's class of the same name). */
export class NonRetriableError extends Error {
  override readonly name = 'NonRetriableError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
