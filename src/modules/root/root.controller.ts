import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { resolveDashboardIndex } from '../../common/utils/dashboard-dist';
import { Public } from '../auth/decorators/auth.decorators';

@Controller()
export class RootController {
  /**
   * The dashboard, when it has been built.
   *
   * It used to redirect to DASHBOARD_URL instead, which pointed at a second port with
   * nothing listening behind it, so the link was a dead end. Serving the same SPA from here
   * means the landing URL a user actually types is the working dashboard. If the build is
   * missing, fall through to the API-only page rather than a blank screen.
   */
  @Public()
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  getRoot(@Res() res: Response): void {
    const indexFile = resolveDashboardIndex();

    if (indexFile) {
      res.sendFile(indexFile);
      return;
    }

    res.send(`<!DOCTYPE html>
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
    <div class="links">
      <a href="/api/docs">API Docs</a>
      <a href="/api/health">Health Check</a>
    </div>
    <p style="margin-top:1.5rem;font-size:0.8rem;opacity:0.6">
      Dashboard not built. Run: <code>npm --prefix dashboard run build</code>
    </p>
  </div>
</body>
</html>`);
  }
}
