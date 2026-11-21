# Vercel API Gateway + HostBot Worker

HostBot's HTTP API is exposed through Vercel Functions, while the stateful hosting worker remains on a Linux VPS. The Vercel function is a reverse proxy only; it does not run Docker, store bot source files, or maintain background connections.

## Architecture

- Vercel project: repository root (`.`), deploys `api/[...path].ts`.
- Worker VPS: runs the existing `apps/api` Fastify process and Docker daemon.
- Supabase: persistent database.
- Web dashboard: uses the Vercel API URL as `API_BASE_URL`.
- Management bot in Docker Compose: keeps using the private Docker-network URL `http://api:3001`, so ZIP uploads bypass Vercel request-body limits.
- The Vercel gateway forwards requests to the worker over HTTPS and adds a private proxy header.

The worker must remain running on the VPS. Do not deploy `apps/api/src/index.ts` as a Vercel Function: it starts Docker, a scheduler, a Pushbullet WebSocket, and relies on persistent local disk.

## Vercel project

Create a separate Vercel project connected to this repository:

- Project name: `hostbot-api`
- Root Directory: repository root (`.`)
- Framework Preset: Other
- Build Command: leave empty
- Output Directory: leave empty
- Install Command: `npm install`

Set these Production and Preview environment variables:

- `WORKER_API_URL`: public HTTPS origin of the worker, for example `https://worker.example.com`. Do not include an API path.
- `WORKER_PROXY_SECRET`: a random secret of at least 32 bytes. Use the exact same value on the worker VPS.

After setting the variables, deploy. The public API URL is the Vercel deployment domain. Set that URL as `API_BASE_URL` in the dashboard and management bot.

## Worker VPS

Keep the existing Docker Compose deployment for `apps/api` and the management bot. Add this variable to the API service environment:

```env
WORKER_PROXY_SECRET=<same random secret as Vercel>
```

When this variable is set, the API accepts either the private gateway header or the existing authenticated management/admin API keys. This keeps the management bot working over the private Docker network while the dashboard and webhook traffic can pass through Vercel. Keep the worker origin HTTPS-only and restrict inbound traffic to the Vercel gateway and trusted management-bot network where practical. Keep Docker enabled only on this worker.

The worker still needs the existing application variables, including Supabase credentials, `BOT_API_KEY`, `ADMIN_API_KEY`, and `TOKEN_ENCRYPTION_KEY`. Do not put these values in public client-side variables.

## Upload size limitation

The existing product accepts ZIP files up to 20 MiB. Vercel Functions currently impose a smaller request-body limit on the Hobby plan (4.5 MB). Therefore, ZIP uploads larger than that must be sent directly to the worker or moved to a direct-to-object-storage upload flow; do not increase the advertised ZIP limit or assume the gateway can proxy 20 MiB uploads on Hobby. Other API requests continue to use the Vercel URL.

## Health check

After deployment and worker configuration, request `/health` on the Vercel API domain. A successful response comes from the worker and reports `service: "hostbot-api"`.