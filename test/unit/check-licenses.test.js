const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, satisfies, licenseOf } = require('../../scripts/check-licenses');

const allowed = new Set(['MIT', 'Apache-2.0', 'BSD-3-Clause']);

test('SPDX expressions', () => {
  assert.equal(satisfies('MIT', allowed), true);
  assert.equal(satisfies('(MIT OR WTFPL)', allowed), true);
  assert.equal(satisfies('Apache-2.0 AND MIT', allowed), true);
  assert.equal(satisfies('Apache-2.0 AND LGPL-3.0-or-later', allowed), false);
  assert.equal(satisfies('GPL-3.0-or-later', allowed), false);
  assert.equal(satisfies('UNKNOWN', allowed), false);
});

test('licenseOf handles the legacy licenses array', () => {
  assert.equal(licenseOf({ license: 'MIT' }), 'MIT');
  assert.equal(licenseOf({ licenses: [{ type: 'BSD' }] }), 'BSD');
  assert.equal(licenseOf({}), 'UNKNOWN');
});

test('flags copyleft and unknown packages; exceptions apply by pattern', () => {
  const policy = {
    allowed: ['MIT'],
    flagged: ['GPL', 'AGPL'],
    exceptions: { '@img/sharp-*': { license: 'LGPL', reason: 'test' }, 'never-used': { reason: 'test' } }
  };
  const lock = {
    packages: {
      '': { name: 'root' },
      'node_modules/ok': { version: '1.0.0', license: 'MIT' },
      'node_modules/bad': { version: '2.0.0', license: 'AGPL-3.0-only' },
      'node_modules/mystery': { version: '0.1.0' },
      'node_modules/@img/sharp-libvips-linux-x64': { version: '1.0.0', license: 'LGPL-3.0-or-later' }
    }
  };
  const result = evaluate(policy, lock);
  assert.equal(result.checked, 4);
  assert.equal(result.problems.length, 2);
  assert.match(result.problems.find(item => item.startsWith('bad@')), /flagged: GPL/);
  assert.ok(result.problems.some(item => item.startsWith('mystery@')));
  assert.deepEqual(result.exceptionsUsed, ['@img/sharp-*']);
  assert.deepEqual(result.unused, ['never-used']);
});
