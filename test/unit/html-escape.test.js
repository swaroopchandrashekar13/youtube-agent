const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml, safeCssColor, safeDataImageUrl } = require('../../utils/html-escape');

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("Tom & Jerry's `code`"), 'Tom &amp; Jerry&#39;s &#96;code&#96;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml('a\u0000b\u0007c\nd'), 'abc\nd');
});

test('escapeHtml keeps Kannada text intact', () => {
  const kannada = 'ಕನ್ನಡದಲ್ಲಿ ಸಂದರ್ಶನ ತಯಾರಿ';
  assert.equal(escapeHtml(kannada), kannada);
});

test('safeCssColor allows only plain colors', () => {
  assert.equal(safeCssColor('gold'), 'gold');
  assert.equal(safeCssColor('dark blue'), 'dark blue');
  assert.equal(safeCssColor('#FFCC00'), '#FFCC00');
  assert.equal(safeCssColor('red; } * { display:none'), 'white');
  assert.equal(safeCssColor('url(http://x)', 'black'), 'black');
});

test('safeDataImageUrl allows only base64 image data URLs', () => {
  assert.equal(safeDataImageUrl('data:image/png;base64,iVBORw0K'), 'data:image/png;base64,iVBORw0K');
  assert.equal(safeDataImageUrl('https://evil.example/x.png'), '');
  assert.equal(safeDataImageUrl('data:image/png;base64,abc" onerror="x'), '');
  assert.equal(safeDataImageUrl('file:///etc/passwd'), '');
});
