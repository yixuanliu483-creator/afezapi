/** Runtime load known-good worker source */
export default {
  async fetch(request, env, ctx) {
    try {
      if (!globalThis.__AFEZ) {
        const urls = [
          'https://cdn.jsdelivr.net/gh/yixuanliu483-creator/afezapi@8a47e95dab5b53cdab0e2b76b639551456a914c8/src/index.js',
          'https://raw.githubusercontent.com/yixuanliu483-creator/afezapi/8a47e95dab5b53cdab0e2b76b639551456a914c8/src/index.js'
        ];
        let code = null;
        for (const u of urls) {
          try {
            const r = await fetch(u);
            if (r.ok) { code = await r.text(); break; }
          } catch (_) {}
        }
        if (!code) return new Response(JSON.stringify({ error: 'API 源加载失败' }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        const code2 = code.replace(/export\s+default\s+/, 'module.exports = ');
        const mod = { exports: {} };
        new Function('module', 'exports', code2)(mod, mod.exports);
        globalThis.__AFEZ = mod.exports;
      }
      return globalThis.__AFEZ.fetch(request, env, ctx);
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }
  }
};
