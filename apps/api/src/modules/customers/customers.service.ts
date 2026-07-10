import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { balanceAdjustSchema, customerUpsertSchema } from '@shiye/shared';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly xui: XuiService) {}

  async list() {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: customerSelect
      }),
      this.prisma.customer.count()
    ]);
    return { items, page: 1, pageSize: 20, total };
  }

  async create(input: z.infer<typeof customerUpsertSchema>) {
    const password = input.loginPassword || randomPassword();
    const loginPasswordHash = await bcrypt.hash(password, 12);
    return this.prisma.customer.create({
      data: {
        name: input.name,
        loginUsername: input.loginUsername,
        loginPasswordHash,
        email: input.email || null,
        phone: input.phone || null,
        balance: new Prisma.Decimal(input.balance || 0),
        status: input.status,
        remark: input.remark || null
      },
      select: customerSelect
    });
  }

  async update(id: string, input: Partial<z.infer<typeof customerUpsertSchema>>) {
    await this.ensureExists(id);
    const loginPasswordHash = input.loginPassword ? await bcrypt.hash(input.loginPassword, 12) : undefined;
    return this.prisma.customer.update({
      where: { id },
      data: {
        name: input.name,
        loginUsername: input.loginUsername,
        loginPasswordHash,
        email: input.email === undefined ? undefined : input.email || null,
        phone: input.phone === undefined ? undefined : input.phone || null,
        balance: input.balance === undefined ? undefined : new Prisma.Decimal(input.balance),
        status: input.status,
        remark: input.remark === undefined ? undefined : input.remark || null
      },
      select: customerSelect
    });
  }

  async remove(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true, nodes: { select: { id: true } } }
    });
    if (!customer) throw new NotFoundException('用户不存在');

    for (const node of customer.nodes) {
      await this.xui.deleteCustomerNode(id, node.id);
    }

    await this.prisma.customer.delete({ where: { id } });
    return { deleted: true, id };
  }

  async adjustBalance(id: string, input: z.infer<typeof balanceAdjustSchema>, operator = 'admin') {
    return this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id } });
      if (!customer) throw new NotFoundException('用户不存在');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const amount = new Prisma.Decimal(input.amount);
      const afterBalance = input.mode === 'set'
        ? amount
        : input.mode === 'subtract'
          ? beforeBalance.minus(amount)
          : beforeBalance.plus(amount);

      if (afterBalance.lessThan(0)) throw new BadRequestException('余额不能小于 0');

      const updated = await tx.customer.update({ where: { id }, data: { balance: afterBalance }, select: customerSelect });
      await tx.balanceLog.create({
        data: {
          customerId: id,
          type: input.mode === 'set' ? 'admin_set' : input.mode === 'subtract' ? 'admin_subtract' : 'admin_add',
          amount: input.mode === 'subtract' ? amount.negated() : amount,
          beforeBalance,
          afterBalance,
          operator,
          remark: input.remark || null,
          detail: { mode: input.mode }
        }
      });

      return updated;
    });
  }

  async userDashboard(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: customerSelect
    });
    if (!customer) throw new NotFoundException('用户不存在');

    const [nodes, balanceLogs, renewalLogs] = await this.prisma.$transaction([
      this.prisma.customerNode.findMany({ where: { customerId }, include: { serviceNode: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.balanceLog.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.renewalLog.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 50 })
    ]);

    return { customer, nodes, balanceLogs, renewalLogs };
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('用户不存在');
  }
}

const customerSelect = {
  id: true,
  name: true,
  loginUsername: true,
  email: true,
  phone: true,
  balance: true,
  status: true,
  remark: true,
  nodes: {
    select: {
      id: true,
      xuiEmail: true,
      expireAt: true,
      status: true,
      lastSyncedAt: true,
      serviceNode: { select: { id: true, name: true, server: { select: { id: true, name: true } } } }
    },
    orderBy: { createdAt: 'desc' }
  },
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CustomerSelect;

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
