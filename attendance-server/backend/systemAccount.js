/**
 * System account (superadmin) — DO NOT DELETE THIS FILE.
 *
 * Provides a developer-only login that is NOT an employee record. The account is
 * re-created automatically on every backend start if removed from users.json, and
 * protected fields cannot be changed through the normal user-management API.
 *
 * Password: set SUPERADMIN_PASSWORD env var before first creation (never commit it).
 */

const SYSTEM_USERNAME = 'superadmin';
const SYSTEM_USER_ID = 900001;

const PROTECTED_KEYS = new Set([
  'id', 'username', 'role', 'isSystemAccount', 'employeeNo', 'name', 'dept', 'position',
  'active', 'isObserver', 'facePhoto', 'salary', 'annualLeave', 'sickLeave', 'businessLeave',
  'transport', 'positionAllowance', 'housing', 'allowance3', 'pvdRate', 'doorSync',
]);

function isSystemAccountUser(u) {
  return !!(u && (u.isSystemAccount === true || String(u.username).toLowerCase() === SYSTEM_USERNAME));
}

function isSuperAdminUser(u) {
  return isSystemAccountUser(u) && u.role === 'superadmin';
}

function buildSystemAccountRecord(passwordHash) {
  return {
    id: SYSTEM_USER_ID,
    employeeNo: '',
    username: SYSTEM_USERNAME,
    password: passwordHash || '',
    name: 'System Administrator',
    facePhoto: '',
    role: 'superadmin',
    dept: 'System',
    position: 'Developer Access',
    salary: 0,
    idCard: '',
    phone: '',
    email: '',
    address: '',
    startDate: '',
    bankName: '',
    bankAccount: '',
    emergencyContact: '',
    emergencyPhone: '',
    annualLeave: 0,
    sickLeave: 0,
    businessLeave: 0,
    transport: 0,
    positionAllowance: 0,
    housing: 0,
    allowance3: 0,
    pvdRate: 0,
    active: true,
    isSystemAccount: true,
    isObserver: false,
    personalCarEligible: false,
    phoneAllowanceEligible: false,
    tokenVersion: 0,
    mustChangePassword: false,
  };
}

function ensureSystemAccounts(users, bcrypt, rounds) {
  if (!Array.isArray(users)) return { users, changed: false };

  let changed = false;
  const withoutDupes = [];
  let kept = null;

  for (const u of users) {
    if (!isSystemAccountUser(u)) {
      withoutDupes.push(u);
      continue;
    }
    if (!kept) kept = u;
  }

  if (!kept) {
    const envPass = process.env.SUPERADMIN_PASSWORD;
    if (!envPass) {
      console.warn('[SYSTEM] superadmin missing — set SUPERADMIN_PASSWORD and restart backend to create it');
      return { users: withoutDupes, changed: false };
    }
    kept = buildSystemAccountRecord(bcrypt.hashSync(String(envPass), rounds));
    console.log('[SYSTEM] Created superadmin system account (password from SUPERADMIN_PASSWORD env)');
    changed = true;
  }

  const canonical = buildSystemAccountRecord(kept.password);
  canonical.password = kept.password;
  canonical.tokenVersion = Number.isFinite(kept.tokenVersion) ? kept.tokenVersion : 0;
  if (kept.mustChangePassword === true) canonical.mustChangePassword = true;

  const merged = { ...kept, ...canonical };
  withoutDupes.push(merged);

  if (!changed) {
    for (const k of PROTECTED_KEYS) {
      if (kept[k] !== merged[k]) { changed = true; break; }
    }
  }

  return { users: withoutDupes, changed };
}

function filterEmployeeRecords(users, viewerId) {
  return users.filter(u => {
    if (!isSystemAccountUser(u)) return true;
    return viewerId != null && u.id === viewerId;
  });
}

function employeeRecords(users) {
  return (users || []).filter(u => !isSystemAccountUser(u));
}

function employeeActiveRecords(users) {
  return employeeRecords(users).filter(u => u.active !== false);
}

function assertNotCreatingSystemAccount(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.isSystemAccount === true || body.role === 'superadmin') {
    return 'Cannot create system accounts through the API';
  }
  if (String(body.username || '').toLowerCase() === SYSTEM_USERNAME) {
    return 'Username is reserved for the system account';
  }
  return null;
}

function assertCanMutateSystemAccount(target, actor, action) {
  if (!isSystemAccountUser(target)) return null;
  if (action === 'self-password' && actor && target.id === actor.id) return null;
  return 'System account is protected and cannot be modified this way';
}

function stripSystemAccountFields(updates) {
  if (!updates || typeof updates !== 'object') return updates;
  const out = { ...updates };
  for (const k of PROTECTED_KEYS) delete out[k];
  if ('isSystemAccount' in out) delete out.isSystemAccount;
  if ('role' in out) delete out.role;
  if ('username' in out) delete out.username;
  if ('active' in out) delete out.active;
  if ('isObserver' in out) delete out.isObserver;
  return out;
}

module.exports = {
  SYSTEM_USERNAME,
  SYSTEM_USER_ID,
  isSystemAccountUser,
  isSuperAdminUser,
  buildSystemAccountRecord,
  ensureSystemAccounts,
  filterEmployeeRecords,
  employeeRecords,
  employeeActiveRecords,
  assertNotCreatingSystemAccount,
  assertCanMutateSystemAccount,
  stripSystemAccountFields,
};
