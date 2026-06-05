import { IProgressEmitter } from "../../types";

/**
 * Default progress emitter: discards every event. Used whenever structured
 * progress isn't requested, so the normal CLI path has zero overhead and
 * unchanged behavior.
 */
export class NoopProgressEmitter implements IProgressEmitter {
  emit(): void {
    // intentionally empty
  }
}
