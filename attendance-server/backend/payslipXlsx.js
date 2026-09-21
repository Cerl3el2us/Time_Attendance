// Generates the payslip .xlsx (real SUM formulas, not hardcoded numbers) for one
// employee/period. Portrait A4, header/employee-info/attendance-summary full width, then
// Earnings (left half) | Deductions (right half) side-by-side, Net Pay bar, signatures —
// 2026-07-31: restored the side-by-side split on portrait paper (was briefly a single-column
// stacked layout 2026-07-23..31, but that dropped the two-column look the user actually
// wanted kept when they asked for A4). Since both columns must share the same row range, the
// shorter side is padded with blank bordered rows so EARNINGS/DEDUCTIONS totals line up on
// the same row. Palette (trust navy + premium gold) from the ui-ux-pro-max skill, color
// domain, "Banking/Traditional Finance" + "Scanner & Document Manager" results. Edit this
// file to change the template — nothing else in the app depends on its exact layout.
const ExcelJS = require('exceljs');
const path = require('path');

const NAVY = 'FF1E293B';        // headers, Net Pay bar
const ACCENT_BLUE = 'FF2563EB'; // divider rule, attendance stat numbers
const GOLD = 'FFFBBF24';        // Net Pay amount (on navy)
const SLATE_BG = 'FFF1F5F9';    // muted panel backgrounds (labels, totals, attendance header)
const ZEBRA = 'FFF8FAFC';       // faint alternating row tint in the earnings/deductions lists
const WHITE = 'FFFFFFFF';
const TEXT = 'FF0F172A';        // near-black navy, softer than pure #000
const MUTED_TEXT = 'FF64748B';  // secondary text (address, tax id)
const BORDER_COLOR = 'FFCBD5E1';
const FONT_NAME = 'Calibri';

const LOGO_PATH = path.join(__dirname, '..', '..', 'attendance', 'images', 'logo-long.png');
const LOGO_W = 1612, LOGO_H = 415; // native px, keeps aspect ratio

const thin = { style: 'thin', color: { argb: BORDER_COLOR } };
const thick = { style: 'medium', color: { argb: NAVY } };
const boxBorder = { top: thin, left: thin, right: thin, bottom: thin };

// companyInfo: {name, address, taxId, branch}
// user: {name, position, role, startDate}
// calc: computePayroll() return value
// fin: {bonus, pit, manualAllowances:[{type,amount,advance}]}
// period: {label, paymentDateLabel, paymentDate?: Date}
// attendance: {workingDays, daysWorked, leaveDays, lateTimes, otHours, absentDays}
// approvedBy: name of the MD who approved this payslip (finalize.json .approvedBy), '' if none yet
// eligibility: {diligence,longDistance,personalCar,upcountry,earlyLate,ot} booleans, computed by
// the caller from settings.appSettings.allowanceEligibility (2026-07-31) -- this module stays a
// pure layout template with no settings/role-rule knowledge of its own. If omitted, every row
// shows (fail-open on display, never fail-closed and hide an amount that was actually earned).
// workbook/sheetName (2026-08-02, both optional): pass an existing ExcelJS.Workbook to add this
// employee as one more SHEET in it instead of creating a new single-sheet workbook -- lets the
// "download all" endpoint call this once per employee against the same workbook. Omit both for
// the normal single-employee download (unchanged behavior: new workbook, sheet named 'Payslip').
function buildPayslipWorkbook({ companyInfo, user, calc, fin, period, attendance, approvedBy, eligibility, workbook, sheetName }) {
  const canShow = k => eligibility ? !!eligibility[k] : true;
  const wb = workbook || new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName || 'Payslip', { views: [{ showGridLines: false }] });

  // Non-uniform column widths (sum 120, same total as 12x10 before) so the 5-tile Attendance
  // Summary grid (spans [1-3][4-5][6-7][8-9][10-12]) comes out PERFECTLY equal-width (24 each)
  // while Earnings (cols 1-6) and Deductions (cols 7-12) still sum to the same 60 each, keeping
  // that side-by-side table symmetric too -- 2026-07-31, replaces the uniform-width columns
  // that made the 3/2/2/2/3-column tile spans visibly unequal.
  const COL_WIDTHS = [8, 8, 8, 12, 12, 12, 12, 12, 12, 8, 8, 8];
  COL_WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  const set = (addr, value, opts = {}) => {
    const cell = ws.getCell(addr);
    cell.value = value;
    if (opts.font) cell.font = { name: FONT_NAME, size: 10.5, color: { argb: TEXT }, ...opts.font };
    if (opts.align) cell.alignment = opts.align;
    if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
    if (opts.border) cell.border = opts.border;
    if (opts.numFmt) cell.numFmt = opts.numFmt;
    return cell;
  };
  const merge = (rng) => ws.mergeCells(rng);
  const center = { horizontal: 'center', vertical: 'middle', wrapText: true };
  const leftMid = { horizontal: 'left', vertical: 'middle', wrapText: true };
  const rightMid = { horizontal: 'right', vertical: 'middle' };

  // ---- Logo box: A1:E4 ----
  merge('A1:E4');
  for (let r = 1; r <= 4; r++) {
    ws.getRow(r).height = 15;
    ['A', 'B', 'C', 'D', 'E'].forEach(c => { ws.getCell(`${c}${r}`).border = boxBorder; });
  }
  try {
    const imgId = wb.addImage({ filename: LOGO_PATH, extension: 'png' });
    // 2026-08-02: bumped 280->335 (user-provided reference file measured at ~335x86px rendered)
    // to fill the logo box more fully; aspect ratio still derived from the native PNG dims.
    const w = 335, h = Math.round(w * LOGO_H / LOGO_W);
    ws.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: w, height: h } });
  } catch (e) {
    console.error('[payslipXlsx] logo image failed to load:', e.message);
  }

  // ---- Company info block: F1:L4 -- font sizes bumped up 2026-07-31 (name 13->15, address/tax
  // 9->10.5), then again 2026-08-02 (name 15->16, address/tax 10.5->12) per user request, and the
  // "Branch:" line dropped per user request (not needed for this single-branch company). ----
  merge('F1:L1');
  set('F1', companyInfo.name, { font: { size: 15, bold: true, color: { argb: NAVY } }, align: leftMid });
  merge('F2:L2');
  set('F2', companyInfo.address, { font: { size: 12, color: { argb: MUTED_TEXT } }, align: leftMid });
  merge('F3:L3');
  set('F3', `Tax ID: ${companyInfo.taxId}`, { font: { size: 12, color: { argb: MUTED_TEXT } }, align: leftMid });

  // ---- Accent rule + title bar ----
  ws.getRow(5).height = 6;
  merge('A5:L5');
  set('A5', '', { fill: ACCENT_BLUE });

  ws.getRow(6).height = 26;
  merge('A6:L6');
  set('A6', 'PAYSLIP', { font: { size: 16, bold: true, color: { argb: WHITE } }, align: center, fill: NAVY });

  ws.getRow(7).height = 10;

  // ---- Employee info: rows 8-9 ----
  const infoRow = (r, l1, v1, l2, v2) => {
    merge(`A${r}:B${r}`);
    set(`A${r}`, l1, { font: { bold: true, size: 9.5, color: { argb: NAVY } }, align: leftMid, fill: SLATE_BG, border: boxBorder });
    merge(`C${r}:F${r}`);
    set(`C${r}`, v1, { font: { color: { argb: TEXT } }, align: leftMid, border: boxBorder });
    merge(`G${r}:H${r}`);
    set(`G${r}`, l2, { font: { bold: true, size: 9.5, color: { argb: NAVY } }, align: leftMid, fill: SLATE_BG, border: boxBorder });
    merge(`I${r}:L${r}`);
    set(`I${r}`, v2, { font: { color: { argb: TEXT } }, align: leftMid, border: boxBorder });
  };
  ws.getRow(8).height = 20;
  ws.getRow(9).height = 20;
  ws.getRow(10).height = 20;
  infoRow(8, 'Employee Name:', user.name, 'Position:', user.position || '');
  infoRow(9, 'Pay Period:', period.label, 'Payment Date:', period.paymentDateLabel);
  // Start Working: 2026-07-31 addition per user -- employee's real hire date (user.startDate),
  // matching the reference paper payslip which has this field. 2026-08-17 addition: paired with
  // Tax ID No. on the right (user.idCard -- same field used regardless of idType, matching the
  // 50-Tawi certificate's convention; this English-only payslip doesn't need to distinguish
  // national-ID-card vs tax-ID label, just show whichever official number is on file).
  infoRow(10, 'Start Working:', user.startDate || '', 'Tax ID No.:', user.idCard || '');

  ws.getRow(11).height = 10;

  // ---- Attendance summary: 2-row grid, split ceil(n/2)/floor(n/2) (2026-08-02, matches the web
  // Payslip page's identical TILE_ORDER + split exactly). Priority order: Days Worked/Late/
  // Absent Days (universal attendance facts) first, then Over Time/Upcountry/Early Morning/Late
  // Night (eligibility-gated via canShow(), same rule as the Earnings rows below -- a role with
  // that eligibility revoked in Settings shouldn't still see the tile, even at 0), then Paid
  // Holiday/Sick Leave/Business Leave (universal) last. A fully-eligible role still gets the
  // original 5-top/5-bottom split; fewer eligible tiles reduce the total and re-split evenly
  // (e.g. a role eligible for Upcountry + Early/Late but not OT: fewer tiles, re-split evenly --
  // note driver's own Over Time tile is separately force-hidden below regardless of eligibility).
  // BUG FIX 2026-08-05 (Opus audit, H1): this section used to render unconditionally, but the web
  // Payslip page (app.js) has always hidden this entire grid for role:'md' ("MD has no work-day/
  // late/leave/OT tracking"). That claim doesn't hold against the real data (MD's account has
  // real scan events and a real Days Worked/Absent Days count), but the web page's behavior is
  // the established product decision either way -- the bulk "Download All" export (new
  // 2026-08-02) is what made this drift actually visible, since it's the first thing that puts
  // the MD's own sheet in front of Accounting every period. Mirrored here for consistency rather
  // than silently disagreeing with the web page.
  let attR = 12;
  // 2026-08-05 (Opus audit, L3, alongside the H1 fix above): FIXED_HEIGHT_BEFORE_ITEMS further
  // down assumed the attendance grid always occupies exactly 2 tile-rows (98pt: 16pt header + 2 x
  // 36pt tile-row + 10pt spacer) -- already inaccurate for any role whose eligible tile count is
  // <=6 (one row, 62pt: driver/accounting/marketing/md-without-this-fix), and now also for MD
  // (0pt, section skipped entirely). Tracked here and applied to the height budget below instead
  // of the fixed 98pt guess, so the item-row height still fills the same fraction of A4 for every
  // role, not just the fully-eligible one the constant was tuned against.
  let attSectionHeight = 0;
  if (user.role !== 'md') {
  ws.getRow(12).height = 16;
  merge('A12:L12');
  set('A12', 'ATTENDANCE SUMMARY', { font: { bold: true, size: 9.5, color: { argb: NAVY } }, align: leftMid, fill: SLATE_BG });

  // "Over Time" tile hidden ONLY for driver (2026-08-02, user request -- explicitly driver-only,
  // corrected after an earlier pass removed it for every role by mistake; matches the identical
  // fix on the web Payslip page) -- a driver's guaranteedOT reads as a flat "100" here with no
  // context, duplicating the real OT money/hours breakdown already shown in the Earnings section
  // below. Every other eligible role still sees this tile. Money/eligibility unaffected either
  // way -- display only.
  // 2026-08-02: shows attendance.otCount (number of approved OT requests), not otHours -- matches
  // every other tile in this grid (Late/Upcountry/Early Morning/Late Night are all counts, not
  // raw quantities); hours no longer shown anywhere in this file at all now that Calculation
  // Details moved to the web page only.
  const attTileOrder = [
    ['Days Worked', attendance.daysWorked, true],
    ['Late (times)', attendance.lateTimes, true],
    ['Absent Days', attendance.absentDays, true],
    ['Over Time', attendance.otCount, canShow('ot') && user.role !== 'driver'],
    ['Upcountry', attendance.upcountryCount, canShow('upcountry')],
    ['Early Morning', attendance.earlyCount, canShow('earlyLate')],
    ['Late Night', attendance.lateNightCount, canShow('earlyLate')],
    ['Paid Holiday', attendance.paidHoliday, true],
    ['Sick Leave', attendance.sickLeave, true],
    ['Business Leave', attendance.businessLeave, true],
  ];
  const visibleAttTiles = attTileOrder.filter(t => t[2]).map(([label, value]) => [label, value]);
  // 2026-08-02: the 6 universal tiles are the floor (none of the 4 eligibility-gated ones
  // apply) -- reads better as one full row than an artificial 3/3 split. 7+ tiles still split
  // ceil(n/2), matching the web Payslip page's identical rule.
  const attSplit = visibleAttTiles.length <= 6 ? visibleAttTiles.length : Math.ceil(visibleAttTiles.length / 2);
  const attRows = attSplit >= visibleAttTiles.length
    ? [visibleAttTiles]
    : [visibleAttTiles.slice(0, attSplit), visibleAttTiles.slice(attSplit)];
  attSectionHeight = 16 + 36 * attRows.length + 10; // header + N tile-rows (14+22 each) + spacer
  const colLetter = n => String.fromCharCode(64 + n);
  // Distributes 12 columns across n tiles as evenly as possible, widening outer tiles first when
  // there's a remainder -- reproduces the original hardcoded 5-tile [3,2,2,2,3] split exactly.
  const computeColSpans = (n) => {
    const base = Math.floor(12 / n);
    let rem = 12 % n;
    const widths = new Array(n).fill(base);
    let li = 0, ri = n - 1, right = true;
    while (rem > 0) {
      if (right) { widths[ri]++; ri--; } else { widths[li]++; li++; }
      right = !right; rem--;
    }
    const spans = []; let c = 1;
    for (const w of widths) { spans.push([c, c + w - 1]); c += w; }
    return spans;
  };
  attR = 13;
  attRows.forEach((tiles) => {
    ws.getRow(attR).height = 14;
    ws.getRow(attR + 1).height = 22;
    computeColSpans(tiles.length).forEach(([c1n, c2n], i) => {
      const c1 = colLetter(c1n), c2 = colLetter(c2n);
      const [label, value] = tiles[i];
      merge(`${c1}${attR}:${c2}${attR}`);
      set(`${c1}${attR}`, label, { font: { size: 7.5, bold: true, color: { argb: MUTED_TEXT } }, align: center, border: boxBorder, fill: WHITE });
      merge(`${c1}${attR + 1}:${c2}${attR + 1}`);
      set(`${c1}${attR + 1}`, value, { font: { size: 13, bold: true, color: { argb: ACCENT_BLUE } }, align: center, border: boxBorder });
    });
    attR += 2;
  });

  ws.getRow(attR).height = 10; attR++;
  }

  // Earnings — allowance1 (upcountry) / allowance2 (early/late) / allowance3 (phone) each get
  // their own row (2026-07-31 per user, comparing against the real paper payslip currently in
  // use: "Allowance 1/2/3" are printed as separate line items there, not lumped together).
  // Manual allowances entered per period on the Finalize Payroll page (fin.manualAllowances,
  // e.g. a one-off bonus item) still get their OWN row too, using their real .type label --
  // same per-item breakdown the in-app payslip already shows (app.js renderPayslip
  // ~5906-5923), so nothing gets silently combined.
  //
  // 2026-07-31: role-eligibility moved to a settings-driven config (allowanceEligibility) --
  // the caller computes `eligibility` from settings + user.role and passes it in; this module
  // just reads it via canShow(), no role-name literals here anymore. See server.js computePayroll()
  // for where each of these is now actually zeroed at the calc layer too (not just hidden here).
  // 2026-09-15: omit zero-amount earnings rows (Bonus / Holiday Transport / OT / allowances
  // with amount 0). Manual allowances were already filtered. SSF/PVD/PIT below still always
  // print even at 0.00 — matching the user's Excel-slip request for earnings only.
  const otTotal = (calc.ot15Amount || 0) + (calc.ot20Amount || 0) + (calc.ot30Amount || 0);
  const earningsItems = [
    ['Basic Salary', calc.base], ['Position Allowance', calc.posAllowance],
    ['Housing Allowance', calc.housingAllowance], ['Transportation Allowance', calc.transport],
    ...(canShow('diligence') ? [['Perfect Attendance', calc.diligenceAllowance]] : []),
    ...(canShow('ot') ? [['Overtime Pay', otTotal]] : []),
    ...(canShow('upcountry') ? [['Allowance 1 (Upcountry)', calc.allowance1]] : []),
    ...(canShow('earlyLate') ? [['Allowance 2 (Early Morning / Late Night)', calc.allowance2]] : []),
    // 2026-07-31: phone allowance is now per-employee-flag-gated (like personalCar), not
    // unconditional -- caller's `eligibility.phone` is already ANDed with user.phoneAllowanceEligible.
    ...(canShow('phone') ? [['Allowance 3 (Mobile Phone)', calc.allowance3]] : []),
    ...(canShow('longDistance') ? [['Long Distance Allowance', calc.longDistanceTotal]] : []),
    ...(canShow('personalCar') ? [['Personal Car Allowance', calc.personalCarTotal]] : []),
    ...(canShow('holidayWork') ? [['Holiday Transport Allowance', calc.holidayTransportTotal || 0]] : []),
    ...(canShow('abroad') ? [['Abroad Allowance', calc.abroadTotal || 0]] : []),
    ['Bonus', fin.bonus],
    ...(fin.manualAllowances || []).filter(ma => (ma.amount || 0) > 0).map(ma => [ma.type || 'Other Allowance', ma.amount]),
  ].filter(([, amount]) => (amount || 0) > 0);

  // Deductions -- SSF/PVD/PIT are recurring, every-month line items (per user 2026-07-31: "ปกติ
  // แล้วยอด deduct มันมีอยู่ทุกเดือนอยู่แล้ว"), so they always get a row even when the computed
  // amount is 0 (e.g. PIT often nets to 0 for lower incomes) -- unlike Earnings, where a missing
  // allowance genuinely means "doesn't apply this period." Only the one-off manual advance items
  // stay conditional, shown only when actually deducted this period.
  const deductionItems = [
    ['Social Security Fund (SSF)', calc.ssf || 0],
    ['Provident Fund (PVD)', calc.pvd || 0],
    ['Personal Income Tax (PIT)', fin.pit || 0],
    ...(fin.manualAllowances || []).filter(ma => (ma.advance || 0) > 0).map(ma => [`Advance Deducted: ${ma.type || ''}`, ma.advance]),
  ];

  // Dynamic item-row height: everything on this page EXCEPT the Earnings/Deductions item rows
  // has a fixed, known height, so the remaining vertical budget can be divided evenly across
  // however many item rows this particular payslip actually has -- a short list (e.g.
  // accounting/marketing, few applicable allowances) gets taller, more spacious rows, and a
  // long list (e.g. a driver with every allowance) gets more compact rows, but the page always
  // ends up filling roughly the same fraction of A4 instead of a fixed row height sometimes
  // looking cramped and sometimes leaving a gap (2026-07-31, replaces the earlier fixed 16pt).
  // 290 was tuned assuming the attendance grid always renders as 2 tile-rows (98pt: 16pt header +
  // 2x36pt tile-row + 10pt spacer, see attSectionHeight above) -- replaced that fixed assumption
  // with the actual measured height for this employee's role/eligibility (0pt for md, 62pt for a
  // 1-row grid, 98pt for the original 2-row case).
  const FIXED_HEIGHT_BEFORE_ITEMS = 290 - 98 + attSectionHeight; // rows 1-18 (header, employee info incl. Start Working, attendance grid, section header)
  const blankSpaceHeight = 54;           // open room above signatures to physically sign (2026-07-31)
  // 2026-08-02: Calculation Details footnote section removed from this file entirely (moved to
  // the web Payslip page instead, per user request the same session) -- no more CALC_DETAILS_HEIGHT
  // term in this budget; that vertical space now just goes to the item rows instead.
  const FIXED_HEIGHT_AFTER_ITEMS = 20 + 10 + 32 + 8 + blankSpaceHeight + 22 + 18 + 14; // total row through Date row
  const TARGET_PAGE_HEIGHT = 730; // usable A4 height (~741pt) minus a small safety margin
  // 2026-08-02: +2 always-blank trailing item rows after whichever side (earnings/deductions)
  // has more real items, per user's reference example (Bonus, then 2 empty rows, then TOTAL
  // EARNINGS) -- these 2 slots are folded into the same height budget as the real items, so the
  // page still fills the same fraction of A4 rather than growing taller for everyone.
  const maxItemsForHeight = Math.max(earningsItems.length, deductionItems.length) + 2;
  const itemBudget = TARGET_PAGE_HEIGHT - FIXED_HEIGHT_BEFORE_ITEMS - FIXED_HEIGHT_AFTER_ITEMS;
  const ITEM_ROW_HEIGHT = Math.max(16, Math.min(30, Math.round(itemBudget / maxItemsForHeight)));

  // side: 'L' -> label A:D, value E:F | side: 'R' -> label G:J, value K:L
  const cols = { L: { lblRange: c => `A${c}:D${c}`, valRange: c => `E${c}:F${c}`, valStart: 'E' },
                 R: { lblRange: c => `G${c}:J${c}`, valRange: c => `K${c}:L${c}`, valStart: 'K' } };

  const sectionHeader = (r, label, side) => {
    ws.getRow(r).height = 20;
    const range = side === 'L' ? `A${r}:F${r}` : `G${r}:L${r}`;
    merge(range);
    set(range.split(':')[0], label, { font: { size: 11, bold: true, color: { argb: WHITE } }, align: leftMid, fill: NAVY });
  };
  // Earnings values (side 'L') use a zero-as-dash format to match the real paper payslip
  // ("Bonus  -" rather than "Bonus  0.00"); Deductions (side 'R') keep plain 0.00 since SSF/
  // PVD/PIT showing an explicit "0.00" was the fix the user asked for 2026-07-31.
  const itemRow = (r, label, value, zebraOn, side) => {
    const fillColor = zebraOn ? ZEBRA : WHITE;
    const { lblRange, valRange } = cols[side];
    const lblAddr = lblRange(r), valAddr = valRange(r);
    merge(lblAddr);
    set(lblAddr.split(':')[0], label || '', { font: { color: { argb: TEXT } }, align: leftMid, border: { left: thin, top: thin, bottom: thin }, fill: fillColor });
    merge(valAddr);
    const numFmt = side === 'L' ? '#,##0.00;-#,##0.00;"-"' : '#,##0.00';
    set(valAddr.split(':')[0], value, { font: { color: { argb: TEXT } }, align: rightMid, border: { right: thin, top: thin, bottom: thin }, numFmt, fill: fillColor });
  };
  const totalRow = (r, label, formula, result, side) => {
    ws.getRow(r).height = 20;
    const { lblRange, valRange } = cols[side];
    const lblAddr = lblRange(r), valAddr = valRange(r);
    merge(lblAddr);
    set(lblAddr.split(':')[0], label, { font: { bold: true, color: { argb: NAVY } }, align: leftMid, fill: SLATE_BG, border: { left: thin, top: thick, bottom: thin } });
    merge(valAddr);
    set(valAddr.split(':')[0], { formula, result }, { font: { bold: true, color: { argb: NAVY } }, align: rightMid, fill: SLATE_BG, border: { right: thin, top: thick, bottom: thin }, numFmt: '#,##0.00' });
  };

  let r = attR;
  sectionHeader(r, 'EARNINGS', 'L');
  sectionHeader(r, 'DEDUCTIONS', 'R');
  r++;
  const itemStart = r;
  const maxItems = maxItemsForHeight;
  for (let i = 0; i < maxItems; i++) {
    ws.getRow(r).height = ITEM_ROW_HEIGHT;
    const zebraOn = i % 2 === 1;
    const e = earningsItems[i];
    itemRow(r, e ? e[0] : null, e ? e[1] : null, zebraOn, 'L');
    const d = deductionItems[i];
    itemRow(r, d ? d[0] : null, d ? d[1] : null, zebraOn, 'R');
    r++;
  }
  const itemEnd = r - 1;
  const totalEarnings = earningsItems.reduce((s, [, v]) => s + (v || 0), 0);
  const totalDeductions = deductionItems.reduce((s, [, v]) => s + (v || 0), 0);
  const totEarnRow = r;
  const totDedRow = r;
  totalRow(r, 'TOTAL EARNINGS', `SUM(E${itemStart}:F${itemEnd})`, totalEarnings, 'L');
  totalRow(r, 'TOTAL DEDUCTIONS', `SUM(K${itemStart}:L${itemEnd})`, totalDeductions, 'R');

  // Accent-blue divider between the Earnings/Deductions columns (header row through total row).
  const dividerRule = { style: 'medium', color: { argb: ACCENT_BLUE } };
  for (let dr = itemStart - 1; dr <= r; dr++) {
    const fCell = ws.getCell(`F${dr}`), gCell = ws.getCell(`G${dr}`);
    fCell.border = { ...fCell.border, right: dividerRule };
    gCell.border = { ...gCell.border, left: dividerRule };
  }
  r++;
  ws.getRow(r).height = 10; r++;

  // ---- Net pay: solid navy bar, gold amount -- the "trust navy + premium gold" accent pairing ----
  const netRow = r;
  ws.getRow(netRow).height = 32;
  merge(`A${netRow}:H${netRow}`);
  set(`A${netRow}`, 'NET PAY  (Total Earnings − Total Deductions)', { font: { size: 13, bold: true, color: { argb: WHITE } }, align: leftMid, fill: NAVY, border: boxBorder });
  merge(`I${netRow}:L${netRow}`);
  // References E/K (not F/L) -- totalRow() writes the value into the merged range's anchor
  // cell, which is the LEFT column of each value pair (E for Earnings' E:F, K for Deductions'
  // K:L); F26/L26 are the merged-away secondary cells and read back as blank/0 in real Excel,
  // which silently recomputed this formula to 0.00 on open until fixed (2026-07-31).
  set(`I${netRow}`, { formula: `E${totEarnRow}-K${totDedRow}`, result: totalEarnings - totalDeductions }, { font: { size: 14, bold: true, color: { argb: GOLD } }, align: rightMid, fill: NAVY, border: boxBorder, numFmt: '#,##0.00 "THB"' });
  r++;
  ws.getRow(r).height = 8; r++;

  // 2026-08-02: Calculation Details footnote section (rate x quantity = amount) removed from
  // here per user request -- moved to the web Payslip page instead (renderPayslip() in app.js),
  // shown there now, not in this exported file.

  // ---- Blank open space above the signatures (2026-07-31, replaces the Remarks notes box +
  // footer note per user request -- plain empty room to physically sign, not a bordered box or
  // system-generated text).
  ws.getRow(r).height = blankSpaceHeight; r++;

  // ---- Signatures: "Paid by"/"Received by" to the LEFT of the line, same row (2026-07-31 --
  // corrected from an earlier version that put the label on its own row above the line; the
  // reference mockup has label and line inline: "Paid by ______________"), then the ACTUAL
  // approver/employee name below the line in parentheses (accent blue, sized up so it's legible
  // -- was too small before), then Date. approvedBy comes from finalize.json's
  // mdApproval.approvedBy (the real MD who approved this payslip, set by
  // mdApprovePayrollForEmployee() in app.js); falls back to a blank line if the payslip is
  // being previewed before MD approval (MD/accounting self-service view).
  const sigLineRow = r;
  ws.getRow(sigLineRow).height = 22;
  set(`B${sigLineRow}`, 'Paid by', { font: { bold: true, size: 9.5, color: { argb: NAVY } }, align: { horizontal: 'left', vertical: 'bottom' } });
  merge(`C${sigLineRow}:E${sigLineRow}`);
  set(`C${sigLineRow}`, '', { border: { bottom: { style: 'thin', color: { argb: TEXT } } } });
  set(`H${sigLineRow}`, 'Received by', { font: { bold: true, size: 9.5, color: { argb: NAVY } }, align: { horizontal: 'left', vertical: 'bottom' } });
  merge(`I${sigLineRow}:K${sigLineRow}`);
  set(`I${sigLineRow}`, '', { border: { bottom: { style: 'thin', color: { argb: TEXT } } } });
  r++;

  const sigNameRow = r;
  ws.getRow(sigNameRow).height = 18;
  merge(`C${sigNameRow}:E${sigNameRow}`);
  set(`C${sigNameRow}`, `(${approvedBy || '_______________________'})`, { font: { italic: true, size: 11, color: { argb: ACCENT_BLUE } }, align: center });
  merge(`I${sigNameRow}:K${sigNameRow}`);
  set(`I${sigNameRow}`, `(${user.name})`, { font: { italic: true, size: 11, color: { argb: ACCENT_BLUE } }, align: center });
  r++;

  const sigDateRow = r;
  ws.getRow(sigDateRow).height = 14;
  // Match sample payslip: date under the name columns only (C:E / I:K), real Excel date
  // with format dd mmmm yyyy (e.g. "30 September 2026") — no "Date:" text prefix and not
  // merged from B/H (those columns stay empty like the sample).
  const payDate = (period.paymentDate instanceof Date && !Number.isNaN(period.paymentDate.getTime()))
    ? period.paymentDate
    : null;
  merge(`C${sigDateRow}:E${sigDateRow}`);
  merge(`I${sigDateRow}:K${sigDateRow}`);
  if (payDate) {
    set(`C${sigDateRow}`, payDate, { font: { size: 9, color: { argb: MUTED_TEXT } }, align: center, numFmt: 'dd mmmm yyyy' });
    set(`I${sigDateRow}`, payDate, { font: { size: 9, color: { argb: MUTED_TEXT } }, align: center, numFmt: 'dd mmmm yyyy' });
  } else {
    set(`C${sigDateRow}`, '_______________________', { font: { size: 9, color: { argb: MUTED_TEXT } }, align: center });
    set(`I${sigDateRow}`, '_______________________', { font: { size: 9, color: { argb: MUTED_TEXT } }, align: center });
  }

  const lastRow = sigDateRow;
  // ---- Outer frame around the payslip's main content, stopping at NET PAY (2026-08-02 -- user
  // wants the box to end at Net Pay, not extend down through the calc-details/signature area).
  // Draws a continuous rectangle: left edge (col A) and right edge (col L) from row 1 to netRow,
  // plus top edge (row 1) and bottom edge (netRow) across all columns -- same `thick` style as
  // before (previously this only thickened row 1, so the frame visibly stopped after the header
  // instead of closing anywhere, "แหว่ง" per user report). ----
  for (let rr = 1; rr <= netRow; rr++) {
    const leftCell = ws.getCell(rr, 1);
    leftCell.border = { ...leftCell.border, left: thick };
    const rightCell = ws.getCell(rr, 12);
    rightCell.border = { ...rightCell.border, right: thick };
  }
  for (let c = 1; c <= 12; c++) {
    const topCell = ws.getCell(1, c);
    topCell.border = { ...topCell.border, top: thick };
    const bottomCell = ws.getCell(netRow, c);
    bottomCell.border = { ...bottomCell.border, bottom: thick };
  }

  // fitToHeight: 0 (not 1) is deliberate -- with BOTH fitToWidth and fitToHeight set to 1,
  // Excel applies ONE uniform scale equal to whichever dimension needs more shrinking. Our 12
  // columns need real shrinking to fit A4 portrait width, but the content is naturally shorter
  // than a full page tall -- so the width-driven scale was shrinking the height far more than
  // necessary too, leaving a big blank gap and making the page look "shrunk" (2026-07-31 user
  // report). fitToHeight: 0 makes the scale depend only on the (constant) column layout, never
  // on how many earnings/deduction rows a given month happens to have.
  ws.pageSetup = {
    orientation: 'portrait',
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    verticalCentered: false,
    margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printArea: `A1:L${lastRow}`,
  };

  return wb;
}

module.exports = { buildPayslipWorkbook };
