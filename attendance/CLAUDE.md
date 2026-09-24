# Time Attendance Project — Claude Instructions

## เมื่อเปิด session ใหม่ให้ทำทันที

### Sync memory (ใช้ได้ทุกเครื่อง — ไม่ต้องแยกเครื่องหลัก/เครื่องใหม่)

สคริปต์เดียวใช้ได้ทุกเครื่อง: `Z:\claude_memory\sync_memory.ps1`
สคริปต์จะคำนวณ local memory path ของเครื่องนั้นๆ เองจาก working directory ปัจจุบัน
(ตาม convention ที่ Claude Code ใช้: แทน `:` และ `\` ด้วย `-` เช่น `C:\Claude` → `C--Claude`)
ดังนั้นต้อง `cd` ไปที่ project directory ที่ใช้เปิด Claude Code ก่อนรัน (หรือส่ง `-ProjectDir` ตรงๆ)

**ตอนเริ่ม session** (ถ้าสงสัยว่า memory อาจไม่ใช่ล่าสุด หรือเพิ่งสลับมาจากเครื่องอื่น):
```powershell
powershell -File Z:\claude_memory\sync_memory.ps1 pull
```

**ตอนจบ session** (ผู้ใช้บอกว่าเสร็จแล้ว หรือจะปิด/สลับเครื่อง):
```powershell
powershell -File Z:\claude_memory\sync_memory.ps1 push
```

Sync เฉพาะไฟล์ memory ของโปรเจกต์ Time Attendance เท่านั้น (`project_time_attendance.md`,
`feedback_attendance_users_data.md`, `feedback_attendance_fixstatictext.md`) — ไม่แตะ memory
ของโปรเจกต์อื่นที่อยู่ในเครื่องเดียวกัน

**ถ้าไม่มี Z: drive** (ไม่ได้ต่อ VPN/network): ข้ามการ sync ไปก่อน แล้วทำงานต่อด้วย memory
ที่มีอยู่ในเครื่องนั้น — ไม่ใช่ blocker

---

## Project Context

- **Project:** Time Attendance — Tozai Boeki Kaisha (Thailand) Ltd.
- **Frontend:** `Z:\Time_Attendance\attendance\` (แก้ไขที่นี่ เห็นผลทันที) — moved 2026-08-16
  from `Z:\attendance\` (compatibility symlink left at the old path during a soak period)
- **Backend:** NAS SSH → `/volume1/web/Time_Attendance/attendance-server/backend/server.js`
  (moved 2026-08-16 from `/volume1/web/attendance-server/`, which itself was moved 2026-07-14
  from `/volume1/Teerawat/attendance-backend/`)
- **Deploy:** `python Z:\Time_Attendance\attendance-server\scripts\deploy\deploy_backend.py`
  (needs `NAS_PASSWORD` env var set first, via `setx NAS_PASSWORD "..."` in cmd.exe;
  optional `NAS_USER` picks the DSM account — unset = `Teerawat`; the account must be
  a DSM administrator because the restart step uses `sudo`. Full setup steps live in
  `attendance-server/DEVELOPER_HANDOFF.md`)
- **Live URL:** https://attendance.tozaiboeki.co.th (Cloudflare Tunnel — this is the real
  production URL; the LAN fallback `http://192.168.100.100/Time_Attendance/attendance/` also still works — URL updated 2026-08-16 when the compatibility symlinks were removed same day; the old `/attendance/` path no longer works at all)
- **NAS credentials:** user: Teerawat / (ask the current admin for the password — no longer stored in plaintext here as of 2026-08-13, see the Opus-audited exposure this file itself was flagged for; set it as the `NAS_PASSWORD` env var per `deploy_backend.py`'s own convention)
