import {
  json, error, getAuthUser, isStaff, ensureBoard,
  handleSendCode, handleRegister, handleLogin, handleLogout, handleMe,
  handleBoards, handleListPosts
} from './part1.js';

export async function handleGetPost(request, env, postId) {
  let post;
  try {
    post = await env.DB.prepare(`SELECT p.*, COALESCE(p.like_count,0) as like_count, COALESCE(p.is_anonymous,0) as is_anonymous, u.uid, u.nickname, u.avatar, b.name as board_name FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN boards b ON b.id = p.board_id WHERE p.id = ?`).bind(postId).first();
  } catch {
    post = await env.DB.prepare(`SELECT p.*, u.uid, u.nickname, u.avatar, b.name as board_name FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN boards b ON b.id = p.board_id WHERE p.id = ?`).bind(postId).first();
  }
  if (!post) return error('帖子不存在', 404);
  if (post.is_hidden) {
    const user = await getAuthUser(request, env);
    if (!user || !isStaff(user)) return error('帖子不存在或已处理', 404);
  }
  await env.DB.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').bind(postId).run();
  const comments = await env.DB.prepare(`SELECT c.id, c.content, c.parent_id, c.created_at, u.uid, u.nickname, u.avatar FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id ASC`).bind(postId).all();
  await ensureVoteTables(env);
  const user = await getAuthUser(request, env);
  const votes = await getVoteStats(env, postId, user && user.id);
  post.is_reported = post.is_reported ? 1 : 0;
  return json({ post, comments: comments.results || [], votes });
}

export async function handleCreatePost(request, env) {
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

export async function handleLikePost(request, env, postId) {
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

export async function handleCreateComment(request, env, postId) {
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

export async function handleDeletePost(request, env, postId) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const post = await env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  if (!isStaff(user) && post.user_id !== user.id) return error('无权限', 403);
  await env.DB.prepare('DELETE FROM comments WHERE post_id = ?').bind(postId).run();
  try { await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ?').bind(postId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM post_votes WHERE post_id = ?').bind(postId).run(); } catch (_) {}
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
  return json({ ok: true, message: '已删除' });
}

export async function ensureVoteTables(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS post_votes (
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      vote TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id)
    )`).run();
  } catch (_) {}
  try { await env.DB.prepare(`ALTER TABLE posts ADD COLUMN is_hidden INTEGER DEFAULT 0`).run(); } catch (_) {}
  try { await env.DB.prepare(`ALTER TABLE posts ADD COLUMN hide_reason TEXT`).run(); } catch (_) {}
  try { await env.DB.prepare(`ALTER TABLE posts ADD COLUMN is_reported INTEGER DEFAULT 0`).run(); } catch (_) {}
}

async function getVoteStats(env, postId, userId) {
  const rows = await env.DB.prepare('SELECT vote, COUNT(*) as c FROM post_votes WHERE post_id = ? GROUP BY vote').bind(postId).all();
  let violation = 0, normal = 0;
  for (const r of (rows.results || [])) {
    if (r.vote === 'violation') violation = r.c;
    if (r.vote === 'normal') normal = r.c;
  }
  let my_vote = null;
  if (userId) {
    const mine = await env.DB.prepare('SELECT vote FROM post_votes WHERE post_id = ? AND user_id = ?').bind(postId, userId).first();
    if (mine) my_vote = mine.vote;
  }
  return { violation, normal, total: violation + normal, my_vote };
}

export async function handleReportPost(request, env, postId) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  await ensureVoteTables(env);
  const post = await env.DB.prepare('SELECT id, COALESCE(is_hidden,0) as is_hidden, COALESCE(is_reported,0) as is_reported FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  if (post.is_hidden) return error('该帖已进入处理流程', 400);
  if (!post.is_reported) {
    await env.DB.prepare('UPDATE posts SET is_reported = 1 WHERE id = ?').bind(postId).run();
  }
  try {
    await env.DB.prepare('INSERT INTO post_votes (post_id, user_id, vote) VALUES (?, ?, ?)').bind(postId, user.id, 'violation').run();
  } catch (_) {}
  const stats = await getVoteStats(env, postId, user.id);
  return json({ ok: true, is_reported: 1, ...stats, message: '已举报并投违规票，帖子进入社区表决' });
}

export async function handleVotePost(request, env, postId) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const body = await request.json().catch(() => null);
  const vote = body && body.vote;
  if (vote !== 'violation' && vote !== 'normal') return error('请选择：违规 或 正常');
  await ensureVoteTables(env);
  const post = await env.DB.prepare('SELECT id, COALESCE(is_hidden,0) as is_hidden, COALESCE(is_reported,0) as is_reported FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  if (post.is_hidden) return error('该帖已进入处理流程', 400);
  if (!post.is_reported) return error('该帖尚未被举报，无法表决', 400);
  const existing = await env.DB.prepare('SELECT vote FROM post_votes WHERE post_id = ? AND user_id = ?').bind(postId, user.id).first();
  if (existing) {
    return error('你已经投过票了（当前：' + (existing.vote === 'violation' ? '违规' : '正常') + '）', 400);
  }
  await env.DB.prepare('INSERT INTO post_votes (post_id, user_id, vote) VALUES (?, ?, ?)').bind(postId, user.id, vote).run();
  const stats = await getVoteStats(env, postId, user.id);
  let hidden = false;
  if (stats.total >= 5 && stats.violation / stats.total > 3 / 5) {
    await env.DB.prepare(`UPDATE posts SET is_hidden = 1, hide_reason = ? WHERE id = ?`).bind('社区表决违规≥3/5，已交管理员', postId).run();
    hidden = true;
  }
  return json({ ok: true, is_reported: 1, ...stats, hidden, message: hidden ? '表决通过：帖子已隐藏并移交管理员' : '投票成功' });
}

export async function handleGetVotes(request, env, postId) {
  await ensureVoteTables(env);
  const post = await env.DB.prepare('SELECT id, COALESCE(is_reported,0) as is_reported, COALESCE(is_hidden,0) as is_hidden FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  const user = await getAuthUser(request, env);
  const stats = await getVoteStats(env, postId, user && user.id);
  return json({ is_reported: !!post.is_reported, is_hidden: !!post.is_hidden, ...stats });
}

export async function handleWithdrawPost(request, env, postId) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const post = await env.DB.prepare('SELECT id, user_id FROM posts WHERE id = ?').bind(postId).first();
  if (!post) return error('帖子不存在', 404);
  if (post.user_id !== user.id) return error('只能撤回自己的帖子', 403);
  await env.DB.prepare('DELETE FROM comments WHERE post_id = ?').bind(postId).run();
  try { await env.DB.prepare('DELETE FROM post_likes WHERE post_id = ?').bind(postId).run(); } catch (_) {}
  try { await env.DB.prepare('DELETE FROM post_votes WHERE post_id = ?').bind(postId).run(); } catch (_) {}
  await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(postId).run();
  return json({ ok: true, message: '已撤回' });
}

export async function handleAdminListPosts(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  if (!isStaff(user)) return error('无权限', 403);
  await ensureVoteTables(env);
  try {
    const rows = await env.DB.prepare(`SELECT p.id, p.board_id, p.title, p.content, p.view_count, p.reply_count,
      COALESCE(p.like_count,0) as like_count, COALESCE(p.is_hidden,0) as is_hidden,
      COALESCE(p.is_reported,0) as is_reported, p.hide_reason, p.created_at, u.uid, u.nickname
      FROM posts p JOIN users u ON u.id = p.user_id
      ORDER BY COALESCE(p.is_hidden,0) DESC, COALESCE(p.is_reported,0) DESC, p.id DESC LIMIT 100`).all();
    return json({ posts: rows.results || [] });
  } catch {
    const rows = await env.DB.prepare(`SELECT p.id, p.board_id, p.title, p.content, p.view_count, p.reply_count, p.created_at, u.uid, u.nickname FROM posts p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 100`).all();
    return json({ posts: rows.results || [] });
  }
}

export async function handleListMarket(request, env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'on_sale',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
  } catch (_) {}
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  let sql = `SELECT m.*, u.uid, u.nickname FROM market_items m JOIN users u ON u.id = m.user_id WHERE m.status = 'on_sale'`;
  const params = [];
  if (q) { sql += ` AND (m.title LIKE ? OR m.description LIKE ?)`; params.push('%'+q+'%', '%'+q+'%'); }
  sql += ' ORDER BY m.id DESC LIMIT 50';
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ items: rows.results || [] });
}

export async function handleGetMarketItem(request, env, id) {
  const row = await env.DB.prepare(`SELECT m.*, u.uid, u.nickname FROM market_items m JOIN users u ON u.id = m.user_id WHERE m.id = ?`).bind(id).first();
  if (!row) return error('商品不存在', 404);
  return json({ item: row });
}

export async function handleCreateMarketItem(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const body = await request.json().catch(() => null);
  if (!body || !body.title) return error('请填写标题');
  const price = parseFloat(body.price);
  if (isNaN(price) || price < 0) return error('请填写正确价格');
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'on_sale',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
  } catch (_) {}
  const result = await env.DB.prepare(`INSERT INTO market_items (user_id, title, price, description) VALUES (?, ?, ?, ?)`)
    .bind(user.id, String(body.title).trim().slice(0, 60), price, (body.description || '').trim()).run();
  return json({ ok: true, id: result.meta?.last_row_id, message: '发布成功' });
}

export async function handleSoldMarketItem(request, env, id) {
  const user = await getAuthUser(request, env);
  if (!user) return error('请先登录', 401);
  const item = await env.DB.prepare('SELECT id, user_id FROM market_items WHERE id = ?').bind(id).first();
  if (!item) return error('商品不存在', 404);
  if (item.user_id !== user.id && !isStaff(user)) return error('无权限', 403);
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
        },
      });
    }
    try {
      const path = new URL(request.url).pathname;
      if (path === '/' || path === '/api/health') return json({ status: 'ok', name: '安福二中论坛 API' });
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
      const reportMatch = path.match(/^\/api\/posts\/(\d+)\/report$/);
      if (reportMatch && request.method === 'POST') return await handleReportPost(request, env, parseInt(reportMatch[1], 10));
      const voteMatch = path.match(/^\/api\/posts\/(\d+)\/vote$/);
      if (voteMatch && request.method === 'POST') return await handleVotePost(request, env, parseInt(voteMatch[1], 10));
      if (voteMatch && request.method === 'GET') return await handleGetVotes(request, env, parseInt(voteMatch[1], 10));
      const withdrawMatch = path.match(/^\/api\/posts\/(\d+)\/withdraw$/);
      if (withdrawMatch && request.method === 'POST') return await handleWithdrawPost(request, env, parseInt(withdrawMatch[1], 10));
      const commentMatch = path.match(/^\/api\/posts\/(\d+)\/comments$/);
      if (commentMatch && request.method === 'POST') return await handleCreateComment(request, env, parseInt(commentMatch[1], 10));
      if (path === '/api/admin/posts' && request.method === 'GET') return await handleAdminListPosts(request, env);
      if (path === '/api/market' && request.method === 'GET') return await handleListMarket(request, env);
      if (path === '/api/market' && request.method === 'POST') return await handleCreateMarketItem(request, env);
      const marketMatch = path.match(/^\/api\/market\/(\d+)$/);
      if (marketMatch && request.method === 'GET') return await handleGetMarketItem(request, env, parseInt(marketMatch[1], 10));
      const marketSold = path.match(/^\/api\/market\/(\d+)\/sold$/);
      if (marketSold && request.method === 'POST') return await handleSoldMarketItem(request, env, parseInt(marketSold[1], 10));
      return error('接口不存在', 404);
    } catch (e) {
      return error('服务器内部错误: ' + e.message, 500);
    }
  },
};
