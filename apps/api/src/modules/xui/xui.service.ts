import { randomBytes, randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AccountStatus } from '@prisma/client';
import { xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { XuiClient } from '@shiye/xui-client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';

type XuiServerConfig = {
  baseUrl: string;
  basePath?: string | null;
  tokenEnc?: string | null;
  token?: string | null;
  username?: string | null;
  passwordEnc?: string | null;
  password?: string | null;
};

type SyncOptions = {
  expireAt?: Date | null;
  status?: AccountStatus;
  trafficLimitGb?: Prisma.Decimal | number | string | null;
  createIfMissing?: boolean;
};

type ServiceNodeConfig = {
  encryption?: string;
  socksRelayEnabled?: boolean;
  socksNodeId?: string | null;
  remoteMode?: 'create' | 'bind';
  remoteManaged?: boolean;
  remoteInboundTag?: string;
  remoteInboundRemark?: string;
  remoteInboundPort?: number;
};

type CreateServiceInboundInput = {
  serverId: string;
  name: string;
  protocol: string;
  encryption?: string;
  enabled: boolean;
  port?: number;
  remark?: string | null;
};

const SHIYE_ROUTE_MARK = 'shiye-service-node';

@Injectable()
export class XuiService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async testConnection(input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient({
      baseUrl: input.baseUrl,
      basePath: input.basePath,
      token: input.token,
      username: input.username,
      password: input.password
    });

    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, inbounds };
  }

  async testStoredServer(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

    const client = await this.createAuthenticatedClient(server);
    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, serverId: id, enabled: server.enabled, inboundCount: this.xuiArray(inbounds).length, inbounds };
  }

  async syncServiceNode(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, select: { id: true, name: true } });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');

    const customerNodes = await this.prisma.customerNode.findMany({
      where: { serviceNodeId },
      select: { id: true, customerId: true, xuiEmail: true }
    });

    const results: Array<{ customerNodeId: string; customerId: string; xuiEmail: string; synced: boolean; message?: string }> = [];
    for (const node of customerNodes) {
      try {
        await this.syncCustomerNode(node.customerId, node.id);
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, synced: true });
      } catch (error) {
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, synced: false, message: this.errorMessage(error) });
      }
    }

    const success = results.filter((item) => item.synced).length;
    return { serviceNodeId, serviceNodeName: serviceNode.name, total: results.length, success, failed: results.length - success, results };
  }

  async syncServiceNodeRemoteConfig(serviceNodeId: string, options: { removeOnly?: boolean } = {}) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    const client = await this.createAuthenticatedClient(serviceNode.server);
    const inboundPayload = await client.getInbound(serviceNode.inboundId);
    this.assertXuiSuccess(inboundPayload);
    const inbound = this.xuiObject(this.xuiObject(inboundPayload).obj || this.xuiObject(inboundPayload).data || inboundPayload);
    const inboundTag = String(inbound.tag || `inbound-${serviceNode.inboundId}`);
    const outboundTag = this.socksOutboundTag(serviceNode.id);

    const xrayPayload = await client.getXrayConfig();
    this.assertXuiSuccess(xrayPayload);
    const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
    const rawSetting = xrayObj.xraySetting ?? xrayObj;
    const xraySetting = this.xuiObject(rawSetting);
    if (!Object.keys(xraySetting).length) throw new BadGatewayException('3x-ui returned an empty Xray config');

    const nextConfig = this.removeManagedSocksRoute(xraySetting, serviceNode.id);
    let action: 'removed' | 'updated' = 'removed';
    let socksDetail: Record<string, unknown> | null = null;

    if (!options.removeOnly && config.socksRelayEnabled) {
      if (!config.socksNodeId) throw new BadRequestException('Socks relay enabled but no Socks node selected');
      const socksNode = await this.prisma.socksNode.findUnique({ where: { id: config.socksNodeId } });
      if (!socksNode) throw new NotFoundException('Socks node not found');
      if (!socksNode.enabled) throw new BadRequestException('Selected Socks node is disabled');

      const outbound = this.buildSocksOutbound(outboundTag, socksNode);
      const outbounds = Array.isArray(nextConfig.outbounds) ? nextConfig.outbounds : [];
      outbounds.push(outbound);
      nextConfig.outbounds = outbounds;

      const routing = this.ensureRouting(nextConfig);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      rules.push({
        type: 'field',
        inboundTag: [inboundTag],
        outboundTag,
        _shiyeManaged: true,
        _shiyeServiceNodeId: serviceNode.id,
        _shiyeMark: SHIYE_ROUTE_MARK
      });
      routing.rules = rules;
      nextConfig.routing = routing;
      action = 'updated';
      socksDetail = { socksNodeId: socksNode.id, host: socksNode.host, port: socksNode.port, username: socksNode.username || '' };
    }

    const outboundTestUrl = typeof xrayObj.outboundTestUrl === 'string' ? xrayObj.outboundTestUrl : undefined;
    const response = await client.updateXrayConfig({ xraySetting: JSON.stringify(nextConfig, null, 2), outboundTestUrl });
    this.assertXuiSuccess(response);
    await this.writeSyncLog(serviceNode.serverId, 'service-node-config-sync', 'success', `Service node ${serviceNode.name} remote config ${action}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      inboundTag,
      outboundTag,
      action,
      socks: socksDetail,
      response: this.toJsonValue(response)
    });
    return { synced: true, action, serviceNodeId, inboundId: serviceNode.inboundId, inboundTag, outboundTag, socks: socksDetail };
  }

  async createServiceNodeInbound(input: CreateServiceInboundInput) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

    const client = await this.createAuthenticatedClient(server);
    const rawInbounds = await client.listInbounds();
    this.assertXuiSuccess(rawInbounds);
    const inbounds = this.xuiArray(rawInbounds);
    const usedPorts = new Set(inbounds.map((item) => Number(this.xuiObject(item).port)).filter((port) => Number.isInteger(port) && port > 0));
    const port = input.port || this.pickInboundPort(usedPorts);
    if (usedPorts.has(port)) throw new BadRequestException(`3x-ui 入站端口 ${port} 已被占用`);

    const tag = this.serviceInboundTag();
    const payload = this.buildInboundPayload({ ...input, port, tag });
    const response = await client.addInbound(payload);
    this.assertXuiSuccess(response);

    let inboundId = this.extractCreatedInboundId(response);
    if (!inboundId) {
      const afterPayload = await client.listInbounds();
      this.assertXuiSuccess(afterPayload);
      const created = this.xuiArray(afterPayload).find((item) => {
        const inbound = this.xuiObject(item);
        return inbound.tag === tag || (inbound.remark === payload.remark && Number(inbound.port) === port);
      });
      inboundId = this.inboundIdOf(created);
    }

    if (!inboundId) throw new BadGatewayException('3x-ui 已返回成功，但没有返回新入站 ID');
    await this.writeSyncLog(server.id, 'service-node-inbound-create', 'success', `Created inbound ${inboundId} for ${input.name}`, {
      inboundId,
      port,
      protocol: input.protocol,
      tag,
      response: this.toJsonValue(response)
    });
    return { inboundId, port, tag, remark: String(payload.remark), response };
  }

  async validateServiceNodeInbound(serverId: string, inboundId: number) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    const client = await this.createAuthenticatedClient(server);
    const payload = await client.getInbound(inboundId);
    this.assertXuiSuccess(payload);
    return { inboundId, valid: true };
  }

  async deleteManagedServiceNodeInbound(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode?.inboundId) return { deleted: false, skipped: true };
    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    if (!config.remoteManaged) return { deleted: false, skipped: true };

    try {
      const client = await this.createAuthenticatedClient(serviceNode.server);
      const response = await client.deleteInbound(serviceNode.inboundId);
      this.assertXuiSuccess(response);
      await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'success', `Deleted inbound ${serviceNode.inboundId}`, {
        serviceNodeId,
        inboundId: serviceNode.inboundId,
        response: this.toJsonValue(response)
      });
      return { deleted: true, inboundId: serviceNode.inboundId, response };
    } catch (error) {
      if (/not found|record not found|404/i.test(this.errorMessage(error))) return { deleted: true, inboundId: serviceNode.inboundId, alreadyAbsent: true };
      await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'failed', this.errorMessage(error), { serviceNodeId, inboundId: serviceNode.inboundId });
      throw new BadGatewayException(`删除远端 3x-ui 入站失败：${this.errorMessage(error)}`);
    }
  }

  async deleteRemoteInbound(serverId: string, inboundId: number) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) return { deleted: false, skipped: true };
    const client = await this.createAuthenticatedClient(server);
    const response = await client.deleteInbound(inboundId);
    this.assertXuiSuccess(response);
    return { deleted: true, inboundId, response };
  }

  async syncServer(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId }, select: { id: true, name: true } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

    const customerNodes = await this.prisma.customerNode.findMany({
      where: { serviceNode: { serverId } },
      select: { id: true, customerId: true, xuiEmail: true, serviceNode: { select: { id: true, name: true } } }
    });

    const results: Array<{ customerNodeId: string; customerId: string; serviceNodeId: string; serviceNodeName: string; xuiEmail: string; synced: boolean; message?: string }> = [];
    for (const node of customerNodes) {
      try {
        await this.syncCustomerNode(node.customerId, node.id);
        results.push({ customerNodeId: node.id, customerId: node.customerId, serviceNodeId: node.serviceNode.id, serviceNodeName: node.serviceNode.name, xuiEmail: node.xuiEmail, synced: true });
      } catch (error) {
        results.push({ customerNodeId: node.id, customerId: node.customerId, serviceNodeId: node.serviceNode.id, serviceNodeName: node.serviceNode.name, xuiEmail: node.xuiEmail, synced: false, message: this.errorMessage(error) });
      }
    }

    const success = results.filter((item) => item.synced).length;
    return { serverId, serverName: server.name, total: results.length, success, failed: results.length - success, results };
  }

  async deleteCustomerNode(customerId: string, customerNodeId: string, keepTraffic = false) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
    return this.deleteRemoteClient(customerNode.serviceNode.server, customerNode.xuiEmail, keepTraffic, {
      customerId,
      customerNodeId,
      serviceNodeId: customerNode.serviceNodeId
    });
  }

  async deleteServiceNodeClients(serviceNodeId: string, keepTraffic = false) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: { server: true, customerNodes: { select: { id: true, customerId: true, xuiEmail: true } } }
    });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');

    const results: Array<{ customerNodeId: string; customerId: string; xuiEmail: string; deleted: boolean; message?: string }> = [];
    for (const node of serviceNode.customerNodes) {
      try {
        await this.deleteRemoteClient(serviceNode.server, node.xuiEmail, keepTraffic, {
          customerId: node.customerId,
          customerNodeId: node.id,
          serviceNodeId
        });
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: true });
      } catch (error) {
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: false, message: this.errorMessage(error) });
      }
    }

    const success = results.filter((item) => item.deleted).length;
    const failed = results.length - success;
    if (failed > 0) throw new BadGatewayException(`删除远端 3x-ui 客户端失败：成功 ${success}，失败 ${failed}`);
    return { serviceNodeId, total: results.length, success, failed, results };
  }

  async syncCustomerNode(customerId: string, customerNodeId: string, options: SyncOptions = {}) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: {
        customer: true,
        serviceNode: { include: { server: true } }
      }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');

    const server = customerNode.serviceNode.server;
    const serverId = server.id;

    try {
      const targetStatus = options.status || customerNode.status;
      if (!server.enabled && targetStatus === 'active') throw new BadRequestException('3x-ui 服务器已停用');
      if (!customerNode.serviceNode.enabled && targetStatus === 'active') throw new BadRequestException('服务节点已停用');
      if (!customerNode.serviceNode.inboundId) throw new BadRequestException('服务节点缺少 3x-ui 入站 ID');

      const client = await this.createAuthenticatedClient(server);
      const rawInbounds = await client.listInbounds();
      this.assertXuiSuccess(rawInbounds);
      const inbounds = this.xuiArray(rawInbounds);
      const inboundId = customerNode.serviceNode.inboundId;
      const inbound = inbounds.find((item) => this.inboundIdOf(item) === inboundId);
      if (!inbound) {
        const knownIds = inbounds.map((item) => this.inboundIdOf(item)).filter(Boolean).join(', ') || '-';
        throw new BadRequestException(`3x-ui 入站 ${inboundId} 不存在，可用 ID: ${knownIds}`);
      }

      const uuid = customerNode.uuid || randomUUID();
      const subId = this.subscriptionId(uuid);
      const xuiClient = this.buildXuiClient({
        uuid,
        subId,
        email: customerNode.xuiEmail,
        enabled: targetStatus === 'active',
        expireAt: options.expireAt === undefined ? customerNode.expireAt : options.expireAt,
        trafficLimitGb: options.trafficLimitGb ?? customerNode.trafficLimitGb
      });

      const existing = await this.findClient(client, customerNode.xuiEmail, inbounds);
      if (!existing.exists && options.createIfMissing === false) {
        const syncedAt = new Date();
        const updatedNode = await this.prisma.customerNode.update({
          where: { id: customerNode.id },
          data: { uuid, lastSyncedAt: syncedAt, config: this.toJsonValue({ ...(this.xuiObject(customerNode.config)), subId, links: [] }) },
          include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
        });
        const detail = {
          customerId,
          customerNodeId,
          inboundId,
          xuiEmail: customerNode.xuiEmail,
          route: 'clients/get',
          action: 'already-absent',
          subId,
          links: [] as string[]
        };
        await this.writeSyncLog(serverId, 'customer-node-sync', 'success', `Remote client already absent: ${customerNode.xuiEmail}`, detail);
        return { synced: true, action: 'already-absent', route: 'clients/get', node: updatedNode, detail };
      }
      const route = existing.exists ? 'clients/update' : 'clients/add';
      const payload = existing.exists
        ? await client.updateClient(customerNode.xuiEmail, { ...xuiClient, inboundIds: [inboundId] })
        : await client.addClient({ client: xuiClient, inboundIds: [inboundId] });
      this.assertXuiSuccess(payload);
      const links = await this.linksForClient(client, customerNode.xuiEmail).catch(() => [] as string[]);
      const syncedAt = new Date();
      const updatedNode = await this.prisma.customerNode.update({
        where: { id: customerNode.id },
        data: { uuid, lastSyncedAt: syncedAt, config: this.toJsonValue({ ...(this.xuiObject(customerNode.config)), subId, links }) },
        include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
      });

      const detail = {
        customerId,
        customerNodeId,
        inboundId,
        xuiEmail: customerNode.xuiEmail,
        route,
        action: existing.exists ? 'update' : 'add',
        subId,
        links,
        response: this.toJsonValue(payload)
      };
      await this.writeSyncLog(serverId, 'customer-node-sync', 'success', `Synced ${customerNode.xuiEmail}`, detail);
      return { synced: true, action: existing.exists ? 'update' : 'add', route, node: updatedNode, detail };
    } catch (error) {
      await this.writeSyncLog(serverId, 'customer-node-sync', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        xuiEmail: customerNode.xuiEmail
      });
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new BadGatewayException(`同步 3x-ui 失败：${this.errorMessage(error)}`);
    }
  }

  async customerNodeLinks(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('Customer node not found');
    const config = this.xuiObject(customerNode.config);
    const savedLinks = Array.isArray(config.links) ? config.links.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
    if (savedLinks.length) return savedLinks;
    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    return this.linksForClient(client, customerNode.xuiEmail);
  }

  private async createAuthenticatedClient(config: XuiServerConfig) {
    const client = new XuiClient({
      baseUrl: config.baseUrl,
      basePath: config.basePath || undefined,
      auth: config.token || config.tokenEnc ? { kind: 'token', token: config.token || this.encryption.decrypt(config.tokenEnc || '') } : undefined
    });

    if (!config.token && !config.tokenEnc && config.username && (config.password || config.passwordEnc)) {
      await client.login({ username: config.username, password: config.password || this.encryption.decrypt(config.passwordEnc || '') });
    }

    return client;
  }

  private async deleteRemoteClient(server: XuiServerConfig & { id?: string | null }, xuiEmail: string, keepTraffic: boolean, detail: Record<string, unknown>) {
    try {
      const client = await this.createAuthenticatedClient(server);
      const payload = await client.deleteClient(xuiEmail, keepTraffic);
      this.assertXuiSuccess(payload);
      await this.writeSyncLog(server.id || null, 'customer-node-delete', 'success', `Deleted ${xuiEmail}`, { ...detail, keepTraffic, response: this.toJsonValue(payload) });
      return { deleted: true, xuiEmail, response: payload };
    } catch (error) {
      if (/not found|record not found|404/i.test(this.errorMessage(error))) {
        await this.writeSyncLog(server.id || null, 'customer-node-delete', 'success', `Remote client already absent: ${xuiEmail}`, { ...detail, xuiEmail, keepTraffic });
        return { deleted: true, xuiEmail, alreadyAbsent: true };
      }
      await this.writeSyncLog(server.id || null, 'customer-node-delete', 'failed', this.errorMessage(error), { ...detail, xuiEmail, keepTraffic });
      throw new BadGatewayException(`删除 3x-ui 客户端失败：${this.errorMessage(error)}`);
    }
  }

  private buildXuiClient(input: { uuid: string; subId: string; email: string; enabled: boolean; expireAt?: Date | null; trafficLimitGb: Prisma.Decimal | number | string | null }) {
    return {
      id: input.uuid,
      uuid: input.uuid,
      email: input.email,
      enable: input.enabled,
      expiryTime: input.expireAt ? input.expireAt.getTime() : 0,
      totalGB: this.gbToBytes(input.trafficLimitGb),
      limitIp: 0,
      flow: '',
      tgId: 0,
      subId: input.subId,
      reset: 0
    };
  }

  private buildInboundPayload(input: CreateServiceInboundInput & { port: number; tag: string }) {
    const protocol = input.protocol;
    const remark = input.remark || input.name;
    return {
      up: 0,
      down: 0,
      total: 0,
      remark,
      enable: input.enabled,
      expiryTime: 0,
      listen: '',
      port: input.port,
      protocol,
      settings: this.defaultInboundSettings(protocol, input.encryption),
      streamSettings: this.defaultStreamSettings(),
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic', 'fakedns'],
        metadataOnly: false,
        routeOnly: false
      },
      tag: input.tag,
      _shiyeManaged: true
    };
  }

  private defaultInboundSettings(protocol: string, encryption = 'none') {
    if (protocol === 'vless') return { clients: [], decryption: 'none', fallbacks: [] };
    if (protocol === 'vmess') return { clients: [] };
    if (protocol === 'trojan') return { clients: [], fallbacks: [] };
    if (protocol === 'shadowsocks') {
      return {
        method: encryption && encryption !== 'none' && encryption !== 'auto' ? encryption : 'aes-128-gcm',
        password: this.randomSecret(16),
        network: 'tcp,udp',
        clients: []
      };
    }
    if (protocol === 'socks') return { auth: 'noauth', accounts: [], udp: true, ip: '127.0.0.1' };
    if (protocol === 'http') return { accounts: [] };
    if (protocol === 'mixed') return { auth: 'noauth', accounts: [], udp: true, ip: '127.0.0.1' };
    return { clients: [] };
  }

  private defaultStreamSettings() {
    return {
      network: 'tcp',
      security: 'none',
      tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } }
    };
  }

  private async linksForClient(client: XuiClient, email: string) {
    const payload = await client.clientLinks(email);
    this.assertXuiSuccess(payload);
    const links = this.xuiArray(payload).filter((item): item is string => typeof item === 'string' && item.length > 0);
    if (links.length) return links;
    const object = this.xuiObject(payload);
    for (const key of ['links', 'urls', 'obj', 'data']) {
      const value = this.parseMaybeJson(object[key]);
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
    }
    return [];
  }

  private async findClient(client: XuiClient, email: string, inbounds: unknown[]) {
    try {
      const payload = await client.getClient(email);
      this.assertXuiSuccess(payload);
      const object = this.xuiObject(payload);
      const detailClient = this.xuiObject(object.client || object.clientStats || object.client_stat || object);
      if (this.clientEmailOf(detailClient) === email || this.clientEmailOf(object) === email) return { exists: true, raw: payload };
    } catch (error) {
      if (!/not found|record not found|404/i.test(this.errorMessage(error))) throw error;
    }

    for (const inbound of inbounds) {
      const settings = this.parseMaybeJson(this.xuiObject(inbound).settings);
      const settingsObject = this.xuiObject(settings);
      const clients = Array.isArray(settingsObject.clients) ? settingsObject.clients : [];
      if (clients.some((item: unknown) => this.clientEmailOf(item) === email)) return { exists: true, raw: inbound };
    }
    return { exists: false, raw: null };
  }

  private removeManagedSocksRoute(config: Record<string, unknown>, serviceNodeId: string) {
    const next: Record<string, unknown> = { ...config };
    const outboundTag = this.socksOutboundTag(serviceNodeId);
    const outbounds = Array.isArray(next.outbounds) ? next.outbounds : [];
    next.outbounds = outbounds.filter((item) => this.xuiObject(item).tag !== outboundTag);

    const routing = this.xuiObject(next.routing);
    if (Object.keys(routing).length) {
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      routing.rules = rules.filter((item) => {
        const rule = this.xuiObject(item);
        return rule._shiyeServiceNodeId !== serviceNodeId && rule.outboundTag !== outboundTag;
      });
      next.routing = routing;
    }

    return next;
  }

  private buildSocksOutbound(tag: string, socksNode: { host: string; port: number; username: string | null; passwordEnc: string | null }) {
    const user = socksNode.username
      ? [{ user: socksNode.username, pass: socksNode.passwordEnc ? this.encryption.decrypt(socksNode.passwordEnc) : '' }]
      : undefined;
    return {
      tag,
      protocol: 'socks',
      settings: {
        servers: [{ address: socksNode.host, port: socksNode.port, users: user }]
      },
      streamSettings: { network: 'tcp' },
      _shiyeManaged: true,
      _shiyeMark: SHIYE_ROUTE_MARK
    };
  }

  private ensureRouting(config: Record<string, unknown>) {
    const routing = this.xuiObject(config.routing);
    if (!Array.isArray(routing.rules)) routing.rules = [];
    return routing;
  }

  private socksOutboundTag(serviceNodeId: string) {
    return `shiye-socks-${serviceNodeId.slice(0, 18)}`;
  }

  private assertXuiSuccess(payload: unknown) {
    if (!payload || typeof payload !== 'object') return;
    const record = payload as Record<string, unknown>;
    if (record.success === false) throw new Error(String(record.msg || record.message || '3x-ui returned success=false'));
  }

  private xuiArray(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    const object = this.xuiObject(data);
    for (const key of ['obj', 'data', 'result', 'items', 'inbounds', 'clients']) {
      const value = this.parseMaybeJson(object[key]);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        for (const nestedKey of ['items', 'inbounds', 'clients']) {
          const nested = (value as Record<string, unknown>)[nestedKey];
          if (Array.isArray(nested)) return nested;
        }
      }
    }
    return [];
  }

  private xuiObject(data: unknown): Record<string, unknown> {
    const parsed = this.parseMaybeJson(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private inboundIdOf(item: unknown) {
    const object = this.xuiObject(item);
    const value = Number(object.id ?? object.inboundId ?? object.inbound_id ?? object.value);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  private clientEmailOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.email || object.clientEmail || object.name || '').trim();
  }

  private gbToBytes(value: Prisma.Decimal | number | string | null) {
    if (value === null) return 0;
    const gb = Number(value);
    if (!Number.isFinite(gb) || gb <= 0) return 0;
    return Math.round(gb * 1024 * 1024 * 1024);
  }

  private subscriptionId(uuid: string) {
    return uuid.replace(/-/g, '').slice(0, 16);
  }

  private serviceInboundTag() {
    return `shiye-inbound-${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  }

  private pickInboundPort(usedPorts: Set<number>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const port = 20000 + Math.floor(Math.random() * 30000);
      if (!usedPorts.has(port)) return port;
    }
    for (let port = 20000; port <= 50000; port += 1) {
      if (!usedPorts.has(port)) return port;
    }
    throw new BadRequestException('没有可用的 3x-ui 入站端口');
  }

  private extractCreatedInboundId(payload: unknown) {
    const direct = this.inboundIdOf(payload);
    if (direct) return direct;
    const object = this.xuiObject(payload);
    for (const key of ['obj', 'data', 'result', 'inbound']) {
      const value = object[key];
      const id = this.inboundIdOf(value);
      if (id) return id;
    }
    return 0;
  }

  private randomSecret(bytes = 24) {
    return randomBytes(bytes).toString('base64url');
  }

  private async writeSyncLog(serverId: string | null, action: string, status: string, message: string, detail: unknown) {
    await this.prisma.syncLog.create({
      data: {
        serverId,
        action,
        status,
        message,
        detail: this.toJsonValue(detail)
      }
    }).catch(() => undefined);
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
