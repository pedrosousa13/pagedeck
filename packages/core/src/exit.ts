import { printable } from "@pagedeck/content/escape";

export { printable };

export const EXIT_CODES = {
  success: 0,
  syncFailed: 1,
  configError: 2,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

export function describeError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(
      messages.length === 0 ? current.message : printable(current.message),
    );
    current = current.cause;
  }
  if (messages.length === 0) messages.push(printable(String(error)));
  return messages.join(": ");
}
