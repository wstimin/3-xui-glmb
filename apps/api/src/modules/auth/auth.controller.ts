import { Body, Controller, Get, Post, Res, UseGuards, UsePipes } from '@nestjs/common';
import { changePasswordSchema, loginSchema } from '@shiye/shared';
import type { z } from 'zod';
import type { Response } from 'express';
import { AuthGuard, clearSessionCookie, sessionCookie, signSession } from '../../shared/auth.guard.js';
import { CurrentUser } from '../../shared/current-user.decorator.js';
import type { SessionUser } from '../../shared/auth.types.js';
import { ZodValidationPipe } from '../../shared/zod-validation.pipe.js';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(@Body() body: z.infer<typeof loginSchema>, @Res({ passthrough: true }) response: Response) {
    const user = await this.auth.login(body);
    response.setHeader('Set-Cookie', sessionCookie(signSession(user)));
    return user;
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: Response) {
    response.setHeader('Set-Cookie', clearSessionCookie());
    return this.auth.logout();
  }

  @Get('auth/me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: SessionUser) {
    return user;
  }

  @Post('change-password')
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(changePasswordSchema))
  async changePassword(@Body() body: z.infer<typeof changePasswordSchema>, @CurrentUser() user: SessionUser, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.changePassword(user, body);
    response.setHeader('Set-Cookie', clearSessionCookie());
    return result;
  }
}
