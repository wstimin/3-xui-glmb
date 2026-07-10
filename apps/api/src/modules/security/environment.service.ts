import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

@Injectable()
export class EnvironmentService implements OnModuleInit {
  private readonly logger = new Logger(EnvironmentService.name);

  onModuleInit() {
    const required = ['DATABASE_URL', 'SESSION_SECRET', 'ENCRYPTION_KEY'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

    this.assertSecret('SESSION_SECRET', 32);
    this.assertEncryptionKey();

    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn('API is running outside production mode; secure cookies are disabled for local development.');
    }
  }

  status() {
    return {
      nodeEnv: process.env.NODE_ENV || 'development',
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      sessionSecretConfigured: Boolean(process.env.SESSION_SECRET || process.env.JWT_SECRET),
      encryptionConfigured: Boolean(process.env.ENCRYPTION_KEY),
      publicWebUrl: process.env.PUBLIC_WEB_URL || null,
      adminPath: process.env.ADMIN_PATH || '/admin'
    };
  }

  private assertSecret(name: string, minLength: number) {
    const value = process.env[name] || '';
    if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
    if (/replace-with|change-me|dev-only/i.test(value)) throw new Error(`${name} still uses a placeholder value`);
  }

  private assertEncryptionKey() {
    const raw = process.env.ENCRYPTION_KEY || '';
    if (/replace-with|change-me|dev-only/i.test(raw)) throw new Error('ENCRYPTION_KEY still uses a placeholder value');
    const candidates = [Buffer.from(raw, 'base64'), Buffer.from(raw, 'hex'), Buffer.from(raw, 'utf8')];
    if (!candidates.some((value) => value.length >= 32)) throw new Error('ENCRYPTION_KEY must contain at least 32 bytes');
  }
}
