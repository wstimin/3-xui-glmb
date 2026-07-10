import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService, private readonly xui: XuiService) {}

  rechargeOrders() {
    return this.prisma.rechargeOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { customer: { select: { id: true, name: true, loginUsername: true } } } });
  }

  balanceLogs() {
    return this.prisma.balanceLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { customer: { select: { id: true, name: true, loginUsername: true } } } });
  }

  async renewCustomerNode(customerId: string, customerNodeId: string, months: number, operator: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: true, customer: true }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
    if (customerNode.status !== 'active') throw new BadRequestException('节点已停用，不能续费');

    const priceMonthly = new Prisma.Decimal(customerNode.serviceNode.priceMonthly);
    const amount = priceMonthly.mul(months);
    const initialBalance = new Prisma.Decimal(customerNode.customer.balance);
    if (initialBalance.lessThan(amount)) throw new BadRequestException('余额不足');

    const now = new Date();
    const beforeExpireAt = customerNode.expireAt;
    const baseDate = beforeExpireAt && beforeExpireAt > now ? beforeExpireAt : now;
    const afterExpireAt = addMonths(baseDate, months);

    const syncResult = await this.xui.syncCustomerNode(customerId, customerNodeId, { expireAt: afterExpireAt, status: 'active' });

    return this.prisma.$transaction(async (tx) => {
      const freshCustomer = await tx.customer.findUnique({ where: { id: customerId }, select: { balance: true } });
      if (!freshCustomer) throw new NotFoundException('用户不存在');

      const beforeBalance = new Prisma.Decimal(freshCustomer.balance);
      if (beforeBalance.lessThan(amount)) throw new BadRequestException('余额不足');
      const afterBalance = beforeBalance.minus(amount);

      await tx.customer.update({ where: { id: customerId }, data: { balance: afterBalance } });
      const updatedNode = await tx.customerNode.update({
        where: { id: customerNodeId },
        data: { expireAt: afterExpireAt, status: 'active', lastSyncedAt: new Date() },
        include: { serviceNode: { include: { server: true } } }
      });

      await tx.balanceLog.create({
        data: {
          customerId,
          type: 'renewal',
          amount: amount.negated(),
          beforeBalance,
          afterBalance,
          operator,
          remark: `续费 ${customerNode.serviceNode.name} ${months} 个月`,
          detail: toJsonValue({ customerNodeId, serviceNodeId: customerNode.serviceNodeId, months, sync: syncResult.detail })
        }
      });

      const renewalLog = await tx.renewalLog.create({
        data: {
          customerId,
          customerNodeId,
          months,
          amount,
          status: 'success',
          beforeExpireAt,
          afterExpireAt,
          detail: { operator, serviceNodeName: customerNode.serviceNode.name, syncRoute: syncResult.route }
        }
      });

      return { node: updatedNode, renewalLog, amount, afterBalance, sync: syncResult.detail };
    });
  }
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() < day) next.setDate(0);
  return next;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
