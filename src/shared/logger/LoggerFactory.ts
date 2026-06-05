import { appendFileSync } from "fs";
import { Logger as TSLogger } from "tslog";
import { ProcessingOptions } from "../../types";
import { Logger } from "./Logger";

export class LoggerFactory {
  static createLogger(
    options: Pick<
      ProcessingOptions,
      "logFile" | "logLevel" | "silent" | "debug" | "progressNdjson"
    >
  ): Logger {
    const { logFile, logLevel, silent, debug, progressNdjson } = options;

    const logger = new TSLogger<any>({
      name: "kg-gen",
      // In NDJSON progress mode, suppress tslog's built-in pretty output so it
      // can't pollute the structured stdout stream; we re-emit logs ourselves as
      // `channel: "log"` lines below.
      type: progressNdjson ? "hidden" : "pretty",
      minLevel: silent
        ? 4
        : debug
        ? 0
        : logLevel === "debug"
        ? 0
        : logLevel === "info"
        ? 1
        : logLevel === "warning"
        ? 2
        : logLevel === "error"
        ? 3
        : 4,
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
