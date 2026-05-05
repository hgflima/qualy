# Lint decisions

Append-only log of manual rule and threshold changes applied via qualy
commands (`/lint:rules:add`, `/lint:rules:remove`, `/lint:update`, and
any `/lint:setup` change that lowers coverage thresholds).

This file lives at `.harn/qualy/docs/lint-decisions.md` in the project
root and is versioned with the rest of the codebase. Each entry captures
**why** a change was made so future readers — humans or agents — can
audit the rationale without re-running `git blame` on configuration
files.

## Conventions

- **Append-only.** Never edit or delete existing entries; they are part
  of the audit trail. The qualy CLI appends new entries between the
  marker lines under `## Entries` below.
- **Timestamp.** ISO-8601 in UTC (`YYYY-MM-DDTHH:MM:SSZ`).
- **Author.** Read from `git config user.email` at write time.
- **Reason.** Captured via `AskUserQuestion`; required for every change
  that loosens enforcement (rule removal, threshold lower, coverage
  lower). For tightening changes (rule add, threshold raise) the reason
  is still recorded but may be empty.

## Entry shape

Each entry is an H3 heading followed by a bullet list:

    ### <timestamp> — <kind>: <subject>

    - **kind**: rule-add | rule-remove | threshold-raise |
      threshold-lower | coverage-lower | rec-apply |
      ignore-add | ignore-update | ignore-remove | ignore-import |
      meta:migrate-decision-log
    - **rule**: <rule-id>     (omit for coverage-only changes)
    - **author**: <git email>
    - **reason**: <free-form text captured via AskUserQuestion>

The CLI appends new entries between the markers below in chronological
order (oldest first). Do not move, duplicate, or remove the markers.

## Entries

<!-- qualy:entries-start -->
<!-- qualy:entries-end -->
