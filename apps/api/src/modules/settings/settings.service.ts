import { Injectable } from '@nestjs/common';
import { settingsUpdateSchema } from '@shiye/shared';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';

type BrandSettings = {
  brandName: string;
  logoDataUrl: string;
};

type BusinessSettings = {
  cardPurchaseUrl: string;
};

type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async publicBranding(): Promise<BrandSettings> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'brand' } });
    const value = row?.value && typeof row.value === 'object' ? row.value as Partial<BrandSettings> : {};
    return {
      brandName: value.brandName || process.env.APP_NAME || '十夜管理系统',
      logoDataUrl: value.logoDataUrl || ''
    };
  }

  async publicBusiness(): Promise<BusinessSettings> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'business' } });
    const value = row?.value && typeof row.value === 'object' ? row.value as Partial<BusinessSettings> : {};
    return { cardPurchaseUrl: value.cardPurchaseUrl || '' };
  }

  async publicSettings() {
    const [brand, business] = await Promise.all([this.publicBranding(), this.publicBusiness()]);
    return { ...brand, ...business };
  }

  async adminSettings() {
    const [brand, business] = await Promise.all([this.publicBranding(), this.publicBusiness()]);
    return { brand, business };
  }

  async updateSettings(input: SettingsUpdateInput) {
    if (input.brand) {
      await this.prisma.systemSetting.upsert({
        where: { key: 'brand' },
        create: { key: 'brand', value: toJsonValue(input.brand) },
        update: { value: toJsonValue(input.brand) }
      });
    }

    if (input.business) {
      await this.prisma.systemSetting.upsert({
        where: { key: 'business' },
        create: { key: 'business', value: toJsonValue(input.business) },
        update: { value: toJsonValue(input.business) }
      });
    }

    return this.adminSettings();
  }
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
