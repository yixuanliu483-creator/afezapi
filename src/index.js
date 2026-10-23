/**
 * 安福二中论坛 API - Workers + D1
 * (restored - see migration notes)
 */
const PBKDF2_ITERATIONS = 100000;
export default {
  async fetch(request, env) {
    return new Response(JSON.stringify({ status: 'ok', name: '安福二中论坛 API', note: 'deploying full code' }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
};
