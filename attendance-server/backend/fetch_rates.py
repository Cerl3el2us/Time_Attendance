#!/usr/bin/env python3
# Fetches JPY/THB TTB rates from Mizuho Bank + Resona Bank public rate pages.
# Both sites sit behind Akamai Bot Manager, which blocks plain HTTP clients (curl, Node https)
# by TLS fingerprint regardless of headers/cookies -- curl_cffi impersonates a real Chrome TLS
# handshake, which is enough to pass. Called as a child process from server.js (Node has no
# equivalent TLS-impersonation library), one process per call, stdout is JSON.
# CORRECTNESS FIX 2026-08-13 (E-7, Opus audit): both per-request timeouts were 15s -- worst case
# (both requests slow) was ~30s, but the Node side (server.js's execFile call) kills this whole
# process at a 20s ceiling. If Mizuho succeeded and Resona was merely slow, the kill discarded BOTH
# results identically, even though the first had already succeeded. Lowered to 8s each so the
# worst case stays inside Node's 20s ceiling. 2026-08-23: SMBC is fetched here too (curl_cffi
# fallback when Node's plain https is blocked/times out). The three banks run in parallel so
# adding SMBC does not eat the 20s budget sequentially.
import sys, json, re
from concurrent.futures import ThreadPoolExecutor

try:
    from curl_cffi import requests
except Exception as e:
    err = {"error": "curl_cffi import failed: " + str(e)}
    print(json.dumps({"smbc": err, "mizuho": err, "resona": err}))
    sys.exit(0)

def fmt_hm(t):
    # "0:00:00" / "9:5:00" -> "00:00" -- zero-pad hour, drop seconds
    parts = t.split(':')
    return f'{parts[0].zfill(2)}:{parts[1].zfill(2)}'

def fetch_smbc():
    r0 = requests.get("https://www.smbctb.co.jp/common/xml/FX_INT.xml", impersonate="chrome124", timeout=8)
    m0 = re.search(
        r'\(THB\)</col>\s*<col[^>]*>([\d.]+)</col>\s*<col[^>]*>([\d.]+)</col>\s*<col[^>]*>([\d.]+)</col>',
        r0.text,
    )
    if not m0:
        return {"error": "THB row not found in XML"}
    out = {"tts": float(m0.group(1)), "mid": float(m0.group(2)), "ttb": float(m0.group(3))}
    dm0 = re.search(r'<caption>[^:：]*[:：]\s*([^<]+)</caption>', r0.text)
    if dm0:
        out["updatedAt"] = dm0.group(1).strip()
    return out

def fetch_mizuho():
    r = requests.get("https://www.mizuhobank.co.jp/market/csv/BK01_06.csv", impersonate="chrome124", timeout=8)
    m = re.search(r'タイバーツ,THB,([\d.]+),([\d.]+),([\d.]+)', r.text)
    if not m:
        return {"error": "THB row not found in CSV"}
    out = {"tts": float(m.group(1)), "ttb": float(m.group(2)), "mid": float(m.group(3))}
    # BK02 section (the one with the THB row) has its own date/time line right after [START]
    dm = re.search(r'\[START\],BK02,[^\n]*\n(\d{4}/\d{2}/\d{2}),(\d{1,2}:\d{1,2}:\d{1,2})', r.text)
    if dm:
        out["updatedAt"] = f'{dm.group(1)} {fmt_hm(dm.group(2))}'
    return out

def fetch_resona():
    r2 = requests.get("https://www.resonabank.co.jp/kojin/market/spotrate.html", impersonate="chrome124", timeout=8)
    m2 = re.search(
        r'タイバーツ）</th>\s*<td class="tCenter wordNumber">([\d.]+)</td>\s*'
        r'<td class="tCenter wordNumber">([\d.]+)</td>\s*<td class="tCenter wordNumber">([\d.]+)</td>',
        r2.text, re.S
    )
    if not m2:
        return {"error": "THB row not found in HTML"}
    # Resona quotes THB per 100-unit (see page's ※1 note) -- normalize to per-1-THB
    # to match Mizuho/SMBC's convention.
    out = {
        "tts": round(float(m2.group(1)) / 100, 4),
        "ttb": round(float(m2.group(2)) / 100, 4),
        "mid": round(float(m2.group(3)) / 100, 4),
    }
    dm2 = re.search(r'最終更新日時[：:]\s*(\d{4})/(\d{1,2})/(\d{1,2})\s+(\d{1,2}:\d{2})', r2.text)
    if dm2:
        out["updatedAt"] = f'{dm2.group(1)}/{dm2.group(2).zfill(2)}/{dm2.group(3).zfill(2)} {dm2.group(4)}'
    return out

def run(fn):
    try:
        return fn()
    except Exception as e:
        return {"error": str(e)}

with ThreadPoolExecutor(max_workers=3) as pool:
    f_smbc = pool.submit(run, fetch_smbc)
    f_mizuho = pool.submit(run, fetch_mizuho)
    f_resona = pool.submit(run, fetch_resona)
    result = {
        "smbc": f_smbc.result(),
        "mizuho": f_mizuho.result(),
        "resona": f_resona.result(),
    }

print(json.dumps(result))
