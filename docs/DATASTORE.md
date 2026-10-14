# Data Store setup (one-time, manual)

DozAI stores everything in **one table**. Catalyst has no CLI command to create tables, so create it in the console.

Console: your project > **Cloud Scale > Data Store > Create Table**. Name: `dozai_docs`. Scope: Project (default).

| Column name | Data type | Max length | Mandatory | Unique |
|---|---|---|---|---|
| `uniq_key` | Var Char | 255 | yes | **yes** |
| `tenant_id` | Var Char | 100 | yes | no |
| `collection` | Var Char | 40 | yes | no |
| `doc_id` | Var Char | 120 | yes | no |
| `parent_id` | Var Char | 120 | no | no |
| `version` | Int | | yes | no |
| `body` | Text | (largest allowed, at least 9000) | yes | no |

The **unique** flag on `uniq_key` is what makes the atomic version check safe. Do not skip it.

Then set the table's permissions so **only the project's functions** (admin scope) can read and write it.

Why one table: see the header comment in `backend/packages/core/src/storage/docstore.ts`.
