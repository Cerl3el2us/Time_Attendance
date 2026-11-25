# แผนลงมือ: วันหยุดที่ทับทริปต่างประเทศ ให้เป็นวันลาอัตโนมัติอย่างเดียว · ตัด OT ทุกชนิด

> **สำหรับ agent ที่มาทำต่อ:** ใช้ `superpowers:subagent-driven-development` หรือ
> `superpowers:executing-plans` ทำทีละ task · ขั้นตอนเป็น checkbox ไว้ติ๊กตามจริง
> **สเปกต้นเรื่อง:** `docs/superpowers/specs/2026-11-17-abroad-holiday-credit-design.md` (หัวข้อ 5 และ 5.1)

**เป้าหมาย:** ทริปต่างประเทศที่อนุมัติแล้ว ให้ +1 วันลาพักร้อนอัตโนมัติต่อวันหยุดที่เสียไป และห้ามเคลมเงินใดๆ บนวันนั้น

**วิธี:** แก้สูตรนับเครดิตให้เดินทุกวันในช่วงทริปแล้วเก็บลง `Set` (กันนับซ้ำ) · เพิ่ม `'ot'` กับ
`'holiday-work'` เข้ารายการห้ามเคลมของวัน abroad · เติมด่านที่ `submitOT`/`submitDriverOT` ซึ่งไม่มี ·
กรองวัน abroad ออกจากตัวคำนวณเงิน · ขยายด่านตอนยื่นทริปจาก 2 วันเป็นทั้งช่วง

**เครื่องมือ:** JavaScript ล้วน ไม่มี framework · เทสต์คือ `node --test tests/<ชื่อ>.test.js`
ซึ่งดึงฟังก์ชันจากไฟล์จริงมารันใน sandbox (`vm`) จึงพิสูจน์ dual-sync ให้เองด้วย

## ข้อบังคับที่ใช้กับทุก task

- **Dual-sync:** ทุกฟังก์ชันที่แก้มีฝาแฝดใน `attendance/js/app.js` และ
  `attendance-server/backend/server.js` — แก้ข้างเดียวตัวเลขเงินจะแตกกันเงียบๆ โค้ดสองฝั่ง
  ต้องเหมือนกันตัวอักษรต่อตัวอักษร
- **ห้ามลบคอมเมนต์คำตัดสินเดิมของเจ้าของ** ให้เพิ่มบรรทัดลงวันที่ `2026-11-25 (owner)` ทับ และบอกว่า
  ของเดิมคืออะไร (กฎโปรเจกต์: `feedback_attendance_annotate_rules_in_code.md`)
- **ข้อความผู้ใช้ต้องมาพร้อมกัน 3 ภาษา** TH/EN/JA ทุกครั้ง
- **ห้ามแตะ:** เบี้ยเลี้ยงเหมารายวัน (`abroadDays`) · กฎ "ต้องมาถึงแล้ว" (`d <= today`) ·
  การข้าม Company Trip · snapshot เงินเดือนของงวดที่ปิดแล้ว
- **`node --check` ทั้งสองไฟล์ก่อน commit ทุกครั้ง** (lint จับ TDZ ไม่ได้)
- **ห้ามแก้ `Z:\Time_Attendance`** ทำงานใน worktree ของเครื่องนั้นเท่านั้น
- เจ้าของอนุมัติดีไซน์แล้ว 2026-11-25 · ผลย้อนหลังตรวจแล้ว 2 ครั้ง = ไม่มี (ไม่ต้องเขียนสคริปต์ย้อนหลัง)

---
## Task 1: สูตรนับเครดิตวันหยุดที่ทับทริป

**ไฟล์:**
- แก้: `tests/year-end-abroad.test.js` (stub ของ sandbox + เทสต์ใหม่)
- แก้: `attendance/js/app.js:5054-5069` (`abroadTravelCreditDays`)
- แก้: `attendance-server/backend/server.js:5829-5845` (ฝาแฝด)

**อินเทอร์เฟซ:**
- ใช้ของเดิม: `bangkokDateStr()` `isNonWorkDayForComp(d)` `isPublicHoliday(d)` `isCompanyTripDay(d)`
- ส่งต่อ: `abroadTravelCreditDays(abroadLeaves, yStart, yEnd) -> number` — **ลายเซ็นไม่เปลี่ยน**
  ผู้เรียกทุกตัวจึงไม่ต้องแก้ (`getApprovedHolidayWorkAnnualLeaveDays` ฝั่ง server,
  `getApprovedHolidayWorkDays` ฝั่งเว็บ, `earnedCreditMinutesOf` ทั้งสองฝั่ง)

- [ ] **ขั้น 1: ทำ stub ของ sandbox ให้รับวันหยุดได้**

ตอนนี้ไฟล์เทสต์ตรึง `isPublicHoliday: () => false` ไว้ ⇒ เขียนเทสต์นักขัตฤกษ์ไม่ได้เลย
แก้ทั้งใน `makeClient` (บรรทัด ~59-60) และ `makeServer` (~73-74) ให้เป็น:

```js
    isPublicHoliday: d => !!(w.holidays && w.holidays.includes(d)),
    isCompanyTripDay: d => !!(w.companyTrips && w.companyTrips.includes(d)),
    isNonWorkDayForComp: d => {
      const x = new Date(d + 'T12:00:00').getDay();
      return x === 0 || x === 6 || !!(w.holidays && w.holidays.includes(d));
    },
```

เข้ากันได้กับเทสต์เดิมทุกตัว เพราะ world เดิมไม่มี `holidays`/`companyTrips` ⇒ ได้ `false` เหมือนเดิม

- [ ] **ขั้น 2: เขียนเทสต์ที่ต้องแดง**

เพิ่มท้ายไฟล์ — ตัวช่วยนี้ยืนยัน dual-sync ให้เองทุกเคส:

```js
// 2026-11-25 (owner): วันหยุดที่ทับทริปต่างประเทศได้ +1 วันลาอัตโนมัติ
// วันเดินทางไป/กลับ: เสาร์-อาทิตย์หรือนักขัตฤกษ์ · วันกลางทริป: นักขัตฤกษ์เท่านั้น
function creditBoth(over, leaves, yStart, yEnd) {
  const w = { today: '2026-12-31', leaves: [], users: [], leave: leaveSettings(),
    cf: {}, openingUsed: {}, ...over };
  const c = makeClient(w).abroadTravelCreditDays(leaves, yStart, yEnd);
  const s = makeServer(w).abroadTravelCreditDays(leaves, yStart, yEnd);
  assert.strictEqual(c, s, 'dual-sync แตก: app.js กับ server.js ให้ค่าต่างกัน');
  return c;
}
const trip = (dateFrom, dateTo) => [{ dateFrom, dateTo }];
const Y26 = ['2026-01-01', '2026-12-31'];

// วันจริงยืนยันแล้ว: 2026-03-02 จ · 03-06 ศ · 03-07 ส · 03-08 อา · 03-09 จ · 03-15 อา
test('นักขัตฤกษ์กลางทริปได้คืน 1 วัน', () => {
  assert.strictEqual(creditBoth({ holidays: ['2026-03-04'] }, trip('2026-03-02', '2026-03-06'), ...Y26), 1);
});
test('นักขัตฤกษ์กลางทริป 2 วันได้คืน 2 วัน', () => {
  assert.strictEqual(creditBoth({ holidays: ['2026-03-04', '2026-03-05'] }, trip('2026-03-02', '2026-03-06'), ...Y26), 2);
});
test('เสาร์-อาทิตย์กลางทริปไม่ได้คืน', () => {
  assert.strictEqual(creditBoth({}, trip('2026-03-02', '2026-03-09'), ...Y26), 0);
});
test('วันเดินทางไปตรงเสาร์ได้ 1 กลับตรงอาทิตย์ได้อีก 1', () => {
  assert.strictEqual(creditBoth({}, trip('2026-03-07', '2026-03-15'), ...Y26), 2);
});
test('วันเดินทางที่เป็นทั้งเสาร์และนักขัตฤกษ์ได้ 1 ไม่ใช่ 2', () => {
  assert.strictEqual(creditBoth({ holidays: ['2026-03-07'] }, trip('2026-03-07', '2026-03-09'), ...Y26), 1);
});
test('ทริปวันเดียวที่ตรงนักขัตฤกษ์ได้ 1 ครั้งเดียว', () => {
  assert.strictEqual(creditBoth({ holidays: ['2026-03-04'] }, trip('2026-03-04', '2026-03-04'), ...Y26), 1);
});
test('วันที่ยังไม่มาถึงไม่ได้เครดิต', () => {
  assert.strictEqual(creditBoth({ today: '2026-03-03', holidays: ['2026-03-04'] },
    trip('2026-03-02', '2026-03-06'), ...Y26), 0);
});
test('นักขัตฤกษ์ที่เป็น Company Trip ด้วย ไม่ได้เครดิต', () => {
  assert.strictEqual(creditBoth({ holidays: ['2026-03-04'], companyTrips: ['2026-03-04'] },
    trip('2026-03-02', '2026-03-06'), ...Y26), 0);
});
test('ทริปคาบปี นับเฉพาะวันที่อยู่ในปีที่ถาม', () => {
  // 2026-12-31 พฤ · 2027-01-01 ศ (นักขัตฤกษ์ทั้งคู่) · ทริป 2026-12-30 พ -> 2027-01-02 ส
  const t = trip('2026-12-30', '2027-01-02');
  const w = { today: '2027-12-31', holidays: ['2026-12-31', '2027-01-01'] };
  assert.strictEqual(creditBoth(w, t, ...Y26), 1);
  assert.strictEqual(creditBoth(w, t, '2027-01-01', '2027-12-31'), 2);
});
```

- [ ] **ขั้น 3: รันให้เห็นว่าแดงจริง**

รัน: `node --test tests/year-end-abroad.test.js`
คาดหวัง: เคสนักขัตฤกษ์กลางทริปแดง (ได้ 0 ควรได้ 1) ส่วนเคสวันเดินทางผ่านอยู่แล้ว
**ถ้าเคสที่ควรแดงกลับเขียว ให้หยุดและหาสาเหตุ** — แปลว่า stub หรือเทสต์ไม่ได้วัดของจริง

- [ ] **ขั้น 4: แก้สูตรในไฟล์จริงทั้งสองไฟล์ (โค้ดเหมือนกันตัวต่อตัว)**

แทนที่ตัวฟังก์ชันเดิม **เก็บคอมเมนต์เดิมไว้ทั้งก้อน** แล้วเพิ่มคอมเมนต์ใหม่ต่อท้ายก่อน `function`:

```js
// 2026-11-25 (owner): ขอบเขตกว้างขึ้น -- ของเดิม (2026-09-23) ให้เครดิตเฉพาะวันเดินทาง
// คือวันเริ่มกับวันจบทริปเท่านั้น วันหยุดที่อยู่กลางทริปไม่ได้อะไรเลย เจ้าของสั่งเปลี่ยนเป็น:
//   วันเดินทางไป/กลับ -> ได้เมื่อตรงเสาร์-อาทิตย์ "หรือ" นักขัตฤกษ์ (เหมือนเดิม)
//   วันกลางทริป       -> ได้เมื่อตรงนักขัตฤกษ์เท่านั้น (เสาร์-อาทิตย์กลางทริปไม่ได้คืน)
// เจ้าของพูดเองว่า "หากเป็นการเดินทางยาว วันเสาร์อาทิตย์จะไม่ได้คืน เสาร์อาทิตย์จะได้คืน
// แค่เฉพาะเป็นกรณีของวันเดินทางเท่านั้น" · ไม่มีเพดานต่อทริป (เจ้าของยืนยัน 2026-11-25)
// `credited` เป็น Set ต่อหนึ่งทริป จึงกันการนับซ้ำเมื่อวันเดินทางตรงนักขัตฤกษ์ด้วย
// และกันทริปวันเดียวนับสองครั้งไปในตัว · Dual-sync กับอีกไฟล์
function abroadTravelCreditDays(abroadLeaves, yStart, yEnd) {
  const today = bangkokDateStr();
  const pad2 = v => String(v).padStart(2, '0');
  const ymd = dt => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  let n = 0;
  abroadLeaves.forEach(l => {
    if (!l || !l.dateFrom) return;
    const from = l.dateFrom;
    const to = l.dateTo || l.dateFrom;
    if (to < from) return;
    const travel = new Set([from, to]);
    const credited = new Set();
    // ความยาวทริปถูกจำกัดด้วย ABROAD_SPAN_MAX_DAYS อยู่แล้ว เพดาน 400 รอบนี้กันเฉพาะกรณี
    // ข้อมูลเสียหาย (dateTo ห่างผิดปกติ) ไม่ให้ลูปวิ่งไม่สิ้นสุด
    let guard = 0;
    for (let dt = new Date(from + 'T12:00:00'); guard < 400; dt.setDate(dt.getDate() + 1)) {
      guard++;
      const d = ymd(dt);
      if (d > to) break;
      if (d < yStart || d > yEnd || d > today) continue;
      if (isCompanyTripDay(d)) continue;
      if (travel.has(d) ? isNonWorkDayForComp(d) : isPublicHoliday(d)) credited.add(d);
    }
    n += credited.size;
  });
  return n;
}
```

- [ ] **ขั้น 5: รันเทสต์ให้เขียว + ตรวจไวยากรณ์**

```bash
node --check attendance/js/app.js
node --check attendance-server/backend/server.js
node --test tests/year-end-abroad.test.js
```

คาดหวัง: `node --check` ไม่พิมพ์อะไร (เงียบ = ผ่าน) · เทสต์ 0 failed

- [ ] **ขั้น 6: commit**

```bash
git add tests/year-end-abroad.test.js attendance/js/app.js attendance-server/backend/server.js
git commit -m "feat(abroad): นักขัตฤกษ์ที่ทับกลางทริปต่างประเทศได้วันลาอัตโนมัติ"
```

---
## Task 2: ห้ามเคลม OT และ Holiday Work บนวัน abroad

**ไฟล์:**
- แก้: `attendance-server/backend/server.js:10666-10678` (`ABROAD_NO_CLAIM_TYPES`, `abroadNoClaimMessage`)
- แก้: `attendance/js/app.js:24068-24072` (ฝาแฝดของ set) และ `:24135-24143` (`blockIfAbroadDay`)
- แก้: `attendance/js/app.js` เติมด่านที่ `submitOT` (หลัง ~21260) และ `submitDriverOT` (หลัง ~21380)
- สร้าง: `tests/abroad-no-claims.test.js`

**สิ่งที่ต้องรู้ก่อนลงมือ (ตรวจกับโค้ดจริงแล้ว):**
- ฝั่ง server `isAbroadClaimBlocked(type, user, dateFrom)` ถูกเรียกอยู่แล้ว **ทั้ง POST**
  (`server.js:7221`) **และ PUT** (`server.js:7780`) และคีย์ด้วย `type`
  ⇒ **เพิ่มชนิดเข้า set ครอบทั้งสองเส้นทางให้เอง ไม่ต้องไปเติมการเรียก**
- **Driver OT ไม่ใช่ประเภทใบแยก** มันคือ `type: 'ot'` + ธง `isDriverOT: true`
  (ยืนยันที่ `app.js:21382` และ `21393`) ⇒ ฝั่ง server ครอบให้เองด้วย `'ot'`
- ฝั่งเว็บ `app.js:22162` **เรียก `blockIfAbroadDay(date, 'holiday-work')` รออยู่แล้ว** —
  ตอนนี้เป็น no-op เพราะชนิดนั้นไม่อยู่ใน set ⇒ พอเพิ่มเข้า set ด่านนี้ทำงานทันที
- ฝั่งเว็บ **ไม่มี** `blockIfAbroadDay(date, 'ot')` ที่ไหนเลย `submitOT` และ `submitDriverOT`
  เรียกแค่ `blockIfCompanyTrip()` ⇒ ต้องเติมมือทั้งสองที่
- ตรวจแล้วว่า **ไม่มีเทสต์ไฟล์ไหนยืนยันข้อความ abroad เดิม** ⇒ เปลี่ยนข้อความได้ไม่ทำเทสต์เก่าแดง

- [ ] **ขั้น 1: เขียนเทสต์ที่ต้องแดง**

สร้าง `tests/abroad-no-claims.test.js` — อ่าน set ออกจากไฟล์จริง ไม่เขียนรายการซ้ำไว้ในเทสต์
(ไม่งั้นเทสต์จะยืนยันแค่ตัวเอง):

```js
// 2026-11-25 (owner): วัน abroad เคลมอะไรไม่ได้เลย -- วันหยุดที่ทับจะเพิ่มวันลาให้อัตโนมัติแทน
// ของเดิม (2026-09-21 และ 2026-09-23) อนุญาต OT และ Holiday Work บนวัน abroad โดยเจตนา
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'attendance/js/app.js'), 'utf8');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'attendance-server/backend/server.js'), 'utf8');

function noClaimTypes(src) {
  const m = /const ABROAD_NO_CLAIM_TYPES = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, 'ไม่เจอ ABROAD_NO_CLAIM_TYPES');
  return new Set(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
}

function functionBody(src, name) {
  const m = new RegExp(`^(async )?function ${name}\(`, 'm').exec(src);
  assert.ok(m, `ไม่เจอ ${name}`);
  const i = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(m.index, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

test('วัน abroad ห้ามเคลมทุกชนิด รวม OT และ Holiday Work (ทั้งสองไฟล์)', () => {
  for (const [name, src] of [['app.js', APP_SRC], ['server.js', SERVER_SRC]]) {
    const s = noClaimTypes(src);
    for (const t of ['ot', 'holiday-work', 'early-morning', 'late-out',
      'upcountry', 'long-distance', 'personal-car']) {
      assert.ok(s.has(t), `${name}: ขาด '${t}' ในรายการห้ามเคลมของวัน abroad`);
    }
  }
});

test('รายการห้ามเคลมของสองไฟล์ต้องเหมือนกัน (dual-sync)', () => {
  assert.deepStrictEqual([...noClaimTypes(APP_SRC)].sort(), [...noClaimTypes(SERVER_SRC)].sort());
});

test('submitOT และ submitDriverOT ต้องเรียกด่าน abroad', () => {
  for (const fn of ['submitOT', 'submitDriverOT']) {
    assert.ok(/blockIfAbroadDay\(\s*date\s*,\s*'ot'\s*\)/.test(functionBody(APP_SRC, fn)),
      `${fn}: ไม่ได้เรียก blockIfAbroadDay(date, 'ot')`);
  }
});

test('ข้อความบอกเหตุผลต้องไม่บอกว่ายังเคลม OT ได้ และต้องครบ 3 ภาษา', () => {
  assert.ok(!/only OT and Holiday Work can be claimed/.test(SERVER_SRC),
    'server.js: ยังมีข้อความเดิมที่บอกว่าเคลม OT ได้');
  const body = functionBody(APP_SRC, 'blockIfAbroadDay');
  assert.ok(/'ja'/.test(body) && /L\(/.test(body), 'blockIfAbroadDay: ข้อความไม่ครบ 3 ภาษา');
  assert.ok(!/เคลมได้เฉพาะ OT/.test(body), 'app.js: ยังมีข้อความไทยเดิม');
});
```

- [ ] **ขั้น 2: รันให้เห็นว่าแดง**

รัน: `node --test tests/abroad-no-claims.test.js`
คาดหวัง: แดงทั้ง 4 เคส
