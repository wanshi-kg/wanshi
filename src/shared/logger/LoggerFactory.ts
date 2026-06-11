import { appendFileSync } from "fs";
import { Logger as TSLogger } from "tslog";
import { ProcessingOptions } from "../../types";
import { Logger } from "./Logger";

export class LoggerFactory {
  static createLogger(
    options: { logging?: Partial<ProcessingOptions["logging"]> }
  ): Logger {
    const {
      file: logFile,
      level: logLevel,
      silent,
      debug,
      progressNdjson,
    } = options.logging ?? {};

    const logger = new TSLogger<any>({
      name: "kg-gen",
      // In NDJSON progress mode, suppress tslog's built-in pretty output so it
      // can't pollute the structured stdout stream; we re-emit logs ourselves as
      // `channel: "log"` lines below.
      type: progressNdjson ? "hidden" : "pretty",
      // tslog scale: silly=0, trace=1, debug=2, info=3, warn=4, error=5, fatal=6.
      // The old mapping was two notches loose (info→1 = "trace and up"), and
      // `silent` at 4 still printed warn/error. (KG-19)
      minLevel: silent
        ? 7 // above fatal → nothing prints
        : debug
        ? 2
        : logLevel === "debug"
        ? 2
        : logLevel === "info"
        ? 3
        : logLevel === "warning"
        ? 4
        : logLevel === "error"
        ? 5
        : 3,
    });

    if (progressNdjson) {
      // Bridge logs onto the same NDJSON stdout stream the progress emitter uses,
      // so a parent process gets a live log tail demuxed by `channel`.
      logger.attachTransport((logObj) => {
        try {
          process.stdout.write(
            JSON.stringify({
              channel: "log",
              ts: Date.now(),
              level: String(logObj?._meta?.logLevelName ?? "INFO").toLowerCase(),
              message: stringifyLogArgs(logObj),
            }) + "\n"
          );
        } catch {
          // side-channel only — swallow write errors (e.g. EPIPE)
        }
      });
    }

    if (logFile) {
      logger.attachTransport((logObj) => {
        appendFileSync(logFile, JSON.stringify(logObj) + "\n");
      });
    }

    return logger as Logger;
  }
}

/**
 * tslog passes logged arguments as numeric keys (`0`, `1`, …) on the log object
 * alongside the `_meta` block. Join the string parts into a single message,
 * JSON-stringifying any non-string argument.
 */
function stringifyLogArgs(logObj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(logObj)) {
    if (key === "_meta") continue;
    const value = logObj[key];
    parts.push(typeof value === "string" ? value : JSON.stringify(value));
  }
  return parts.join(" ");
}
