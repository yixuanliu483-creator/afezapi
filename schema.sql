-- 安福二中论坛 D1 数据库结构

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,          -- 内部自增ID
  uid TEXT NOT NULL UNIQUE,                      -- 对外显示的UID，如 0000001
  email TEXT NOT NULL UNIQUE,                    -- 必须是 数字@qq.com
  nickname TEXT NOT NULL,
  password_hash TEXT NOT NULL,                  -- 哈希后的密码，绝不存明文
  avatar TEXT,                                   -- 头像URL（可选）
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会话表（长期记住登录）
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                           -- session token
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 贴吧板块
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT,
  description TEXT,
  sort_order INTEGER DEFAULT 0
);

-- 帖子
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  view_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (board_id) REFERENCES boards(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 评论/回复
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  parent_id INTEGER,                             -- 楼中楼
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 跳蚤市场
CREATE TABLE IF NOT EXISTS market_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  price REAL,
  images TEXT,                                   -- JSON 数组
  status TEXT DEFAULT 'available',               -- available / sold / offline
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 初始化默认板块
INSERT OR IGNORE INTO boards (id, name, icon, description, sort_order) VALUES
  ('study', '学习交流', '📚', '作业、考试、学习方法', 1),
  ('life', '生活分享', '🏠', '校园生活、日常点滴', 2),
  ('club', '社团活动', '🎭', '社团招新、活动通知', 3),
  ('exam', '考试专区', '📝', '中考、期中期末', 4),
  ('help', '求助问答', '❓', '有问题就来问', 5),
  ('fun', '娱乐灌水', '🎮', '轻松聊天灌水', 6);

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board_id);
CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
