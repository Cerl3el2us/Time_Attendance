// Generates the official 50-Tawi (หนังสือรับรองการหักภาษี ณ ที่จ่าย, มาตรา 50 ทวิ) withholding-tax
// certificate .xlsx, one sheet per employee -- a faithful reproduction of the real government form
// template (see tawi50Template.js for the byte-for-byte static layout, transcribed from the
// reference file). This module is a pure layout template with no settings/payroll-calc knowledge
// of its own, same convention as payslipXlsx.js: writeStaticForm() lays down every fixed cell/
// border/merge from the template, then writeCompanyBlock()/writeEmployeeBlock() overwrite only the
// handful of cells that carry real data. Edit tawi50Template.js (not this file) to fix a
// transcription error in the fixed form; edit this file to change which live values map to which
// cell, following the answered Part 6 questions in project memory
// (project_time_attendance_2026_08_17_session_close_and_tawi50_xlsx_pending.md).
const ExcelJS = require('exceljs');
const path = require('path');
const { MERGES, CELLS, BORDERS, COL_WIDTHS, ROW_HEIGHTS } = require('./tawi50Template');

const BORDER_STYLE = { thin: 'thin', medium: 'medium', thick: 'thick', dotted: 'dotted', dashed: 'dashed', hair: 'hair' };

function applyBorderSide(style) {
  return { style: BORDER_STYLE[style] || style };
}

// 2026-08-17 (user feedback, given by editing a generated preview file directly): every DYNAMIC
// value cell (company/employee data, computed totals) gets this blue so it reads visually
// distinct from the certificate's static black form text -- matches the color the user applied by
// hand across every data cell in their edit (grep-verified exact match: #0066CC).
const DATA_FONT_COLOR = { argb: 'FF0066CC' };
function tintAsData(ws, addr) {
  const cell = ws.getCell(addr);
  cell.font = { ...cell.font, color: DATA_FONT_COLOR };
}

const SEAL_IMAGE_PATH = path.join(__dirname, '..', '..', 'attendance', 'images', 'tawi50-seal-placeholder.png');

// Thai-only prefix map for legal document use -- deliberately separate from app.js's
// namePrefixLabel(), which is language-dependent (L(pair[0], pair[1])) and would print "Mr." into
// this Thai government form if reused server-side under an EN/JA UI session (see Part 2 finding F,
// project memory). Keys match NAME_PREFIX_VALUES in server.js.
const TH_NAME_PREFIX = { '': '', mr: 'นาย', mrs: 'นาง', ms: 'นางสาว' };

// 2026-08-17 (user feedback): tawi50Template.js's `align.v` values were transcribed straight from
// openpyxl, which reports the RAW OOXML attribute value -- and raw OOXML actually spells vertical
// centering "center", not "middle". ExcelJS's own public API is the opposite: its alignment
// validator (xlsx/xform/style/alignment-xform.js) only recognizes 'top'/'middle'/'bottom'/
// 'distributed'/'justify' for vertical -- 'center' isn't one of them, so `vertical: 'center'`
// silently resolves to `undefined` on write. Every cell transcribed from the reference with
// vertical-center alignment (most of the form's label cells) was therefore silently losing it.
function normalizeVertical(v) {
  return v === 'center' ? 'middle' : (v || undefined);
}

function writeStaticForm(ws) {
  MERGES.forEach(rng => ws.mergeCells(rng));
  CELLS.forEach(c => {
    const cell = ws.getCell(c.addr);
    if (c.formula !== undefined) cell.value = { formula: c.formula };
    else cell.value = c.value;
    cell.numFmt = c.numFmt;
    cell.font = { name: c.font.name, size: c.font.size, bold: c.font.bold };
    cell.alignment = { horizontal: c.align.h || undefined, vertical: normalizeVertical(c.align.v), wrapText: !!c.align.wrap };
  });
  BORDERS.forEach(b => {
    const cell = ws.getCell(b.addr);
    const border = {};
    for (const side of ['top', 'bottom', 'left', 'right']) {
      if (b.sides[side]) border[side] = applyBorderSide(b.sides[side]);
    }
    cell.border = { ...cell.border, ...border };
  });
  Object.entries(COL_WIDTHS).forEach(([col, w]) => { ws.getColumn(col).width = w; });
  Object.entries(ROW_HEIGHTS).forEach(([r, h]) => { ws.getRow(Number(r)).height = h; });

  // 2026-08-17 (user feedback, corrected): only the WORDS "ฉบับที่ 1"/"ฉบับที่ 2" should be bold,
  // not the whole sentence including the parenthetical explanation -- an earlier version bolded
  // the entire cell. Uses ExcelJS rich-text runs (an array of {font, text} fragments) to bold just
  // the leading fragment while the rest keeps the reference's normal weight.
  // 2026-08-18 (Opus review finding): `bold + rest` below must concatenate to exactly
  // tawi50Template.js's own A1/A2 CELLS values -- there's no automatic check for that. If
  // tawi50Template.js is ever regenerated from a changed reference file, diff its A1/A2 entries
  // against the two strings below before assuming this still matches.
  [
    { addr: 'A1', bold: 'ฉบับที่ 1', rest: '   ( สำหรับผู้ถูกหักภาษี ณ ที่จ่าย ใช้แนบพร้อมกับแบบแสดงรายการภาษี )' },
    { addr: 'A2', bold: 'ฉบับที่ 2', rest: '   ( สำหรับผู้ถูกหักภาษี ณ ที่จ่าย เก็บไว้เป็นหลักฐาน)' },
  ].forEach(({ addr, bold, rest }) => {
    const cell = ws.getCell(addr);
    const baseFont = { name: cell.font.name, size: cell.font.size };
    cell.value = { richText: [{ font: { ...baseFont, bold: true }, text: bold }, { font: { ...baseFont, bold: false }, text: rest }] };
  });

  // 2026-08-17 (user feedback, corrected): rows 3-4 need to be REAL merged cells (A3:N3, A4:N4),
  // not just centerContinuous-across-unmerged-cells like the reference authored them -- same class
  // of change as the M22:N22/etc. merges above, so same mergeCellsWithoutStyle() requirement
  // (plain mergeCells() would wipe out whatever border/font BORDERS/CELLS already set on B3..N3).
  // Columns O-R stay outside this merge (O3 is an unused spacer, P3:R3/P4:R4 hold the separate
  // เล่มที่/เลขที่ box, already merged/positioned independently).
  ['A3:N3', 'A4:N4'].forEach(rng => {
    ws.mergeCellsWithoutStyle(rng);
    const cell = ws.getCell(rng.split(':')[0]);
    cell.alignment = { ...cell.alignment, horizontal: 'center', vertical: 'middle' };
  });
  ['P3', 'Q3', 'P4', 'Q4'].forEach(addr => {
    const cell = ws.getCell(addr);
    cell.alignment = { ...cell.alignment, vertical: 'middle' };
  });

  // 2026-08-17 (user feedback): the ภ.ง.ด. form-type checkbox row (H17/J17/M17/O17's boxes plus
  // their "(1) ภ.ง.ด. 1ก."-style labels in I17/K17/N17/P17, and the same pattern one row down in
  // H19/J19/M19 + I19/K19/N19) reads as top-aligned within its row -- the reference itself has no
  // explicit vertical value here (`v: null` in tawi50Template.js, so normalizeVertical() correctly
  // leaves it unset same as the reference), but the user wants this whole section vertically
  // centered regardless of what the reference file's own (apparently unset-and-visually-fine-by-
  // accident) value was. Explicit override, not reference-driven.
  ['H17', 'J17', 'M17', 'O17', 'I17', 'K17', 'N17', 'P17', 'H19', 'J19', 'M19', 'I19', 'K19', 'N19'].forEach(addr => {
    const cell = ws.getCell(addr);
    cell.alignment = { ...cell.alignment, vertical: 'middle' };
  });

  // Part 6 answer 4: the reference sheet has no value/formula at Q47 for the standard ภ.ง.ด.1ก
  // salary certificate (the leftover "3%"-variant formula the plan was worried about isn't
  // actually present in this file) -- tawi50Template.js's CELLS array correctly has no Q47 entry,
  // nothing to do here.

  // 2026-08-17 (review fix): P13 (the ID-number box for passport/tax_id employees, mirrors P12)
  // has no CELLS entry in tawi50Template.js because it's EMPTY in the reference -- but that also
  // means writeStaticForm()'s CELLS loop above never styles it, so a value written into it later
  // by writeEmployeeBlock() would render in ExcelJS's default font/alignment instead of matching
  // P12's Leelawadee-10-centered-numFmt-'0' look. Style it explicitly here, matching P12 exactly.
  const p13 = ws.getCell('P13');
  p13.numFmt = '0';
  p13.font = { name: 'Leelawadee', size: 10, bold: false };
  p13.alignment = { horizontal: 'center', vertical: undefined, wrapText: false };

  // 2026-08-17 (user feedback, given by editing a generated preview file directly): several
  // header/label pairs (transcribed from the reference using UNMERGED cells + centerContinuous
  // alignment, matching how the reference file itself was authored) don't display consistently --
  // the user converted them to real merged+centered cells when reviewing a preview file. Match
  // that here, both horizontal center AND vertical middle (an earlier pass only set horizontal).
  // MUST use mergeCellsWithoutStyle(), not mergeCells(): ExcelJS's plain mergeCells() makes every
  // NON-anchor cell in the range adopt the anchor cell's FULL style wholesale (Cell.merge() ->
  // `this.style = master.style`), which silently wiped the border/font that CELLS/BORDERS had
  // already set individually on the non-anchor cell (e.g. N22's own right-edge border, replaced by
  // M22's border which has no right edge) -- caught when the user reported borders/fonts missing
  // after this fix's first version. mergeCellsWithoutStyle() skips that copy, so each cell keeps
  // its own pre-set border/font (exactly how the template's ORIGINAL pre-existing merges already
  // work, since those merge before CELLS/BORDERS ever runs -- see MERGES.forEach() at the top of
  // this function -- this new block just needed the same "don't clobber" property another way).
  ['M22:N22', 'Q22:R22', 'M23:N23', 'Q23:R23', 'A51:F51', 'G59:K59'].forEach(rng => {
    ws.mergeCellsWithoutStyle(rng);
    const cell = ws.getCell(rng.split(':')[0]);
    cell.alignment = { ...cell.alignment, horizontal: 'center', vertical: 'middle' };
  });

  // ---- Checkbox glyphs: ExcelJS 4.4.0 can't draw the reference's real rounded-rectangle
  // drawings (Wingdings "ü" glyph shapes floating over the cells below), so each checkbox is
  // emulated as a ☑/☐ glyph in the nearest available unmerged cell (values set by
  // writeEmployeeBlock() below, data-driven) -- same convention this template already uses for
  // H17/J17/M17/O17 (the ภ.ง.ด. form-type checkboxes, real cells in the reference, not drawings).
  // 2026-08-17 (user feedback): an earlier version also drew a medium-border BOX around each of
  // these cells -- removed per direct user edit (the ☑/☐ glyphs are already visually box-shaped,
  // an extra cell border was redundant and, worse, kept clobbering the certificate's outer
  // left-frame line for these 4 rows specifically). Only font/alignment are set here now; border
  // is whatever the BORDERS pass above already gave the cell (the frame's thin left edge, same as
  // every other row).
  ['A57', 'A58', 'A59', 'A60'].forEach(addr => {
    const cell = ws.getCell(addr);
    cell.font = { name: 'Leelawadee', size: 9, bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  // Corporate-seal placeholder ("ประทับตรานิติบุคคล(ถ้ามี)", an ellipse textbox in the reference,
  // purely a physical-stamp placeholder with no data). Part 6 answer 8 kept a bordered-RECTANGLE
  // text emulation as an explicitly provisional first pass ("try it first, adjust after") since
  // ExcelJS 4.4.0 can't draw a real ellipse shape -- 2026-08-17 (user feedback): replaced with a
  // pre-rendered oval PNG (generated once via Pillow, same font/text as the reference, see
  // tawi50-seal-placeholder.png) embedded as an image, matching payslipXlsx.js's existing
  // wb.addImage() convention for the company logo.
  // 2026-08-17 (user feedback, round 2): the first version anchored the image to the FULL
  // 'Q57:R61' range (ExcelJS's range-string shorthand, which stretches the image edge-to-edge to
  // exactly fill the cell range) -- that made the image's own bounding box sit directly on top of
  // R57:R61's real thin RIGHT FRAME border and R61's bottom border (BORDERS data: R57-60 each have
  // {right:'thin'}, R61 has {bottom:'thin',right:'thin'}), and a floating image draws ABOVE cell
  // borders regardless of the image's own transparency, visually erasing that stretch of the
  // certificate's outer frame line. A 2nd attempt shrank it to a smaller centered box; the user
  // then repositioned/resized it by hand in Excel and asked for that EXACT placement to be used --
  // read straight from their saved file's drawing XML (`<xdr:from>` col=15/colOff=641350/
  // row=55/rowOff=57150, `<xdr:ext>` cx=cy=946150 EMU) rather than re-guessing. ExcelJS's tl/ext
  // object form doesn't take a plain `{col,row}` sub-cell offset (only the range-string shorthand
  // or a `{nativeCol,nativeColOff,nativeRow,nativeRowOff}` anchor does), and `ext` is in pixels
  // (EMU_PER_PIXEL_AT_96_DPI=9525 per exceljs/lib/xlsx/xform/drawing/ext-xform.js) -- 946150/9525
  // = ~99.3px, so 99.
  ws.mergeCellsWithoutStyle('Q57:R61');
  try {
    // 2026-08-18 (Opus review finding): writeStaticForm() runs once per sheet, and
    // workbook.addImage() doesn't dedupe by filename -- an N-employee "download all" export was
    // embedding N identical copies of the same PNG. Cache the image id on the workbook itself so
    // every sheet after the first reuses it.
    const wb = ws.workbook;
    const imgId = wb._tawi50SealImageId !== undefined
      ? wb._tawi50SealImageId
      : (wb._tawi50SealImageId = wb.addImage({ filename: SEAL_IMAGE_PATH, extension: 'png' }));
    ws.addImage(imgId, {
      tl: { nativeCol: 15, nativeColOff: 641350, nativeRow: 55, nativeRowOff: 57150 },
      ext: { width: 99, height: 99 },
    });
  } catch (e) {
    console.error('[tawi50Xlsx] seal placeholder image failed to load:', e.message);
  }

  // O49/Q49/I51 are static formula cells (SUM/BAHTTEXT over the data rows) -- tinted blue like
  // every other dynamic/computed cell, matching the user's own coloring.
  ['O49', 'Q49', 'I51'].forEach(addr => tintAsData(ws, addr));
}

// company: { name, nameTh, address, addressTh, taxId } (from appSettings.company)
// pvdLicenseNo/ssoEmployerAccountNo: strings, also from appSettings.company
function writeCompanyBlock(ws, company, pvdLicenseNo, ssoEmployerAccountNo) {
  ws.getCell('C7').value = company.nameTh || company.name || '';
  ws.getCell('P7').value = String(company.taxId || '');
  ws.getCell('C9').value = company.addressTh || company.address || '';
  // 2026-08-17 (user feedback): P6 (เลขประจำตัวประชาชน -- national ID) never applies to a
  // corporate withholding agent (only P7's tax ID does) -- print a dash rather than leave it
  // blank, matching the same "no data -> dash, not blank" convention as P12/P13 below. P6 has no
  // CELLS entry in tawi50Template.js (blank in the reference), so writeStaticForm()'s CELLS loop
  // never styled it at all -- alignment was set explicitly here (round 2 follow-up: user centered
  // it by hand after the dash-only fix left it at Excel's left/bottom default), but font was
  // missed until the 2026-08-18 Opus review caught it: tintAsData()'s `{...cell.font, color}`
  // spread only ever touched font.color, leaving name/size unset and rendering in ExcelJS's
  // default Calibri instead of matching P12/P13's Leelawadee 10 -- same class of gap P13's own
  // explicit styling block above was written to fix.
  const p6 = ws.getCell('P6');
  p6.value = '-';
  p6.font = { name: 'Leelawadee', size: 10, bold: false };
  p6.alignment = { horizontal: 'center', vertical: 'middle' };
  // B53/C54's label text is written by writeEmployeeBlock() (below), which prefixes it with the
  // PVD/SSO disclosure checkmark -- kept together since both need the same amounts data.
  ws.getCell('J53').value = pvdLicenseNo || '';
  ws.getCell('G55').value = ssoEmployerAccountNo || '';
  ['C7', 'P7', 'C9', 'P6', 'J53', 'G55'].forEach(addr => tintAsData(ws, addr));
}

// employee: { name, namePrefix, firstNameTh, lastNameTh, idCardAddress, idCard, idType, employeeNo, role }
// amounts: { grossIncome, pit, sso, pvd } (annual totals, already override-resolved)
// seq: string/number written to both D17 and Q4 (Part 6 answer 1: employeeNo, not export position)
// year: the CE tax year these amounts cover (the ?year= query param) -- M24 wants the Buddhist-era
// equivalent, which is NOT derived from issueDate (the certificate is normally issued the year
// AFTER the tax year it covers, e.g. a 2025-income certificate issued in 2026).
// issueDate: JS Date (Part 6 answer 2: today's date at export time)
function writeEmployeeBlock(ws, employee, amounts, seq, year, issueDate) {
  const prefix = TH_NAME_PREFIX[employee.namePrefix || ''] || '';
  const thaiName = [prefix, employee.firstNameTh, employee.lastNameTh].filter(Boolean).join(' ').trim();
  ws.getCell('C13').value = thaiName || employee.name || '';
  ws.getCell('C15').value = employee.idCardAddress || '';
  tintAsData(ws, 'C13');
  tintAsData(ws, 'C15');

  // Part 6 answer 3: idType -> ID-slot mapping. idcard (Thai national ID) -> P12, everything else
  // (passport/tax_id, both foreign-employee cases) -> P13. P55 (SSO card no.) always mirrors
  // whichever slot applies -- no separate fallback (Part 6 answer 9).
  // 2026-08-17 (user feedback): whichever of P12/P13 does NOT apply prints a dash, not a blank
  // cell -- same "no data -> dash" convention as P6/Q3 elsewhere on this form.
  const idValue = employee.idCard ? String(employee.idCard) : '';
  if (employee.idType === 'idcard') {
    ws.getCell('P12').value = idValue || '-';
    ws.getCell('P13').value = '-';
  } else {
    ws.getCell('P12').value = '-';
    ws.getCell('P13').value = idValue || '-';
  }
  // 2026-08-18 (Opus review finding): match P12/P13's "no data -> dash, not blank" convention --
  // this used to write '' when idValue was empty, inconsistent with its own P12/P13 neighbors.
  ws.getCell('P55').value = idValue || '-';
  ['P12', 'P13', 'P55'].forEach(addr => tintAsData(ws, addr));

  // Part 6 answer 1: D17/Q4 (ลำดับที่/เลขที่) use the employee's stable employeeNo, not a
  // per-export sequential position; the เล่มที่ field's VALUE (Q3) prints a dash instead of the
  // reference's literal "ภ.ง.ด.1ก" text (the user reversed an earlier "reproduce it verbatim"
  // decision) -- P3 itself is the static "เล่มที่" CAPTION from writeStaticForm(), untouched here
  // (2026-08-17 review fix: this used to also blank P3's caption by mistake).
  ws.getCell('D17').value = seq;
  ws.getCell('Q4').value = String(seq);
  ws.getCell('Q3').value = '-';
  ['D17', 'Q4', 'Q3'].forEach(addr => tintAsData(ws, addr));

  // Row 24: item (1) เงินเดือน ค่าจ้าง... -- M24 is the Buddhist-era tax year, O24/Q24 the annual
  // gross/withheld-tax totals.
  ws.getCell('M24').value = year + 543;
  ws.getCell('O24').value = Math.round(amounts.grossIncome || 0);
  ws.getCell('Q24').value = Math.round(amounts.pit || 0);
  ['M24', 'O24', 'Q24'].forEach(addr => tintAsData(ws, addr));

  ws.getCell('P53').value = Math.round(amounts.pvd || 0);
  ws.getCell('J54').value = Math.round(amounts.sso || 0);
  tintAsData(ws, 'P53');
  tintAsData(ws, 'J54');

  // Part 6 answer 2: issue date is today at export time, not user-editable, not the approval date.
  // ExcelJS serializes Date cells via getTime() (dateToExcel(), pure UTC millis) with no timezone
  // concept of its own -- a Date built from LOCAL calendar components (e.g. `new Date()`) shifts
  // by the server's UTC offset once round-tripped through Excel, silently printing the wrong day
  // (caught in testing: server TZ UTC+7 turned "18 Aug" into "17 Aug" on open). Re-anchor the
  // intended LOCAL calendar day at UTC midnight so it survives the round-trip intact regardless of
  // server timezone.
  ws.getCell('G60').value = new Date(Date.UTC(issueDate.getFullYear(), issueDate.getMonth(), issueDate.getDate()));
  tintAsData(ws, 'G60');

  // Checkbox emulation (Part 6 answer 7 + "additional business rule confirmed mid-implementation-
  // planning"): role==='md' -> B58 "ออกภาษีให้ตลอดไป" (issued permanently); every other role ->
  // B57 "หักภาษี ณ ที่จ่าย" (withheld at source). A real per-role business rule, not a single
  // hardcoded default.
  // 2026-08-17 (user feedback, given by editing a generated preview file directly): checkbox
  // glyphs use ☑/☐ (not a plain "X"/blank), matching the same convention already used for the
  // PVD/SSO disclosure checkmarks below.
  const checkedAddr = employee.role === 'md' ? 'A58' : 'A57';
  ['A57', 'A58', 'A59', 'A60'].forEach(addr => { ws.getCell(addr).value = '☐'; });
  ws.getCell(checkedAddr).value = '☑';

  // PVD/SSO disclosure checkboxes (the reference's C53:D53/E54 tick marks are separate floating
  // drawings overlapping the B53:I53/C54:I54 merged label cells -- ExcelJS can't reproduce that
  // geometry without breaking the merge, so this is emulated as a checkmark PREFIX on the label
  // text itself rather than a separate cell, same "provisional, expect follow-up feedback" spirit
  // as the corporate-seal box above). Checked when this employee actually has a nonzero PVD/SSO
  // contribution for the year, unchecked (blank box) otherwise.
  // 2026-08-18 (user confirmed, corrected after Opus review): kept amount-driven, NOT role-driven.
  // The role==='md' exemption in computePayroll() means a normally-computed MD sheet WILL come out
  // unchecked, but that's not guaranteed for every MD row -- a manual tawi50Overrides entry (the
  // 50-Tawi table's SSO/PVD columns are editable for every role, MD included, per
  // project_time_attendance_2026_08_17_tawi50_editable_sso_pvd) or an already-approved finalize
  // snapshot from before the exemption existed can still carry a nonzero amount for an MD. The
  // real invariant this checkbox upholds is simpler and always true regardless of source: it must
  // match whatever amount is actually printed in P53/J54 right next to it, since a ☐ next to a
  // nonzero printed amount would be self-contradictory on a legal document.
  const pvdMark = (amounts.pvd || 0) > 0 ? '☑' : '☐';
  const ssoMark = (amounts.sso || 0) > 0 ? '☑' : '☐';
  ws.getCell('B53').value = `${pvdMark} เงินสะสมจ่ายเข้ากองทุนสำรองเลี้ยงชีพ ใบอนุญาตเลขที่`;
  ws.getCell('C54').value = `${ssoMark} เงินสมทบจ่ายเข้ากองทุนประกันสังคม จำนวน `;
}

function applyPageSetup(ws) {
  // 2026-08-18 (Opus review finding): `scale` and `fitToPage` are mutually exclusive per the OOXML
  // spec -- when fitToPage is set, Excel ignores `scale` entirely and shrinks to whatever
  // fitToWidth/fitToHeight say (both default to 1 page if unset, which is what actually happened
  // here, not the 93% this used to claim). Made the fit-to-one-page intent explicit instead,
  // matching payslipXlsx.js's own applyPageSetup() convention.
  ws.pageSetup = {
    orientation: 'portrait',
    paperSize: 9, // A4
    fitToWidth: 1,
    fitToHeight: 0,
    fitToPage: true,
    horizontalCentered: true,
    verticalCentered: true,
    blackAndWhite: true,
    margins: { left: 0.2362204724409449, right: 0.2362204724409449, top: 0.11811023622047245, bottom: 0.11811023622047245, header: 0, footer: 0 },
    printArea: 'A1:R65',
  };
  ws.views = [{ showGridLines: false }];
  // Reference has one manual row break after row 64 -- cosmetic only (per project memory,
  // "ignorable"), skipped here rather than risk misusing ExcelJS's rowBreaks API for it.
}

// company: appSettings.company (name/nameTh/address/addressTh/taxId/pvdLicenseNo/ssoEmployerAccountNo)
// employee: {name, namePrefix, firstNameTh, lastNameTh, idCardAddress, idCard, idType, employeeNo, role}
// amounts: {grossIncome, pit, sso, pvd} -- annual, override-resolved totals for this employee/year
// seq: employee's employeeNo (D17/Q4)
// year: CE tax year these amounts cover (the ?year= query param)
// issueDate: JS Date
// workbook/sheetName (optional): pass an existing ExcelJS.Workbook to add this employee as one
// more sheet, mirroring payslipXlsx.js's buildPayslipWorkbook() convention for the "download all"
// route (GET /api/tawi50-xlsx-all).
function buildTawi50Workbook({ company, employee, amounts, seq, year, issueDate, pvdLicenseNo, ssoEmployerAccountNo, workbook, sheetName }) {
  const wb = workbook || new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || '50 Tawi', { views: [{ showGridLines: false }] });
  writeStaticForm(ws);
  writeCompanyBlock(ws, company, pvdLicenseNo, ssoEmployerAccountNo);
  writeEmployeeBlock(ws, employee, amounts, seq, year, issueDate);
  applyPageSetup(ws);
  return wb;
}

module.exports = { buildTawi50Workbook };
