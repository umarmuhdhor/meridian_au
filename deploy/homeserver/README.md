# Meridian di homeserver Windows — `au.alieffauzan.com` via Cloudflare Tunnel

Runbook untuk menjalankan Meridian (daemon + dashboard Next.js) di satu PC
Windows sebagai homeserver, diekspos ke internet lewat `cloudflared` **tanpa
membuka port apa pun di router** (tunnel outbound-only).

Berbeda dari `deploy/OPERATIONS.md` (vivobook, Docker, `calisto.nafidinara.com`).
Setup ini **native Node + pm2**, tanpa Docker, tanpa Caddy.

```
Browser ── https://au.alieffauzan.com
              │
              ▼
     Cloudflare edge (TLS, DNS, opsional Access)
              │  tunnel outbound-only, tidak ada port router yang dibuka
              ▼
     cloudflared (Windows service)  ──► http://localhost:3000
                                              │
                                    meridian-web (Next.js, pm2)
                                              │  http://127.0.0.1:8787 (bridge)
                                              ▼
                                       meridian (daemon, pm2)
                                              │
                                     data/*.json  (STATE_DIR)
```

**Dua pintu auth** di depan panel: Cloudflare Access (opsional, di edge) dan PIN
6 digit milik aplikasi (`middleware.ts` + iron-session). Bridge `8787` **tidak
pernah** terekspos ke internet — hanya listen di `127.0.0.1`.

---

## Prasyarat

| Item | Cek |
|---|---|
| Node ≥ 22 | `node -v` |
| pm2 global | `npm i -g pm2` |
| cloudflared | `cloudflared --version` — kalau belum: `winget install --id Cloudflare.cloudflared` |
| `alieffauzan.com` di Cloudflare | nameserver zone sudah `*.ns.cloudflare.com` |

---

## 1. Build

```powershell
cd D:\Abang\Agent\meridian_au
npm install
npm run build
cd dashboard\web; npm install; npm run build; cd ..\..
```

`postinstall` menjalankan `scripts/patch-anchor.js` — **wajib** di Node 22+, tanpa
itu `@meteora-ag/dlmm` gagal di-load (anchor ESM directory-import + export `BN`).

## 2. Konfigurasi

```powershell
copy deploy\homeserver\env.daemon.sample .env
copy user-config.example.json user-config.json
node scripts/setup-local-secrets.mjs
```

State (`state.json`, `lessons.json`, `decision-log.json`, …) tinggal di **root
repo**, bukan subfolder — semuanya sudah di-gitignore. Ini bukan selera:
daemon membaca `user-config.json` dari cwd (hardcoded), sedangkan dashboard
membaca seluruh file whitelist — `user-config.json` termasuk — dari satu folder
`MERIDIAN_ROOT`. Pisahkan keduanya dan halaman Config tampil **kosong tanpa
error**. Jadi `MERIDIAN_STATE_DIR` (daemon) dan `MERIDIAN_ROOT` (web) harus
sama-sama menunjuk root repo.

Script terakhir menanyakan PIN 6 digit (tidak di-echo), lalu menulis:

| File | Dibaca oleh | Isi |
|---|---|---|
| `.env` | daemon (dotenv) | `DASHBOARD_TOKEN`, `MERIDIAN_SESSION_SECRET`, `MERIDIAN_DASHBOARD_PIN_HASH` |
| `dashboard/web/.env.local` | Next.js (`next start`) | `BRIDGE_URL`, `BRIDGE_TOKEN`, `MERIDIAN_ROOT`, + dua yang sama di atas |

PIN disimpan sebagai `salt:scryptHash`, tidak pernah plaintext. Ganti PIN:
ulangi script. Rotasi token + secret sekalian: `--rotate`.

> Kedua proses **harus** punya `MERIDIAN_SESSION_SECRET` yang identik — cookie
> session di-seal daemon-side oleh Next dan di-unseal middleware. Script menjaga
> ini otomatis; jangan edit salah satunya manual.

## 3. Jalankan dengan pm2

```powershell
pm2 start ecosystem.config.cjs
pm2 save
pm2 status
```

Verifikasi lokal sebelum menyentuh Cloudflare:

```powershell
curl.exe -sI http://localhost:3000/login          # 200
curl.exe -s http://127.0.0.1:8787/health -H "Authorization: Bearer <DASHBOARD_TOKEN>"
```

### Auto-start saat PC boot

pm2 tidak punya `pm2 startup` di Windows. Pakai Task Scheduler:

```powershell
$node = "C:\Program Files\nodejs\node.exe"
$pm2  = "$env:APPDATA\npm\node_modules\pm2\bin\pm2"
$act  = New-ScheduledTaskAction -Execute $node -Argument "`"$pm2`" resurrect" -WorkingDirectory "D:\Abang\Agent\meridian_au"
$trg  = New-ScheduledTaskTrigger -AtStartup
$set  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0
Register-ScheduledTask -TaskName "meridian-pm2-resurrect" -Action $act -Trigger $trg -Settings $set -RunLevel Highest -User $env:USERNAME
```

`pm2 resurrect` memulihkan daftar proses dari `pm2 save` terakhir — jadi setiap
kali daftar proses berubah, jalankan `pm2 save` lagi.

Supaya PC tidak sleep dan mematikan tunnel:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

## 4. Cloudflare Tunnel

> ⚠️ `alieffauzan.com` punya record **wildcard `*`** yang mengarah ke Vercel.
> Menambah record eksplisit `au` **tidak** mengubah wildcard maupun root —
> Cloudflare selalu memilih record paling spesifik. Jangan hapus/ubah `*` atau `@`.

Pakai tunnel **remotely-managed** (dikonfigurasi dari dashboard Zero Trust) —
di Windows ini jauh lebih tahan banting daripada `config.yml` lokal, karena
service berjalan sebagai LocalSystem yang `%USERPROFILE%`-nya berbeda.

1. <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a tunnel**
2. Connector **Cloudflared**, nama misal `homeserver-au`, **Save**.
3. Pilih **Windows / 64-bit**. Salin perintah yang muncul — ada token panjang di
   ujungnya. Jalankan di **PowerShell as Administrator**:

   ```powershell
   cloudflared.exe service install eyJhIjoi...<token>
   ```

   Cek: `Get-Service cloudflared` → `Running`. Di dashboard connector jadi
   **HEALTHY**.

4. Tab **Routes** (UI lama: *Public Hostname*) → **+ Add route** → tipe
   **Published application** / *Public hostname*:

   | Field | Nilai | Jebakan |
   |---|---|---|
   | Subdomain | `au` | Dua huruf saja — bukan `au.alieffauzan.com`. |
   | Domain | `alieffauzan.com` | Dropdown zone. |
   | Path | *(kosong)* | Jangan isi `/`, dan jangan mengetik `HTTP` di sini. |
   | Type | `HTTP` | Bukan HTTPS — origin bicara HTTP polos, HTTPS → 502. |
   | URL | `localhost:3000` | Tanpa skema, tanpa trailing slash. |

   Baris hasilnya harus terbaca `au.alieffauzan.com` → `http://localhost:3000`.
   **Save**. Cloudflare otomatis membuat CNAME proxied `au` →
   `<tunnel-uuid>.cfargotunnel.com`. Hanya satu record yang ditambah; `@` dan
   wildcard `*` tidak tersentuh.

5. Buka <https://au.alieffauzan.com> → halaman PIN.

### Alternatif: tunnel locally-managed

Kalau lebih suka semuanya di file:

```powershell
cloudflared tunnel login                      # pilih zone alieffauzan.com
cloudflared tunnel create homeserver-au       # catat UUID
cloudflared tunnel route dns homeserver-au au.alieffauzan.com
```

`%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <UUID>
credentials-file: C:\Users\<user>\.cloudflared\<UUID>.json
ingress:
  - hostname: au.alieffauzan.com
    service: http://localhost:3000
  - service: http_status:404
```

Lalu `cloudflared --config C:\Users\<user>\.cloudflared\config.yml service install`
(Administrator). Kalau service gagal start, salin `config.yml` + `<UUID>.json`
ke `C:\Windows\System32\config\systemprofile\.cloudflared\`.

## 5. Cloudflare Access (opsional, sangat disarankan sebelum live)

Panel ini mengendalikan wallet. PIN 6 digit sendirian tipis untuk endpoint publik.

Zero Trust → **Access → Applications → Add an application** → Self-hosted:
- Application domain: `au.alieffauzan.com`
- Policy: Allow → **Emails** → alamat email kamu
- Zero Trust → Settings → Authentication → aktifkan **One-time PIN**

Setelah aktif, `curl -sI https://au.alieffauzan.com` harus `302` (redirect ke
Access), bukan `200`.

## 6. Naik ke live trading

Setelah hosting terverifikasi:

1. `pm2 stop meridian`
2. Edit `.env`: `MERIDIAN_CHAIN=meteora`, `MERIDIAN_WRITE_UNSAFE=true`,
   `MERIDIAN_DEMO=false`; isi `WALLET_PRIVATE_KEY` (base58, **bukan** base64),
   `RPC_URL`, `OPENROUTER_API_KEY`.
3. Sesuaikan `user-config.json` (`deployAmountSol`, `maxPositions`, exit rules).
4. `pm2 restart meridian` lalu `pm2 logs meridian`.

Di log boot harus terbaca `chain: meteora` + `market: real`. Kalau muncul
`wallet: X SOL ($150)` / `market: fake` → `MERIDIAN_CHAIN` belum terbaca.

### Decider: Sage TIDAK diperlukan di sini

Keputusan "masuk pool yang mana" butuh LLM. Ada dua implementasi; yang berlaku
ditentukan `daemon.ts`:

```ts
const sageEnabled = process.env.MERIDIAN_DECIDER !== "loop"
  && !!process.env.SAGE_BASE_URL && !!process.env.SAGE_API_KEY;
```

Sage baru aktif kalau `SAGE_BASE_URL` **dan** `SAGE_API_KEY` dua-duanya terisi.
Di homeserver ini keduanya kosong, jadi daemon otomatis memakai ReAct loop lokal
lewat `OPENROUTER_API_KEY` — tidak perlu setting apa pun. **Jangan** menambahkan
variabel `SAGE_*` dan jangan set `MERIDIAN_DECIDER`; `docker-compose.yml` memang
memasang `MERIDIAN_DECIDER=sage`, tapi itu khusus vivobook yang memang
menjalankan Hermes/Sage di host yang sama.

Jadi satu-satunya kunci LLM yang dibutuhkan di sini adalah OpenRouter.
`RPC_URL` dan `WALLET_PRIVATE_KEY` bukan LLM — itu untuk membaca chain dan
menandatangani transaksi.

### Ambang saldo

Screening akan **skip** (dan menulis decision `skip`) selama
`wallet.sol < deployAmountSol + gasReserve`. Dengan default homeserver
(`0.05 + 0.2`) wallet harus berisi minimal **0.25 SOL** sebelum siklus pertama
bisa deploy.

## 7. Operasi harian

```powershell
pm2 status
pm2 logs meridian            # log daemon
pm2 logs meridian-web        # log dashboard
pm2 restart meridian         # reload setelah ubah .env
pm2 stop meridian            # KILL SWITCH (posisi on-chain tetap terbuka)
Get-Service cloudflared
Restart-Service cloudflared
```

Update kode:

```powershell
git pull
npm install; npm run build
cd dashboard\web; npm install; npm run build; cd ..\..
pm2 restart all
```

## 8. Troubleshooting

| Gejala | Sebab / perbaikan |
|---|---|
| `au.alieffauzan.com` → 404 Vercel | Public hostname belum ditambahkan; request masih jatuh ke wildcard `*`. |
| Error 1033 / 530 | `cloudflared` service mati. `Get-Service cloudflared` → `Restart-Service cloudflared`. |
| Error 502 di edge | Tunnel hidup tapi `localhost:3000` mati. `pm2 status`, `pm2 logs meridian-web`. |
| Halaman PIN loop terus | `MERIDIAN_SESSION_SECRET` beda antara `.env` dan `.env.local`, atau < 32 char. Jalankan ulang `setup-local-secrets.mjs`. |
| PIN selalu ditolak | `MERIDIAN_DASHBOARD_PIN_HASH` tidak terbaca Next. Pastikan ada di `dashboard/web/.env.local` dan **tanpa tanda kutip**. |
| Dashboard 500 / positions kosong | `BRIDGE_TOKEN` ≠ `DASHBOARD_TOKEN`, atau daemon mati. |
| Halaman Config / Feed kosong, tanpa pesan error | `MERIDIAN_ROOT` (web) ≠ `MERIDIAN_STATE_DIR` (daemon), atau salah satunya bukan root repo. `/api/files/:name` mengembalikan `{}` untuk file yang tidak ada — sengaja, supaya halaman tetap render. Samakan keduanya ke root repo. |
| `bridge not started` di log | `DASHBOARD_TOKEN` kosong di `.env`. |
| Daemon crash `Directory import … @coral-xyz/anchor` | `scripts/patch-anchor.js` tidak jalan. `npm rebuild` / `npm install` ulang. |
| Semua mati setelah reboot | Task Scheduler `meridian-pm2-resurrect` belum dibuat, atau `pm2 save` belum dijalankan setelah perubahan terakhir. |
| 404 berbadan **kosong** (tanpa `x-vercel-error`) | Request sampai ke tunnel tapi tidak ada route yang cocok — catch-all `http_status:404`. Biasanya field **Path** pada route terisi. Kosongkan. |
| 404 dengan `x-vercel-error: DEPLOYMENT_NOT_FOUND` | Request belum sampai ke tunnel sama sekali; masih jatuh ke wildcard `*` → Vercel. Route belum tersimpan. |
| Redirect ke `https://localhost:3000/login` | Next membangun URL absolut dari bind address-nya sendiri, bukan dari header `Host`. Sudah diperbaiki oleh `applyPublicOrigin()` di `dashboard/web/middleware.ts` — kalau muncul lagi, build web-nya tertinggal: `cd dashboard/web && npm run build && pm2 restart meridian-web`. |
| `TypeError: Invalid URL` di log web saat redirect | Adapter middleware Next mem-parse header `Location` sebagai URL absolut — `Location` relatif akan melempar `ERR_INVALID_URL` + 500. Redirect di middleware harus absolut. |
