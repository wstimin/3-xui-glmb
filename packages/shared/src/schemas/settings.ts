import { z } from 'zod';

export const brandSettingsSchema = z.object({
  brandName: z.string().trim().min(1).max(80),
  logoDataUrl: z.string().trim().max(500_000).optional().default('')
});

export const businessSettingsSchema = z.object({
  cardPurchaseUrl: z.string().trim().url().optional().or(z.literal(''))
});

export const settingsUpdateSchema = z.object({
  brand: brandSettingsSchema.optional(),
  business: businessSettingsSchema.optional()
});
