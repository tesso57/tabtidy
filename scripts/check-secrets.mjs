import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const stagedOnly = process.argv.includes('--staged');
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.zip',
]);

const FORBIDDEN_PATH_PATTERNS = [
  { name: 'env file', re: /(^|\/)\.env(\.[^/]+)?$/i, allow: /(^|\/)\.env\.(example|sample)$/i },
  { name: 'private key / cert / extension key', re: /\.(pem|key|p12|pfx|jks|keystore|crx)$/i },
  {
    name: 'credential or secret file',
    re: /(^|\/)([^/]*credentials[^/]*|\.?secrets?|id_(rsa|ed25519|ecdsa)[^/]*)(\.[^/]+)?$/i,
  },
  { name: 'secret-suffixed file', re: /\.secret(\.[^/]+)?$/i },
  { name: 'secrets directory', re: /(^|\/)\.?secrets\//i },
  { name: 'npm auth config', re: /(^|\/)\.npmrc$/i },
  { name: 'local override file', re: /\.local$/i },
];

const SECRET_CONTENT_PATTERNS = [
  { name: 'Private key block', re: new RegExp(`-----${'BEGIN'} [A-Z ]*${'PRIVATE KEY'}-----`) },
  {
    name: 'AWS Access Key ID',
    re: new RegExp(`\\b(${'AK' + 'IA'}|${'AS' + 'IA'})[0-9A-Z]{16}\\b`),
  },
  {
    name: 'GitHub token',
    re: new RegExp(
      `\\b(${'gh' + 'p_'}[A-Za-z0-9]{20,}|${'github_' + 'pat_'}[A-Za-z0-9_]{20,}|${'gh' + 'o_'}[A-Za-z0-9]{20,}|${'gh' + 's_'}[A-Za-z0-9]{20,}|${'gh' + 'u_'}[A-Za-z0-9]{20,}|${'gh' + 'r_'}[A-Za-z0-9]{20,})\\b`
    ),
  },
  { name: 'npm access token', re: new RegExp(`\\b${'np' + 'm_'}[A-Za-z0-9]{20,}\\b`) },
  { name: 'Google API key', re: new RegExp(`\\b${'AI' + 'za'}[0-9A-Za-z_-]{35}\\b`) },
  { name: 'Secret API key (sk-...)', re: new RegExp(`\\b${'s' + 'k-'}(proj-|ant-)?[A-Za-z0-9_-]{20,}\\b`) },
  { name: 'Slack token', re: new RegExp(`\\b${'xo' + 'x'}[baprs]-[0-9A-Za-z-]{10,}\\b`) },
  {
    name: 'Chrome extension manifest key',
    fileRe: /(^|\/)manifest(\.[^/]+)?\.json$/i,
    re: new RegExp(`"${'ke' + 'y'}"\\s*:\\s*"[A-Za-z0-9+/=_-]{16,}"`),
  },
  { name: 'macOS local user path', re: new RegExp(`${'/User' + 's/'}` + '[A-Za-z0-9._-]+') },
];

function getTargetFiles() {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  const raw = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return raw.split('\0').filter(Boolean);
}

function readTargetText(file) {
  try {
    let buf;
    if (stagedOnly) {
      // Read the staged index blob so unstaged working-tree edits cannot mask staged secrets.
      buf = execFileSync('git', ['show', `:${file}`], {
        cwd: repoRoot,
        maxBuffer: 20 * 1024 * 1024,
      });
    } else {
      const absPath = resolve(repoRoot, file);
      if (!lstatSync(absPath).isFile()) return null;
      buf = readFileSync(absPath);
    }
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
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

  const text = readTargetText(file);
  if (text === null) continue;

  const applicableRules = SECRET_CONTENT_PATTERNS.filter(
    (rule) => !rule.fileRe || rule.fileRe.test(file)
  );
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const rule of applicableRules) {
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
