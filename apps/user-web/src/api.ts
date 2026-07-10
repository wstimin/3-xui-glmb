type ApiOptions = Omit<RequestInit, 'body'> & { body?: unknown };

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, ...requestOptions } = options;
  const response = await fetch(path, {
    credentials: 'include',
    ...requestOptions,
    headers: {
      'content-type': 'application/json',
      ...requestOptions.headers
    },
    body: typeof body === 'string' || !body ? body as BodyInit | null | undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) throw new Error(payload?.message || `请求失败：${response.status}`);
  return payload?.data ?? payload;
}
