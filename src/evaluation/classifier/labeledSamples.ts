import { ContentClass } from "../../types";

/**
 * A small hand-labeled corpus for measuring content-classifier accuracy (A3).
 *
 * Each sample is a realistic `(path, content)` pair with its true {@link ContentClass}
 * — *not* cherry-picked to be trivially separable. The point is an honest baseline:
 * the heuristic classifier is mediocre by design (see the S2/S3 findings), and this
 * set is the falsifiable target that any future tuning (S2/S3/A1) must not regress.
 *
 * Two samples per class × 12 classes. Paths carry real extensions/dirs because the
 * heuristic scores the path too, exactly as it does at runtime.
 */
export interface LabeledSample {
  id: string;
  path: string;
  content: string;
  expected: ContentClass;
}

export const LABELED_SAMPLES: LabeledSample[] = [
  // ── code ───────────────────────────────────────────────────────────────
  {
    id: "code-1",
    path: "src/services/AuthService.ts",
    expected: "code",
    content: `import { TokenStore } from "./TokenStore";

export class AuthService extends BaseService {
  async login(user: string, password: string): Promise<Session> {
    const hash = await this.hasher.hash(password);
    if (!this.store.verify(user, hash)) {
      throw new Error("invalid credentials");
    }
    return this.store.createSession(user);
  }
}`,
  },
  {
    id: "code-2",
    path: "scripts/clean_data.py",
    expected: "code",
    content: `import os
import json

def clean(records):
    for r in records:
        if r.get("value") is None:
            continue
        yield {"id": r["id"], "value": float(r["value"])}

def main():
    with open("data.json") as f:
        records = json.load(f)
    print(list(clean(records)))`,
  },

  // ── financial ──────────────────────────────────────────────────────────
  {
    id: "financial-1",
    path: "reports/q3-earnings.md",
    expected: "financial",
    content: `Q3 revenue rose to $4.2 billion, beating analyst estimates of $3.9 billion.
EBITDA margin improved to 28%. The board declared a dividend of $0.45 per share.
NASDAQ: ACME closed up 6% after the earnings call. Full-year guidance was raised.`,
  },
  {
    id: "financial-2",
    path: "finance/portfolio-review.txt",
    expected: "financial",
    content: `Portfolio allocation: 60% equity, 30% bonds, 10% cash. The S&P 500 holdings
returned $1,250,000 in unrealized gains. P/E ratio of the tech sleeve sits at 24.
Dividend yield across the portfolio is 2.1%. SEC 10-K filings reviewed for each holding.`,
  },

  // ── medical ────────────────────────────────────────────────────────────
  {
    id: "medical-1",
    path: "records/patient-note.txt",
    expected: "medical",
    content: `Patient presents with hypertension. Prescribed lisinopril 10 mg PO daily and
metformin 500 mg BID for type 2 diabetes. Blood pressure 148/92 mmHg, heart rate 84 bpm.
Diagnosis confirmed; follow-up in 4 weeks to reassess medication and symptoms.`,
  },
  {
    id: "medical-2",
    path: "trials/study-protocol.txt",
    expected: "medical",
    content: `This randomized controlled, double-blind, placebo-controlled trial evaluates
drug efficacy in Phase II. FDA approval is pending. Adverse events were recorded per
protocol. IRB-approved informed consent obtained from all participants. 200 mg IV dose.`,
  },

  // ── legal ──────────────────────────────────────────────────────────────
  {
    id: "legal-1",
    path: "legal/nda.txt",
    expected: "legal",
    content: `WHEREAS the parties agree to the following terms. Effective Date: 2023-01-01.
Termination: either party may terminate upon 30 days notice. The receiving party shall
not disclose Confidential Information. This agreement is governed by the jurisdiction of Delaware.`,
  },
  {
    id: "legal-2",
    path: "contracts/master-services-agreement.md",
    expected: "legal",
    content: `The Contractor shall indemnify the Client for any breach of this Agreement.
Liability for damages is capped per Section 7.2. Counsel for both parties reviewed the
provisions. The plaintiff waives any claim arising under this clause.`,
  },

  // ── research ───────────────────────────────────────────────────────────
  {
    id: "research-1",
    path: "papers/sparse-attention.md",
    expected: "research",
    content: `## Abstract
We propose a sparse-attention method and demonstrate that it reduces memory cost.
Our experimental results on the PG-19 dataset improve perplexity over the baseline.
We build on Beltagy et al. (2020). doi:10.1145/1234567. p < 0.01 across 4 seeds.`,
  },
  {
    id: "research-2",
    path: "research/ablation-findings.md",
    expected: "research",
    content: `## Methodology
We investigated whether dropout improves generalization. The hypothesis was tested on a
held-out benchmark. Experimental evaluation reports accuracy: 0.91 and f1-score: 0.88.
The confidence interval excludes the baseline. Smith et al. (2019) reported similar findings.`,
  },

  // ── transcript ─────────────────────────────────────────────────────────
  {
    id: "transcript-1",
    path: "meetings/q4-standup.txt",
    expected: "transcript",
    content: `Meeting Minutes - Q4 Standup
Attendees: John, Sarah, Mike
Sarah: we agreed to ship the beta on Friday.
Mike: I'll follow up with the vendor.
Action Items:
- John: finalize the budget by next week`,
  },
  {
    id: "transcript-2",
    path: "transcripts/customer-interview.txt",
    expected: "transcript",
    content: `Interviewer: what's your biggest pain point today?
Participant: onboarding takes too long.
Interviewer: and how would you fix it?
Participant: a guided setup. We decided to prototype that next sprint.
Speaker 2: agreed, let's schedule a review.`,
  },

  // ── tabular ────────────────────────────────────────────────────────────
  {
    id: "tabular-1",
    path: "data/sales-2023.csv",
    expected: "tabular",
    content: `product,region,units_sold,revenue,margin
Widget A,EMEA,1500,15000,0.32
Widget B,APAC,2200,25000,0.28
Widget C,AMER,900,9000,0.41
Widget D,EMEA,1750,19500,0.30`,
  },
  {
    id: "tabular-2",
    path: "exports/inventory.tsv",
    expected: "tabular",
    content: `sku\twarehouse\ton_hand\treorder_point\tsupplier
A-100\tDAL\t420\t100\tAcme
B-200\tSEA\t85\t120\tGlobex
C-300\tNYC\t310\t150\tInitech
D-400\tDAL\t12\t50\tAcme`,
  },

  // ── communication ──────────────────────────────────────────────────────
  {
    id: "communication-1",
    path: "mail/budget-update.eml",
    expected: "communication",
    content: `From: john@acme.com
To: sarah@acme.com
Cc: mike@acme.com
Subject: Q4 budget draft

Hi Sarah, attached is the budget draft. Please review the travel section.
Best regards,
John`,
  },
  {
    id: "communication-2",
    path: "messages/reply-thread.txt",
    expected: "communication",
    content: `On Mon, Nov 3, Sarah Lee wrote:
> Can you send the updated numbers?

Hi Sarah, sure — forwarded them just now. Thanks for the reminder.
Regards, John (cc: mike@acme.com)`,
  },

  // ── documentation ──────────────────────────────────────────────────────
  {
    id: "documentation-1",
    path: "README.md",
    expected: "documentation",
    content: `# Wanshi

Turns files into knowledge graphs.

## Installation
\`\`\`bash
npm install -g wanshi
\`\`\`

## Getting Started
To get started, run the CLI. You can configure the output format in config.yaml.`,
  },
  {
    id: "documentation-2",
    path: "docs/api-guide.md",
    expected: "documentation",
    content: `## API Reference
This guide shows how to use the endpoints. Follow these steps to authenticate.

\`\`\`bash
GET /graph
\`\`\`

You need to set the API key first. See the configuration section for parameters.`,
  },

  // ── technical ──────────────────────────────────────────────────────────
  {
    id: "technical-1",
    path: "logs/app.log",
    expected: "technical",
    content: `2023-11-03T09:12:44.512Z INFO  server started on port 8080
2023-11-03T09:12:45.001Z WARN  cache miss for key user:42
2023-11-03T09:12:46.220Z ERROR connection timeout to database after 5000ms
2023-11-03T09:12:47.330Z INFO  retrying connection (attempt 2)`,
  },
  {
    id: "technical-2",
    path: "config/server.yaml",
    expected: "technical",
    content: `host: 0.0.0.0
port: 8080
timeout: 30
database:
  url: postgres://localhost/app
  pool: 10
cache:
  ttl: 300`,
  },

  // ── narrative ──────────────────────────────────────────────────────────
  {
    id: "narrative-1",
    path: "articles/ai-and-society.md",
    expected: "narrative",
    content: `The future of work is being reshaped by automation. However, the picture is more
nuanced than the headlines suggest. Furthermore, many roles will evolve rather than vanish.
According to recent analysis, the transition will be gradual. The story explores both sides.`,
  },
  {
    id: "narrative-2",
    path: "posts/remote-work-essay.txt",
    expected: "narrative",
    content: `This essay examines how remote work changed team culture. It discusses the trade-offs
between flexibility and connection. Therefore, companies must rethink their norms.
Meanwhile, employees report higher satisfaction. The article argues for a hybrid approach.`,
  },

  // ── reference ──────────────────────────────────────────────────────────
  {
    id: "reference-1",
    path: "reference/glossary.md",
    expected: "reference",
    content: `Entity: a uniquely named node in the knowledge graph.
Observation: a provenance-stamped fact attached to an entity.
Relation: a typed directed edge between two entities.
See also: cross-reference the schema definition for each term.`,
  },
  {
    id: "reference-2",
    path: "specs/abbreviations.md",
    expected: "reference",
    content: `API: Application Programming Interface.
DOI: Digital Object Identifier.
KG: Knowledge Graph.
This catalog lists common acronyms alphabetically. Each entry is indexed by its symbol.`,
  },

  // ── hard / ambiguous (neutral paths, cross-cutting signals) ─────────────
  // These are the cases that matter for S2/S3: confusable content and paths
  // that carry no telltale extension, so the classifier must decide on content
  // alone. The gold label is the most defensible single class, but the current
  // heuristic is expected to confuse several of these — that is the point.
  {
    id: "hard-research-prose",
    path: "notes/sparse-idea.md",
    expected: "research",
    content: `We hypothesize that sparse attention preserves accuracy while cutting cost.
Our analysis on a held-out benchmark suggests the approach generalizes. The methodology
extends prior work, and the experimental results beat the baseline on most metrics.`,
  },
  {
    id: "hard-narrative-sciencey",
    path: "articles/science-column.md",
    expected: "narrative",
    content: `The promise of fusion energy has captivated scientists for decades. According to
researchers, recent breakthroughs bring it closer. However, skeptics argue the timeline
remains uncertain. This article explores what the latest experiments mean for the public.`,
  },
  {
    id: "hard-doc-plain",
    path: "docs/overview.txt",
    expected: "documentation",
    content: `This page explains how to set up the tool. You can install it with the package
manager, then run the command. To get started, follow these steps and configure the
options. See the usage section for more, and refer to the tutorial for a walkthrough.`,
  },
  {
    id: "hard-reference-defs",
    path: "notes/terms.txt",
    expected: "reference",
    content: `Idempotent: an operation that yields the same result when applied repeatedly.
Latency: the time between a request and its response.
Throughput: the number of operations completed per unit time.
See also: the performance glossary for related definitions.`,
  },
  {
    id: "hard-technical-plain",
    path: "infra/setup.txt",
    expected: "technical",
    content: `host: api.internal
port: 9090
timeout: 60
The service connects to the database and the cache. On startup it loads the configuration
and binds to the port. Restart the daemon after changing any setting.`,
  },
  {
    id: "hard-code-in-md",
    path: "notes/snippet.md",
    expected: "code",
    content: `Here's the helper I wrote:

\`\`\`js
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
\`\`\``,
  },
  {
    id: "hard-communication-chat",
    path: "chat/dm.md",
    expected: "communication",
    content: `hey, did you get a chance to look at the proposal?
yeah, sent you my notes a minute ago. let me know if the budget section makes sense.
thanks! I'll reply after the call. cc'ing Dana so she's in the loop.`,
  },
  {
    id: "hard-transcript-plain",
    path: "audio/recording.txt",
    expected: "transcript",
    content: `Anna: so where did we land on the launch date?
Ben: I think the 15th is realistic if QA signs off.
Anna: okay, let's plan for that and revisit Thursday.
Ben: works for me. I'll update the schedule.`,
  },
  {
    id: "hard-medical-prose",
    path: "health/summary.txt",
    expected: "medical",
    content: `The patient has a chronic condition managed with ongoing treatment. Symptoms include
fatigue and elevated blood pressure. The care team adjusted the therapeutic plan and will
monitor the diagnosis. A follow-up visit is scheduled to review the prescription.`,
  },
  {
    id: "hard-financial-prose",
    path: "memos/quarter.txt",
    expected: "financial",
    content: `Revenue grew this quarter and earnings exceeded our internal forecast. The investment
in the new line is paying off, and the board expects the dividend to hold. Analysts remain
bullish on the stock despite a softer outlook for the sector.`,
  },
  {
    id: "hard-legal-light",
    path: "policy/terms.txt",
    expected: "legal",
    content: `By using this service you agree to these terms. The provider may terminate access for
breach of the conditions. Each party retains liability only as set out in this agreement.
Disputes are subject to the courts of the stated jurisdiction.`,
  },
  {
    id: "hard-tabular-markdown",
    path: "reports/summary.md",
    expected: "tabular",
    content: `| product | region | units | revenue |
| ------- | ------ | ----- | ------- |
| Widget A | EMEA | 1500 | 15000 |
| Widget B | APAC | 2200 | 25000 |
| Widget C | AMER | 900 | 9000 |`,
  },
];
