import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/decorators/auth.decorators';

@Controller()
export class RootController {
  @Public()
  @Get()
  getRoot(): string {
    const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:2886';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenWA - WhatsApp API Gateway</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #075e54; color: white; text-align: center; }
    .card { background: rgba(255,255,255,0.1); padding: 2rem; border-radius: 12px; max-width: 500px; }
    h1 { margin: 0 0 0.5rem; font-size: 2rem; }
    p { opacity: 0.8; margin: 0 0 1.5rem; }
    a { display: inline-block; padding: 0.75rem 1.5rem; background: #25d366; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; margin: 0.25rem; }
    a:hover { background: #1da851; }
    .links { margin-top: 1rem; }
    .links a { background: rgba(255,255,255,0.2); font-size: 0.875rem; }
    .links a:hover { background: rgba(255,255,255,0.3); }
  </style>
</head>
<body>
  <div class="card">
    <h1>OpenWA</h1>
    <p>Open Source WhatsApp API Gateway</p>
    <a href="${dashboardUrl}">Open Dashboard</a>
    <div class="links">
      <a href="/api/docs">API Docs</a>
      <a href="/api/health">Health Check</a>
    </div>
  </div>
</body>
</html>`;
  }
}
