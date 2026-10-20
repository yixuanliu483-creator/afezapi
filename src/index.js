/**
 * 安福二中论坛 API - Cloudflare Workers + D1
 * 仅支持 QQ 邮箱（纯数字@qq.com）注册登录
 */

// ---------- 工具函数 ----------
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...headers
    }
  });
}

function error(msg, status = 400) {
  return json({ error: msg }, status);
}

// 简单密码哈希（生产环境建议用 Web Crypto + 更强算法或 bcrypt 兼容库）
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'anfu-erzhong-salt-v1');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hash) {
  const h = await hashPassword(password);
  return h === hash;
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 校验 QQ 邮箱：本地部分必须是 5-12 位纯数字
function isValidQQEmail(email) {
  return /^\d{5,12}@qq\.com$/i.test(email);
}

function padUid(num) {
  return String(num).padStart(7, '0');
}

// ---------- 路由处理 ----------
async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');

  const { email, nickname, password } = body;
  if (!email || !nickname || !password) {
    return error('请填写完整信息');
  }

  const emailLower = email.trim().toLowerCase();
  if (!isValidQQEmail(emailLower)) {
    return error('仅支持纯数字QQ号@qq.com 格式的邮箱');
  }
  if (nickname.length < 2 || nickname.length > 16) {
    return error('昵称长度需 2-16 个字符');
  }
  if (password.length < 6) {
    return error('密码至少 6 位');
  }

  // 检查是否已注册
  const exist = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailLower).first();
  if (exist) return error('该QQ邮箱已注册');

  // 生成下一个 UID
  const maxRow = await env.DB.prepare('SELECT MAX(id) as maxId FROM users').first();
  const nextId = (maxRow?.maxId || 0) + 1;
  const uid = padUid(nextId);

  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    `INSERT INTO users (uid, email, nickname, password_hash) VALUES (?, ?, ?, ?)`
  ).bind(uid, emailLower, nickname.trim(), passwordHash).run();

  // 创建长期会话（90天）
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const user = await env.DB.prepare('SELECT id FROM users WHERE uid = ?').bind(uid).first();

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(token, user.id, expiresAt).run();

  return json({
    token,
    user: { uid, email: emailLower, nickname: nickname.trim(), avatar: null }
  });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');

  const { email, password } = body;
  if (!email || !password) return error('请填写邮箱和密码');

  const emailLower = email.trim().toLowerCase();
  if (!isValidQQEmail(emailLower)) {
    return error('仅支持纯数字QQ号@qq.com 格式的邮箱');
  }

  const user = await env.DB.prepare(
    'SELECT id, uid, email, nickname, password_hash, avatar FROM users WHERE email = ?'
  ).bind(emailLower).first();

  if (!user) return error('账号不存在，请先注册', 401);

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return error('密码错误', 401);

  // 新会话
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(token, user.id, expiresAt).run();

  return json({
    token,
    user: {
      uid: user.uid,
      email: user.email,
      nickname: user.nickname,
      avatar: user.avatar
    }
  });
}

async function handleMe(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return error('未登录', 401);

  const session = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.uid, u.email, u.nickname, u.avatar, u.created_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`
  ).bind(token).first();

  if (!session) return error('登录已失效', 401);
  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
    return error('登录已过期', 401);
  }

  return json({
    uid: session.uid,
    email: session.email,
    nickname: session.nickname,
    avatar: session.avatar,
    createdAt: session.created_at
  });
}

async function handleLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
  }
  return json({ ok: true });
}

// ---------- 主入口 ----------
export default {
  async fetch(request, env, ctx) {
    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 路由
      if (path === '/api/auth/register' && request.method === 'POST') {
        return await handleRegister(request, env);
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        return await handleLogin(request, env);
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        return await handleLogout(request, env);
      }
      if (path === '/api/user/me' && request.method === 'GET') {
        return await handleMe(request, env);
      }

      // 健康检查
      if (path === '/' || path === '/api/health') {
        return json({ status: 'ok', name: '安福二中论坛 API' });
      }

      return error('接口不存在', 404);
    } catch (e) {
      console.error(e);
      return error('服务器内部错误: ' + e.message, 500);
    }
  }
};
