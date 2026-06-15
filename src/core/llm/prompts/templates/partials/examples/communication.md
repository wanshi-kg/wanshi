### Example 1: Email with cc + attachment

Input:

## File information

Path: `mail/q4-budget.eml`

## Content to analyze
```
From: John Park <john@acme.com>
To: Sarah Lee <sarah@acme.com>
Cc: Mike Ross <mike@acme.com>
Subject: Q4 budget draft — Apollo
Date: 2022-11-03

Hi Sarah, attached is the Q4 budget draft for the Apollo project. I'll finalize the
headcount numbers by Friday — can you review the travel section before then?
Thanks, John

[attachment: q4-budget.xlsx]
```

Output:

```json
{
  "entities": [
    {
      "name": "John Park",
      "entityType": "person",
      "observations": [
        "Sent the Q4 budget draft email on 2022-11-03",
        "Committed to finalize the headcount numbers by Friday"
      ]
    },
    {
      "name": "Sarah Lee",
      "entityType": "person",
      "observations": ["Asked to review the travel section before Friday"]
    },
    {
      "name": "Mike Ross",
      "entityType": "person",
      "observations": ["Cc'd on the Q4 budget draft email"]
    },
    {
      "name": "Q4 budget draft — Apollo",
      "entityType": "thread",
      "observations": ["Email about the Apollo project budget, dated 2022-11-03"]
    },
    {
      "name": "Apollo project",
      "entityType": "project",
      "observations": ["Initiative the Q4 budget covers"]
    },
    {
      "name": "q4-budget.xlsx",
      "entityType": "attachment",
      "observations": ["Spreadsheet holding the Q4 budget draft"]
    }
  ],
  "relations": [
    { "from": "John Park",                "to": "Sarah Lee",                "relationType": ["sends_to"] },
    { "from": "John Park",                "to": "Mike Ross",                "relationType": ["cc"] },
    { "from": "Q4 budget draft — Apollo", "to": "Apollo project",           "relationType": ["references"] },
    { "from": "q4-budget.xlsx",           "to": "Q4 budget draft — Apollo", "relationType": ["part_of"] }
  ]
}
```

Note: the deadline ("by Friday") and the review request are observations on the
people, not nodes. `sends_to` is sender → recipient; `cc` is its own predicate, not
stacked onto `sends_to`. The attachment is `part_of` the thread that carried it.

---

### Example 2: Reply in the thread (with prior context — extend)

Input:

## File information

Path: `mail/q4-budget.eml`
Chunk 2 of 3

## Already extracted (do not re-emit)

- **John Park** (person): Sent the Q4 budget draft email on 2022-11-03
- **Sarah Lee** (person): Asked to review the travel section before Friday

## Content to analyze
```
From: Sarah Lee <sarah@acme.com>
To: John Park <john@acme.com>
Subject: Re: Q4 budget draft — Apollo
Date: 2022-11-04

Reviewed — travel looks fine. Looping in my manager, Dana, who owns the Apollo
budget sign-off.
```

Output:

```json
{
  "entities": [
    {
      "name": "Sarah Lee",
      "entityType": "person",
      "observations": ["Reviewed the travel section and approved it (2022-11-04)"]
    },
    {
      "name": "Dana",
      "entityType": "person",
      "observations": ["Sarah Lee's manager; owns the Apollo budget sign-off"]
    }
  ],
  "relations": [
    { "from": "Sarah Lee", "to": "John Park", "relationType": ["replies_to"] },
    { "from": "Sarah Lee", "to": "Dana",      "relationType": ["reports_to"] }
  ]
}
```

Note: the reply is `replies_to`, not another `sends_to`; `reports_to` captures the
org hierarchy. `Sarah Lee` is re-emitted under her exact name carrying a *new*
observation (the approval), which extends the existing node on merge.

---

### Example 3: Group chat (hand-off + scheduling)

Input:

## File information

Path: `chat/apollo-standup.txt`

## Content to analyze
```
[09:02] Mike Ross: I'll forward the vendor quote to Sarah for the budget.
[09:03] Sarah Lee: thanks. Let's set up a sync Thursday to close the numbers.
[09:03] John Park: works for me, I'll book the room.
```

Output:

```json
{
  "entities": [
    {
      "name": "Mike Ross",
      "entityType": "person",
      "observations": ["Forwarded the vendor quote to Sarah for the Apollo budget"]
    },
    {
      "name": "Sarah Lee",
      "entityType": "person",
      "observations": ["Proposed a Thursday sync to finalize the numbers"]
    },
    {
      "name": "John Park",
      "entityType": "person",
      "observations": ["Agreed to book a room for the Thursday sync"]
    }
  ],
  "relations": [
    { "from": "Mike Ross", "to": "Sarah Lee", "relationType": ["forwards_to"] },
    { "from": "Sarah Lee", "to": "John Park", "relationType": ["schedules_with"] },
    { "from": "John Park", "to": "Mike Ross", "relationType": ["collaborates_with"] }
  ]
}
```

Note: each predicate names the one real interaction — `forwards_to` for the hand-off,
`schedules_with` for the proposed sync, `collaborates_with` for joint work. No
`["sends_to", "forwards_to"]` synonym stacking; the timestamps stay out of the graph.

---

### Example 4: Encrypted body → empty graph

Input:

## File information

Path: `mail/secure-thread.eml`
Chunk 2 of 2

## Content to analyze
```
-----BEGIN PGP MESSAGE-----
hQEMA4l3xK2vQp9rAQf/Wd7yK0c1nT8mLpQ2... (encrypted body) ...=Xy7Q
-----END PGP MESSAGE-----
```

Output:

```json
{ "entities": [], "relations": [] }
```

Note: an encrypted or otherwise undecodable body carries no extractable facts —
empty graph, not a node minted from the armor headers.
