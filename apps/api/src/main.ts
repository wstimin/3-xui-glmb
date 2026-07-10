import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './modules/app.module.js';
import { HttpExceptionFilter } from './shared/http-exception.filter.js';
import { ResponseInterceptor } from './shared/response.interceptor.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.use(express.text({ type: ['text/xml', 'application/xml', '*/xml'] }));
  app.use(express.urlencoded({ extended: false }));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  serveWebApps(app.getHttpAdapter().getInstance());

  const port = Number(process.env.PORT || 3388);
  await app.listen(port, '0.0.0.0');
  console.log(`Shiye API listening on http://0.0.0.0:${port}`);
}

function serveWebApps(server: express.Express) {
  const rootDir = findRuntimeRoot();
  const userWebDir = join(rootDir, 'dist/user-web');
  const adminWebDir = join(rootDir, 'dist/admin-web');

  if (existsSync(userWebDir)) {
    server.use(express.static(userWebDir, { index: false }));
  }

  if (existsSync(adminWebDir)) {
    server.use('/admin', express.static(adminWebDir, { index: false }));
  }

  server.get(/^\/admin(?:\/.*)?$/, (_request, response, next) => {
    const indexFile = join(adminWebDir, 'index.html');
    if (!existsSync(indexFile)) return next();
    return response.sendFile(indexFile);
  });

  server.get(/^\/(?!api(?:\/|$)).*$/, (_request, response, next) => {
    const indexFile = join(userWebDir, 'index.html');
    if (!existsSync(indexFile)) return next();
    return response.sendFile(indexFile);
  });
}

function findRuntimeRoot() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '../..'),
    resolve(moduleDir, '../../..')
  ];

  return candidates.find((candidate) => (
    existsSync(join(candidate, 'dist/user-web/index.html')) ||
    existsSync(join(candidate, 'dist/admin-web/index.html'))
  )) || process.cwd();
}

void bootstrap();
