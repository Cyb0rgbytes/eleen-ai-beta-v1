export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Serve index.html for root path
    if (url.pathname === '/') {
      const html = await env.ASSETS.fetch(new URL(request.url)).then(res => res.text());
      return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }
    
    // Let assets handle other requests (CSS, JS, images)
    return env.ASSETS.fetch(request);
  }
};
