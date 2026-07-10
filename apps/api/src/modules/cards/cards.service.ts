import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { cardGenerateSchema, cardRedeemSchema } from '@shiye/shared';
import type { z } from 'zod';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.card.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          batch: { select: { id: true, name: true } },
          usedBy: { select: { id: true, name: true, loginUsername: true } }
        }
      }),
      this.prisma.card.count()
    ]);

    return { items, page: 1, pageSize: 100, total };
  }

  async generate(input: z.infer<typeof cardGenerateSchema>) {
    const amount = new Prisma.Decimal(input.amount);
    const codes = Array.from({ length: input.quantity }, () => generateCardCode(input.prefix));
    const batch = await this.prisma.cardBatch.create({
      data: {
        name: input.name,
        amount,
        quantity: input.quantity,
        cards: {
          createMany: {
            data: codes.map((code) => ({
              codeHash: hashCardCode(code),
              codePreview: previewCode(code),
              amount
            }))
          }
        }
      },
      include: { cards: true }
    });

    return {
      batchId: batch.id,
      generated: codes.length,
      codes
    };
  }

  async redeem(customerId: string, input: z.infer<typeof cardRedeemSchema>) {
    const codeHash = hashCardCode(input.code);

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.card.findUnique({ where: { codeHash } });
      if (!card) throw new NotFoundException('卡密不存在');
      if (card.status !== 'unused') throw new BadRequestException('卡密已使用或已禁用');

      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer || customer.status !== 'active') throw new NotFoundException('用户不存在或已禁用');

      const claimed = await tx.card.updateMany({
        where: { id: card.id, status: 'unused' },
        data: { status: 'used', usedById: customerId, usedAt: new Date() }
      });
      if (claimed.count !== 1) throw new BadRequestException('卡密已被兑换');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const amount = new Prisma.Decimal(card.amount);
      const afterBalance = beforeBalance.plus(amount);

      const updatedCustomer = await tx.customer.update({
        where: { id: customerId },
        data: { balance: afterBalance },
        select: {
          id: true,
          name: true,
          loginUsername: true,
          balance: true,
          status: true
        }
      });

      await tx.balanceLog.create({
        data: {
          customerId,
          type: 'card_redeem',
          amount,
          beforeBalance,
          afterBalance,
          operator: customer.loginUsername,
          remark: `兑换卡密 ${card.codePreview}`,
          detail: { cardId: card.id, codePreview: card.codePreview }
        }
      });

      return { customer: updatedCustomer, amount };
    });
  }
}

function generateCardCode(prefix = '') {
  const head = prefix ? `${prefix.toUpperCase()}-` : '';
  const body = crypto.randomBytes(12).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return `${head}${body.match(/.{1,4}/g)?.join('-') || body}`;
}

function hashCardCode(code: string) {
  const secret = process.env.CARD_HASH_SECRET || process.env.ENCRYPTION_KEY || 'dev-card-secret';
  return crypto.createHmac('sha256', secret).update(normalizeCardCode(code)).digest('hex');
}

function normalizeCardCode(code: string) {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

function previewCode(code: string) {
  const normalized = normalizeCardCode(code);
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}
