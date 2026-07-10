import { Body, Controller, Get, Param, Post, Query, Res, UseGuards, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import { rechargeOrderCreateSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { PaymentsService } from './payments.service.js';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('user/recharge-orders')
  @UseGuards(AuthGuard)
  @Roles('user')
  @UsePipes(new ZodValidationPipe(rechargeOrderCreateSchema))
  createOrder(@Body() body: z.infer<typeof rechargeOrderCreateSchema>, @CurrentUser() user: SessionUser) {
    return this.payments.createOrder(user.customerId || '', body);
  }

  @Post('payments/:provider/notify')
  async notify(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Body() body: unknown, @Res() response: Response) {
    const text = await this.payments.notify({ provider, query, body });
    return response.type('text/plain').send(text);
  }

  @Get('payments/:provider/notify')
  async getNotify(@Param('provider') provider: string, @Query() query: Record<string, unknown>, @Res() response: Response) {
    const text = await this.payments.notify({ provider, query, body: {} });
    return response.type('text/plain').send(text);
  }

  @Get('payments/result')
  result(@Query('trade_no') tradeNo: string) { return this.payments.result(tradeNo); }
}
