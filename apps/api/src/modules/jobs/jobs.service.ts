import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';

type DisableExpiredResult = {
  customerNodeId: string;
  customerId: string;
  xuiEmail: string;
  expireAt: Date;
  disabled: boolean;
  message?: string;
};

type DisableTrafficExceededResult = {
  customerNodeId: string;
  customerId: string;
  xuiEmail: string;
  usedBytes: number;
  limitBytes: number;
  usedTrafficGb: number;
  trafficLimitGb: number;
  disabled: boolean;
  message?: string;
};

type JobSettings = {
  disableExpiredEnabled: boolean;
  trafficSyncEnabled: boolean;
};

const JOB_SETTINGS_KEY = 'jobs';
const DEFAULT_JOB_SETTINGS: JobSettings = {
  disableExpiredEnabled: true,
  trafficSyncEnabled: true
};

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private disableExpiredRunning = false;
  private disableTrafficExceededRunning = false;

  constructor(private readonly prisma: PrismaService, private readonly xui: XuiService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async disableExpiredOnSchedule() {
    if (this.disableExpiredRunning) return;
    const settings = await this.jobSettings();
    if (!settings.disableExpiredEnabled) return;
    this.disableExpiredRunning = true;
    try {
      const result = await this.disableExpiredNodes('schedule');
      if (result.total > 0) {
        this.logger.log(`Expired node disable job finished: success=${result.success}, failed=${result.failed}, total=${result.total}`);
      }
    } catch (error) {
      this.logger.error(`Expired node disable job failed: ${this.errorMessage(error)}`);
    } finally {
      this.disableExpiredRunning = false;
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async disableTrafficExceededOnSchedule() {
    if (this.disableTrafficExceededRunning) return;
    const settings = await this.jobSettings();
    if (!settings.trafficSyncEnabled) return;
    this.disableTrafficExceededRunning = true;
    try {
      const result = await this.disableTrafficExceededNodes('schedule');
      if (result.disabled > 0 || result.failed > 0) {
        this.logger.log(`Traffic limit disable job finished: disabled=${result.disabled}, failed=${result.failed}, checked=${result.checked}`);
      }
    } catch (error) {
      this.logger.error(`Traffic limit disable job failed: ${this.errorMessage(error)}`);
    } finally {
      this.disableTrafficExceededRunning = false;
    }
  }

  async jobSettings(): Promise<JobSettings> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: JOB_SETTINGS_KEY } });
    const value = this.objectValue(row?.value);
    return {
      disableExpiredEnabled: this.booleanValue(value.disableExpiredEnabled, DEFAULT_JOB_SETTINGS.disableExpiredEnabled),
      trafficSyncEnabled: this.booleanValue(value.trafficSyncEnabled, DEFAULT_JOB_SETTINGS.trafficSyncEnabled)
    };
  }

  async jobStatus() {
    const [disableExpiredLog, trafficSyncLog] = await Promise.all([
      this.prisma.syncLog.findFirst({ where: { action: 'disable-expired-nodes' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.syncLog.findFirst({ where: { action: 'disable-traffic-exceeded-nodes' }, orderBy: { createdAt: 'desc' } })
    ]);

    return {
      lastDisableExpired: this.disableExpiredStatus(disableExpiredLog),
      lastTrafficSync: this.trafficSyncStatus(trafficSyncLog)
    };
  }

  async updateJobSettings(input: Partial<Record<keyof JobSettings, unknown>>) {
    const current = await this.jobSettings();
    const next: JobSettings = {
      disableExpiredEnabled: input.disableExpiredEnabled === undefined ? current.disableExpiredEnabled : this.booleanValue(input.disableExpiredEnabled, current.disableExpiredEnabled),
      trafficSyncEnabled: input.trafficSyncEnabled === undefined ? current.trafficSyncEnabled : this.booleanValue(input.trafficSyncEnabled, current.trafficSyncEnabled)
    };
    await this.prisma.systemSetting.upsert({
      where: { key: JOB_SETTINGS_KEY },
      create: { key: JOB_SETTINGS_KEY, value: this.toJsonValue(next) },
      update: { value: this.toJsonValue(next) }
    });
    return next;
  }

  async disableExpiredNodes(trigger = 'manual') {
    const now = new Date();
    const expiredNodes = await this.prisma.customerNode.findMany({
      where: {
        status: 'active',
        expireAt: { not: null, lte: now }
      },
      orderBy: { expireAt: 'asc' },
      select: {
        id: true,
        customerId: true,
        xuiEmail: true,
        expireAt: true,
        serviceNodeId: true
      }
    });

    const results: DisableExpiredResult[] = [];
    for (const node of expiredNodes) {
      if (!node.expireAt) continue;
      try {
        await this.xui.syncCustomerNode(node.customerId, node.id, { status: 'disabled', expireAt: node.expireAt, createIfMissing: false });
        await this.prisma.customerNode.update({
          where: { id: node.id },
          data: { status: 'disabled', lastSyncedAt: new Date() }
        });
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, expireAt: node.expireAt, disabled: true });
      } catch (error) {
        results.push({
          customerNodeId: node.id,
          customerId: node.customerId,
          xuiEmail: node.xuiEmail,
          expireAt: node.expireAt,
          disabled: false,
          message: this.errorMessage(error)
        });
      }
    }

    const success = results.filter((item) => item.disabled).length;
    const failed = results.length - success;
    await this.prisma.syncLog.create({
      data: {
        serverId: null,
        action: 'disable-expired-nodes',
        status: failed > 0 ? 'partial' : 'success',
        message: `Expired node disable job by ${trigger}: success ${success}, failed ${failed}, total ${results.length}`,
        detail: JSON.parse(JSON.stringify({ trigger, checkedAt: now, results }))
      }
    }).catch(() => undefined);

    return { checkedAt: now, total: results.length, success, failed, results };
  }

  async disableTrafficExceededNodes(trigger = 'manual') {
    const checkedAt = new Date();
    const activeNodes = await this.prisma.customerNode.findMany({
      where: {
        status: 'active',
        trafficLimitGb: { gt: new Prisma.Decimal(0) }
      },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        customerId: true,
        xuiEmail: true,
        trafficLimitGb: true,
        serviceNodeId: true
      }
    });

    const results: DisableTrafficExceededResult[] = [];
    for (const node of activeNodes) {
      const trafficLimitGb = Number(node.trafficLimitGb);
      const limitBytes = this.gbToBytes(trafficLimitGb);
      if (limitBytes <= 0) continue;

      try {
        const trafficResult = await this.xui.customerNodeTraffic(node.customerId, node.id);
        const traffic = this.objectValue(trafficResult.traffic);
        const usedBytes = this.numberValue(traffic.up) + this.numberValue(traffic.down);
        const usedTrafficGb = this.bytesToGb(usedBytes);

        await this.prisma.customerNode.update({
          where: { id: node.id },
          data: { usedTrafficGb: new Prisma.Decimal(usedTrafficGb.toFixed(2)), lastSyncedAt: new Date() }
        });

        if (usedBytes < limitBytes) continue;

        await this.xui.syncCustomerNode(node.customerId, node.id, { status: 'disabled', trafficLimitGb: node.trafficLimitGb, createIfMissing: false });
        await this.prisma.customerNode.update({
          where: { id: node.id },
          data: { status: 'disabled', usedTrafficGb: new Prisma.Decimal(usedTrafficGb.toFixed(2)), lastSyncedAt: new Date() }
        });
        results.push({
          customerNodeId: node.id,
          customerId: node.customerId,
          xuiEmail: node.xuiEmail,
          usedBytes,
          limitBytes,
          usedTrafficGb,
          trafficLimitGb,
          disabled: true
        });
      } catch (error) {
        results.push({
          customerNodeId: node.id,
          customerId: node.customerId,
          xuiEmail: node.xuiEmail,
          usedBytes: 0,
          limitBytes,
          usedTrafficGb: 0,
          trafficLimitGb,
          disabled: false,
          message: this.errorMessage(error)
        });
      }
    }

    const disabled = results.filter((item) => item.disabled).length;
    const failed = results.length - disabled;
    await this.prisma.syncLog.create({
      data: {
        serverId: null,
        action: 'disable-traffic-exceeded-nodes',
        status: failed > 0 ? 'partial' : 'success',
        message: `Traffic limit disable job by ${trigger}: disabled ${disabled}, failed ${failed}, checked ${activeNodes.length}`,
        detail: JSON.parse(JSON.stringify({ trigger, checkedAt, checked: activeNodes.length, results }))
      }
    }).catch(() => undefined);

    return { checkedAt, checked: activeNodes.length, disabled, failed, results };
  }

  private gbToBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value * 1024 * 1024 * 1024);
  }

  private bytesToGb(value: number) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value / 1024 / 1024 / 1024;
  }

  private numberValue(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private booleanValue(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private disableExpiredStatus(log: { detail: Prisma.JsonValue; createdAt: Date } | null) {
    if (!log) return null;
    const detail = this.objectValue(log.detail);
    const results = Array.isArray(detail.results) ? detail.results.map((item) => this.objectValue(item)) : [];
    const success = results.filter((item) => item.disabled === true).length;
    const failed = results.length - success;
    return {
      checkedAt: this.dateValue(detail.checkedAt) || log.createdAt,
      total: results.length,
      success,
      failed
    };
  }

  private trafficSyncStatus(log: { detail: Prisma.JsonValue; createdAt: Date } | null) {
    if (!log) return null;
    const detail = this.objectValue(log.detail);
    const results = Array.isArray(detail.results) ? detail.results.map((item) => this.objectValue(item)) : [];
    const disabled = results.filter((item) => item.disabled === true).length;
    const failed = results.length - disabled;
    return {
      checkedAt: this.dateValue(detail.checkedAt) || log.createdAt,
      checked: this.numberValue(detail.checked) || 0,
      disabled,
      failed
    };
  }

  private dateValue(value: unknown) {
    const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
