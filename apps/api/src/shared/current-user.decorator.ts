import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { SessionUser } from './auth.types.js';

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): SessionUser | undefined => {
  const request = context.switchToHttp().getRequest<Request>();
  return request.user;
});
