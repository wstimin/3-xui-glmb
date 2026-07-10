import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = error instanceof HttpException ? error.getResponse() : null;
    const message = typeof payload === 'object' && payload && 'message' in payload
      ? (payload as { message: string | string[] }).message
      : error instanceof Error
        ? error.message
        : 'Internal server error';

    response.status(status).json({ ok: false, message: Array.isArray(message) ? message.join('; ') : message });
  }
}
