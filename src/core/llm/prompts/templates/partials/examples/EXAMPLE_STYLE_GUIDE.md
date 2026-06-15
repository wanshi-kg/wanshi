# Example partial style guide (v5)

Every file in `partials/examples/*.md` is training signal, not decoration. The
model imitates whatever the gold examples do. These rules make the examples teach
the behavior the merged graph needs.

## Status of the existing files

**Already close to v5 style — light touch only:** `article.md`, `transcript.md`,
`code.md`, `notes.md`, `tabular.md`. These use lowercase reusable types and rich
observations. The only fix they need: collapse the few two-synonym `relationType`
arrays (e.g. `["contains", "uses"]`, `["used_to_create"]` is fine; `["develops",
"announces"]` should split into the single most accurate predicate) and remove the
one self-loop in `notes.md` (`Cursor-based Pagination → Cursor-based Pagination`).

**Need a full rewrite (rebuilt in v5 form):** `financial.md` ✅ done, `medical.md`
✅ done, `legal.md` ✅ done, `logs.md` ✅ done.

**Dedicated examples (replaced the shared `generic.md` fallback):** `research.md`,
`communication.md`, `documentation.md` ✅ done. Every `ContentClass` now routes to
its own example file (`CLASS_TO_PARTIAL`); there is no generic catch-all — the
KG-05 test in `vocabulary.test.ts` requires every example file to be reachable.

## The seven rules

1. **Reuse types.** Across an entire example file, the distinct `entityType` count
   should be small. If every entity has a unique bespoke type, the example is
   teaching sprawl. Lowercase `snake_case` only.

2. **One canonical predicate per relation.** `relationType` is a one-element array.
   Never stack near-synonyms (`["uses", "depends_on"]` → pick one). This is the
   single biggest fix; the old examples taught the 500-relation-type explosion.

3. **No type-pair predicates.** A relation label is a verb-like predicate
   (`depends_on`, `targets`), never the two endpoint types restated
   (`["SOURCE_IP", "REQUEST_METHOD"]` is not a relation — it's two node types).
   This was the core defect in `logs.md`.

4. **No self-loops.** `from` and `to` always differ.

5. **Literals are observations, not entities.** Dollar amounts, timestamps, raw
   counts, single values — fold them into an observation on a real entity. Don't
   make `$5,000` or `2022-10-15 14:30:00` a node. (This guts most of the old
   `financial.md` and de-hubs `logs.md`.)

6. **Observations add information beyond the type.** `entityType: medication` +
   observation `"a medication"` is circular. State dosage, route, indication,
   measured value — something the type doesn't already say.

7. **Consistent direction.** actor → object, specific → general, caller → callee.
   Don't emit both `A → B` and `B → A` for one relationship.

## Domain-specific notes for the three rewrites

**medical.md** — real entities are patients, conditions, medications, procedures,
providers. Suggested type set: `person, condition, medication, procedure, test,
result, allergy, provider, metric`. Vitals and dosages are observations
(`"BP 120/80 mmHg"` on the patient or the reading), not nodes. Predicates:
`diagnosed_with`, `prescribed`, `underwent`, `has_result`, `allergic_to`,
`treated_by`, `related_to`. Drop the `entityType: "Patient Name"` pattern — the
type is `person`, the name is the patient's name.

**legal.md** — types: `person, organization, document, court, statute, term, date,
duration`. Predicates: `party_to`, `signed`, `governs`, `references`, `defines`,
`filed_in`, `related_to`. Effective dates are observations on the document, not
their own `date` nodes unless the date genuinely anchors multiple entities.

**logs.md** — this one needs the most rethinking. A log line's real entities are
the actors and resources: an IP, a user, a service, a process, a file, an error.
The timestamp is an observation on the event, not a hub node every edge points at.
Types: `ip_address, user, service, process, file, request, error, event`.
Predicates: `requests`, `authenticates_as`, `accesses`, `triggers`, `targets`,
`reports`, `related_to`. Each relation is one real interaction
(`ip_address → request : requests`), never `["CLIENT_IP", "REQUEST_METHOD"]`.

## Quick self-check before committing an example file

- Distinct entityType count across the file: small? (If > ~10 for a short file,
  you're sprawling.)
- Every `relationType` array length 1?
- Any predicate that is just two node types concatenated? (Must be zero.)
- Any `from == to`? (Must be zero.)
- Any standalone literal-value entity? (Must be zero.)
- Does every observation say something the type doesn't?
