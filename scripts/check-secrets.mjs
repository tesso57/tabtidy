import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const stagedOnly = process.argv.includes('--staged');

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.zip',
]);

const FORBIDDEN_PATH_PATTERNS = [
  { name: 'env file', re: /(^|\/)\.env(\.[^/]+)?$/i, allow: /(^|\/)\.env\.(example|sample)$/i },
  { name: 'private key / cert / extension key', re: /\.(pem|key|p12|pfx|jks|keystore|crx)$/i },
  { name: 'credential or secret file', re: /(^|\/)(credentials|secrets?|id_rsa|id_ed25519)(\.[^/]+)?$/i },
  { name: 'local override file', re: /\.local$/i },
];

const SECRET_CONTENT_PATTERNS = [
  { name: 'Private key block', re: new RegExp(`-----${'BEGIN'} [A-Z ]*${'PRIVATE KEY'}-----`) },
  { name: 'AWS Access Key ID', re: new RegExp(`\\b${'AK' + 'IA'}[0-9A-Z]{16}\\b`) },
  {
    name: 'GitHub token',
    re: new RegExp(`\\b(${'gh' + 'p_'}[A-Za-z0-9]{20,}|${'github_' + 'pat_'}[A-Za-z0-9_]{20,}|${'gh' + 'o_'}[A-Za-z0-9]{20,}|${'gh' + 's_'}[A-Za-z0-9]{20,})\\b`),
  },
  { name: 'Google API key', re: new RegExp(`\\b${'AI' + 'za'}[0-9A-Za-z_-]{35}\\b`) },
  { name: 'Secret API key (sk-...)', re: new RegExp(`\\b${'s' + 'k-'}(proj-|ant-)?[A-Za-z0-9_-]{20,}\\b`) },
  { name: 'Slack token', re: new RegExp(`\\b${'xo' + 'x'}[baprs]-[0-9A-Za-z-]{10,}\\b`) },
  { name: 'macOS local user path', re: new RegExp(`${'/User' + 's/'}` + '[A-Za-z0-9._-]+') },
];

function getTargetFiles() {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const raw = execFileSync('git', args, { encoding: 'utf8' });
  return raw.split('\0').filter(Boolean);
}

const files = getTargetFiles();
const findings = [];

for (const file of files) {
  for (const rule of FORBIDDEN_PATH_PATTERNS) {
    if (rule.re.test(file) && !(rule.allow && rule.allow.test(file))) {
      findings.push(`${file}: forbidden filename (${rule.name})`);
    }
  }

  if (BINARY_EXTENSIONS.has(extname(file).toLowerCase())) continue;

  let text = '';
  try {
    if (!statSync(file).isFile()) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const rule of SECRET_CONTENT_PATTERNS) {
      if (rule.re.test(line)) {
        findings.push(`${file}:${idx + 1}: potential ${rule.name}`);
      }
    }
  });
}

if (findings.length > 0) {
  console.error('Secret / sensitive-file check failed:');
  for (const item of findings) {
    console.error(`  - ${item}`);
  }
  process.exit(1);
}

console.log(`Secret check OK (${files.length} files scanned).`);
