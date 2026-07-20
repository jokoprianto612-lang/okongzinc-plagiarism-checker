export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // HANDLER KHUSUS UNTUK MCP ENDPOINT
    // ==========================================
    if (url.pathname === '/mcp') {
      // Respons untuk MCP client (Claude, Windsurf, dll)
      return new Response(JSON.stringify({
        status: 'ok',
        message: 'MCP Server untuk Cloudflare Tasks',
        version: '1.0.0',
        endpoints: {
          tasks: '/Tasks',
          docs: '/'
        }
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ==========================================
    // HANDLER UNTUK API TASKS (YANG SUDAH ADA)
    // ==========================================
    // GET /Tasks - Ambil semua task
    if (url.pathname === '/Tasks' && request.method === 'GET') {
      // Contoh data (nanti bisa diganti dengan database)
      const sampleTasks = [
        { id: 1, name: 'Belajar MCP', completed: false },
        { id: 2, name: 'Deploy Worker', completed: true }
      ];
      return new Response(JSON.stringify(sampleTasks), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // POST /Tasks - Buat task baru
    if (url.pathname === '/Tasks' && request.method === 'POST') {
      try {
        const body = await request.json();
        return new Response(JSON.stringify({
          success: true,
          task: {
            id: Date.now(),
            ...body,
            created_at: new Date().toISOString()
          }
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // ==========================================
    // RESPON DEFAULT (Root path)
    // ==========================================
    return new Response(`
      🚀 MCP Server aktif!
      
      Endpoint yang tersedia:
      - /mcp  → Untuk koneksi MCP client
      - /Tasks → API Tasks (GET, POST)
      - /     → Dokumentasi Swagger UI
    `, {
      headers: { 'Content-Type': 'text/plain' }
    });
  }
};