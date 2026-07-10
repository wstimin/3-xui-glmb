import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const PREFIX = 'enc:v1:';

@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key = loadEncryptionKey();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.encryptLegacyXuiSecrets();
  }

  encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  decrypt(value: string) {
    if (!value.startsWith(PREFIX)) return value;
    const [ivText, tagText, ciphertextText] = value.slice(PREFIX.length).split(':');
    if (!ivText || !tagText || !ciphertextText) throw new Error('Invalid encrypted payload');

    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()]).toString('utf8');
  }

  encryptNullable(value: string | null | undefined) {
    const normalized = value?.trim();
    return normalized ? this.encrypt(normalized) : null;
  }

  decryptNullable(value: string | null | undefined) {
    return value ? this.decrypt(value) : null;
  }

  private async encryptLegacyXuiSecrets() {
    const servers = await this.prisma.xuiServer.findMany({ select: { id: true, passwordEnc: true, tokenEnc: true } }).catch(() => []);
    let updated = 0;
    for (const server of servers) {
      const passwordEnc = server.passwordEnc && !server.passwordEnc.startsWith(PREFIX) ? this.encrypt(server.passwordEnc) : undefined;
      const tokenEnc = server.tokenEnc && !server.tokenEnc.startsWith(PREFIX) ? this.encrypt(server.tokenEnc) : undefined;
      if (passwordEnc === undefined && tokenEnc === undefined) continue;
      await this.prisma.xuiServer.update({ where: { id: server.id }, data: { passwordEnc, tokenEnc } });
      updated += 1;
    }
    if (updated) this.logger.log(`Encrypted ${updated} legacy 3x-ui server secret record(s).`);
  }
}

function loadEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || 'dev-only-change-me-dev-only-32b';
  const base64 = Buffer.from(raw, 'base64');
  if (base64.length === 32) return base64;

  const hex = Buffer.from(raw, 'hex');
  if (hex.length === 32) return hex;

  const utf8 = Buffer.from(raw, 'utf8');
  if (utf8.length >= 32) return utf8.subarray(0, 32);

  throw new Error('ENCRYPTION_KEY must be a 32-byte base64/hex value or at least 32 UTF-8 bytes');
}
