import { z } from 'zod';

export const idSchema = z.string().min(1).max(64);

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(20),
  keyword: z.string().trim().max(100).optional()
});

export const moneySchema = z.coerce.number().finite().min(0).multipleOf(0.01);
