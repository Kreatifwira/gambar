import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const env = (key: string) => Deno.env.get(key) ?? "";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Sesi login tidak ditemukan." }, 401);
    const supabaseUrl = env("SUPABASE_URL");
    const publishableKey = env("SUPABASE_ANON_KEY") || env("SUPABASE_PUBLISHABLE_KEY");
    if (!supabaseUrl || !publishableKey) return json({ error: "Konfigurasi Supabase belum lengkap." }, 500);

    const supabase = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) return json({ error: "Sesi tidak valid. Silakan masuk kembali." }, 401);
    const userId = authData.user.id;
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "generate_lyrics") {
      const projectId = String(body.project_id || "");
      const idea = String(body.idea || "").trim();
      if (!projectId || !idea) return json({ error: "Proyek dan ide lagu wajib diisi." }, 400);
      const { data: project, error: projectError } = await supabase.from("projects")
        .select("id,title,language").eq("id", projectId).eq("user_id", userId).single();
      if (projectError || !project) return json({ error: "Proyek tidak ditemukan." }, 404);
      const key = env("DATABYTE_API_KEY");
      if (!key) return json({ error: "DATABYTE_API_KEY belum tersedia di Supabase Secrets." }, 500);

      const response = await fetch("https://ai.databyte.co.id/gateway/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-6-astra",
          temperature: 0.8,
          messages: [
            { role: "system", content: "Anda adalah penulis lagu profesional. Tulis lirik orisinal, emosional, mudah dinyanyikan, dengan struktur [Verse 1], [Pre-Chorus] bila cocok, [Chorus], [Verse 2], [Bridge], [Final Chorus]. Jangan meniru lagu atau artis tertentu. Keluarkan hanya lirik, satu baris per larik, tanpa penjelasan." },
            { role: "user", content: `Judul: ${project.title}\nBahasa: ${project.language === "en" ? "Inggris" : "Indonesia"}\nIde/tema: ${idea}\nBuat lirik lagu lengkap yang kuat secara cerita dan memiliki chorus yang mudah diingat.` },
          ],
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "DataByte (GPT) gagal membuat lirik.");
      const lyrics = result.choices?.[0]?.message?.content?.trim();
      if (!lyrics) throw new Error("OpenAI tidak mengembalikan lirik.");
      const { error: saveError } = await supabase.from("projects")
        .update({ lyrics, description: idea, status: "draft", updated_at: new Date().toISOString() })
        .eq("id", projectId).eq("user_id", userId);
      if (saveError) throw saveError;
      return json({ lyrics });
    }

    if (action === "create_prompts") {
      const projectId = String(body.project_id || "");
      if (!projectId) return json({ error: "project_id wajib diisi." }, 400);
      const { data: project, error: projectError } = await supabase.from("projects")
        .select("id,title,lyrics,visual_style,image_ratio").eq("id", projectId).eq("user_id", userId).single();
      if (projectError || !project) return json({ error: "Proyek tidak ditemukan." }, 404);
      if (!project.lyrics?.trim()) return json({ error: "Tambahkan atau buat lirik terlebih dahulu." }, 400);
      const key = env("DATABYTE_API_KEY");
      if (!key) return json({ error: "DATABYTE_API_KEY belum tersedia di Supabase Secrets." }, 500);

      const lyricsChunk = typeof body.lyrics_chunk === "string" ? body.lyrics_chunk : project.lyrics;
      const lineOffset = Math.max(0, Number(body.line_offset) || 0);
      const replaceExisting = body.replace_existing !== false;
      const lines: { line_number: number; section_name: string; lyric_text: string }[] = [];
      let section = "Verse";
      for (const raw of lyricsChunk.split(/\r?\n/)) {
        const value = raw.trim();
        if (!value) continue;
        if (/^\[.*\]$/.test(value)) { section = value.replace(/^\[|\]$/g, ""); continue; }
        lines.push({ line_number: lineOffset + lines.length + 1, section_name: section, lyric_text: value });
      }
      if (!lines.length) return json({ error: "Tidak ditemukan baris lirik." }, 400);
      if (lines.length > 40) return json({ error: "Maksimal 40 baris lirik per proses agar stabil. Bagi lirik menjadi beberapa bagian." }, 400);

      let response: Response;
      try {
        response = await fetch("https://ai.databyte.co.id/gateway/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(50000),
          body: JSON.stringify({
            model: "deepseek/deepseek-v4.1-flash",
            temperature: 0.4,
            max_tokens: 7000,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "Anda adalah sutradara visual dan prompt engineer. Buat tepat satu prompt gambar berbahasa Inggris untuk SETIAP baris lirik. Pertahankan konsistensi karakter, pakaian, usia dewasa jika disebut, palet warna, dan dunia visual. Gambarkan makna setiap baris secara sinematik. Tanpa teks, subtitle, logo, watermark, atau tipografi. Kembalikan hanya JSON object dengan properti prompts berupa array objek. Setiap objek wajib memiliki line_number (angka sesuai input), prompt_text (prompt gambar detail berbahasa Inggris), dan negative_prompt (hal yang harus dihindari)." },
              { role: "user", content: JSON.stringify({ title: project.title, visual_style: project.visual_style, image_ratio: project.image_ratio, lyric_lines: lines }) },
            ],
          }),
        });
      } catch (error) {
        console.error("DeepSeek fetch error:", error);
        const message = error instanceof Error && error.name === "TimeoutError"
          ? "DeepSeek melewati batas waktu 50 detik. Coba lagi dengan bagian lirik yang lebih pendek."
          : "Tidak dapat terhubung ke DataByte DeepSeek. Periksa koneksi gateway.";
        return json({ error: message }, 504);
      }
      const responseText = await response.text();
      let result: any = {};
      try { result = responseText ? JSON.parse(responseText) : {}; } catch {
        console.error("DeepSeek returned non-JSON HTTP body:", response.status, responseText.slice(0, 1200));
        return json({ error: "DataByte DeepSeek mengirim respons yang tidak dapat dibaca (HTTP " + response.status + ")." }, 502);
      }
      if (!response.ok) {
        const detail = result.error?.message || result.message || responseText.slice(0, 500) || "Tidak ada detail dari gateway.";
        console.error("DeepSeek gateway HTTP error:", response.status, detail);
        return json({ error: "DataByte DeepSeek gagal (HTTP " + response.status + "): " + detail }, 502);
      }
      const choice = result.choices?.[0];
      const messageContent = choice?.message?.content
        ?? choice?.text
        ?? result.output_text
        ?? result.output
        ?? result.result?.content
        ?? result.data?.content
        ?? result.content;
      if (messageContent == null || messageContent === "") {
        const shape = JSON.stringify(result).slice(0, 1200);
        console.error("DeepSeek response has no recognized content field:", shape);
        return json({ error: "DataByte berhasil merespons, tetapi isi jawaban DeepSeek tidak ditemukan. Struktur respons: " + (shape || "(kosong)") }, 502);
      }
      const raw = Array.isArray(messageContent)
        ? messageContent.map((part: any) => typeof part === "string" ? part : part?.text || part?.content || "").join("\\n")
        : typeof messageContent === "string" ? messageContent : JSON.stringify(messageContent);
      let parsed: any;
      try {
        const cleaned = String(raw).trim()
          .replace(/^\\x60\\x60\\x60(?:json)?\\s*/i, "")
          .replace(/\\s*\\x60\\x60\\x60$/i, "")
          .replace(/^json\\s*/i, "");
        try { parsed = JSON.parse(cleaned); }
        catch {
          const firstObject = cleaned.indexOf("{");
          const firstArray = cleaned.indexOf("[");
          const first = firstObject < 0 ? firstArray : firstArray < 0 ? firstObject : Math.min(firstObject, firstArray);
          if (first < 0) throw new Error("JSON tidak ditemukan dalam jawaban model.");
          const opening = cleaned[first];
          const closing = opening === "{" ? "}" : "]";
          let depth = 0, inString = false, escaped = false, last = -1;
          for (let i = first; i < cleaned.length; i++) {
            const ch = cleaned[i];
            if (inString) {
              if (escaped) escaped = false;
              else if (ch === "\\\\") escaped = true;
              else if (ch === '"') inString = false;
              continue;
            }
            if (ch === '"') inString = true;
            else if (ch === opening) depth++;
            else if (ch === closing && --depth === 0) { last = i; break; }
          }
          if (last < 0) throw new Error("JSON terpotong atau kurung tidak lengkap.");
          parsed = JSON.parse(cleaned.slice(first, last + 1));
        }
      } catch (error) {
        const preview = String(raw).replace(/\\s+/g, " ").slice(0, 350);
        console.error("DeepSeek response parse error:", error, String(raw).slice(0, 2000));
        return json({ error: "DeepSeek mengirim format yang tidak valid. Detail: " + (error instanceof Error ? error.message : "gagal membaca JSON") + ". Awal respons: " + (preview || "(kosong)") }, 502);
      }
      const prompts = Array.isArray(parsed) ? parsed : Array.isArray(parsed.prompts) ? parsed.prompts : [];
      if (!prompts.length) {
        console.error("DeepSeek returned zero prompts:", JSON.stringify(result).slice(0, 1200));
        return json({ error: "DeepSeek merespons tetapi tidak mengirim daftar prompt. Coba ulangi atau kurangi jumlah baris." }, 502);
      }
      const missing = lines.filter(line => !prompts.some((p: any) => Number(p.line_number) === line.line_number && String(p.prompt_text || "").trim()));
      if (missing.length) return json({ error: "DeepSeek hanya menghasilkan " + (lines.length - missing.length) + " dari " + lines.length + " prompt. Coba ulang bagian ini." }, 502);
      if (replaceExisting) {
        const { data: oldImages } = await supabase.from("generated_images").select("storage_path").eq("project_id", projectId).eq("user_id", userId);
        if (oldImages?.length) await supabase.storage.from("music-studio-images").remove(oldImages.map((x: any) => x.storage_path));
        const { error: imageDeleteError } = await supabase.from("generated_images").delete().eq("project_id", projectId).eq("user_id", userId);
        if (imageDeleteError) throw imageDeleteError;
        const { error: promptDeleteError } = await supabase.from("image_prompts").delete().eq("project_id", projectId).eq("user_id", userId);
        if (promptDeleteError) throw promptDeleteError;
        const { error: lineDeleteError } = await supabase.from("lyric_lines").delete().eq("project_id", projectId).eq("user_id", userId);
        if (lineDeleteError) throw lineDeleteError;
      }
      const { data: savedLines, error: lineError } = await supabase.from("lyric_lines").insert(lines.map(line => ({ ...line, project_id: projectId, user_id: userId }))).select();
      if (lineError) throw lineError;
      const promptRows = savedLines.map(line => {
        const prompt = prompts.find((p: any) => Number(p.line_number) === line.line_number);
        if (!prompt?.prompt_text) throw new Error(`Prompt untuk baris ${line.line_number} tidak ditemukan.`);
        return { project_id: projectId, lyric_line_id: line.id, user_id: userId, prompt_text: String(prompt.prompt_text), negative_prompt: String(prompt.negative_prompt || ""), visual_style: project.visual_style, image_ratio: project.image_ratio, status: "pending" };
      });
      const { data: savedPrompts, error: promptError } = await supabase.from("image_prompts").insert(promptRows).select();
      if (promptError) throw promptError;
      await supabase.from("projects").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", projectId).eq("user_id", userId);
      return json({ total: savedPrompts.length, prompts: savedPrompts });
    }

    if (action === "generate_image") {
      const promptId = String(body.prompt_id || "");
      if (!promptId) return json({ error: "prompt_id wajib diisi." }, 400);
      const { data: prompt, error: promptError } = await supabase.from("image_prompts")
        .select("id,project_id,lyric_line_id,user_id,prompt_text,negative_prompt,visual_style,image_ratio")
        .eq("id", promptId).eq("user_id", userId).single();
      if (promptError || !prompt) return json({ error: "Prompt tidak ditemukan." }, 404);

      const key = env("AIERA_API_KEY");
      if (!key) return json({ error: "AIERA_API_KEY belum tersedia di Supabase Edge Function Secrets." }, 500);

      await supabase.from("image_prompts").update({ status: "processing", error_message: null, updated_at: new Date().toISOString() }).eq("id", promptId).eq("user_id", userId);
      await supabase.from("projects").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", prompt.project_id).eq("user_id", userId);

      try {
        // Z-Image Turbo has an 800-character prompt limit. Keep a safety margin
        // and preserve the scene description instead of sending the full DeepSeek
        // prompt plus long repeated instructions.
        const style = String(prompt.visual_style || "cinematic").slice(0, 100);
        const prefix = "Cinematic music-video frame. Style: " + style + ". Scene: ";
        const suffix = ". No text, subtitles, logos, or watermark.";
        const scene = String(prompt.prompt_text || "").trim().replaceAll("\n", " ").replaceAll("\r", " ").replaceAll("\t", " ");
        const sceneBudget = Math.max(100, 780 - prefix.length - suffix.length);
        const sceneText = scene.length > sceneBudget
          ? scene.slice(0, sceneBudget)
          : scene;
        const promptText = prefix + sceneText + suffix;

        const controller = new AbortController();
        const generationTimeout = setTimeout(() => controller.abort(), 70000);
        let response: Response;
        let result: any;
        try {
          response = await fetch("https://api.ai-era.id/v1/studio/images", {
            method: "POST",
            headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              model: "z-image-turbo",
              prompt: promptText,
              aspect: prompt.image_ratio || "16:9",
              n: 1,
              wait: 60
            }),
          });
          const responseText = await response.text();
          try { result = responseText ? JSON.parse(responseText) : {}; }
          catch { throw new Error("Aiera mengirim respons yang tidak dapat dibaca."); }
          if (!response.ok && response.status !== 202) {
            throw new Error(result.error?.message || result.message || "Aiera gagal membuat gambar (HTTP " + response.status + ").");
          }
        } finally {
          clearTimeout(generationTimeout);
        }

        let requestResult = result;
        const requestId = String(result.id || result.request_id || "");
        if (response.status === 202 || ["queued", "pending", "processing"].includes(String(result.status || "").toLowerCase())) {
          if (!requestId) throw new Error("Aiera menerima permintaan tetapi tidak mengembalikan ID proses.");
          const deadline = Date.now() + 65000;
          let completed = false;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 2500));
            const pollResponse = await fetch("https://api.ai-era.id/v1/studio/requests/" + encodeURIComponent(requestId), {
              method: "GET",
              headers: { "Authorization": "Bearer " + key },
              signal: AbortSignal.timeout(15000),
            });
            const pollText = await pollResponse.text();
            let pollResult: any = {};
            try { pollResult = pollText ? JSON.parse(pollText) : {}; }
            catch { throw new Error("Aiera mengirim status proses dalam format yang tidak dapat dibaca."); }
            if (!pollResponse.ok) {
              throw new Error(pollResult.error?.message || pollResult.message || "Gagal memeriksa proses Aiera (HTTP " + pollResponse.status + ").");
            }
            requestResult = pollResult;
            const status = String(pollResult.status || "").toLowerCase();
            if (status === "completed") { completed = true; break; }
            if (status === "failed") {
              throw new Error(pollResult.error?.message || pollResult.message || "Aiera gagal membuat gambar. Periksa status saldo di dashboard Aiera sebelum mengulang.");
            }
          }
          if (!completed) throw new Error("Proses gambar Aiera belum selesai setelah menunggu. Silakan periksa galeri Aiera sebelum mengulang jika status masih berjalan.");
        }

        const generation = requestResult.generations?.find((item: any) => String(item.status || "completed").toLowerCase() === "completed")
          || requestResult.generations?.[0];
        const output = generation?.outputs?.find((item: any) => item.url) || generation?.outputs?.[0];
        if (!output?.url) throw new Error("Aiera menyelesaikan permintaan tetapi URL gambar tidak ditemukan.");

        const imageResponse = await fetch(output.url, { signal: AbortSignal.timeout(30000) });
        if (!imageResponse.ok) throw new Error("Gagal mengunduh hasil gambar Aiera (HTTP " + imageResponse.status + ").");
        const mime = String(output.mime || imageResponse.headers.get("content-type") || "image/png").split(";")[0].trim().toLowerCase();
        if (!mime.startsWith("image/")) throw new Error("Aiera mengembalikan tipe file yang bukan gambar (" + mime + ").");
        const bytes = new Uint8Array(await imageResponse.arrayBuffer());
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("Ukuran gambar kosong atau melebihi batas 20 MB.");
        const extension = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("avif") ? "avif" : "png";
        const path = userId + "/" + prompt.project_id + "/" + prompt.lyric_line_id + "." + extension;

        const { error: uploadError } = await supabase.storage.from("music-studio-images").upload(path, bytes, { contentType: mime, upsert: true });
        if (uploadError) throw uploadError;

        const { data: existing } = await supabase.from("generated_images").select("id").eq("prompt_id", promptId).eq("user_id", userId).maybeSingle();
        const imageRow = { project_id: prompt.project_id, lyric_line_id: prompt.lyric_line_id, prompt_id: promptId, user_id: userId, storage_path: path, public_url: null, model: "z-image-turbo", status: "completed", error_message: null };
        const saveResult = existing?.id
          ? await supabase.from("generated_images").update(imageRow).eq("id", existing.id).select().single()
          : await supabase.from("generated_images").insert(imageRow).select().single();
        if (saveResult.error) throw saveResult.error;

        await supabase.from("image_prompts").update({ status: "completed", error_message: null, updated_at: new Date().toISOString() }).eq("id", promptId).eq("user_id", userId);
        const { count: remaining } = await supabase.from("image_prompts").select("id", { count: "exact", head: true }).eq("project_id", prompt.project_id).eq("user_id", userId).neq("status", "completed");
        if ((remaining ?? 0) === 0) {
          await supabase.from("projects").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", prompt.project_id).eq("user_id", userId);
        }
        return json({ image: saveResult.data, completed: true, provider: "Aiera", model: "z-image-turbo" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gagal membuat gambar melalui Aiera.";
        await supabase.from("image_prompts").update({ status: "failed", error_message: message, updated_at: new Date().toISOString() }).eq("id", promptId).eq("user_id", userId);
        await supabase.from("projects").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", prompt.project_id).eq("user_id", userId);
        return json({ error: message }, 502);
      }
    }

    return json({ error: "Aksi tidak dikenal." }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Terjadi kesalahan server." }, 500);
  }
});