import { existsSync, readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

loadEnv();

const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to sync the admin account.');
}

const prisma = new PrismaClient();

try {
  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.adminUser.upsert({
    where: { username },
    create: { username, passwordHash, status: 'active' },
    update: { passwordHash, status: 'active' }
  });

  await prisma.systemSetting.upsert({
    where: { key: 'brand' },
    create: { key: 'brand', value: { brandName: process.env.APP_NAME || '十夜管理系统', logoDataUrl: '' } },
    update: {}
  });

  console.log(`Admin account synced. Username: ${username}. Password was synced from DEFAULT_ADMIN_PASSWORD.`);
} finally {
  await prisma.$disconnect();
}

function loadEnv() {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = unquote(trimmed.slice(index + 1).trim());
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
