export type Role = 'admin' | 'user';

export type ApiResult<T> =
  | { ok: true; data: T; message?: string }
  | { ok: false; message: string; detail?: unknown };

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type MoneyAmount = number;

export type ISODateTime = string;
