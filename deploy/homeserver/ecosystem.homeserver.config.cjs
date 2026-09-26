// pm2 ecosystem untuk homeserver Windows (native Node, tanpa Docker).
//
// Beda dari ecosystem.config.cjs di root — JANGAN gabungkan keduanya:
//   root : dipakai image Docker produksi (vivobook). Di sana meridian-web WAJIB
//          listen di semua interface, karena Caddy menjangkaunya lewat DNS
//          container `meridian:3000` (bukan loopback).
//   ini  : satu PC, satu-satunya klien web adalah cloudflared di mesin yang sama,
//          jadi Next diikat ke 127.0.0.1 — tidak terekspos ke LAN sama sekali.
//
// Pakai:  pm2 start deploy/homeserver/ecosystem.homeserver.config.cjs
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");

module.exports = {
  apps: [
    {
      name: "meridian",
      script: path.join(repoRoot, "dist/entrypoints/daemon.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
        MERIDIAN_AUTONOMOUS: "true",
      },
    },
    {
      // Next.js dashboard. -H 127.0.0.1 = loopback saja; cloudflared jalan di
      // mesin ini juga, jadi tidak ada yang hilang. BRIDGE_URL/BRIDGE_TOKEN/
      // MERIDIAN_ROOT dibaca Next dari dashboard/web/.env.local.
      name: "meridian-web",
      script: path.join(repoRoot, "dashboard/web/node_modules/next/dist/bin/next"),
      args: "start -H 127.0.0.1 -p 3000",
      cwd: path.join(repoRoot, "dashboard/web"),
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
