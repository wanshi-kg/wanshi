import { Logger } from "../shared";

/** Minimal no-op Logger for unit tests (avoids tslog/file side effects). */
export function stubLogger(): Logger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
  } as unknown as Logger;
}
