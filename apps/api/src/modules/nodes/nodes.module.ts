import { Module } from '@nestjs/common';
import { NodesController } from './nodes.controller.js';
import { NodesService } from './nodes.service.js';

@Module({ controllers: [NodesController], providers: [NodesService], exports: [NodesService] })
export class NodesModule {}
