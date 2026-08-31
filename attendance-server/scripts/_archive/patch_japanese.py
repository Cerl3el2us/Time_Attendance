import paramiko, os, base64, time, os

HOST='192.168.100.100'; USER='Teerawat'; PASS=os.environ.get('NAS_PASSWORD', '')
APP  = '/volume1/web/attendance/js/app.js'
HTML = '/volume1/web/attendance/index.html'
JA_DEST = '/volume1/web/attendance/lang/ja.js'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(HOST, username=USER, password=PASS)

def remote_read(path):
    _, out, _ = ssh.exec_command(f'cat {path}')
    return out.read().decode('utf-8', errors='replace')

def remote_write(path, content, label=''):
    enc = base64.b64encode(content.encode('utf-8')).decode()
    chunks = [enc[i:i+2000] for i in range(0, len(enc), 2000)]
    ssh.exec_command(f'echo "{chunks[0]}" > /tmp/_patch_b64.txt'); time.sleep(0.3)
    for ch in chunks[1:]:
        ssh.exec_command(f'echo "{ch}" >> /tmp/_patch_b64.txt'); time.sleep(0.08)
    time.sleep(0.5)
    _, _, err = ssh.exec_command(f'cat /tmp/_patch_b64.txt | tr -d "\\n" | base64 -d > {path}')
    time.sleep(0.5)
    e = err.read().decode()
    if e: print(f'  WRITE ERROR {label}: {e}')
    else: print(f'  WRITE OK: {label}')

# ── 1. Upload lang/ja.js ─────────────────────────────────────────────────────
print('1. Creating lang/ dir and uploading ja.js...')
ssh.exec_command('mkdir -p /volume1/web/attendance/lang')
time.sleep(0.3)

ja_local = r'C:\Users\tairo\ja.js'
with open(ja_local, 'r', encoding='utf-8') as f:
    ja_content = f.read()
remote_write(JA_DEST, ja_content, 'lang/ja.js')

# ── 2. Patch app.js ──────────────────────────────────────────────────────────
print('2. Patching app.js...')
js = remote_read(APP)
original_len = len(js)

# ── 2a. L() function ──
js = js.replace(
    'function L(en, th) { return currentLang === \'en\' ? en : th; }',
    'function L(en, th) { if (currentLang === \'ja\') { return (window.LANG_JA && window.LANG_JA[en]) || en; } return currentLang === \'en\' ? en : th; }'
)

# ── 2b. toggleLang() ──
js = js.replace(
    "function toggleLang() {\n  currentLang = currentLang === 'th' ? 'en' : 'th';\n  localStorage.setItem('ta_lang', currentLang);\n  const btn = document.getElementById('lang-toggle-btn');\n  if (btn) btn.textContent = currentLang === 'th' ? 'EN' : 'TH';\n  applyLanguage();\n}",
    "function toggleLang() {\n  currentLang = currentLang === 'th' ? 'en' : currentLang === 'en' ? 'ja' : 'th';\n  localStorage.setItem('ta_lang', currentLang);\n  const btn = document.getElementById('lang-toggle-btn');\n  if (btn) btn.textContent = currentLang === 'th' ? 'EN' : currentLang === 'en' ? 'JP' : 'ไทย';\n  applyLanguage();\n}"
)

# ── 2c. applyLanguage() — html lang attr ──
js = js.replace(
    "    document.documentElement.lang = currentLang === 'en' ? 'en' : 'th';",
    "    document.documentElement.lang = currentLang === 'en' ? 'en' : currentLang === 'ja' ? 'ja' : 'th';"
)

# ── 2d. applyLanguage() — button text ──
js = js.replace(
    "    if (btn) btn.textContent = currentLang === 'th' ? 'EN' : 'TH';",
    "    if (btn) btn.textContent = currentLang === 'th' ? 'EN' : currentLang === 'en' ? 'JP' : 'ไทย';"
)

# ── 2e. sidebar footer button (line ~8202) ──
js = js.replace(
    "  if (_lb) _lb.textContent = currentLang === 'th' ? 'EN' : 'TH';",
    "  if (_lb) _lb.textContent = currentLang === 'th' ? 'EN' : currentLang === 'en' ? 'JP' : 'ไทย';"
)

# ── 2f. Day/Month JA arrays + updated _dayNames etc. ──
js = js.replace(
    "function _dayNames()   { return currentLang === 'en' ? DAY_NAMES_EN   : DAY_NAMES_TH; }\nfunction _monthNames()  { return currentLang === 'en' ? MONTH_NAMES_EN  : MONTH_NAMES_TH; }\nfunction _monthShort()  { return currentLang === 'en' ? MONTH_SHORT_EN  : MONTH_SHORT_TH; }",
    "const DAY_NAMES_JA = ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'];\nconst MONTH_NAMES_JA = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];\nconst MONTH_SHORT_JA = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];\nfunction _dayNames()   { return currentLang === 'en' ? DAY_NAMES_EN : currentLang === 'ja' ? DAY_NAMES_JA : DAY_NAMES_TH; }\nfunction _monthNames() { return currentLang === 'en' ? MONTH_NAMES_EN : currentLang === 'ja' ? MONTH_NAMES_JA : MONTH_NAMES_TH; }\nfunction _monthShort() { return currentLang === 'en' ? MONTH_SHORT_EN : currentLang === 'ja' ? MONTH_SHORT_JA : MONTH_SHORT_TH; }"
)

# ── 2g. applyStaticI18n() ──
js = js.replace(
    "function applyStaticI18n() {\n  document.querySelectorAll('[data-en]').forEach(el => {\n    if (el.dataset.th === undefined) el.dataset.th = el.textContent;\n    el.textContent = currentLang === 'en' ? el.dataset.en : el.dataset.th;\n  });\n  document.querySelectorAll('[data-en-ph]').forEach(el => {\n    if (el.dataset.thPh === undefined) el.dataset.thPh = el.getAttribute('placeholder') || '';\n    el.setAttribute('placeholder', currentLang === 'en' ? el.dataset.enPh : el.dataset.thPh);\n  });\n  document.querySelectorAll('[data-en-title]').forEach(el => {\n    if (el.dataset.thTitle === undefined) el.dataset.thTitle = el.getAttribute('title') || '';\n    el.setAttribute('title', currentLang === 'en' ? el.dataset.enTitle : el.dataset.thTitle);\n  });\n}",
    "function applyStaticI18n() {\n  const _ja = currentLang === 'ja', _jaM = window.LANG_JA || {};\n  document.querySelectorAll('[data-en]').forEach(el => {\n    if (el.dataset.th === undefined) el.dataset.th = el.textContent;\n    el.textContent = currentLang === 'en' ? el.dataset.en : _ja ? (_jaM[el.dataset.en] || el.dataset.en) : el.dataset.th;\n  });\n  document.querySelectorAll('[data-en-ph]').forEach(el => {\n    if (el.dataset.thPh === undefined) el.dataset.thPh = el.getAttribute('placeholder') || '';\n    el.setAttribute('placeholder', currentLang === 'en' ? el.dataset.enPh : _ja ? (_jaM[el.dataset.enPh] || el.dataset.enPh) : el.dataset.thPh);\n  });\n  document.querySelectorAll('[data-en-title]').forEach(el => {\n    if (el.dataset.thTitle === undefined) el.dataset.thTitle = el.getAttribute('title') || '';\n    el.setAttribute('title', currentLang === 'en' ? el.dataset.enTitle : _ja ? (_jaM[el.dataset.enTitle] || el.dataset.enTitle) : el.dataset.thTitle);\n  });\n}"
)

# ── 2h. i18n.ja section (insert before closing };) ──
I18N_JA = """  ,ja: {
    ns_overview:'概要', ns_personal:'個人情報・勤怠', ns_manager:'管理',
    ns_calendar:'カレンダー', ns_finance:'財務 & レポート',
    nav_checkin:'出退勤打刻', nav_dashboard:'ダッシュボード', nav_profile:'マイプロフィール',
    nav_attendance:'勤怠表', nav_myattendance:'入退室記録',
    nav_leave:'休暇管理', nav_myrequests:'申請状況',
    nav_employees:'社員情報', nav_approval:'申請管理',
    nav_calendar:'祝日カレンダー', nav_holidays:'祝日管理',
    nav_payslip:'給与明細', nav_mypayslip:'自分の給与明細', nav_finalize:'給与確定', nav_reports:'出勤日数サマリー',
    nav_tawi50:'源泉徴収票', nav_archive:'退職社員', nav_audit:'活動ログ', nav_settings:'設定',
    nav_payroll_history:'給与履歴',
    pt_dashboard:'ダッシュボード', ps_dashboard:'勤怠管理システム概要',
    pt_checkin:'出退勤打刻', ps_checkin:'出退勤時刻を記録する',
    pt_attendance:'勤怠表', ps_attendance:'',
    pt_myattendance:'入退室記録', ps_myattendance:'Hikvisionスキャン記録',
    pt_leave:'休暇管理', ps_leave:'休暇申請と確認',
    pt_myrequests:'申請状況', ps_myrequests:'時刻修正・深夜残業などの申請を確認',
    pt_approval:'申請管理',
    pt_employees:'社員情報', ps_employees:'全社員情報の管理',
    pt_payslip:'給与明細', ps_payslip:'給与明細の計算と発行',
    pt_finalize:'給与確定', ps_finalize:'実際の源泉徴収税を入力して給与を確定',
    pt_reports:'レポート', ps_reports:'月次サマリーレポート',
    pt_profile:'マイプロフィール',
    pt_calendar:'祝日カレンダー', ps_calendar:'年間祝日と祝祭日',
    pt_holidays:'祝日管理', ps_holidays:'会社と法定の祝日を設定',
    role_md:'専務取締役', role_manager:'マネージャー', role_accounting:'経理',
    role_user:'スタッフ', role_driver:'ドライバー',
    checkin_title:'出退勤打刻', checkin_sub:'ボタンをタップして時刻を記録',
    btn_checkin:'出勤', btn_checkout:'退勤', btn_scanning:'スキャン中...',
    checkin_status_in:'出勤済み', checkin_status_out:'未出勤',
    checkin_gps_ok:'GPS準備完了', checkin_gps_searching:'位置情報取得中...',
    checkin_gps_off:'位置情報が利用できません',
    today_log:'本日のログ', no_log:'記録はまだありません',
    dash_today_checkin:'本日のチェックイン', dash_on_leave:'休暇中', dash_late:'遅刻',
    dash_ot:'本日の残業', dash_pending:'承認待ち', dash_events_today:'本日のイベント',
    att_date:'日付', att_day:'曜日', att_status:'状態', att_checkin:'チェックイン',
    att_checkout:'チェックアウト', att_early_late:'早出 / 深夜 / 残業', att_actions:'',
    att_period:'期間：', att_employee:'社員：',
    btn_details:'詳細', btn_edit_time:'✏️ 時刻編集', btn_ot:'⏱️',
    btn_late_out:'🌙', btn_offsite:'🗺️',
    leave_annual:'有給休暇', leave_sick:'病気休暇', leave_business:'業務休暇',
    leave_offsite:'出張', leave_lateout:'深夜残業',
    leave_ot:'残業申請', leave_comp:'振替休日', leave_timecor:'時刻修正',
    leave_remaining:'休暇残日数', leave_annual_lbl:'有給', leave_sick_lbl:'病気',
    leave_biz_lbl:'業務', btn_request_leave:'休暇申請', btn_request_offsite:'出張',
    btn_request_lateout:'深夜残業', btn_request_ot:'残業申請', btn_request_comp:'振替休日',
    btn_request_timecor:'時刻修正',
    status_pending:'承認待ち（マネージャー）', status_pending_md:'承認待ち（専務）',
    status_approved:'承認済み', status_rejected:'却下',
    appr_all:'全て', appr_lateout:'深夜残業', appr_ot:'残業', appr_leave:'休暇',
    appr_offsite:'出張', appr_timecor:'時刻修正', appr_comp:'振替休日', appr_longdistance:'長距離', appr_clearattachments:'添付削除',
    btn_approve:'✓ 承認', btn_reject:'✕ 却下', btn_delete:'削除',
    appr_empty:'申請はありません', appr_note:'メモ：',
    emp_name:'氏名', emp_position:'役職', emp_role:'役割',
    emp_rights:'権限', emp_salary:'給与', emp_status:'状態', emp_actions:'',
    btn_add_emp:'+ 社員追加', emp_active:'在職中', emp_inactive:'退職',
    rpt_name:'名前', rpt_workdays:'出勤日数', rpt_late:'遅刻', rpt_annual:'有給',
    rpt_sick:'病気', rpt_offsite:'出張', rpt_early:'早出',
    rpt_latenight:'深夜残業', rpt_ot:'残業', rpt_payslip:'給与明細',
    rpt_title:'月次社員サマリー',
    pay_income:'収入', pay_deduct:'控除', pay_net:'手取り給与',
    pay_base:'基本給', pay_transport:'交通費',
    pay_pos_allow:'役職手当', pay_housing:'住宅手当',
    pay_ot15:'残業 ×1.5（平日）', pay_ot20:'残業 ×2.0', pay_ot30:'残業 ×3.0（休日）',
    pay_offsite:'手当1 — 出張', pay_early_late:'手当2 — 早出/深夜',
    pay_phone:'手当3 — 携帯',
    pay_ssf:'社会保険（SSO）', pay_pvd:'積立年金（PVD）',
    pay_pit:'所得税（PIT）', pay_total_deduct:'控除合計',
    pay_employee:'社員：', pay_period_lbl:'給与期間：',
    pay_created:'作成日：', pay_pay_date:'支払日：',
    pay_ssf_detail:'5%・上限875バーツ（最低賃金1,650バーツ）',
    pay_pit_detail:'源泉徴収', pay_times:'回', pay_total_hrs:'合計',
    fin_title:'給与確定', fin_sub:'実際の源泉徴収税を入力し、社員ごとに ✓ 確認 をクリック',
    fin_gross:'総支給（バーツ）', fin_diligence:'精勤手当（今期）', fin_ssf:'SSF（バーツ）', fin_pvd:'PVD（バーツ）',
    fin_tax:'源泉徴収税（バーツ）', fin_net:'手取り（バーツ）', fin_status:'状態',
    btn_confirm:'✓ 確認', btn_edit:'✏️ 編集',
    prof_title:'マイプロフィール', prof_personal:'個人情報', prof_finance:'財務情報',
    prof_leave_quota:'休暇割当',
    btn_save:'保存', btn_cancel:'キャンセル', btn_close:'閉じる', btn_print:'🖨️ 印刷',
    btn_export:'📥 エクスポート', btn_prev:'◀ 前へ', btn_next:'次へ ▶',
    loading:'読み込み中...', no_data:'データなし', current_period:'← 今期',
    day_mon:'月', day_tue:'火', day_wed:'水', day_thu:'木',
    day_fri:'金', day_sat:'土', day_sun:'日',
    cal_title:'祝日カレンダー', hol_title:'祝日管理',
    hol_date:'日付', hol_name:'祝日名', btn_add_hol:'+ 祝日追加',
    hol_no_data:'祝日が設定されていません',
    toast_no_permission:'⛔ アクセス拒否', ws_connected:'スキャナー：接続済み',
    ws_offline:'スキャナー：切断',
    period_current:'今期',
  }"""

js = js.replace(
    "    period_current:'Current Period',\n  }\n};",
    "    period_current:'Current Period',\n  }" + I18N_JA + "\n};"
)

# ── 2i. Date format line (วัน...ที่...) — add JA branch ──
js = js.replace(
    "? `${DAY_NAMES_EN[dt.getDay()]}, ${fmtDate(dt)}`\n    : `วัน${DAY_NAMES_TH[dt.getDay()]}ที่ ${fmtDate(dt)}`;",
    "? `${DAY_NAMES_EN[dt.getDay()]}, ${fmtDate(dt)}`\n    : currentLang === 'ja' ? `${fmtDate(dt)}（${DAY_NAMES_JA[dt.getDay()]}）`\n    : `วัน${DAY_NAMES_TH[dt.getDay()]}ที่ ${fmtDate(dt)}`;"
)

# ── 2j. Version bump JS ──
js = js.replace('js?v=20260713bp', 'js?v=20260713bq')  # self-ref if any
# (app.js doesn't self-reference its own version, so skip)

# Count replacements made
new_len = len(js)
print(f'  app.js: {original_len} → {new_len} chars (delta {new_len - original_len:+d})')

remote_write(APP, js, 'app.js')

# ── 3. Patch index.html ───────────────────────────────────────────────────────
print('3. Patching index.html...')
html = remote_read(HTML)

# Add lang/ja.js before app.js
html = html.replace(
    '<script src="js/app.js?v=20260713bp"></script>',
    '<script src="lang/ja.js?v=20260714a"></script>\n<script src="js/app.js?v=20260713bq"></script>'
)

remote_write(HTML, html, 'index.html')

# ── 4. node --check ───────────────────────────────────────────────────────────
print('4. Verifying app.js syntax...')
NODE = '/volume1/@appstore/Node.js_v22/usr/local/bin/node'
_, out, err = ssh.exec_command(f'{NODE} --check {APP} 2>&1')
time.sleep(2)
result = (out.read() + err.read()).decode('utf-8', errors='replace').strip()
print(f'  node --check: {result or "OK (no output = pass)"}')

ssh.close()
print('Done.')
