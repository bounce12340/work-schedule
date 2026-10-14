import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mobile = fileURLToPath(new URL('../', import.meta.url));
const www = fileURLToPath(new URL('../www/', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const required = ['index.html', 'privacy.html', 'terms.html', 'build.json'];
const problems = [];

for (const file of required) {
  if (!existsSync(www + file)) problems.push(`mobile/www/ 缺少 ${file}`);
}

if (!problems.length) {
  const build = JSON.parse(readFileSync(www + 'build.json', 'utf8'));
  if (build.version !== pkg.version) {
    problems.push(`build.json 版本 ${build.version} 與 package.json 版本 ${pkg.version} 不一致`);
  }

  const index = readFileSync(www + 'index.html', 'utf8');
  for (const file of ['privacy.html', 'terms.html']) {
    if (!index.includes(`href="/${file}"`)) {
      problems.push(`index.html 沒有指向 /${file} 的法律頁連結`);
    }
    if (!readFileSync(www + file, 'utf8').includes('<html')) {
      problems.push(`${file} 不是有效的 HTML`);
    }
  }
}

if (problems.length) {
  console.error('✗ iOS app web bundle 檢查失敗：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`✓ iOS app web bundle 完整（${required.join('、')}；${mobile}）`);
