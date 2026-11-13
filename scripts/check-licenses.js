#!/usr/bin/env node
/**
 * Dependency license check (fork addition, CLAUDE.md rule 8).
 *
 *   npm run license:check
 *
 * Reads package-lock.json (no network, no installed node_modules needed) and
 * fails when a package's SPDX expression is not satisfied by license-policy.json.
 * OR-expressions pass if any option is allowed; AND-expressions need every part.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/** @param {object} policy @param {string} name */
function exceptionFor(policy, name) {
  for (const [pattern, entry] of Object.entries(policy.exceptions || {})) {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    if (regex.test(name)) return { pattern, ...entry };
  }
  return null;
}

/** @param {unknown} entry lockfile package entry */
function licenseOf(entry) {
  if (typeof entry.license === 'string') return entry.license;
  if (Array.isArray(entry.licenses)) return entry.licenses.map(item => item.type || item).join(' OR ');
  return 'UNKNOWN';
}

/**
 * Minimal SPDX evaluation: parentheses, AND, OR, and "-or-later"/"+" suffixes.
 * @param {string} expression
 * @returns {boolean}
 */
function satisfies(expression, allowed) {
  const text = expression.trim().replace(/^\((.*)\)$/, '$1');
  if (/\sOR\s/i.test(text)) return text.split(/\s+OR\s+/i).some(part => satisfies(part, allowed));
  if (/\sAND\s/i.test(text)) return text.split(/\s+AND\s+/i).every(part => satisfies(part, allowed));
  return allowed.has(text.replace(/[()]/g, '').trim());
}

/**
 * @param {object} policy parsed license-policy.json
 * @param {object} lock parsed package-lock.json
 * @returns {{ checked: number, problems: string[], exceptionsUsed: string[], unused: string[] }}
 */
function evaluate(policy, lock) {
  const allowed = new Set(policy.allowed);

  const problems = [];
  const exceptionsUsed = new Set();
  let checked = 0;
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key) continue; // the root project
    const name = key.replace(/^.*node_modules\//, '');
    const license = licenseOf(entry);
    checked++;
    if (satisfies(license, allowed)) continue;
    const exception = exceptionFor(policy, name);
    if (exception) {
      exceptionsUsed.add(exception.pattern);
      continue;
    }
    const flaggedTerm = policy.flagged.find(term => license.toUpperCase().includes(term.toUpperCase()));
    problems.push(`${name}@${entry.version} ${license}${flaggedTerm ? ` (flagged: ${flaggedTerm})` : ''}${entry.dev ? ' [dev]' : ''}`);
  }
  const unused = Object.keys(policy.exceptions || {}).filter(pattern => !exceptionsUsed.has(pattern));
  return { checked, problems, exceptionsUsed: [...exceptionsUsed], unused };
}

if (require.main === module) {
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'license-policy.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const result = evaluate(policy, lock);
  console.log(`Checked ${result.checked} packages against license-policy.json (lastVerified ${policy.lastVerified}).`);
  if (result.exceptionsUsed.length) console.log(`Exceptions applied: ${result.exceptionsUsed.join(', ')}`);
  if (result.unused.length) console.log(`Unused exceptions (remove them): ${result.unused.join(', ')}`);
  if (result.problems.length) {
    console.error(`\n${result.problems.length} package(s) need review:\n  ${result.problems.join('\n  ')}`);
    console.error('\nAdd an exception with a reason to license-policy.json only after checking the terms.');
    process.exit(1);
  }
  console.log('All dependency licenses are allowed.');
}

module.exports = { evaluate, satisfies, licenseOf };
