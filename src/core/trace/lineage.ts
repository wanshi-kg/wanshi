import * as crypto from "crypto";

/** A single pre-merge mention instance (one extraction's view of an entity). */
export interface MentionRef {
  mentionId: string;
  name: string;
  entityType: string;
  chunkId: string;
  extractionId: string;
  observationIds: string[];
}

const sha8 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);

/**
 * Run-scoped lineage index that lives **entirely outside** the knowledge graph —
 * nothing here is ever written onto an `Entity`/`Observation`/`Relation` or any
 * export, so the serialized graph is byte-identical whether tracing is on or off
 * (the observe-only gate holds by construction).
 *
 * It mints deterministic, reconstructable IDs and tracks, per entity NAME, the
 * list of pre-merge mention instances. As the merger folds one name into another
 * (`fold`), the loser's mentions are reattributed to the winner — so a final
 * canonical node's full set of contributing mentions is `mentionsFor(canonical)`.
 */
export class LineageRegistry {
  private byName = new Map<string, MentionRef[]>();

  static entityMentionId(extractionId: string, name: string): string {
    return `${extractionId}|e|${name}`;
  }
  static observationId(extractionId: string, name: string, text: string): string {
    return `${extractionId}|o|${sha8(`${name}␟${text}`)}`;
  }
  static relationMentionId(extractionId: string, from: string, to: string): string {
    return `${extractionId}|r|${from}>${to}`;
  }

  /** Record one entity mention under its name; returns the minted ref. */
  registerEntity(ref: MentionRef): MentionRef {
    const list = this.byName.get(ref.name);
    if (list) list.push(ref);
    else this.byName.set(ref.name, [ref]);
    return ref;
  }

  /** Reassign the loser name's mentions onto the winner (a merge fusion). */
  fold(loserName: string, winnerName: string): MentionRef[] {
    if (loserName === winnerName) return [];
    const losers = this.byName.get(loserName) ?? [];
    if (losers.length === 0) return [];
    const winners = this.byName.get(winnerName) ?? [];
    this.byName.set(winnerName, winners.concat(losers));
    this.byName.delete(loserName);
    return losers;
  }

  mentionsFor(name: string): MentionRef[] {
    return this.byName.get(name) ?? [];
  }

  mentionIdsFor(name: string): string[] {
    return this.mentionsFor(name).map((m) => m.mentionId);
  }

  reset(): void {
    this.byName.clear();
  }
}
