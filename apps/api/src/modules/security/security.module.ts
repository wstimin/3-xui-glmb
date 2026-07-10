import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { EncryptionService } from './encryption.service.js';
import { EnvironmentService } from './environment.service.js';

@Global()
@Module({ imports: [PrismaModule], providers: [EncryptionService, EnvironmentService], exports: [EncryptionService, EnvironmentService] })
export class SecurityModule {}
