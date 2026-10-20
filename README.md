# afezapi - 安福二中论坛后端

Cloudflare Workers + D1

## 配置已写好

- D1 名称: **efez**
- D1 ID: `19c5a46f-36df-4072-9827-960c279319b0`
- Workers URL: https://afezapi.yixuanliu483.workers.dev

## 部署步骤

```bash
# 1. 建表（只需执行一次）
npx wrangler d1 execute efez --file=./schema.sql --remote

# 2. 部署
npx wrangler deploy
```

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/auth/register | 注册（仅QQ邮箱） |
| POST | /api/auth/login | 登录 |
| POST | /api/auth/logout | 退出 |
| GET  | /api/user/me | 当前用户信息 |
| GET  | / 或 /api/health | 健康检查 |
