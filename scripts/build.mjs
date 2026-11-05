// Tiny bundler: concatenates src modules into the DSH client ModuleLoader format.
// Shared modules (react) come from the shell's module table via `require`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const order = ['model.js', 'styles.js', 'ui.js', 'plugin.js'];

function strip(source, file) {
  return source
    // drop local imports (everything is concatenated into one scope)
    .replace(/^import\s+[^;]*?from\s+'\.\/[^']+';\s*$/gm, '')
    // react import -> shared module
    .replace(/^import\s+React\s+from\s+'react';\s*$/m, "const React = require('react');")
    .replace(/^export\s+(?=(async\s+)?function|const|let|class)/gm, '')
    .replace(/^(?=.)/, `//#region src/${file}\n`) + `\n//#endregion\n`;
}

const body = order.map((f) => strip(readFileSync(join(root, 'src', f), 'utf8'), f)).join('\n');
if (/^\s*(import|export)\s/m.test(body)) throw new Error('unbundled import/export left in output');
const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`;
writeFileSync(join(root, 'lib', 'client.js'), out);
console.log(`lib/client.js written (${out.length} bytes)`);
