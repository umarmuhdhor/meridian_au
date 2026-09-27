# PLAN — Membangun ulang Sage sebagai service TypeScript (`sage-ts`)

> **Status:** rancangan, belum dikerjakan. Dibuat 2026-09-14.
> **Konteks:** Hermes/Sage lama tidak lagi tersedia. Homeserver
> Windows sekarang tidak punya Docker maupun Python. Meridian sementara berjalan
> dengan ReAct loop lokal (`SAGE_*` kosong → `sageEnabled=false`).

---

## 1. Keputusan

Membangun ulang **Hermes** (framework multi-agent: profil, gateway per-agent,
s6-overlay, toolset plugin Python) tidak masuk akal — itu kerangka umum, sedangkan
yang Meridian butuhkan hanya **satu agent dengan satu endpoint**.

Yang dibangun: **`sage-ts`**, satu service TypeScript di repo ini yang memenuhi
kontrak `SageDecider` + `SageExitAdvisor` persis, ditambah surface Telegram dan
memori persisten. Nol Python, nol Docker, nol WSL.

**Konsekuensi yang diterima:** arsitekturnya melingkar (Meridian → HTTP → Sage →
HTTP → bridge Meridian). Ini disengaja: hop HTTP itulah yang menjaga Sage tetap
proses terpisah dengan model, memori, dan siklus hidupnya sendiri — dan yang membuat
kegagalan Sage otomatis jatuh ke loop lokal tanpa menyentuh daemon trading.

---

## 2. Kontrak yang harus dipenuhi

Satu endpoint: `POST /v1/chat/completions` (OpenAI-compatible, non-stream).

| | Nilai |
|---|---|
| Auth | `Authorization: Bearer <SAGE_API_KEY>` |
| Scope memori | header `X-Hermes-Session-Key` (default `meridian-trading`) |
| Body | `{model, stream:false, messages:[{role:"system"…},{role:"user"…}]}` |
| Balasan | `{choices:[{message:{content:"<prosa>"}}]}` |

Sumber: [`sage-decider-http.ts`](../src/adapters/llm/sage-decider-http.ts),
[`sage-exit-advisor-http.ts`](../src/adapters/llm/sage-exit-advisor-http.ts).

### Tiga mode masuk, dibedakan dari bentuk pesan

| Pemicu | Mode | Yang harus dilakukan |
|---|---|---|
| user content memuat `cycle_id:` + blok kandidat, diawali `SCREENING CYCLE` | **screening agentik** | pilih 1 kandidat → panggil `mrd_deploy_position` dengan `cycle_id` verbatim → balas prosa rasional |
| system prompt = `EXIT_ADVISOR_PROMPT`, user = blok `POSITION …` | **exit advisor** | **tanpa tool call**, balas tepat satu baris `CLOSE: <alasan>` / `HOLD: <alasan>` |
| pesan dari Telegram | **human operator** | percakapan bebas, tool sesuai gerbang di §6 |

Deteksi mode wajib **fail-safe**: kalau ragu, perlakukan sebagai human operator
(mode paling sedikit kewenangan otonomnya).

---

## 3. Arsitektur

```
  pm2: meridian                              pm2: sage
  ┌──────────────────────┐                   ┌────────────────────────────┐
  │ screening/cycle      │                   │ http server :8643          │
  │   SageDecider ───────┼──POST /v1/chat───▶│   /v1/chat/completions     │
  │ management/cycle     │                   │        │                   │
  │   SageExitAdvisor ───┼──────────────────▶│   mode router              │
  │                      │                   │        │                   │
  │ dashboard bridge     │                   │   runAgentLoop (dipakai    │
  │   127.0.0.1:8787 ◀───┼───POST /tool──────┼──   ulang) + tool mrd_*     │
  └──────────────────────┘                   │        │                   │
                                             │   memori: sage-data/       │
  Telegram ──────────────────────────────────│   SOUL.md, skills/, sesi   │
   (inbound: sage saja)                      └────────────────────────────┘
```

Bridge sudah siap: seluruh tool yang Sage butuhkan **sudah ter-allowlist**
([`allowlist.ts`](../src/adapters/dashboard/allowlist.ts)), lengkap dengan gerbang
`confirm:true`, idempotensi `cycle_id`, dan human-gate `update_config`.

**Tidak perlu sidecar socat.** Itu khusus netns Docker; di Windows
native kedua proses berbagi loopback yang sama.

---

## 4. Komponen yang ditulis

Semua di bawah `src/sage/`, entrypoint `src/entrypoints/sage.ts`.

| # | Berkas | Isi | ~LOC |
|---|---|---|---|
| 1 | `entrypoints/sage.ts` | composition root: env → deps → server + Telegram | 180 |
| 2 | `sage/server.ts` | HTTP OpenAI-compatible, pola dari [`dashboard/server.ts`](../src/adapters/dashboard/server.ts) | 160 |
| 3 | `sage/mode.ts` | deteksi mode (§2) + unit test | 80 |
| 4 | `sage/bridge-client.ts` | port TS dari [`client.py`](hermes-meridian-plugin/client.py) | 120 |
| 5 | `sage/tools/*.ts` | 13 tool `mrd_*` via `defineTool` + Zod, skema dari [`tools.py`](hermes-meridian-plugin/tools.py) | 420 |
| 6 | `sage/memory/` | SOUL + skill loader, session store, self-edit tool | 260 |
| 7 | `sage/telegram.ts` | inbound REPL, auth allowlist, pola dari [`telegram/router.ts`](../src/app/telegram/router.ts) | 200 |
| 8 | `sage/prompt.ts` | perakit system prompt per mode | 120 |
| — | tests | unit per modul + integrasi in-memory | 400 |

**Dipakai ulang tanpa ditulis ulang:** [`runAgentLoop`](../src/app/agent/loop.ts),
`executeTool`, `defineTool`, `createRegistry`, adapter OpenRouter, `writeJsonAtomic`,
logger. Inilah alasan angka di atas realistis — kerangka agent-nya sudah ada.

### Memori

```
sage-data/                     ← STATE_DIR terpisah dari Meridian
  SOUL.md                      ← persona; diedit manusia
  skills/meridian-ops/
    SKILL.md                   ← seed dari deploy/hermes-meridian-plugin/skill/
    references/*.md            ← 4 berkas retrospektif yang sudah ada
  sessions/<session-key>.json  ← ringkasan bergulir per scope memori
```

`SKILL.md` + `references/` **sudah ada di repo** — pengetahuan operasional Sage
(deteksi mode, inventaris tool, playbook, veto spike-top, matriks strategi) tidak
hilang, hanya versinya tertinggal dari salinan live terakhir di host Sage lama.

Self-edit (Sage menyunting SKILL.md-nya sendiri) diberi gerbang: hanya di mode human
operator, hanya setelah konfirmasi eksplisit, dan setiap tulisan membuat `.bak`.

---

## 5. Fase pengerjaan

Setiap fase berdiri sendiri dan bisa dihentikan di situ.

**Fase 1 — transport + exit advisor.** (komponen 1,2,3,4,8 + tool baca)
Selesai bila: `curl` ke `/v1/chat/completions` dengan `EXIT_ADVISOR_PROMPT`
mengembalikan tepat satu baris `CLOSE:`/`HOLD:`; `sageExitEnabled=true` membuat
eskalasi AMBIGUOUS sampai ke Sage dan tercatat di log management.
Risiko terendah — advisor tidak pernah menulis on-chain.

**Fase 2 — screening agentik.** (komponen 5 lengkap + idempotensi)
Selesai bila: dengan `MERIDIAN_WRITE_UNSAFE` **mati**, satu siklus screening
terdelegasi menghasilkan `mrd_deploy_position` yang ditolak gerbang write, dan
`cycle_id` yang sama dua kali → 409 dari bridge. Baru setelah itu write di-arm.

**Fase 3 — memori persisten.** (komponen 6)
Selesai bila: SOUL + skill terinjeksi ke system prompt; ringkasan sesi bertahan
lintas restart; self-edit membuat `.bak` dan hanya jalan setelah konfirmasi.

**Fase 4 — Telegram.** (komponen 7)
Selesai bila: Sage membalas di grup, hanya user ter-allowlist dilayani, dan
`getUpdates` **hanya satu poller** (lihat §6).

---

## 6. Keamanan — yang tidak boleh dilanggar

1. **`MERIDIAN_TELEGRAM_INBOUND` tetap `false`.** Sage jadi satu-satunya poller
   `getUpdates`. Dua proses pada token yang sama = HTTP 409, dan kartu deploy/close
   Meridian ikut berhenti.
2. **`mrd_close_position` dan `mrd_claim_fees` human-only.** Exit deterministik
   Meridian sudah menangani semua keluar otomatis; Sage tidak boleh balapan dengannya.
   Aturan ini sudah tertulis di [SKILL.md](hermes-meridian-plugin/skill/SKILL.md) dan
   harus ditegakkan **di kode**, bukan sekadar di prompt.
3. **`update_config` tetap human-gated di bridge** — 403 bila ada `cycle_id`. Jangan
   ditiru gerbangnya di sisi Sage; biarkan bridge yang otoritatif.
4. **Server Sage bind `127.0.0.1` saja.** Sama seperti bridge. Tidak pernah `0.0.0.0`,
   tidak pernah lewat tunnel.
5. **Kegagalan Sage tidak boleh menjatuhkan trading.** Sudah dijamin dari sisi
   Meridian (`SageTransportError` → fallback loop lokal / fallback deterministik),
   tapi setiap fase harus diuji dengan Sage sengaja dimatikan.

---

## 7. Yang perlu Anda sediakan

Bagian yang tidak bisa dikerjakan tanpa Anda.

### Wajib sebelum Fase 1

| | Apa | Catatan |
|---|---|---|
| 1 | **Slug model yang tepat** untuk `sage-screening` dan `sage-exit` | Nama pendek (`hy4`, `deepseek-v4-pro`) bukan slug OpenRouter. Format OpenRouter: `vendor/model`. Buka <https://openrouter.ai/models>, salin persis. **Sekalian perbaiki `screeningModel`/`generalModel` Meridian** — sekarang `minimax-m3` tanpa prefix vendor, diduga 400 |
| 2 | **`SAGE_API_KEY`** | Anda yang tentukan, bebas — token lokal antar dua proses di satu mesin. Contoh: `openssl rand -hex 32` |
| 3 | **Konfirmasi `DASHBOARD_TOKEN`** terisi di `.env` | Dipakai Sage sebagai `MERIDIAN_BRIDGE_TOKEN`. Saya tidak punya akses baca `.env` |
| 4 | **Port untuk Sage** | Usul `8643` (sama seperti dulu). Konfirmasi tidak bentrok |

### Wajib sebelum Fase 3

| | Apa | Catatan |
|---|---|---|
| 5 | **Isi `SOUL.md`** — persona Sage | Hanya Anda yang tahu Sage lama seperti apa. Saya bisa buatkan draf dari SKILL.md yang ada, Anda koreksi |

### Wajib sebelum Fase 4

| | Apa | Catatan |
|---|---|---|
| 6 | **Token bot Telegram** | Kalau token @SageHermesAnd_bot masih ada, pakai itu. Kalau hilang: buat bot baru di @BotFather, lalu **`TELEGRAM_BOT_TOKEN` Meridian harus diganti ke token yang sama** supaya kartu deploy/close datang dari bot yang sama |
| 7 | **Chat ID grup + daftar user ID** yang boleh memerintah Sage | Untuk allowlist auth |
| 8 | **`/setprivacy` di BotFather → Disabled** | Kalau tidak, bot tidak melihat pesan grup |

### Keputusan yang perlu Anda ambil

| | Pertanyaan | Kenapa penting |
|---|---|---|
| A | Sage boleh **deploy otonom**, atau usul saja lalu Anda yang eksekusi? | Menentukan apakah Fase 2 mengarm `mrd_deploy_position` atau berhenti di rekomendasi |
| B | Kapan write di-arm? | Usul saya: seluruh Fase 1–4 selesai dan stabil dengan `MERIDIAN_WRITE_UNSAFE=false`, baru di-arm |
| C | `sage-data/` di dalam repo atau di luar? | Sage menyunting berkasnya sendiri; di dalam repo berarti masuk git diff. Usul saya: di luar repo, atau di-gitignore |

---

## 8. Yang TIDAK dibangun

Ada di Hermes lama, sengaja ditinggalkan:

- Multi-agent gateway / profil (Hermes menjalankan 6 agent; kita butuh 1)
- s6-overlay dan supervisi proses (pm2 sudah menangani)
- Toolset `hermes-cli` — akses shell untuk Sage. **Sengaja dibuang**: memberi agent
  akses shell di mesin yang memegang kunci wallet adalah perluasan risiko yang tidak
  sebanding dengan manfaatnya
- `gmgn-cli` — bisa ditambahkan belakangan sebagai tool terbatas, bukan lewat shell

---

## 9. Berkas rujukan

- Kontrak port: [`src/ports/sage-decider.ts`](../src/ports/sage-decider.ts), [`src/ports/sage-exit-advisor.ts`](../src/ports/sage-exit-advisor.ts)
- Bentuk transport: [`src/adapters/llm/sage-decider-http.ts`](../src/adapters/llm/sage-decider-http.ts)
- Prompt exit advisor: `EXIT_ADVISOR_PROMPT` di [`src/app/management/cycle.ts`](../src/app/management/cycle.ts)
- Prompt screening Sage: `sageSystemPrompt` di [`src/app/screening/cycle.ts`](../src/app/screening/cycle.ts)
- Skema 13 tool: [`deploy/hermes-meridian-plugin/tools.py`](hermes-meridian-plugin/tools.py)
- Pengetahuan operasional Sage: [`deploy/hermes-meridian-plugin/skill/SKILL.md`](hermes-meridian-plugin/skill/SKILL.md)
