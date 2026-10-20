/**
 * 安福二中论坛 API - Workers + D1
 * 密码 PBKDF2；注册验证码；贴吧帖子
 */
const PBKDF2_ITERATIONS = 100000;
const CODE_TTL_MINUTES = 10;
const CODE_COOLDOWN_SECONDS = 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}
function error(msg, status = 400) { return json({ error: msg }, status); }
function isValidQQEmail(email) { return /^\d{5,12}@qq\.com$/i.test(email); }
function padUid(num) { return String(num).padStart(7, '0'); }
function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function generateCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}
function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, keyMaterial, 256);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}
async function verifyPassword(password, stored) {
  if (!stored.startsWith('pbkdf2-sha256$')) {
    const data = new TextEncoder().encode(password + 'anfu-erzhong-salt-v1');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return toHex(hash) === stored;
  }
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromHex(parts[2]);
  const expected = parts[3];
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return toHex(bits) === expected;
}

async function sendEmailCode(env, toEmail, code) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`[DEV] 验证码 ${code} -> ${toEmail}`);
    return { ok: true, dev: true };
  }
  const from = env.EMAIL_FROM || '安福二中论坛 <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [toEmail], subject: '【安福二中论坛】邮箱验证码',
      html: `<div style="font-family:sans-serif;padding:20px"><h2>安福二中论坛</h2><p>验证码：</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#7c3aed">${code}</p><p>${CODE_TTL_MINUTES}分钟内有效</p></div>`,
      text: `验证码：${code}`,
    }),
  });
  if (!res.ok) return { ok: false, error: '邮件发送失败' };
  return { ok: true };
}

async function handleSendCode(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');
  const email = (body.email || '').trim().toLowerCase();
  const purpose = body.purpose || 'register';
  if (!isValidQQEmail(email)) return error('仅支持纯数字QQ号@qq.com');
  if (purpose === 'register') {
    const exist = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (exist) return error('该QQ邮箱已注册');
  }
  const recent = await env.DB.prepare(`SELECT created_at FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1`).bind(email, purpose).first();
  if (recent) {
    const created = new Date(String(recent.created_at).replace(' ', 'T') + (String(recent.created_at).endsWith('Z') ? '' : 'Z')).getTime();
    if (Date.now() - created < CODE_COOLDOWN_SECONDS * 1000) return error(`请 ${CODE_COOLDOWN_SECONDS} 秒后再获取验证码`);
  }
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO email_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)`).bind(email, code, purpose, expiresAt).run();
  const sent = await sendEmailCode(env, email, code);
  if (!sent.ok) return error(sent.error || '发送失败', 500);
  const resp = { ok: true, message: '验证码已发送' };
  if (sent.dev) { resp.dev_code = code; resp.message = '开发模式：验证码见 dev_code'; }
  return json(resp);
}

async function consumeCode(env, email, code, purpose) {
  const row = await env.DB.prepare(`SELECT id, expires_at, used FROM email_codes WHERE email = ? AND code = ? AND purpose = ? ORDER BY id DESC LIMIT 1`).bind(email, code, purpose).first();
  if (!row) return { ok: false, error: '验证码错误' };
  if (row.used) return { ok: false, error: '验证码已使用' };
  if (new Date(row.expires_at) < new Date()) return { ok: false, error: '验证码已过期' };
  await env.DB.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').bind(row.id).run();
  return { ok: true };
}

async function handleRegister(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');
  const { email, nickname, password, code } = body;
  if (!email || !nickname || !password || !code) return error('请填写完整信息（含验证码）');
  const emailLower = email.trim().toLowerCase();
  if (!isValidQQEmail(emailLower)) return error('仅支持纯数字QQ号@qq.com');
  if (nickname.length < 2 || nickname.length > 16) return error('昵称长度需 2-16 个字符');
  if (password.length < 6) return error('密码至少 6 位');
  const codeOk = await consumeCode(env, emailLower, String(code).trim(), 'register');
  if (!codeOk.ok) return error(codeOk.error);
  const exist = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailLower).first();
  if (exist) return error('该QQ邮箱已注册');
  const maxRow = await env.DB.prepare('SELECT MAX(id) as maxId FROM users').first();
  const nextId = (maxRow?.maxId || 0) + 1;
  const uid = padUid(nextId);
  const passwordHash = await hashPassword(password);
  await env.DB.prepare(`INSERT INTO users (uid, email, nickname, password_hash, email_verified) VALUES (?, ?, ?, ?, 1)`).bind(uid, emailLower, nickname.trim(), passwordHash).run();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const user = await env.DB.prepare('SELECT id FROM users WHERE uid = ?').bind(uid).first();
  await env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).bind(token, user.id, expiresAt).run();
  return json({ token, user: { uid, email: emailLower, nickname: nickname.trim(), avatar: null } });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');
  const { email, password } = body;
  if (!email || !password) return error('请填写邮箱和密码');
  const emailLower = email.trim().toLowerCase();
  if (!isValidQQEmail(emailLower)) return error('仅支持纯数字QQ号@qq.com');
  const user = await env.DB.prepare('SELECT id, uid, email, nickname, password_hash, avatar FROM users WHERE email = ?').bind(emailLower).first();
  if (!user) return error('账号不存在，请先注册', 401);
  if (!(await verifyPassword(password, user.password_hash))) return error('密码错误', 401);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).bind(token, user.id, expiresAt).run();
  return json({ token, user: { uid: user.uid, email: user.email, nickname: user.nickname, avatar: user.avatar } });
}

async function handleMe(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return error('未登录', 401);
  const session = await env.DB.prepare(`SELECT s.expires_at, u.uid, u.email, u.nickname, u.avatar, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(token).first();
  if (!session) return error('登录已失效', 401);
  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
    return error('登录已过期', 401);
  }
  return json({ uid: session.uid, email: session.email, nickname: session.nickname, avatar: session.avatar, createdAt: session.created_at });
}

async function handleLogout(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
  return json({ ok: true });
}

async function getAuthUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const session = await env.DB.prepare(`SELECT s.expires_at, u.id, u.uid, u.email, u.nickname, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(token).first();
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
    return null;
  }
  return session;
}

async function handleBoards(env) {
  const rows = await env.DB.prepare(`SELECT b.*, (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id) as post_count FROM boards b ORDER BY b.sort_order ASC`).all();
  return json({ boards: rows.results || [] });
}

async function handleListPosts(request, env) {
  const url = new URL(request.url);
  const boardId = url.searchParams.get('board') || '';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 20;
  const offset = (page - 1) * limit;
  let sql = `SELECT p.id, p.board_id, p.title, p.content, p.view_count, p.reply_count, p.is_pinned, p.created_at, p.updated_at, u.uid, u.nickname, u.avatar, b.name as board_name FROM posts p JOIN users u ON u.id = p.user_id JOIN boards b ON b.id = p.board_id`;
  const params = [];
  if (boardId) { sql += ' WHERE p.board_id = ?'; params.push(boardId); }
  sql += ' ORDER BY p.is_pinned DESC, p.updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ posts: rows.results || [], page, limit });
}

async function handleGetPost(request, env, postId) {
  const post = await env.DB.prepare(`SELECT p.*, u.uid, u.nickname, u.avatar, b.name as board_name FROM posts p JOIN users u ON u.id = p.user_id JOIN boards b ON b.id = p.board_id WHERE p.id = ?`).bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  await env.DB.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').bind(postId).run();
  const comments = await env.DB.prepare(`SELECT c.id, c.content, c.parent_id, c.created_at, u.uid, u.nickname, u.avatar FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id ASC`).bind(postId).all();
  return json({ post, comments: comments.results || [] });
}

async function handleCreatePost(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');
  const { board_id, title, content } = body;
  if (!board_id || !title || !content) return error('请填写板块、标题和内容');
  if (title.trim().length < 2 || title.trim().length > 80) return error('标题长度 2-80 字');
  const board = await env.DB.prepare('SELECT id FROM boards WHERE id = ?').bind(board_id).first();
  if (!board) return error('板块不存在');
  const result = await env.DB.prepare(`INSERT INTO posts (board_id, user_id, title, content) VALUES (?, ?, ?, ?)`).bind(board_id, user.id, title.trim(), content.trim()).run();
  return json({ ok: true, id: result.meta?.last_row_id, message: '发帖成功' });
}

async function handleCreateComment(request, env, postId) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const body = await request.json().catch(() => null);
  if (!body || !body.content) return error('请输入回复内容');
  const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  await env.DB.prepare(`INSERT INTO comments (post_id, user_id, content, parent_id) VALUES (?, ?, ?, ?)`).bind(postId, user.id, body.content.trim(), body.parent_id || null).run();
  await env.DB.prepare(`UPDATE posts SET reply_count = reply_count + 1, updated_at = datetime('now') WHERE id = ?`).bind(postId).run();
  return json({ ok: true, message: '回复成功' });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    const path = new URL(request.url).pathname;
    try {
      if (path === '/api/auth/send-code' && request.method === 'POST') return await handleSendCode(request, env);
      if (path === '/api/auth/register' && request.method === 'POST') return await handleRegister(request, env);
      if (path === '/api/auth/login' && request.method === 'POST') return await handleLogin(request, env);
      if (path === '/api/auth/logout' && request.method === 'POST') return await handleLogout(request, env);
      if (path === '/api/user/me' && request.method === 'GET') return await handleMe(request, env);
      if (path === '/api/boards' && request.method === 'GET') return await handleBoards(env);
      if (path === '/api/posts' && request.method === 'GET') return await handleListPosts(request, env);
      if (path === '/api/posts' && request.method === 'POST') return await handleCreatePost(request, env);
      const postMatch = path.match(/^\/api\/posts\/(\d+)$/);
      if (postMatch && request.method === 'GET') return await handleGetPost(request, env, parseInt(postMatch[1], 10));
      const commentMatch = path.match(/^\/api\/posts\/(\d+)\/comments$/);
      if (commentMatch && request.method === 'POST') return await handleCreateComment(request, env, parseInt(commentMatch[1], 10));
      if (path === '/' || path === '/api/health') return json({ status: 'ok', name: '安福二中论坛 API' });
      return error('接口不存在', 404);
    } catch (e) {
      console.error(e);
      return error('服务器内部错误: ' + e.message, 500);
    }
  },
};
