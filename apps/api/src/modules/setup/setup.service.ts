import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnvironmentService } from '../security/environment.service.js';

@Injectable()
export class SetupService {
  constructor(private readonly prisma: PrismaService, private readonly environment: EnvironmentService) {}

  async status() {
    const env = this.environment.status();
    try {
      const [adminCount, customerCount] = await Promise.all([
        this.prisma.adminUser.count(),
        this.prisma.customer.count()
      ]);
      return {
        installed: adminCount > 0,
        storage: 'mysql',
        databaseConnected: true,
        adminCount,
        customerCount,
        env
      };
    } catch (error) {
      return {
        installed: false,
        storage: 'mysql',
        databaseConnected: false,
        adminCount: 0,
        customerCount: 0,
        env,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  installHint() {
    return {
      message: '安装流程已切换为 Prisma migration + seed 脚本',
      commands: ['npm run prisma:migrate', 'npm run db:seed']
    };
  }
}
