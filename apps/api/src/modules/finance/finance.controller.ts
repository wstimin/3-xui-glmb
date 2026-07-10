import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { renewalSchema, userRenewalSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { FinanceService } from './finance.service.js';

@Controller()
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('admin/recharge-orders')
  @UseGuards(AuthGuard)
  @Roles('admin')
  rechargeOrders() { return this.finance.rechargeOrders(); }

  @Get('admin/balance-logs')
  @UseGuards(AuthGuard)
  @Roles('admin')
  balanceLogs() { return this.finance.balanceLogs(); }

  @Post('user/renewals')
  @UseGuards(AuthGuard)
  @Roles('user')
  renew(@Body(new ZodValidationPipe(userRenewalSchema)) body: z.infer<typeof userRenewalSchema>, @CurrentUser() user: SessionUser) {
    return this.finance.renewCustomerNode(user.customerId || '', body.nodeId, body.months, user.username);
  }

  @Post('admin/customers/:id/nodes/:nodeId/renew')
  @UseGuards(AuthGuard)
  @Roles('admin')
  adminRenew(@Param('id') id: string, @Param('nodeId') nodeId: string, @Body(new ZodValidationPipe(renewalSchema)) body: z.infer<typeof renewalSchema>, @CurrentUser() user: SessionUser) {
    return this.finance.renewCustomerNode(id, nodeId, body.months, user.username);
  }
}
