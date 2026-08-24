// Parse-check the one <script> block in index.html. The file is a single
// 24k-line classic script, so a stray backtick inside a GLSL template literal
// takes the whole game out with one SyntaxError and no stack worth reading.
import { readFileSync } from 'node:fs';
const s = readFileSync(process.argv[2] || 'index.html', 'utf8');
const i = s.indexOf('<script>'), j = s.lastIndexOf('</script>');
if (i < 0 || j < 0) { console.log('no <script> block'); process.exit(1); }
try { new Function(s.slice(i + 8, j)); console.log('parses OK'); }
catch (e) { console.log('SYNTAX ERROR:', e.message); process.exit(1); }
