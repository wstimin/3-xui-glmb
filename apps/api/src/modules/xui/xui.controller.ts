import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
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

  @Post('admin/xui-servers/:id/test')
  @UseGuards(AuthGuard)
  @Roles('admin')
  testStoredServer(@Param('id') id: string) { return this.xui.testStoredServer(id); }

  @Post('admin/service-nodes/:id/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncServiceNode(@Param('id') id: string) { return this.xui.syncServiceNode(id); }

  @Post('admin/customers/:id/nodes/:nodeId/sync')
  @UseGuards(AuthGuard)
  @Roles('admin')
  syncCustomerNode(@Param('id') id: string, @Param('nodeId') nodeId: string) {
    return this.xui.syncCustomerNode(id, nodeId);
  }
}
