import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { changePasswordSchema, loginSchema } from '@shiye/shared';
import type { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { SessionUser } from '../../shared/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';

type LoginInput = z.infer<typeof loginSchema>;
type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  async login(input: LoginInput) {
    if (input.entry === 'admin') {
      const admin = await this.prisma.adminUser.findUnique({ where: { username: input.username } });
      if (!admin || admin.status !== 'active') throw new UnauthorizedException('账号或密码错误');
      const valid = await bcrypt.compare(input.password, admin.passwordHash);
      if (!valid) throw new UnauthorizedException('账号或密码错误');
      return { role: 'admin' as const, username: admin.username, userId: admin.id };
    }

    const customer = await this.prisma.customer.findUnique({ where: { loginUsername: input.username } });
    if (!customer || customer.status !== 'active') throw new UnauthorizedException('账号或密码错误');
    const valid = await bcrypt.compare(input.password, customer.loginPasswordHash);
    if (!valid) throw new UnauthorizedException('账号或密码错误');
    return { role: 'user' as const, username: customer.loginUsername, customerId: customer.id };
  }

  async logout() {
    return { message: '已退出登录' };
  }

  async changePassword(user: SessionUser, input: ChangePasswordInput) {
    if (user.role === 'admin') {
      if (!user.userId) throw new UnauthorizedException('登录已失效，请重新登录');
      const admin = await this.prisma.adminUser.findUnique({ where: { id: user.userId } });
      if (!admin || admin.status !== 'active') throw new NotFoundException('管理员不存在或已禁用');

      await this.assertPassword(input.currentPassword, admin.passwordHash);
      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      await this.prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } });
      return { message: '密码已修改，请重新登录' };
    }

    if (!user.customerId) throw new UnauthorizedException('登录已失效，请重新登录');
    const customer = await this.prisma.customer.findUnique({ where: { id: user.customerId } });
    if (!customer || customer.status !== 'active') throw new NotFoundException('用户不存在或已禁用');

    await this.assertPassword(input.currentPassword, customer.loginPasswordHash);
    const loginPasswordHash = await bcrypt.hash(input.newPassword, 12);
    await this.prisma.customer.update({ where: { id: customer.id }, data: { loginPasswordHash } });
    return { message: '密码已修改，请重新登录' };
  }

  private async assertPassword(plain: string, hash: string) {
    const valid = await bcrypt.compare(plain, hash);
    if (!valid) throw new UnauthorizedException('当前密码错误');
  }
}
