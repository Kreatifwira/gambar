# AI Music Studio

Aplikasi web untuk membuat proyek lagu, menyimpan lirik, menentukan gaya visual, dan menyiapkan pipeline gambar per baris lirik.

## Stack
- React 19 + Vite
- Supabase Auth, Postgres, Storage, Edge Functions
- OpenAI untuk lirik, DeepSeek untuk prompt visual, Gemini untuk generasi gambar (backend only)

## Menjalankan lokal
1. Salin `.env.example` menjadi `.env`.
2. Isi `VITE_SUPABASE_URL` dan `VITE_SUPABASE_PUBLISHABLE_KEY`.
3. Jalankan `npm install`, lalu `npm run dev`.

## Status implementasi
- [x] Supabase schema untuk projects, lyric_lines, image_prompts, generated_images, ai_jobs.
- [x] Row Level Security untuk kepemilikan data pengguna.
- [x] Private Storage bucket untuk hasil gambar.
- [x] React dashboard, autentikasi, CRUD proyek, editor lirik, pengaturan gaya visual.
- [ ] Supabase Edge Function untuk orkestrasi OpenAI → DeepSeek → Gemini.
- [ ] Galeri hasil gambar dan retry job per baris.
- [ ] Konfigurasi secret API provider dan deployment hosting.

## Keamanan
Jangan memasukkan Supabase service-role key atau API key provider AI ke variabel `VITE_*`, source code, atau Git. Simpan kredensial server-side sebagai Supabase Edge Function Secrets.
