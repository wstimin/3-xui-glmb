import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './modules/app.module.js';
import { HttpExceptionFilter } from './shared/http-exception.filter.js';
import { ResponseInterceptor } from './shared/response.interceptor.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false }));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  const port = Number(process.env.PORT || 3388);
  await app.listen(port, '0.0.0.0');
  console.log(`Shiye API listening on http://0.0.0.0:${port}`);
}

void bootstrap();
