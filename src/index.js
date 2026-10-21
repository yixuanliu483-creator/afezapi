/**
 * 安福二中论坛 API - Workers + D1
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
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
}
function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
function isStaff(user) {
  return user && (user.role === 'admin' || user.role === 'owner');
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
  if (!apiKey) { console.log(`[DEV] 验证码 ${code} -> ${toEmail}`); return { ok: true, dev: true }; }
  const from = env.EMAIL_FROM || '安福二中论坛 <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: [toEmail], subject: '【安福二中论坛】邮箱验证码',
      html: `<div style="font-family:sans-serif;padding:20px"><h2>安福二中论坛</h2><p style="font-size:28px;font-weight:bold;color:#7c3aed">${code}</p><p>${CODE_TTL_MINUTES}分钟内有效</p></div>`,
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
  return json({ token, user: { uid, email: emailLower, nickname: nickname.trim(), avatar: null, role: 'user' } });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');
  const { email, password } = body;
  if (!email || !password) return error('请填写邮箱和密码');
  const emailLower = email.trim().toLowerCase();
  if (!isValidQQEmail(emailLower)) return error('仅支持纯数字QQ号@qq.com');
  let user;
  try {
    user = await env.DB.prepare('SELECT id, uid, email, nickname, password_hash, avatar, COALESCE(role, \'user\') as role FROM users WHERE email = ?').bind(emailLower).first();
  } catch {
    user = await env.DB.prepare('SELECT id, uid, email, nickname, password_hash, avatar FROM users WHERE email = ?').bind(emailLower).first();
    if (user) user.role = 'user';
  }
  if (!user) return error('账号不存在，请先注册', 401);
  if (!(await verifyPassword(password, user.password_hash))) return error('密码错误', 401);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).bind(token, user.id, expiresAt).run();
  return json({ token, user: { uid: user.uid, email: user.email, nickname: user.nickname, avatar: user.avatar, role: user.role || 'user' } });
}

async function handleMe(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return error('未登录', 401);
  let session;
  try {
    session = await env.DB.prepare(`SELECT s.expires_at, u.uid, u.email, u.nickname, u.avatar, u.created_at, COALESCE(u.role, 'user') as role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(token).first();
  } catch {
    session = await env.DB.prepare(`SELECT s.expires_at, u.uid, u.email, u.nickname, u.avatar, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(token).first();
    if (session) session.role = 'user';
  }
  if (!session) return error('登录已失效', 401);
  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
    return error('登录已过期', 401);
  }
  return json({ uid: session.uid, email: session.email, nickname: session.nickname, avatar: session.avatar, createdAt: session.created_at, role: session.role || 'user' });
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
  let session;
  try {
    session = await env.DB.prepare(`SELECT s.expires_at, u.id, u.uid, u.email, u.nickname, u.avatar, COALESCE(u.role, 'user') as role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(token).first();
  } catch {
    session = await env.DB.prepare(`SELECT s.expires_at, u.id, u.uid, u.email, u.nickname, u.avatar FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).bind(token).first();
    if (session) session.role = 'user';
  }
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(token).run();
    return null;
  }
  return session;
}

async function ensureBoard(env, board_id) {
  let board = await env.DB.prepare('SELECT id FROM boards WHERE id = ?').bind(board_id).first();
  if (board) return;
  const names = { daily: '日常', biaobai: '表白', xunwu: '寻物招领', help: '求助', study: '学习交流', anonymous: '匿名墙' };
  await env.DB.prepare('INSERT OR IGNORE INTO boards (id, name, icon, description, sort_order) VALUES (?, ?, ?, ?, 0)')
    .bind(board_id, names[board_id] || board_id, board_id === 'anonymous' ? '🎭' : (board_id === 'biaobai' ? '💕' : '📌'), '').run();
}

async function handleBoards(env) {
  const rows = await env.DB.prepare(`SELECT b.*, (SELECT COUNT(*) FROM posts p WHERE p.board_id = b.id) as post_count FROM boards b ORDER BY b.sort_order ASC`).all();
  return json({ boards: rows.results || [] });
}

async function handleListPosts(request, env) {
  const url = new URL(request.url);
  const boardId = url.searchParams.get('board') || '';
  const hot = url.searchParams.get('hot') === '1';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 20;
  const offset = (page - 1) * limit;
  let sql = `SELECT p.id, p.board_id, p.title, p.content, p.view_count, p.reply_count, p.is_pinned,
                    COALESCE(p.like_count, 0) as like_count, COALESCE(p.is_anonymous, 0) as is_anonymous,
                    p.created_at, p.updated_at, u.uid, u.nickname, u.avatar, b.name as board_name
             FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN boards b ON b.id = p.board_id`;
  const params = [];
  const where = [];
  if (boardId) { where.push('p.board_id = ?'); params.push(boardId); }
  if (hot) { where.push('COALESCE(p.like_count, 0) >= 5'); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += hot ? ' ORDER BY COALESCE(p.like_count, 0) DESC, p.updated_at DESC LIMIT ? OFFSET ?' : ' ORDER BY p.is_pinned DESC, p.updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  try {
    const rows = await env.DB.prepare(sql).bind(...params).all();
    return json({ posts: rows.results || [], page, limit });
  } catch (e) {
    let sql2 = `SELECT p.id, p.board_id, p.title, p.content, p.view_count, p.reply_count, p.is_pinned, p.created_at, p.updated_at, u.uid, u.nickname, u.avatar, b.name as board_name FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN boards b ON b.id = p.board_id`;
    const params2 = [];
    if (boardId) { sql2 += ' WHERE p.board_id = ?'; params2.push(boardId); }
    sql2 += ' ORDER BY p.is_pinned DESC, p.updated_at DESC LIMIT ? OFFSET ?';
    params2.push(limit, offset);
    const rows = await env.DB.prepare(sql2).bind(...params2).all();
    return json({ posts: (rows.results || []).map((p) => ({ ...p, like_count: 0, is_anonymous: p.board_id === 'anonymous' ? 1 : 0 })), page, limit });
  }
}

async function handleGetPost(request, env, postId) {
  let post;
  try {
    post = await env.DB.prepare(`SELECT p.*, COALESCE(p.like_count,0) as like_count, COALESCE(p.is_anonymous,0) as is_anonymous, u.uid, u.nickname, u.avatar, b.name as board_name FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN boards b ON b.id = p.board_id WHERE p.id = ?`).bind(postId).first();
  } catch {
    post = await env.DB.prepare(`SELECT p.*, u.uid, u.nickname, u.avatar, b.name as board_name FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN boards b ON b.id = p.board_id WHERE p.id = ?`).bind(postId).first();
  }
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
  let { board_id, title, content, is_anonymous } = body;
  if (!board_id || !title || !content) return error('请填写板块、标题和内容');
  if (title.trim().length < 2 || title.trim().length > 80) return error('标题长度 2-80 字');
  const isAnon = !!is_anonymous || board_id === 'anonymous';
  if (isAnon) board_id = 'anonymous';
  await ensureBoard(env, board_id);
  try {
    const result = await env.DB.prepare(`INSERT INTO posts (board_id, user_id, title, content, is_anonymous) VALUES (?, ?, ?, ?, ?)`).bind(board_id, user.id, title.trim(), content.trim(), isAnon ? 1 : 0).run();
    return json({ ok: true, id: result.meta?.last_row_id, message: '发帖成功' });
  } catch (e) {
    const result = await env.DB.prepare(`INSERT INTO posts (board_id, user_id, title, content) VALUES (?, ?, ?, ?)`).bind(board_id, user.id, title.trim(), content.trim()).run();
    return json({ ok: true, id: result.meta?.last_row_id, message: '发帖成功' });
  }
}

async function handleLikePost(request, env, postId) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS post_likes (post_id INTEGER NOT NULL, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (post_id, user_id))`).run();
  } catch (_) {}
  const existed = await env.DB.prepare('SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?').bind(postId, user.id).first();
  if (existed) {
    await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').bind(postId, user.id).run();
    try {
      await env.DB.prepare('UPDATE posts SET like_count = CASE WHEN COALESCE(like_count,0) > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?').bind(postId).run();
    } catch (_) {}
    let like_count = 0;
    try {
      const row = await env.DB.prepare('SELECT COALESCE(like_count, 0) as like_count FROM posts WHERE id = ?').bind(postId).first();
      like_count = row?.like_count || 0;
    } catch (_) {}
    return json({ ok: true, liked: false, like_count });
  }
  await env.DB.prepare('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)').bind(postId, user.id).run();
  try {
    await env.DB.prepare('UPDATE posts SET like_count = COALESCE(like_count, 0) + 1 WHERE id = ?').bind(postId).run();
  } catch (_) {}
  let like_count = 1;
  try {
    const row = await env.DB.prepare('SELECT COALESCE(like_count, 0) as like_count FROM posts WHERE id = ?').bind(postId).first();
    like_count = row?.like_count || 1;
  } catch (_) {}
  return json({ ok: true, liked: true, like_count });
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

async function handleDeletePost(request, env, postId) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  if (!isStaff(user)) return error('无权限', 403);
  const post = await env.DB.prepare('SELECT id FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  await env.DB.prepare('DELETE FROM comments WHERE post_id = ?').bind(postId).run();
  try { await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ?').bind(postId).run(); } catch (_) {}
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
  return json({ ok: true, message: '已删除' });
}

async function handleAdminListPosts(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  if (!isStaff(user)) return error('无权限', 403);
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 30;
  const offset = (page - 1) * limit;
  const rows = await env.DB.prepare(
    `SELECT p.id, p.board_id, p.title, p.content, p.view_count, p.reply_count,
            COALESCE(p.like_count,0) as like_count, COALESCE(p.is_anonymous,0) as is_anonymous,
            p.created_at, u.uid, u.nickname, b.name as board_name
     FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN boards b ON b.id = p.board_id
     ORDER BY p.id DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();
  return json({ posts: rows.results || [], page, limit });
}

async function handleListMarket(request, env) {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit = 20;
  const offset = (page - 1) * limit;
  const q = (url.searchParams.get('q') || '').trim();
  let sql = `SELECT m.id, m.title, m.description, m.price, m.status, m.created_at, u.uid, u.nickname, u.avatar FROM market_items m JOIN users u ON u.id = m.user_id WHERE m.status = 'available'`;
  const params = [];
  if (q) { sql += ` AND (m.title LIKE ? OR m.description LIKE ?)`; params.push('%' + q + '%', '%' + q + '%'); }
  sql += ' ORDER BY m.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ items: rows.results || [], page, limit });
}

async function handleGetMarketItem(request, env, id) {
  const item = await env.DB.prepare(`SELECT m.*, u.uid, u.nickname, u.avatar FROM market_items m JOIN users u ON u.id = m.user_id WHERE m.id = ?`).bind(id).first();
  if (!item) return error('商品不存在', 404);
  return json({ item });
}

async function handleCreateMarketItem(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const body = await request.json().catch(() => null);
  if (!body) return error('无效请求体');
  const title = (body.title || '').trim();
  const description = (body.description || '').trim();
  let price = body.price;
  if (!title || title.length < 2) return error('标题至少2个字');
  if (title.length > 60) return error('标题最多60字');
  if (price === undefined || price === null || price === '') return error('请填写价格');
  price = Number(price);
  if (isNaN(price) || price < 0) return error('价格不合法');
  const result = await env.DB.prepare(`INSERT INTO market_items (user_id, title, description, price, status) VALUES (?, ?, ?, ?, 'available')`).bind(user.id, title, description, price).run();
  return json({ ok: true, id: result.meta?.last_row_id, message: '发布成功' });
}

async function handleSoldMarketItem(request, env, id) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const item = await env.DB.prepare('SELECT id, user_id FROM market_items WHERE id = ?').bind(id).first();
  if (!item) return error('商品不存在', 404);
  if (item.user_id !== user.id) return error('只能操作自己的商品', 403);
  await env.DB.prepare(`UPDATE market_items SET status = 'sold' WHERE id = ?`).bind(id).run();
  return json({ ok: true, message: '已标记售出' });
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
      if (postMatch && request.method === 'DELETE') return await handleDeletePost(request, env, parseInt(postMatch[1], 10));
      const likeMatch = path.match(/^\/api\/posts\/(\d+)\/like$/);
      if (likeMatch && request.method === 'POST') return await handleLikePost(request, env, parseInt(likeMatch[1], 10));
      const commentMatch = path.match(/^\/api\/posts\/(\d+)\/comments$/);
      if (commentMatch && request.method === 'POST') return await handleCreateComment(request, env, parseInt(commentMatch[1], 10));
      if (path === '/api/admin/posts' && request.method === 'GET') return await handleAdminListPosts(request, env);
      if (path === '/api/market' && request.method === 'GET') return await handleListMarket(request, env);
      if (path === '/api/market' && request.method === 'POST') return await handleCreateMarketItem(request, env);
      const marketMatch = path.match(/^\/api\/market\/(\d+)$/);
      if (marketMatch && request.method === 'GET') return await handleGetMarketItem(request, env, parseInt(marketMatch[1], 10));
      const marketSold = path.match(/^\/api\/market\/(\d+)\/sold$/);
      if (marketSold && request.method === 'POST') return await handleSoldMarketItem(request, env, parseInt(marketSold[1], 10));
      if (path === '/' || path === '/api/health') return json({ status: 'ok', name: '安福二中论坛 API' });
      return error('接口不存在', 404);
    } catch (e) {
      console.error(e);
      return error('服务器内部错误: ' + e.message, 500);
    }
  },
};
