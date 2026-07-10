export type XuiAuth =
  | { kind: 'token'; token: string }
  | { kind: 'password'; username: string; password: string };

export type XuiClientOptions = {
  baseUrl: string;
  basePath?: string;
  auth?: XuiAuth;
  fetchImpl?: typeof fetch;
};

export type XuiRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
};

export class XuiClientError extends Error {
  constructor(message: string, readonly status?: number, readonly payload?: unknown) {
    super(message);
  }
}

export class XuiClient {
  private readonly fetchImpl: typeof fetch;
  private sessionCookie = '';

  constructor(private readonly options: XuiClientOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async request<T>(endpoint: string, options: XuiRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.authHeaders(),
      ...this.cookieHeaders(),
      ...options.headers
    };

    const response = await this.fetchImpl(this.url(endpoint), {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const text = await response.text();
    this.rememberCookies(response.headers);
    const payload = text ? this.parse(text) : null;
    if (!response.ok) throw new XuiClientError(`3x-ui request failed: ${response.status}`, response.status, payload);
    return payload as T;
  }

  login(body: { username: string; password: string }) {
    return this.request('/login', { method: 'POST', body });
  }

  listInbounds() {
    return this.request('/panel/api/inbounds/list');
  }

  addClient(body: unknown) {
    return this.request('/panel/api/clients/add', { method: 'POST', body });
  }

  updateClient(email: string, body: unknown) {
    return this.request(`/panel/api/clients/update/${encodeURIComponent(email)}`, { method: 'POST', body });
  }

  deleteClient(email: string, keepTraffic = false) {
    const query = keepTraffic ? '?keepTraffic=1' : '';
    return this.request(`/panel/api/clients/del/${encodeURIComponent(email)}${query}`, { method: 'POST' });
  }

  getClient(email: string) {
    return this.request(`/panel/api/clients/get/${encodeURIComponent(email)}`);
  }

  resetTraffic(email: string) {
    return this.request(`/panel/api/clients/resetTraffic/${encodeURIComponent(email)}`, { method: 'POST' });
  }

  clientLinks(email: string) {
    return this.request(`/panel/api/clients/links/${encodeURIComponent(email)}`);
  }

  private url(endpoint: string) {
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '');
    const basePath = this.options.basePath ? `/${this.options.basePath.replace(/^\/+|\/+$/g, '')}` : '';
    return `${baseUrl}${basePath}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  }

  private authHeaders(): Record<string, string> {
    if (this.options.auth?.kind === 'token') return { Authorization: `Bearer ${this.options.auth.token}` };
    return {};
  }

  private cookieHeaders(): Record<string, string> {
    return this.sessionCookie ? { Cookie: this.sessionCookie } : {};
  }

  private rememberCookies(headers: Headers) {
    const setCookies = this.readSetCookieHeaders(headers);
    if (!setCookies.length) return;

    const jar = new Map<string, string>();
    for (const part of this.sessionCookie.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name && value.length) jar.set(name, value.join('='));
    }

    for (const cookie of setCookies) {
      const first = cookie.split(';')[0]?.trim();
      const [name, ...value] = (first || '').split('=');
      if (name && value.length) jar.set(name, value.join('='));
    }

    this.sessionCookie = Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private readSetCookieHeaders(headers: Headers): string[] {
    const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    const cookies = withGetSetCookie.getSetCookie?.();
    if (cookies?.length) return cookies;
    const single = headers.get('set-cookie');
    return single ? [single] : [];
  }

  private parse(text: string) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
