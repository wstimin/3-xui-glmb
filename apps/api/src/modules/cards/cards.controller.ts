import { Body, Controller, Get, Post, UseGuards, UsePipes } from '@nestjs/common';
import { cardGenerateSchema, cardRedeemSchema } from '@shiye/shared';
import type { z } from 'zod';
import { AuthGuard } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import { Roles } from '../../shared/roles.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { CardsService } from './cards.service.js';

@Controller()
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get('admin/cards')
  @UseGuards(AuthGuard)
  @Roles('admin')
  list() { return this.cards.list(); }

  @Post('admin/cards/generate')
  @UseGuards(AuthGuard)
  @Roles('admin')
  @UsePipes(new ZodValidationPipe(cardGenerateSchema))
  generate(@Body() body: z.infer<typeof cardGenerateSchema>) { return this.cards.generate(body); }

  @Post('user/cards/redeem')
  @UseGuards(AuthGuard)
  @Roles('user')
  @UsePipes(new ZodValidationPipe(cardRedeemSchema))
  redeem(@Body() body: z.infer<typeof cardRedeemSchema>, @CurrentUser() user: SessionUser) {
    return this.cards.redeem(user.customerId || '', body);
  }
}
