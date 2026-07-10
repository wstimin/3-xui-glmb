import type { z } from 'zod';
import { paymentProviderSchema } from '@shiye/shared';

export type PaymentProviderName = z.infer<typeof paymentProviderSchema>;

export type CreatePaymentInput = {
  tradeNo: string;
  amount: number;
  subject: string;
  notifyUrl: string;
  returnUrl?: string;
  clientIp?: string;
};

export type CreatePaymentResult = {
  tradeNo: string;
  payUrl?: string;
  qrCode?: string;
  raw?: unknown;
};

export type VerifyNotifyInput = {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
  rawBody?: string;
};

export type VerifyNotifyResult = {
  verified: boolean;
  tradeNo?: string;
  amount?: number;
  paidAt?: Date;
  idempotencyKey?: string;
  raw?: unknown;
};

export interface PaymentProviderAdapter {
  readonly provider: PaymentProviderName;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  verifyNotify(input: VerifyNotifyInput): Promise<VerifyNotifyResult>;
}

export class PaymentRegistry {
  private readonly adapters = new Map<PaymentProviderName, PaymentProviderAdapter>();

  register(adapter: PaymentProviderAdapter) {
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: PaymentProviderName) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`Payment provider is not registered: ${provider}`);
    return adapter;
  }
}
