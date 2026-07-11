import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { Roles } from '../../shared/roles.decorator.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { XuiService } from './xui.service.js';

@Controller()
export class XuiController {
  constructor(private readonly xui: XuiService) {}

  @Post('admin/xui/test')
  @UseGuards(AuthGuard)
  @Roles('admin')
  test(@Body(new ZodValidationPipe(xuiServerUpsertSchema)) body: z.infer<typeof xuiServerUpsertSchema>) { return this.xui.testConnection(body); }

  @Post('admin/xui/certs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  testCertFiles(@Body(new ZodValidationPipe(xuiServerUpsertSchema)) body: z.infer<typeof xuiServerUpsertSchema>) { return this.xui.testConnectionCertFiles(body); }

  @Post('admin/xui-servers/:id/test')
  @UseGuards(AuthGuard)
  @Roles('admin')
  testStoredServer(@Param('id') id: string) { return this.xui.testStoredServer(id); }

  @Get('admin/xui-servers/:id/certs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  storedServerCertFiles(@Param('id') id: string) { return this.xui.storedServerCertFiles(id); }

  @Get('admin/xui-servers/:id/status')
  @UseGuards(AuthGuard)
  @Roles('admin')
  storedServerStatus(@Param('id') id: string) { return this.xui.storedServerStatus(id); }

  @Get('admin/xui-servers/:id/client-presence')
  @UseGuards(AuthGuard)
  @Roles('admin')
  storedServerClientPresence(@Param('id') id: string) { return this.xui.storedServerClientPresence(id); }

  @Get('admin/sync-logs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncLogs(@Query() query: { serverId?: string; action?: string; status?: string; limit?: string }) {
    return this.xui.syncLogs(query);
  }

  @Post('admin/xui-servers/:id/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServer(@Param('id') id: string) { return this.xui.syncServer(id); }

  @Post('admin/service-nodes/:id/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServiceNode(@Param('id') id: string) { return this.xui.syncServiceNode(id); }

  @Post('admin/service-nodes/:id/sync-config')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServiceNodeConfig(@Param('id') id: string) { return this.xui.syncServiceNodeRemoteConfig(id); }

  @Post('admin/service-nodes/:id/set-enable')
  @UseGuards(AuthGuard)
  @Roles('admin')
  setServiceNodeEnable(@Param('id') id: string, @Body() body: { enable?: boolean }) {
    return this.xui.setServiceNodeRemoteEnable(id, body.enable === true);
  }

  @Post('admin/service-nodes/:id/reset-traffic')
  @UseGuards(AuthGuard)
  @Roles('admin')
  resetServiceNodeTraffic(@Param('id') id: string) { return this.xui.resetServiceNodeTraffic(id); }

  @Post('admin/customers/:id/nodes/:nodeId/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncCustomerNode(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.xui.syncCustomerNode(id, nodeId, { syncServiceConfig: true });
  }

  @Get('admin/customers/:id/nodes/:nodeId/traffic')
  @UseGuards(AuthGuard)
  @Roles('admin')
  customerNodeTraffic(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.xui.customerNodeTraffic(id, nodeId);
  }

  @Post('admin/customers/:id/nodes/:nodeId/reset-traffic')
  @UseGuards(AuthGuard)
  @Roles('admin')
  resetCustomerNodeTraffic(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.xui.resetCustomerNodeTraffic(id, nodeId);
  }
}
