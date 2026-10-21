import { timingSafeEqual } from 'node:crypto';

export function adminAuthorized(req, token) {
  if (!token) return false;
  const provided = (req.headers.authorization || '').replace(/^Bearer /, '');
  const actual = Buffer.from(provided),
    expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function protectApi(req, res, next) {
  const publicPaths = ['/state', '/events', '/screen', '/coverage'];
  const readOnly =
    req.method === 'GET' &&
    (publicPaths.includes(req.path) || /^\/stocks\/[A-Z0-9-]{1,15}$/i.test(req.path));
  if (readOnly) return next();
  if (adminAuthorized(req, process.env.ADMIN_TOKEN)) return next();
  return res.status(process.env.ADMIN_TOKEN ? 401 : 503).json({
    error: process.env.ADMIN_TOKEN
      ? '此操作需要管理员身份。'
      : '管理员操作尚未启用，请配置 ADMIN_TOKEN。',
  });
}
