# Workflow diagrams

Generated from the files in `workflows/` by `node scripts/mermaid.js`. Rounded boxes start or end a run, diamonds are decisions, double edged boxes call another system.

## Lead intake and scoring

```mermaid
flowchart TD
  n0(["Lead webhook"])
  n1(["Test run"])
  n2["Sample lead (test only)"]
  n3["Settings"]
  n4["Score lead"]
  n5{"Is it hot?"}
  n6[["Create CRM contact"]]
  n7[["Tell the sales team"]]
  n8[["Add to nurture list"]]
  n9(["Reply"])
  n0 --> n3
  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5
  n5 -->|yes| n6
  n5 -->|no| n8
  n6 --> n7
  n7 --> n9
  n8 --> n9
```

## Signed order webhook, checked and sent on

```mermaid
flowchart TD
  n0(["Order webhook"])
  n1(["Test run"])
  n2["Sample order (test only)"]
  n3["Sign (test only)"]
  n4["Read the request"]
  n5["Compute expected signature"]
  n6["Check and parse"]
  n7["Settings"]
  n8{"Is it valid?"}
  n9[["Send to CRM"]]
  n10[["Send to accounting"]]
  n11[["Tell Slack"]]
  n12["Summarise delivery"]
  n13["Refusal"]
  n14(["Reply"])
  n0 --> n4
  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5
  n5 --> n6
  n6 --> n7
  n7 --> n8
  n8 -->|yes| n9
  n8 -->|no| n13
  n9 --> n10
  n10 --> n11
  n11 --> n12
  n12 --> n14
  n13 --> n14
```

## Daily sales digest

```mermaid
flowchart TD
  n0(["Every morning"])
  n1(["Test run"])
  n2["Settings"]
  n3[["Get yesterday's orders"]]
  n4["Write the digest"]
  n5[["Post to Slack"]]
  n0 --> n2
  n1 --> n2
  n2 --> n3
  n3 --> n4
  n4 --> n5
```
