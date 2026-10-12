---
description: What is still open in the Time Attendance project, from the registered checks (runs npm run backlog)
---

You are answering "what is still open?" for the owner. The logic lives in `scripts/backlog.js`; this
file only fixes how you use its output. Follow these three rules, in this order.

What the command does and does not do: it re-runs the registered check for each OPEN item that
names one, prints the HANDOFF items from `STATUS.md` without checking them, shows an item that names
only an owner wait from its own `STATUS.md` text without checking it, and prints what it could not
measure. Do not describe it as having checked more than that.

1. **Run `npm run backlog` first, before you say anything about what is open.** Run it from the
   `ta-office` worktree (the folder that holds `package.json` and `STATUS.md`). It takes a few
   seconds. Do not answer from memory, from `STATUS.md`, from a previous run or from the session
   summary; none of those is the result of checking.

2. **Report only what the output contains.** Never summarise from memory, and never add an item that
   is not in the output.
   - If an item is `NOT-VERIFIED`, say "NOT-VERIFIED" in those words and give the instruction its
     evidence ends with; do not turn it into "probably fine".
   - If the output lists anything under `NOT MEASURED`, say so in those words and name each entry.
     If it prints `NOT MEASURED -- none reported`, quote that attribution: nothing was reported by
     sync health or by the printer. That is not the same as nothing being unmeasurable, so never
     write "nothing unmeasured", "everything was measured", "complete", "clean" or "all clear".
   - A `PASS` is reported together with its evidence, so the owner sees what it rests on. Quote the
     evidence (for example "the file exists") next to the PASS. Do not call a PASS "done" or
     "finished" unless the evidence itself says the work is done; a PASS that rests on a file
     existing says only that the file exists.
   - A `FAIL` is not yours to soften, and its evidence may end with a sentence telling the reader to
     read something by hand before trusting the FAIL (for example "read `sync_if_dirty.ps1` by hand
     before trusting this FAIL"). Report that sentence, in Thai, as part of the row.
   - Under `SYNC HEALTH`, report every line marked `WARNING` and the final `LIMIT` line, in Thai.
     Never leave out the `LIMIT` line: it says what this machine cannot see.
   - If the output says `OVER BUDGET`, say that too, with its numbers.
   - If the command failed or printed nothing, say that. Do not fall back to a guess.

3. **Report to the owner in Thai, as a Markdown table with the columns `ขนาด | งาน`** (the owner's
   standing instruction for any pending-task list):

   ```
   | ขนาด | งาน |
   |------|-----|
   | เล็ก (ประมาณเอง) | ... |
   | กลาง (ประมาณเอง) | ... |
   | ใหญ่ (ประมาณเอง) | ... |
   ```

   - The `ขนาด` value does not come from the command's output: it is the reporter's own estimate of
     the effort. Mark every size as an estimate, as in the table above ("(ประมาณเอง)"), and add one
     Thai line under the table saying that the sizes are your own estimate and not a measurement.
     Never present a size as something the command found.
   - Put the items that are `FAIL`, `NOT-VERIFIED` or `WAITING-OWNER` first, each with its verdict
     named in the row, then the `PASS` items (with their evidence), then the `HANDOFF` items.
   - Every `HANDOFF` row carries the caveat that it is a claim from `STATUS.md` which this command
     did not check ("ข้อความจาก STATUS.md ยังไม่ได้ตรวจโดยคำสั่งนี้"). An item shown only from its
     owner-wait text carries the same caveat.
   - Quote the `STATUS.md:<line>` of each item.
   - Whatever `NOT MEASURED` held, the `WARNING` and `LIMIT` lines and any "read by hand" sentence go
     in their own rows or lines under the table, not inside the sizes.
