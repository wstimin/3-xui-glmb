import { existsSync, readFileSync } from 'node:fs';

const errors = [];

const adminIndex = readRequiredFile('dist/admin-web/index.html');
const userIndex = readRequiredFile('dist/user-web/index.html');
const nginxConfig = readRequiredFile('infra/nginx/shiye.conf');

if (adminIndex) {
  requireMatch(adminIndex, /src="\/admin\/assets\//, 'Admin build must load JS from /admin/assets/.');
  requireMatch(adminIndex, /href="\/admin\/assets\//, 'Admin build must load CSS from /admin/assets/.');
  forbidMatch(adminIndex, /(?:src|href)="\/assets\//, 'Admin build must not reference root /assets/.');
}

if (userIndex) {
  requireMatch(userIndex, /src="\/assets\//, 'User build must load JS from /assets/.');
  requireMatch(userIndex, /href="\/assets\//, 'User build must load CSS from /assets/.');
}

if (nginxConfig) {
  requireMatch(nginxConfig, /location\s+\/api\//, 'Nginx must proxy /api/.');
  requireMatch(nginxConfig, /proxy_pass\s+http:\/\/127\.0\.0\.1:3388\/api\//, 'Nginx /api/ proxy target must preserve the API prefix.');
  requireMatch(nginxConfig, /location\s+=\s+\/admin\s*{[\s\S]*return\s+301\s+\/admin\//, 'Nginx must redirect /admin to /admin/.');
  requireMatch(nginxConfig, /location\s+\/admin\/assets\//, 'Nginx must serve admin assets under /admin/assets/.');
  requireMatch(nginxConfig, /location\s+\/admin\/\s*{[\s\S]*try_files[\s\S]*\/admin\/index\.html/, 'Nginx must fallback admin routes to /admin/index.html.');
  requireMatch(nginxConfig, /location\s+\/\s*{[\s\S]*try_files[\s\S]*\/index\.html/, 'Nginx must fallback user routes to /index.html.');
}

if (errors.length) {
  console.error('\nDeploy check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Deploy check passed.');

function readRequiredFile(path) {
  if (!existsSync(path)) {
    errors.push(`${path} does not exist. Run npm run build first.`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function requireMatch(content, pattern, message) {
  if (!pattern.test(content)) errors.push(message);
}

function forbidMatch(content, pattern, message) {
  if (pattern.test(content)) errors.push(message);
}
