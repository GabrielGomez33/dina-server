// File: test/auth/authUnit.ts
// ============================================================================
// DINA AUTH — PURE UNIT TESTS (no DB, no network)
// ============================================================================
// Covers the pure decision logic: input policy (normalise + validate) and the
// migration's FK column-type normalisation (the load-bearing VARCHAR-length
// preservation that the first migration attempt got wrong).
// ============================================================================

import {
  normaliseUsername,
  normaliseEmail,
  normalisePassword,
  validateUsername,
  validateEmail,
  validatePassword,
} from '../../src/modules/auth/policy';
import { normalizeColType } from '../../migrations/004_auth_users';

let passed = 0;
let failed = 0;
function t(name: string, cond: boolean): void {
  if (cond) { passed++; } else { failed++; console.error(`  ✗ ${name}`); }
}

// ── normalisation ────────────────────────────────────────────────────────────
t('username strips whitespace', normaliseUsername('  ab c ') === 'abc');
t('email trims + strips interior ws', normaliseEmail('  a b@x.com ') === 'ab@x.com');
t('password NFKC-normalises smart quote', normalisePassword('“pw”').length === 4);
t('password trims edges but keeps interior space', normalisePassword('  a b  ') === 'a b');
t('non-string → empty', normaliseUsername(undefined as unknown) === '' && normalisePassword(null as unknown) === '');

// ── username policy ──────────────────────────────────────────────────────────
t('username too short invalid', validateUsername('ab') !== null);
t('username too long invalid', validateUsername('a'.repeat(21)) !== null);
t('username bad char invalid', validateUsername('bad-name') !== null);
t('username valid', validateUsername('good_Name9') === null);

// ── email policy ─────────────────────────────────────────────────────────────
t('email missing @ invalid', validateEmail('nope') !== null);
t('email valid', validateEmail('a@b.co') === null);

// ── password policy ──────────────────────────────────────────────────────────
t('password too short invalid', validatePassword('Aa1!') !== null);
t('password no upper invalid', validatePassword('aa1!aaaa') !== null);
t('password no lower invalid', validatePassword('AA1!AAAA') !== null);
t('password no digit invalid', validatePassword('Aa!aaaaa') !== null);
t('password no symbol invalid', validatePassword('Aa1aaaaa') !== null);
t('password valid (hyphen symbol)', validatePassword('Str0ng-Pass') === null);
t('password valid (dot symbol)', validatePassword('Str0ng.Pass') === null);
t('password over 128 invalid', validatePassword('Aa1!' + 'a'.repeat(130)) !== null);

// ── migration FK type normalisation (the critical fix) ──────────────────────
t('varchar(36) preserved verbatim', normalizeColType('varchar(36)') === 'varchar(36)');
t('char(36) preserved verbatim', normalizeColType('char(36)') === 'char(36)');
t('int(11) → int', normalizeColType('int(11)') === 'int');
t('bigint(20) unsigned → bigint unsigned', normalizeColType('bigint(20) unsigned') === 'bigint unsigned');
t('int unsigned preserved', normalizeColType('int unsigned') === 'int unsigned');
t('empty → varchar(36) fallback', normalizeColType('') === 'varchar(36)');
t('decimal(10,2) preserved (not an int)', normalizeColType('decimal(10,2)') === 'decimal(10,2)');

console.log(`\n${failed === 0 ? '✅' : '❌'} auth unit: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
