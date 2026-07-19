export type XuiAuth =
  | { kind: 'token'; token: string }
  | { kind: 'password'; username: string; password: string; twoFactorCode?: string };

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

export type XuiFormRequestOptions = Omit<XuiRequestOptions, 'body'> & { body?: Record<string, unknown> };

export class XuiClientError extends Error {
  constructor(message: string, readonly status?: number, readonly payload?: unknown) {
    super(message);
  }
}

export class XuiClient {
  private readonly fetchImpl: typeof fetch;
  private sessionCookie = '';
  private csrfToken = '';

  constructor(private readonly options: XuiClientOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async request<T>(endpoint: string, options: XuiRequestOptions = {}): Promise<T> {
    const method = options.method || (options.body ? 'POST' : 'GET');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.authHeaders(),
      ...this.cookieHeaders(),
      ...this.csrfHeaders(method),
      ...options.headers
    };

    const response = await this.fetchImpl(this.url(endpoint), {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const text = await response.text();
    this.rememberCookies(response.headers);
    const payload = text ? this.parse(text) : null;
    this.assertResponse(response, payload);
    return payload as T;
  }

  async formRequest<T>(endpoint: string, options: XuiFormRequestOptions = {}): Promise<T> {
    const method = options.method || (options.body ? 'POST' : 'GET');
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...this.authHeaders(),
      ...this.cookieHeaders(),
      ...this.csrfHeaders(method),
      ...options.headers
    };

    const response = await this.fetchImpl(this.url(endpoint), {
      method,
      headers,
      body: options.body ? this.encodeForm(options.body) : undefined
    });

    const text = await response.text();
    this.rememberCookies(response.headers);
    const payload = text ? this.parse(text) : null;
    this.assertResponse(response, payload);
    return payload as T;
  }

  async login(body: { username: string; password: string; twoFactorCode?: string }) {
    const payload = await this.request('/login', { method: 'POST', body });
    if (this.options.auth?.kind !== 'token') await this.initializeCookieSession();
    return payload;
  }

  async getCsrfToken() {
    const payload = await this.request<unknown>('/csrf-token');
    const object = this.asObject(payload);
    const token = object.obj ?? object.data ?? object.token;
    if (typeof token !== 'string' || !token) {
      throw new XuiClientError('3x-ui did not return a CSRF token', 200, payload);
    }
    this.csrfToken = token;
    return token;
  }

  listInbounds() {
    return this.request('/panel/api/inbounds/list');
  }

  inboundOptions() {
    return this.request('/panel/api/inbounds/options');
  }

  getInbound(id: number) {
    return this.request(`/panel/api/inbounds/get/${encodeURIComponent(String(id))}`);
  }

  getWebCertFiles() {
    return this.request('/panel/api/server/getWebCertFiles');
  }

  getNewX25519Cert() {
    return this.request('/panel/api/server/getNewX25519Cert');
  }

  scanRealityTarget(target: string) {
    return this.formRequest('/panel/api/server/scanRealityTarget', { method: 'POST', body: { target } });
  }

  scanRealityTargets(targets?: string) {
    return this.formRequest('/panel/api/server/scanRealityTargets', { method: 'POST', body: { targets: targets || '' } });
  }

  addInbound(body: unknown) {
    return this.request('/panel/api/inbounds/add', { method: 'POST', body });
  }

  updateInbound(id: number, body: unknown) {
    return this.request(`/panel/api/inbounds/update/${encodeURIComponent(String(id))}`, { method: 'POST', body });
  }

  deleteInbound(id: number) {
    return this.request(`/panel/api/inbounds/del/${encodeURIComponent(String(id))}`, { method: 'POST' });
  }

  setInboundEnable(id: number, enable: boolean) {
    return this.request(`/panel/api/inbounds/setEnable/${encodeURIComponent(String(id))}`, { method: 'POST', body: { enable } });
  }

  resetInboundTraffic(id: number) {
    return this.request(`/panel/api/inbounds/${encodeURIComponent(String(id))}/resetTraffic`, { method: 'POST' });
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

  clientTraffic(email: string) {
    return this.request(`/panel/api/clients/traffic/${encodeURIComponent(email)}`);
  }

  clientsLastOnline() {
    return this.request('/panel/api/clients/lastOnline', { method: 'POST' });
  }

  onlineClients() {
    return this.request('/panel/api/clients/onlines', { method: 'POST' });
  }

  clientLinks(email: string) {
    return this.request(`/panel/api/clients/links/${encodeURIComponent(email)}`);
  }

  subLinks(subId: string) {
    return this.request(`/panel/api/clients/subLinks/${encodeURIComponent(subId)}`);
  }

  getXrayConfig() {
    return this.request('/panel/api/xray/', { method: 'POST' });
  }

  listOutboundSubscriptions() {
    return this.request('/panel/api/xray/outbound-subs');
  }

  refreshOutboundSubscription(id: number | string) {
    return this.request(`/panel/api/xray/outbound-subs/${encodeURIComponent(String(id))}/refresh`, { method: 'POST' });
  }

  updateXrayConfig(body: { xraySetting: string; outboundTestUrl?: string }) {
    return this.formRequest('/panel/api/xray/update', { method: 'POST', body });
  }

  restartXrayService() {
    return this.request('/panel/api/server/restartXrayService', { method: 'POST' });
  }

  serverStatus() {
    return this.request('/panel/api/server/status');
  }

  getXrayVersion() {
    return this.request('/panel/api/server/getXrayVersion');
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

  private csrfHeaders(method: XuiRequestOptions['method']): Record<string, string> {
    const unsafe = method && !['GET'].includes(method);
    if (this.options.auth?.kind === 'token' || !unsafe || !this.csrfToken) return {};
    return { 'X-CSRF-Token': this.csrfToken };
  }

  private async initializeCookieSession() {
    try {
      await this.getCsrfToken();
    } catch (error) {
      if (this.isUnsupportedCsrf(error)) return;
      throw error;
    }
  }

  private isUnsupportedCsrf(error: unknown) {
    if (!(error instanceof XuiClientError)) return false;
    if (error.status === 404 || error.status === 405) return true;
    return /not found|not implemented|unsupported|unknown route|cannot get \/csrf-token/i.test(this.errorMessage(error.payload));
  }

  private assertResponse(response: Response, payload: unknown) {
    const object = this.asObject(payload);
    const message = this.errorMessage(payload);
    if (!response.ok) {
      throw new XuiClientError(message || `3x-ui request failed: ${response.status}`, response.status, payload);
    }
    if (object.success === false) {
      throw new XuiClientError(message || '3x-ui returned success=false', response.status, payload);
    }
  }

  private errorMessage(payload: unknown) {
    const object = this.asObject(payload);
    const message = object.msg ?? object.message ?? object.error;
    return typeof message === 'string' ? message : '';
  }

  private asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

  private encodeForm(body: Record<string, unknown>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      params.append(key, value === null ? '' : String(value));
    }
    return params.toString();
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
