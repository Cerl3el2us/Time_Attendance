import paramiko, os, base64, sys

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('192.168.100.100', port=22, username='Teerawat', password=os.environ.get('NAS_PASSWORD', ''), timeout=10)

SERVER = '/volume1/Teerawat/attendance-backend/server.js'
TMP    = '/volume1/Teerawat/attendance-backend/server_tmp.js'
NODE   = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'

_, out, _ = client.exec_command(f'cat {SERVER}')
src = out.read().decode('utf-8')
print(f'Read {len(src)} chars')

# ── Patch 1: add nodemailer + node-cron (idempotent) ──
OLD1 = "const bcrypt = require('bcryptjs');"
NEW1 = (
    "const bcrypt = require('bcryptjs');\n"
    "const nodemailer = require('nodemailer');\n"
    "const cron = require('node-cron');"
)
assert OLD1 in src, 'PATCH1 not found'
if "require('nodemailer')" not in src:
    src = src.replace(OLD1, NEW1, 1)
    print('Patch 1: added nodemailer + node-cron')
else:
    print('Patch 1: already patched, skip')

# ── Patch 2: insert email/cron code before server.listen ──
LISTEN_ANCHOR = "server.listen(PORT, '0.0.0.0', () => console.log(`[HTTP] port ${PORT}`));"
assert LISTEN_ANCHOR in src, 'LISTEN_ANCHOR not found'

EMAIL_CODE = r"""
// ===== EMAIL HELPERS =====
function readSettings() { return readJSON('settings.json', {}); }

function getEmailTransport() {
  const cfg = (readSettings().emailConfig) || {};
  if (!cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host || 'smtp.gmail.com',
    port: Number(cfg.port) || 587,
    secure: false,
    auth: { user: cfg.user, pass: cfg.pass }
  });
}

function buildPayslipHtml(payslip) {
  const fmt = n => Number(n||0).toLocaleString('th-TH',{minimumFractionDigits:2,maximumFractionDigits:2});
  const rows = [
    ['เงินเดือน', payslip.baseSalary],
    payslip.diligence ? ['ค่าขยัน', payslip.diligence] : null,
    payslip.otPay   ? ['OT', payslip.otPay] : null,
    payslip.bonus   ? ['โบนัส', payslip.bonus] : null,
    ['รวมรายได้', payslip.grossIncome, true],
    payslip.ssf !== undefined ? ['ประกันสังคม', -payslip.ssf] : null,
    payslip.pvd !== undefined ? ['กองทุนสำรองเลี้ยงชีพ', -payslip.pvd] : null,
    payslip.pit !== undefined ? ['ภาษีหัก ณ ที่จ่าย', -payslip.pit] : null,
    ['รายได้สุทธิ', payslip.netIncome, true, true],
  ].filter(Boolean);
  const rowsHtml = rows.map(([label, val, bold, highlight]) =>
    `<tr style="${highlight ? 'background:#ecfdf5' : ''}">
      <td style="padding:8px 16px;border-bottom:1px solid #e2e8f0;${bold ? 'font-weight:700' : ''}">${label}</td>
      <td style="padding:8px 16px;border-bottom:1px solid #e2e8f0;text-align:right;${bold ? 'font-weight:700' : ''}${highlight ? ';color:#059669' : ''}">${fmt(val)} บาท</td>
    </tr>`
  ).join('');
  return `<div style="font-family:sans-serif;max-width:500px;margin:0 auto">
    <div style="background:#1e293b;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
      <div style="font-size:18px;font-weight:700">สลิปเงินเดือน</div>
      <div style="font-size:13px;opacity:0.7;margin-top:4px">${payslip.employeeName} — งวด ${payslip.periodLabel}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-top:none">
      ${rowsHtml}
    </table>
    <div style="padding:12px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;font-size:11px;color:#94a3b8;text-align:center">
      อีเมลนี้ส่งโดยระบบอัตโนมัติ — กรุณาอย่าตอบกลับ
    </div>
  </div>`;
}

// POST /api/send-payslip
app.post('/api/send-payslip', async (req, res) => {
  try {
    const { to, payslip } = parseBody(req);
    if (!to || !payslip) return res.status(400).json({ success:false, message:'to and payslip required' });
    const transport = getEmailTransport();
    if (!transport) return res.status(503).json({ success:false, message:'Email not configured' });
    const cfg = readSettings().emailConfig || {};
    await transport.sendMail({
      from: `"${cfg.fromName || 'ระบบเงินเดือน'}" <${cfg.user}>`,
      to: String(to),
      subject: `สลิปเงินเดือน ${payslip.periodLabel} — ${payslip.employeeName}`,
      html: buildPayslipHtml(payslip)
    });
    console.log('[EMAIL] payslip sent to', to);
    res.json({ success:true });
  } catch(e) {
    console.error('[EMAIL] send-payslip error:', e.message);
    res.status(500).json({ success:false, message: e.message });
  }
});

// POST /api/test-email
app.post('/api/test-email', async (req, res) => {
  try {
    const { to } = parseBody(req);
    const transport = getEmailTransport();
    if (!transport) return res.status(503).json({ success:false, message:'Email not configured' });
    const cfg = readSettings().emailConfig || {};
    await transport.sendMail({
      from: `"${cfg.fromName || 'ระบบเงินเดือน'}" <${cfg.user}>`,
      to: String(to || cfg.user),
      subject: 'ทดสอบการส่งอีเมล — ระบบ Time Attendance',
      html: '<div style="font-family:sans-serif;padding:20px"><h3>✅ ส่งอีเมลสำเร็จ</h3><p>การตั้งค่า SMTP ใช้งานได้ปกติ</p></div>'
    });
    res.json({ success:true });
  } catch(e) {
    res.status(500).json({ success:false, message: e.message });
  }
});

// ===== NOTIFICATION CRON =====
let _cronJob = null;

function getTypeLabel(type) {
  const labels = { annual:'ลาพักร้อน', sick:'ลาป่วย', business:'ลากิจ', maternity:'ลาคลอด', ordain:'ลาบวช', comp:'วันหยุดชดเชย', ot:'โอที', trip:'ไปต่างจังหวัด', 'long-distance':'เดินทางไกล' };
  return labels[type] || type;
}

function buildPendingEmailHtml(pendingByStage) {
  const sections = [];
  if (pendingByStage.manager && pendingByStage.manager.length > 0) {
    const rows = pendingByStage.manager.map(l =>
      `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9">${l.empName}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9">${l.typeLabel}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9">${l.dateRange}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;color:#94a3b8">${l.pendingDays} วัน</td></tr>`
    ).join('');
    sections.push(`<div style="margin-bottom:20px">
      <div style="font-weight:700;color:#f59e0b;margin-bottom:8px">⏳ รอการอนุมัติจาก Manager (${pendingByStage.manager.length} รายการ)</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#fef3c7"><th style="padding:6px 12px;text-align:left">พนักงาน</th><th style="padding:6px 12px;text-align:left">ประเภท</th><th style="padding:6px 12px;text-align:left">วันที่</th><th style="padding:6px 12px;text-align:left">ค้างมา</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`);
  }
  if (pendingByStage.md && pendingByStage.md.length > 0) {
    const rows = pendingByStage.md.map(l =>
      `<tr><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9">${l.empName}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9">${l.typeLabel}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9">${l.dateRange}</td><td style="padding:6px 12px;border-bottom:1px solid #f1f5f9;color:#94a3b8">${l.pendingDays} วัน</td></tr>`
    ).join('');
    sections.push(`<div style="margin-bottom:20px">
      <div style="font-weight:700;color:#8b5cf6;margin-bottom:8px">⏳ รอการอนุมัติจาก MD (${pendingByStage.md.length} รายการ)</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="background:#ede9fe"><th style="padding:6px 12px;text-align:left">พนักงาน</th><th style="padding:6px 12px;text-align:left">ประเภท</th><th style="padding:6px 12px;text-align:left">วันที่</th><th style="padding:6px 12px;text-align:left">ค้างมา</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`);
  }
  if (!sections.length) return null;
  const todayStr = new Date().toLocaleDateString('th-TH',{year:'numeric',month:'long',day:'numeric'});
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#1e293b;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0">
      <div style="font-size:18px;font-weight:700">🔔 แจ้งเตือนคำขอค้างอนุมัติ</div>
      <div style="font-size:13px;opacity:0.7;margin-top:4px">${todayStr}</div>
    </div>
    <div style="padding:20px 24px;background:#fff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
      ${sections.join('')}
    </div>
    <div style="padding:10px 16px;font-size:11px;color:#94a3b8;text-align:center">อีเมลนี้ส่งโดยระบบอัตโนมัติ — กรุณาอย่าตอบกลับ</div>
  </div>`;
}

function scheduleCronNotification() {
  if (_cronJob) { _cronJob.stop(); _cronJob = null; }
  const settings = readSettings();
  const nc = settings.emailNotification;
  if (!nc || !nc.enabled) return;
  const sched = nc.schedule || {};
  const time = (sched.time || '09:00').split(':');
  const hour = time[0] || '9';
  const min  = time[1] || '0';
  const days = sched.days || ['mon','tue','wed','thu','fri'];
  const dayMap = { sun:'0', mon:'1', tue:'2', wed:'3', thu:'4', fri:'5', sat:'6' };
  const cronDays = days.map(d => dayMap[d] || d).join(',');
  const expr = `${min} ${hour} * * ${cronDays}`;
  console.log('[CRON] notification schedule:', expr);
  _cronJob = cron.schedule(expr, async () => {
    try {
      const s2 = readSettings();
      const nc2 = s2.emailNotification;
      if (!nc2 || !nc2.enabled) return;
      const transport = getEmailTransport();
      if (!transport) return;
      const cfg = s2.emailConfig || {};
      const users = readUsers() || [];
      const leaves = readLeaves() || [];
      const minDays = Number((nc2.schedule||{}).minPendingDays || 0);
      const now = Date.now();
      const pending = leaves.filter(l => l.status === 'pending-manager' || l.status === 'pending-md');
      if (!pending.length) return;
      const pendingByStage = { manager: [], md: [] };
      for (const l of pending) {
        const emp = users.find(u => u.id === l.userId);
        const createdAt = l.createdAt ? new Date(l.createdAt).getTime() : now;
        const pendingDays = Math.floor((now - createdAt) / 86400000);
        if (pendingDays < minDays) continue;
        const item = {
          empName: emp ? emp.name : l.userId,
          typeLabel: getTypeLabel(l.type),
          dateRange: l.dateFrom === l.dateTo ? l.dateFrom : (l.dateFrom + ' - ' + l.dateTo),
          pendingDays
        };
        if (l.status === 'pending-manager') pendingByStage.manager.push(item);
        else pendingByStage.md.push(item);
      }
      const html = buildPendingEmailHtml(pendingByStage);
      if (!html) return;
      const recip = nc2.recipients || {};
      const toList = new Set();
      if (recip.manager)    users.filter(u => u.role === 'manager'    && u.active && u.email).forEach(u => toList.add(u.email));
      if (recip.md)         users.filter(u => u.role === 'md'         && u.active && u.email).forEach(u => toList.add(u.email));
      if (recip.accounting) users.filter(u => u.role === 'accounting' && u.active && u.email).forEach(u => toList.add(u.email));
      (recip.extra || []).forEach(e => e && toList.add(e));
      if (!toList.size) return;
      await transport.sendMail({
        from: `"${cfg.fromName || 'ระบบ Time Attendance'}" <${cfg.user}>`,
        to: [...toList].join(', '),
        subject: `🔔 แจ้งเตือน: มีคำขอค้างอนุมัติ ${pending.length} รายการ`,
        html
      });
      console.log('[CRON] notification sent to', [...toList].join(', '));
    } catch(e) {
      console.error('[CRON] notification error:', e.message);
    }
  }, { timezone: 'Asia/Bangkok' });
}

scheduleCronNotification();

"""

if 'EMAIL HELPERS' not in src:
    src = src.replace(LISTEN_ANCHOR, EMAIL_CODE + '\n' + LISTEN_ANCHOR, 1)
    print('Patch 2: inserted email/cron code')
else:
    print('Patch 2: email code already present, replacing...')
    # Find and replace existing email block
    start = src.find('// ===== EMAIL HELPERS =====')
    end = src.find('\n' + LISTEN_ANCHOR)
    if start >= 0 and end >= 0:
        src = src[:start] + EMAIL_CODE.strip() + '\n\n' + src[end+1:]
        print('Patch 2: replaced existing email block')

# Hook scheduleCronNotification after PUT /api/settings
OLD_SAVE = "  writeJSON('settings.json', updated);\n  res.json({ success: true, settings: updated });"
NEW_SAVE = "  writeJSON('settings.json', updated);\n  scheduleCronNotification();\n  res.json({ success: true, settings: updated });"
if OLD_SAVE in src:
    src = src.replace(OLD_SAVE, NEW_SAVE, 1)
    print('Hooked cron into settings save')

print(f'Final size: {len(src)} chars')

# Write to TMP
encoded = base64.b64encode(src.encode('utf-8')).decode('ascii')
chunk_size = 4096
parts = [encoded[i:i+chunk_size] for i in range(0, len(encoded), chunk_size)]
stdin2, stdout2, stderr2 = client.exec_command(f"echo '{parts[0]}' | base64 -d > {TMP}")
stdout2.channel.recv_exit_status()
for p in parts[1:]:
    stdin2, stdout2, stderr2 = client.exec_command(f"echo '{p}' | base64 -d >> {TMP}")
    stdout2.channel.recv_exit_status()

_, sz, _ = client.exec_command(f'wc -c {TMP}')
print('File size:', sz.read().decode().strip())

# Syntax check
_, syn, _ = client.exec_command(f'{NODE} --check {TMP} 2>&1')
syn.channel.recv_exit_status()
check = syn.read().decode().strip()
if check:
    print('SYNTAX ERROR:', check)
    client.exec_command(f'rm {TMP}')
else:
    client.exec_command(f'mv {TMP} {SERVER}')
    print('server.js updated OK')

client.close()
