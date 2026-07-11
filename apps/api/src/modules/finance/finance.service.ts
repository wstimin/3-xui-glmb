import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService, private readonly xui: XuiService) {}

  async rechargeOrders() {
    await this.prisma.rechargeOrder.updateMany({ where: { status: 'pending', expiresAt: { lte: new Date() } }, data: { status: 'closed' } });
    return this.prisma.rechargeOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { customer: { select: { id: true, name: true, loginUsername: true } } } });
  }

  balanceLogs() {
    return this.prisma.balanceLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { customer: { select: { id: true, name: true, loginUsername: true } } } });
  }

  async clearRechargeOrderHistory() {
    const result = await this.prisma.rechargeOrder.deleteMany({ where: { status: { not: 'pending' } } });
    return { deleted: result.count };
  }

  async clearBalanceLogHistory() {
    const result = await this.prisma.balanceLog.deleteMany({});
    return { deleted: result.count };
  }

  async renewCustomerNode(customerId: string, customerNodeId: string, months: number, operator: string) {
    const pending = await this.prisma.$transaction(async (tx) => {
      const customerNode = await tx.customerNode.findFirst({
        where: { id: customerNodeId, customerId },
        include: { serviceNode: true, customer: true }
      });
      if (!customerNode) throw new NotFoundException('用户节点不存在');

      const priceMonthly = new Prisma.Decimal(customerNode.serviceNode.priceMonthly);
      const amount = priceMonthly.mul(months);
      const beforeBalance = new Prisma.Decimal(customerNode.customer.balance);
      if (beforeBalance.lessThan(amount)) throw new BadRequestException('余额不足');

      const now = new Date();
      const beforeExpireAt = customerNode.expireAt;
      const baseDate = beforeExpireAt && beforeExpireAt > now ? beforeExpireAt : now;
      const afterExpireAt = addMonths(baseDate, months);
      const afterBalance = beforeBalance.minus(amount);

      await tx.customer.update({ where: { id: customerId }, data: { balance: afterBalance } });
      const renewalLog = await tx.renewalLog.create({
        data: {
          customerId,
          customerNodeId,
          months,
          amount,
          status: 'pending',
          beforeExpireAt,
          afterExpireAt,
          detail: toJsonValue({ operator, serviceNodeName: customerNode.serviceNode.name, serviceNodeId: customerNode.serviceNodeId })
        }
      });
      const balanceLog = await tx.balanceLog.create({
        data: {
          customerId,
          type: 'renewal',
          amount: amount.negated(),
          beforeBalance,
          afterBalance,
          operator,
          remark: `续费 ${customerNode.serviceNode.name} ${months} 个月`,
          detail: toJsonValue({ renewalLogId: renewalLog.id, customerNodeId, serviceNodeId: customerNode.serviceNodeId, months, syncStatus: 'pending' })
        }
      });

      return { customerNode, amount, beforeBalance, afterBalance, beforeExpireAt, afterExpireAt, renewalLog, balanceLog };
    });

    let syncResult: Awaited<ReturnType<XuiService['syncCustomerNode']>>;
    try {
      syncResult = await this.xui.syncCustomerNode(customerId, customerNodeId, {
        expireAt: pending.afterExpireAt,
        status: 'active',
        createIfMissing: false,
        requireExisting: true
      });
    } catch (error) {
      await this.refundFailedRenewal(customerId, pending, operator, error);
      throw error;
    }

    return this.prisma.$transaction(async (tx) => {
      const updatedNode = await tx.customerNode.update({
        where: { id: customerNodeId },
        data: { expireAt: pending.afterExpireAt, status: 'active', lastSyncedAt: new Date() },
        include: { serviceNode: { include: { server: true } } }
      });
      const renewalLog = await tx.renewalLog.update({
        where: { id: pending.renewalLog.id },
        data: {
          status: 'success',
          detail: toJsonValue({
            operator,
            serviceNodeName: pending.customerNode.serviceNode.name,
            serviceNodeId: pending.customerNode.serviceNodeId,
            balanceLogId: pending.balanceLog.id,
            syncRoute: syncResult.route,
            sync: syncResult.detail
          })
        }
      });

      return { node: updatedNode, renewalLog, amount: pending.amount, afterBalance: pending.afterBalance, sync: syncResult.detail };
    });
  }

  private async refundFailedRenewal(customerId: string, pending: PendingRenewal, operator: string, error: unknown) {
    const message = errorMessage(error);
    await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { balance: true } });
      if (!customer) return;

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const afterBalance = beforeBalance.plus(pending.amount);
      await tx.customer.update({ where: { id: customerId }, data: { balance: afterBalance } });
      await tx.balanceLog.create({
        data: {
          customerId,
          type: 'refund',
          amount: pending.amount,
          beforeBalance,
          afterBalance,
          operator,
          remark: `续费同步失败退款 ${pending.customerNode.serviceNode.name}`,
          detail: toJsonValue({ renewalLogId: pending.renewalLog.id, originalBalanceLogId: pending.balanceLog.id, reason: message })
        }
      });
      await tx.renewalLog.update({
        where: { id: pending.renewalLog.id },
        data: {
          status: 'failed',
          detail: toJsonValue({
            operator,
            serviceNodeName: pending.customerNode.serviceNode.name,
            serviceNodeId: pending.customerNode.serviceNodeId,
            balanceLogId: pending.balanceLog.id,
            refunded: true,
            error: message
          })
        }
      });
    });
  }
}

type PendingRenewal = {
  amount: Prisma.Decimal;
  renewalLog: { id: string };
  balanceLog: { id: string };
  customerNode: { serviceNode: { name: string }; serviceNodeId: string };
};

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
