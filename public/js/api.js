// Thin fetch wrapper. Session auth rides on the cookie automatically;
// this module just centralizes error handling and query-building.
const BASE = '/api/v1';

class ApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

function qs(params) {
  if (!params) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function req(method, path, { body, params, form } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(BASE + path + qs(params), opts);
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 'network_error', 0);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const msg = (isJson && data.error?.message) || 'Something went wrong';
    throw new ApiError(msg, isJson ? data.error?.code : undefined, res.status);
  }
  return data;
}

export const api = {
  get: (path, params) => req('GET', path, { params }),
  post: (path, body) => req('POST', path, { body }),
  patch: (path, body) => req('PATCH', path, { body }),
  put: (path, body) => req('PUT', path, { body }),
  del: (path, body) => req('DELETE', path, { body }),
  postForm: (path, form) => req('POST', path, { form }),
  patchForm: (path, form) => req('PATCH', path, { form }),
  ApiError,
};
