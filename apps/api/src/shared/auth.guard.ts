import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { Request } from 'express';
import type { Role } from '@shiye/shared';
import { ROLES_KEY } from './roles.decorator.js';
import type { SessionUser } from './auth.types.js';

const COOKIE_NAME = 'shiye_session';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = request.cookies?.[COOKIE_NAME] || bearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('请先登录');

    try {
      const payload = jwt.verify(token, sessionSecret()) as SessionUser;
      request.user = payload;
      const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
      if (roles?.length && !roles.includes(payload.role)) throw new UnauthorizedException('没有访问权限');
      return true;
    } catch {
      throw new UnauthorizedException('登录已失效，请重新登录');
    }
  }
}

export function signSession(user: SessionUser) {
  return jwt.sign(user, sessionSecret(), { expiresIn: sessionTtl() });
}

export function sessionCookie(token: string, maxAgeSeconds = 7 * 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === 'production';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function bearerToken(value: string | undefined) {
  if (!value?.startsWith('Bearer ')) return '';
  return value.slice('Bearer '.length).trim();
}

function sessionSecret() {
  return process.env.SESSION_SECRET || process.env.JWT_SECRET || 'dev-only-change-me';
}

function sessionTtl(): SignOptions['expiresIn'] {
  return (process.env.SESSION_TTL || '7d') as SignOptions['expiresIn'];
}
