import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';

const env = loadEnv();
const errors = [];
const warnings = [];

requireValue('DATABASE_URL');
requireSecret('SESSION_SECRET', 32);
requireSecret('ENCRYPTION_KEY', 32, true);
requireSecret('CARD_HASH_SECRET', 32);

if (!env.PUBLIC_WEB_URL) warnings.push('PUBLIC_WEB_URL is not set; payment callback URLs may need manual configuration.');
if ((env.DEFAULT_ADMIN_PASSWORD || '').toLowerCase() === 'admin123') warnings.push('DEFAULT_ADMIN_PASSWORD is still admin123; change it before public deployment.');

if (!errors.length) await checkDatabase();

if (warnings.length) {
  console.warn('\nWarnings:');
  for (const warning of warnings) console.warn(`- ${warning}`);
}

if (errors.length) {
  console.error('\nInstall check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Install check passed.');

function loadEnv() {
  const values = { ...process.env };
  if (!existsSync('.env')) return values;

  const lines = readFileSync('.env', 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = unquote(trimmed.slice(index + 1).trim());
    if (values[key] === undefined) values[key] = value;
  }
  return values;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function requireValue(name) {
  if (!env[name]) errors.push(`${name} is required.`);
}

function requireSecret(name, minLength, allowBase64 = false) {
  const value = env[name] || '';
  if (!value) {
    errors.push(`${name} is required.`);
    return;
  }
  if (/replace-with|change-me|dev-only/i.test(value)) errors.push(`${name} still uses a placeholder value.`);
  const byteLength = allowBase64 ? Math.max(Buffer.from(value, 'utf8').length, Buffer.from(value, 'base64').length, Buffer.from(value, 'hex').length) : Buffer.from(value, 'utf8').length;
  if (byteLength < minLength) errors.push(`${name} must contain at least ${minLength} bytes.`);
}

async function checkDatabase() {
  let connection;
  try {
    connection = await createConnection(env.DATABASE_URL);
    await connection.query('SELECT 1');
  } catch (error) {
    errors.push(`DATABASE_URL connection failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await connection?.end().catch(() => undefined);
  }
}
