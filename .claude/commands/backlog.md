---
description: What is still open in the Time Attendance project, re-checked against the code with evidence (runs npm run backlog)
---

You are answering "what is still open?" for the owner. The logic lives in `scripts/backlog.js`; this
file only fixes how you use its output. Do these three things, in this order, and nothing else.

1. **Run `npm run backlog` first, before you say anything about what is open.** Run it from the
   `ta-office` worktree (the folder that holds `package.json` and `STATUS.md`). It takes a few
   seconds. Do not answer from memory, from `STATUS.md`, from a previous run or from the session
   summary; none of those is the result of checking.

2. **Report only what the output contains.** Never summarise from memory, and never add an item that
   is not in the output. Do not re-judge a verdict: a `PASS` is not yours to doubt without a reason
   you can show, and a `FAIL` is not yours to soften.
   - If an item is `NOT-VERIFIED`, say "NOT-VERIFIED" in those words and give the instruction its
     evidence ends with; do not turn it into "probably fine".
   - If the output lists anything under `NOT MEASURED`, say so in those words, name each entry, and
     do not describe the backlog as complete, clean or all clear.
   - If the output says `OVER BUDGET`, say that too, with its numbers.
   - If the command failed or printed nothing, say that. Do not fall back to a guess.

3. **Report to the owner in Thai, as a Markdown table with the columns `ขนาด | งาน`** (the owner's
   standing instruction for any pending-task list):

   ```
   | ขนาด | งาน |
   |------|-----|
   | เล็ก | ... |
   | กลาง | ... |
   | ใหญ่ | ... |
   ```

   Put the items that are `FAIL`, `NOT-VERIFIED` or `WAITING-OWNER` first, each with its verdict
   named in the row, then the `PASS` items, then the `HANDOFF` items. Quote the `STATUS.md:<line>`
   of each. Whatever `NOT MEASURED` held goes in its own row or line under the table, not inside
   the sizes.
