// ============================================================
// OKONGZINC CHECKER API - v7.0 (bge-large)
// ============================================================

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const MODEL = env.MODEL_NAME || '@cf/baai/bge-large-en-v1.5';

    // ============================================================
    // 1. TEST AI
    // ============================================================
    if (path === '/test-ai') {
      try {
        const result = await env.AI.run(MODEL, { text: 'Testing AI embedding' });
        const dims = result.data ? result.data[0].length : 0;
        return new Response(JSON.stringify({
          success: true,
          model: MODEL,
          dimensions: dims,
          sample: result.data ? result.data[0].slice(0, 5) : []
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 2. ADD DOKUMEN
    // ============================================================
    if (path === '/add' && request.method === 'POST') {
      try {
        const { id, text, metadata } = await request.json();
        if (!id || !text) {
          return new Response(JSON.stringify({ error: 'ID dan text wajib diisi' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const chunks = splitText(text, 500);
        for (let i = 0; i < chunks.length; i++) {
          const embedding = await getEmbedding(chunks[i], env, MODEL);
          await env.VECTORIZE.upsert([{
            id: `internal_${id}_chunk_${i}`,
            values: embedding,
            metadata: {
              ...metadata,
              type: 'internal',
              source: metadata?.source || 'manual',
              date: new Date().toISOString(),
              chunk: i,
              total_chunks: chunks.length,
              original_id: id,
              full_text: text
            }
          }]);
        }

        return new Response(JSON.stringify({
          success: true,
          message: `Dokumen '${id}' berhasil ditambahkan (${chunks.length} chunk)`,
          total_chunks: chunks.length,
          total_characters: text.length
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 3. CHECK PLAGIARISME
    // ============================================================
    if (path === '/check' && request.method === 'POST') {
      try {
        const { text, topK = 100, threshold = parseFloat(env.PLAGIARISM_THRESHOLD || '0.75'), useLLM = true, turnstileToken } = await request.json();
        // Turnstile verification (skip jika secret key kosong)
        const ts = await verifyTurnstile(turnstileToken, env);
        if (!ts.success) {
          return new Response(JSON.stringify({ error: ts.error }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (!text) {
          return new Response(JSON.stringify({ error: 'Text wajib diisi' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const chunks = splitText(text, 500);
        const allMatches = [];
        for (const chunk of chunks) {
          const embedding = await getEmbedding(chunk, env, MODEL);
          const matches = await env.VECTORIZE.query(embedding, {
            topK: Math.min(topK, 50),
            returnVectors: true
          });
          allMatches.push(...matches.matches);
        }

        const uniqueMatches = deduplicateMatches(allMatches);
        const sorted = uniqueMatches.sort((a, b) => b.score - a.score);

        const results = [];
        for (const match of sorted) {
          const metadata = match.metadata || {};
          const sourceText = metadata.full_text || '';
          const highlights = findSimilarPhrases(text, sourceText);

          let isParaphrase = false;
          let paraphraseReason = '';
          if (useLLM && sourceText.length > 50) {
            try {
              const llmResult = await detectParaphrase(text, sourceText, env);
              isParaphrase = llmResult.isParaphrase;
              paraphraseReason = llmResult.reason;
            } catch (e) {
              paraphraseReason = 'LLM skipped: ' + e.message;
            }
          }

          results.push({
            id: match.id,
            score: match.score,
            similarity: `${(match.score * 100).toFixed(2)}%`,
            isPlagiarized: match.score > threshold || isParaphrase,
            source: metadata.type === 'external' ? metadata.source : 'internal',
            date: metadata.date || 'unknown',
            highlights: highlights,
            isParaphrase: isParaphrase,
            paraphraseReason: paraphraseReason,
            sourcePreview: sourceText.substring(0, 300) + '...'
          });
        }

        const plagiarizedResults = results.filter(m => m.isPlagiarized);
        // Skor overall: MAX (match paling tinggi), bukan rata-rata semua match.
        // Rata-rata menjadikan skor rendah krn banyak match irrelevant masuk hitungan.
        const allScores = results.map(m => m.score);
        const overallScore = allScores.length > 0 ? Math.max(...allScores) * 100 : 0;

        let status, message;
        if (plagiarizedResults.length > 0) {
          status = 'PLAGIARISM_DETECTED';
          message = `⚠️ Terdeteksi ${plagiarizedResults.length} kemiripan`;
        } else if (overallScore > threshold * 100 * 0.7) {
          status = 'SUSPICIOUS';
          message = '🟡 Teks mencurigakan';
        } else {
          status = 'ORIGINAL';
          message = '✅ Teks original';
        }

        return new Response(JSON.stringify({
          success: true,
          text_length: text.length,
          chunk_count: chunks.length,
          overall_similarity: `${overallScore.toFixed(2)}%`,
          status: status,
          message: message,
          threshold: threshold,
          model: MODEL,
          matches: results.slice(0, 20),
          plagiarized_matches: plagiarizedResults.slice(0, 10),
          summary: {
            total_matches: results.length,
            plagiarized_count: plagiarizedResults.length,
            paraphrase_count: results.filter(r => r.isParaphrase).length,
            highest_score: results.length > 0 ? results[0].score : 0
          }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 4. UPLOAD FILE
    // ============================================================
    if (path === '/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        const topK = parseInt(formData.get('topK') || '100');
        const threshold = parseFloat(formData.get('threshold') || env.PLAGIARISM_THRESHOLD || '0.75');
        // Turnstile verification (skip jika secret key kosong)
        const ts = await verifyTurnstile(formData.get('turnstileToken'), env);
        if (!ts.success) {
          return new Response(JSON.stringify({ error: ts.error }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (!file) {
          return new Response(JSON.stringify({ error: 'File tidak ditemukan' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        if (file.size > 100 * 1024 * 1024) {
          return new Response(JSON.stringify({
            error: 'File terlalu besar. Maksimal 100MB.'
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const buffer = await file.arrayBuffer();
        const text = await extractTextFromFile(buffer, file.name);

        if (!text || text.length < 10) {
          return new Response(JSON.stringify({
            error: 'Teks terlalu pendek atau format file tidak didukung.',
            text_length: text ? text.length : 0,
            filename: file.name
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const chunks = splitText(text, 500);
        const allMatches = [];
        
        for (const chunk of chunks) {
          try {
            const embedding = await getEmbedding(chunk, env, MODEL);
            const matches = await env.VECTORIZE.query(embedding, {
              topK: Math.min(topK, 50),
              returnVectors: true
            });
            allMatches.push(...matches.matches);
          } catch (chunkError) {
            console.error('Chunk Error:', chunkError.message);
          }
        }

        const uniqueMatches = deduplicateMatches(allMatches);
        const sorted = uniqueMatches.sort((a, b) => b.score - a.score);
        const results = sorted.map(m => ({
          id: m.id,
          score: m.score,
          similarity: `${(m.score * 100).toFixed(2)}%`,
          isPlagiarized: m.score > threshold,
          source: m.metadata?.source || 'internal'
        }));

        const plagiarizedResults = results.filter(m => m.isPlagiarized);
        // Skor overall: MAX (match paling tinggi), bukan rata-rata.
        const allScores = results.map(m => m.score);
        const overallScore = allScores.length > 0 ? Math.max(...allScores) * 100 : 0;

        let status = overallScore > threshold * 100 ? 'PLAGIARISM_DETECTED' : (overallScore > threshold * 100 * 0.7 ? 'SUSPICIOUS' : 'ORIGINAL');
        let message = status === 'PLAGIARISM_DETECTED' ? '⚠️ Terdeteksi plagiarisme!' : (status === 'SUSPICIOUS' ? '🟡 Teks mencurigakan' : '✅ Teks original');

        return new Response(JSON.stringify({
          success: true,
          filename: file.name,
          file_size: file.size,
          text_length: text.length,
          overall_similarity: `${overallScore.toFixed(2)}%`,
          status: status,
          message: message,
          threshold: threshold,
          model: MODEL,
          matches: results.slice(0, 20),
          summary: {
            total_matches: results.length,
            plagiarized_count: plagiarizedResults.length,
            highest_score: results.length > 0 ? results[0].score : 0
          }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        console.error('Upload Error:', error.message);
        return new Response(JSON.stringify({
          error: 'Upload gagal: ' + error.message,
          stack: error.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 5. BATCH CHECK
    // ============================================================
    if (path === '/batch-check' && request.method === 'POST') {
      try {
        const { texts, topK = 50, threshold = parseFloat(env.PLAGIARISM_THRESHOLD || '0.75') } = await request.json();
        if (!texts || !Array.isArray(texts) || texts.length === 0) {
          return new Response(JSON.stringify({ error: 'Array texts wajib diisi' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const results = [];
        for (let i = 0; i < texts.length; i++) {
          try {
            const chunks = splitText(texts[i], 500);
            let allScores = [];
            for (const chunk of chunks) {
              const embedding = await getEmbedding(chunk, env, MODEL);
              const matches = await env.VECTORIZE.query(embedding, {
                topK: Math.min(topK, 50),
                returnVectors: true
              });
              const scores = matches.matches.map(m => m.score);
              allScores.push(...scores);
            }
            const avgScore = allScores.length > 0 ? Math.max(...allScores) * 100 : 0;
            results.push({
              index: i,
              text_preview: texts[i].substring(0, 100) + '...',
              text_length: texts[i].length,
              overall_similarity: `${avgScore.toFixed(2)}%`,
              status: avgScore > threshold * 100 ? 'PLAGIARISM_DETECTED' : 'ORIGINAL',
              isPlagiarized: avgScore > threshold * 100
            });
          } catch (error) {
            results.push({ index: i, error: error.message });
          }
        }

        return new Response(JSON.stringify({
          success: true,
          total_checked: texts.length,
          model: MODEL,
          results: results,
          summary: {
            plagiarized: results.filter(r => r.isPlagiarized).length,
            original: results.filter(r => !r.isPlagiarized && !r.error).length,
            errors: results.filter(r => r.error).length
          }
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 6. REPORT (HTML / JSON)
    // Sebelumnya Content-Type application/pdf tapi isinya HTML → file rusak.
    // Sekarang: format=html (default) → text/html attachment .html
    //           format=json → data mentah JSON
    // ============================================================
    if (path === '/report' && request.method === 'POST') {
      try {
        const { text, format = 'html', topK = 50 } = await request.json();
        if (!text) {
          return new Response(JSON.stringify({ error: 'Text wajib diisi' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        const chunks = splitText(text, 500);
        let allMatches = [];
        for (const chunk of chunks) {
          const embedding = await getEmbedding(chunk, env, MODEL);
          const matches = await env.VECTORIZE.query(embedding, {
            topK: Math.min(topK, 50),
            returnVectors: true
          });
          allMatches.push(...matches.matches);
        }

        const uniqueMatches = deduplicateMatches(allMatches);
        const sorted = uniqueMatches.sort((a, b) => b.score - a.score);
        const thresholdVal = parseFloat(env.PLAGIARISM_THRESHOLD || '0.75');
        const results = sorted.slice(0, 20).map(m => ({
          id: m.id,
          score: m.score,
          similarity: `${(m.score * 100).toFixed(2)}%`,
          isPlagiarized: m.score > thresholdVal,
          source: m.metadata?.source || 'internal'
        }));

        // Skor overall: ambil MAX (match paling tinggi), bukan rata-rata.
        const allScores = results.map(m => m.score);
        const overallScore = allScores.length > 0 ? Math.max(...allScores) * 100 : 0;

        if (format === 'json') {
          return new Response(JSON.stringify({
            success: true,
            text_length: text.length,
            overall_similarity: overallScore.toFixed(2) + '%',
            status: overallScore > thresholdVal * 100 ? 'PLAGIARISM_DETECTED' : 'ORIGINAL',
            matches: results
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const html = generateReportHTML(text, { overall_similarity: overallScore.toFixed(2) + '%', matches: results });
        return new Response(html, {
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Disposition': 'attachment; filename="okongzinc_report.html"'
          }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 7. DELETE DOKUMEN
    // Support DELETE (sesuai kontrak API) dan POST (frontend lama).
    // Menerima { id } — hapus SEMUA chunk internal_${id}_chunk_*
    // ============================================================
    if ((path === '/delete') && (request.method === 'DELETE' || request.method === 'POST')) {
      try {
        const body = await request.json().catch(() => ({}));
        const id = String(body.id || '').trim();
        if (!id) {
          return new Response(JSON.stringify({ error: 'ID wajib diisi' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // Vectorize deleteByIds butuh ID lengkap. Karena add() menyimpan
        // sebagai internal_${id}_chunk_0..N, kita reconstruct ID pattern
        // dan getByIds utk dapet semua chunk yg ada (reliable, nggak tergantung
        // similarity query). getByIds limit 20 per call, jadi batch 20-20.
        const candidateIds = [];
        for (let i = 0; i < 50; i++) candidateIds.push(`internal_${id}_chunk_${i}`);
        const idsToDelete = [];
        for (let i = 0; i < candidateIds.length; i += 20) {
          const batch = candidateIds.slice(i, i + 20);
          try {
            const got = await env.VECTORIZE.getByIds(batch);
            (got || []).forEach(v => { if (v && v.id) idsToDelete.push(v.id); });
          } catch (e) { /* batch gagal, lanjut */ }
        }

        // Fallback: kalau reconstruct nggak nemu, coba query topK 50
        // dgn filter metadata original_id (untuk dokumen > 50 chunk).
        if (idsToDelete.length === 0) {
          try {
            const probeVec = await getEmbedding(id.slice(0, 500), env, MODEL);
            const probe = await env.VECTORIZE.query(probeVec, {
              topK: 50,
              returnMetadata: 'all',
              returnValues: false
            });
            (probe.matches || []).forEach(m => {
              const meta = m.metadata || {};
              if (String(meta.original_id || '').toLowerCase() === id.toLowerCase()
                  || String(m.id || '').startsWith(`internal_${id}_chunk_`)) {
                idsToDelete.push(m.id);
              }
            });
          } catch (e) { /* fallback gagal, lanjut */ }
        }

        if (idsToDelete.length === 0) {
          return new Response(JSON.stringify({
            success: true,
            message: `Tidak ada chunk ditemukan untuk dokumen '${id}' (mungkin sudah dihapus)`,
            deleted_count: 0
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        await env.VECTORIZE.deleteByIds(idsToDelete);
        return new Response(JSON.stringify({
          success: true,
          message: `Dokumen '${id}' berhasil dihapus (${idsToDelete.length} chunk)`,
          deleted_count: idsToDelete.length,
          deleted_ids: idsToDelete
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 8. PARAPHRASE / TURNITIN v7.0 — Multi-Pass + Stealth + ULTRA pipeline
    // Mode: standard, fluency, humanize, formal, academic, simple, creative
    //       stealth (multi-pass + humanize, bypass AI detection)
    //       ultra  (Scrub → Best-of-N personas → similarity gate → dysfluency)
    // Parameter: passes (1-5), n (1-3 candidates untuk ultra), preserveMeaning
    // ============================================================
    if (path === '/paraphrase' && request.method === 'POST') {
      try {
        const body = await request.json();
        const text = String(body.text || '');
        const mode = String(body.mode || 'standard').toLowerCase();
        const passes = Math.max(1, Math.min(5, parseInt(body.passes) || (mode === 'stealth' ? 3 : 1)));
        const preserveMeaning = body.preserveMeaning !== false;
        // Turnstile verification (skip jika secret key kosong)
        const ts = await verifyTurnstile(body.turnstileToken, env);
        if (!ts.success) {
          return new Response(JSON.stringify({ error: ts.error }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        if (text.length < 10) {
          return new Response(JSON.stringify({ error: 'Teks minimal 10 karakter' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        if (text.length > 8000) {
          return new Response(JSON.stringify({ error: 'Teks terlalu panjang. Maksimal 8000 karakter per request.' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // ============================================================
        // MODE ULTRA — v7.0 full pipeline (adaptasi VoicePrint)
        // Stage 1: Scrub (hapus AI tells)
        // Stage 2: Best-of-N candidates (persona escalation)
        // Stage 3: Similarity gate (pilih yg paling beda tapi makna sama)
        // Stage 4: Dysfluency injection (humanize)
        // ============================================================
        if (mode === 'ultra') {
          const n = Math.max(1, Math.min(3, parseInt(body.n) || 2));
          const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
          const similarityThreshold = 0.55; // minimal similarity utk keep makna

          // Stage 1: Scrub
          const scrubbed = scrubText(text);
          let current = scrubbed.text;

          // Stage 2: Best-of-N — generate N candidates dgn persona berbeda
          const candidates = [];
          for (let i = 0; i < n; i++) {
            const persona = PERSONAS[i % PERSONAS.length];
            try {
              const resp = await env.AI.run(LLM_MODEL, {
                messages: [
                  { role: 'system', content: `${persona.prompt} Output HANYA teks hasil, tanpa pembuka, tanpa penjelasan, tanpa tanda kutip.` },
                  { role: 'user', content: `Tulis ulang teks berikut:\n\n${current}` }
                ],
                max_tokens: Math.min(4000, current.length * 3),
                temperature: 0.85
              });
              const out = cleanLLMOutput(String(resp.response || resp || '').trim());
              if (out && out.length > 5) {
                candidates.push({ persona: persona.name, text: out });
              }
            } catch (e) {
              candidates.push({ persona: persona.name, text: current, error: e.message });
            }
          }

          // Stage 3: Similarity gate — pilih kandidat dgn similarity > threshold & paling beda
          let best = null;
          let bestSim = 0;
          const evalLog = [];
          for (const c of candidates) {
            const sim = await embeddingSimilarity(text, c.text, env, MODEL);
            evalLog.push({ persona: c.persona, similarity: Number(sim.toFixed(3)), length: c.text.length, has_error: !!c.error });
            if (sim >= similarityThreshold && (!best || sim < bestSim || (sim === bestSim && c.text.length > best.text.length))) {
              // Pilih yg similarity cukup (>=threshold) tapi paling rendah (paling beda struktur)
              if (!best || sim < bestSim) {
                best = c;
                bestSim = sim;
              }
            }
          }
          // Fallback: kalau semua kandidat similarity < threshold, ambil yg pertama
          if (!best && candidates.length > 0) {
            best = candidates[0];
            bestSim = await embeddingSimilarity(text, best.text, env, MODEL);
          }
          if (!best) {
            return new Response(JSON.stringify({ error: 'Gagal generate kandidat paraphrase' }), {
              status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
          current = best.text;

          // Stage 4: Dysfluency injection (humanize post-processing)
          // Detect language: cek rasio kata Indonesia vs English
          const idWords = (text.match(/\b(di|ke|dari|yang|dan|atau|untuk|dengan|pada|adalah|akan|tidak|bisa|dapat|ini|itu|para|sebuah)\b/gi) || []).length;
          const detectLang = idWords > 1 ? 'id' : 'en';
          const dysf = injectDysfluency(current, detectLang);
          current = dysf.text;

          // Meaning check
          let meaningCheck = null;
          if (preserveMeaning) {
            try {
              const check = await env.AI.run(LLM_MODEL, {
                messages: [
                  { role: 'system', content: 'Bandingkan makna dua teks. Jawab HANYA JSON: {"same_meaning": true/false, "confidence": 0-100, "note": "singkat"}' },
                  { role: 'user', content: `TEKS ASLI:\n${text}\n\nTEKS HASIL:\n${current}` }
                ],
                max_tokens: 200
              });
              const m = String(check.response || check || '').match(/\{[\s\S]*\}/);
              meaningCheck = m ? safeJsonParse(m[0]) : { same_meaning: null, note: 'no JSON found' };
            } catch (e) { meaningCheck = { error: e.message }; }
          }

          return new Response(JSON.stringify({
            success: true,
            original: text,
            paraphrased: current,
            mode: 'ultra',
            pipeline: {
              stage1_scrub: { changes: scrubbed.changes, removed_count: scrubbed.changes.length },
              stage2_candidates: { requested: n, generated: candidates.filter(c => !c.error).length, personas_used: candidates.map(c => c.persona) },
              stage3_similarity: { chosen_persona: best.persona, similarity_to_original: Number(bestSim.toFixed(3)), threshold: similarityThreshold, eval_log: evalLog },
              stage4_dysfluency: { injected_count: dysf.injected, language: detectLang }
            },
            meaning_check: meaningCheck,
            ai_detection_hint: 'Mode ULTRA v7.0: scrub + best-of-N personas + similarity gate + dysfluency. Pipeline 4-stage adaptasi VoicePrint. Tidak ada jaminan 100% lolos deteksi AI.'
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        // ============================================================
        // MODE LAIN (standard, stealth, dll) — v7.0 logic
        // ============================================================

        // === PROMPT TEMPLATES per mode ===
        const modePrompts = {
          standard: 'Parafrasekan teks berikut dengan gaya standar, menggunakan sinonim dan struktur kalimat yang berbeda namun tetap mempertahankan makna asli.',
          fluency: 'Parafrasekan teks berikut agar lebih lancar dan enak dibaca, perbaiki alur kalimat tanpa mengubah makna.',
          humanize: 'Ubah teks berikut agar terdengar seperti ditulis manusia sungguhan: variasi panjang-pendek kalimat, tambahkan idiom alami jika sesuai, hindari pola bahasa AI yang kaku.',
          formal: 'Parafrasekan teks berikut dengan gaya formal dan profesional, cocok untuk dokumen resmi.',
          academic: 'Parafrasekan teks berikut dengan gaya akademik, gunakan terminologi formal dan struktur argumentatif.',
          simple: 'Parafrasekan teks berikut dengan bahasa sederhana yang mudah dipahami, cocok untuk pembaca umum.',
          creative: 'Parafrasekan teks berikut dengan gaya kreatif dan ekspresif, menggunakan metafora atau analogi yang menarik.',
          expand: 'Tulis ulang teks berikut dengan MENGEMBANGKAN ide, tambahkan detail, contoh, atau penjelasan tambahan. Hasil harus lebih panjang dari aslinya namun tetap mempertahankan makna inti.',
          shorten: 'Ringkas teks berikut dengan Mempertahankan inti makna. Hasil harus lebih pendek dan padat dari aslinya. Buang kata-kata berlebihan tanpa kehilangan informasi penting.',
          stealth: 'Tugas: ubah teks berikut SECARA TOTAL sehingga tidak terdeteksi sebagai konten AI. Ubah struktur kalimat, gunakan sinonim variatif, variasi panjang-pendek, tambahkan sedikit imperfeksi alami. Pertahankan makna inti.'
        };

        // Synonym level (0-100): kontrol seberapa agresif sinonim diganti
        const synonymLevel = Math.max(0, Math.min(100, parseInt(body.synonymLevel) || 50));
        const synonymHint = synonymLevel < 25 ? 'Ganti sinonim secara minimal, hanya kata-kata yang jelas. Pertahankan struktur kalimat.' :
                           synonymLevel > 75 ? 'Ganti sinonim secara agresif, variasikan kosakata semaksimal mungkin. Boleh ubah struktur kalimat.' :
                           'Ganti sinonim secukupnya, seimbang antara variasi dan pemahaman.';
        const basePrompt = `${modePrompts[mode] || modePrompts.standard} ${synonymHint}`;
        const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
        const SYS_BASE = 'Anda adalah asisten parafrase ahli. Hanya keluarkan teks hasil parafrase, tanpa penjelasan, tanpa pembuka, tanpa tanda kutip. Output harus berbahasa Indonesia kecuali input berbahasa lain.';
        const SYS_HUMANIZE = 'Tambahan: tulis seperti manusia asli. Hindari kata-kata khas AI seperti "lebih lanjut", "selain itu", "dengan demikian", "dalam kesimpulan", "penting untuk dicatat". Gunakan bahasa sehari-hari yang natural.';

        // === MULTI-PASS LOOP ===
        let current = text;
        const passLog = [];
        for (let pass = 0; pass < passes; pass++) {
          const isLastPass = pass === passes - 1;
          const isStealth = mode === 'stealth';
          // Variasi prompt per pass supaya output berubah signifikan
          let passPrompt = basePrompt;
          if (isStealth) {
            passPrompt = `${basePrompt} Pass ${pass + 1}/${passes}. ${pass === 0 ? 'Ubah struktur kalimat secara radikal.' : pass === 1 ? 'Ganti sebanyak mungkin kata dengan sinonim kontekstual.' : 'Haluskan dan naturalisasi bahasa.'}`;
          } else if (passes > 1) {
            passPrompt = `${basePrompt} Putaran ke-${pass + 1} dari ${passes}. Ubah lagi dengan variasi yang berbeda dari sebelumnya.`;
          }
          const sys = (mode === 'humanize' || mode === 'stealth' || (isLastPass && passes > 1)) ? `${SYS_BASE} ${SYS_HUMANIZE}` : SYS_BASE;

          const resp = await env.AI.run(LLM_MODEL, {
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: `${passPrompt}\n\nTeks:\n${current}` }
            ],
            max_tokens: Math.min(4000, current.length * 3),
            temperature: isStealth ? 0.85 : 0.7
          });

          const out = String(resp.response || resp || '').trim();
          if (!out) {
            passLog.push({ pass: pass + 1, status: 'empty_output', kept_previous: true });
            break;
          }
          // Bersihkan pembuka yg mungkin muncul
          current = cleanLLMOutput(out);
          passLog.push({ pass: pass + 1, status: 'ok', length: current.length, chars_changed: Math.abs(current.length - text.length) });
        }

        // === PRESERVE MEANING CHECK (optional) ===
        let meaningCheck = null;
        if (preserveMeaning) {
          try {
            const check = await env.AI.run(LLM_MODEL, {
              messages: [
                { role: 'system', content: 'Bandingkan makna dua teks. Jawab HANYA JSON: {"same_meaning": true/false, "confidence": 0-100, "note": "singkat"}' },
                { role: 'user', content: `TEKS ASLI:\n${text}\n\nTEKS HASIL:\n${current}` }
              ],
              max_tokens: 200
            });
            const m = String(check.response || check || '').match(/\{[\s\S]*\}/);
            meaningCheck = m ? safeJsonParse(m[0]) : { same_meaning: null, note: 'no JSON found' };
          } catch (e) { meaningCheck = { error: e.message }; }
        }

        return new Response(JSON.stringify({
          success: true,
          original: text,
          paraphrased: current,
          mode: mode,
          passes: passes,
          synonym_level: synonymLevel,
          pass_log: passLog,
          word_count_original: text.split(/\s+/).filter(Boolean).length,
          word_count_result: current.split(/\s+/).filter(Boolean).length,
          meaning_check: meaningCheck,
          ai_detection_hint: mode === 'stealth' ? 'Mode stealth: multi-pass + humanize untuk menurunkan deteksi AI. Tidak ada jaminan 100% lolos.' : null
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ============================================================
    // 8b. SUMMARIZE — QuillBot-style summarizer
    // POST /summarize {text, length: 'short'|'medium'|'long', format: 'paragraph'|'bullets'}
    // ============================================================
    if (path === '/summarize' && request.method === 'POST') {
      try {
        const body = await request.json();
        const text = String(body.text || '');
        const length = String(body.length || 'medium').toLowerCase();
        const format = String(body.format || 'paragraph').toLowerCase();

        const ts = await verifyTurnstile(body.turnstileToken, env);
        if (!ts.success) {
          return new Response(JSON.stringify({ error: ts.error }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (text.length < 50) {
          return new Response(JSON.stringify({ error: 'Teks minimal 50 karakter untuk dirangkum.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (text.length > 15000) {
          return new Response(JSON.stringify({ error: 'Teks terlalu panjang. Maksimal 15000 karakter.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const lengthMap = {
          short: 'Ringkas dalam 2-3 kalimat saja. Sangat padat.',
          medium: 'Ringkas dalam 4-6 kalimat. Cukup detail.',
          long: 'Ringkas dalam 7-10 kalimat. Pertahankan detail penting.'
        };
        const formatMap = {
          paragraph: 'Output dalam bentuk paragraf.',
          bullets: 'Output dalam bentuk bullet points (- item per baris).'
        };

        const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
        const resp = await env.AI.run(LLM_MODEL, {
          messages: [
            { role: 'system', content: 'Anda adalah asisten peringkas ahli. Output HANYA hasil ringkasan, tanpa pembuka atau penjelasan. Pertahankan makna inti dan fakta penting. Output bahasa mengikuti bahasa input.' },
            { role: 'user', content: `${lengthMap[length] || lengthMap.medium} ${formatMap[format] || formatMap.paragraph}\n\nTeks:\n${text}` }
          ],
          max_tokens: Math.min(2000, text.length),
          temperature: 0.3
        });

        const summary = cleanLLMOutput(String(resp.response || resp || '').trim());
        const wordCountOriginal = text.split(/\s+/).filter(Boolean).length;
        const wordCountSummary = summary.split(/\s+/).filter(Boolean).length;
        const reduction = wordCountOriginal > 0 ? Math.round((1 - wordCountSummary / wordCountOriginal) * 100) : 0;

        return new Response(JSON.stringify({
          success: true,
          summary,
          length,
          format,
          word_count_original: wordCountOriginal,
          word_count_summary: wordCountSummary,
          reduction_percent: reduction
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // ============================================================
    // 8c. AI DETECT — Deteksi konten AI (QuillBot AI Detector equivalent)
    // POST /detect-ai {text}
    // ============================================================
    if (path === '/detect-ai' && request.method === 'POST') {
      try {
        const body = await request.json();
        const text = String(body.text || '');

        const ts = await verifyTurnstile(body.turnstileToken, env);
        if (!ts.success) {
          return new Response(JSON.stringify({ error: ts.error }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (text.length < 50) {
          return new Response(JSON.stringify({ error: 'Teks minimal 50 karakter untuk dianalisis.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        if (text.length > 8000) {
          return new Response(JSON.stringify({ error: 'Teks terlalu panjang. Maksimal 8000 karakter.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }

        const LLM_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

        // Step 1: LLM-based AI detection
        const resp = await env.AI.run(LLM_MODEL, {
          messages: [
            { role: 'system', content: 'You are an AI content detector. Analyze the text and respond with ONLY a JSON object. No markdown, no explanation, just the JSON.\n\n{"ai_probability": <number 0-100>, "ai_tells": ["AI-like phrases found"], "human_tells": ["human-like qualities"], "verdict": "AI-generated or Human-written or Mixed", "note": "one sentence"}\n\nAI text indicators: formal transitions (furthermore, moreover, additionally, in conclusion), uniform sentence length, low burstiness, repetitive patterns, lack of personal voice, overly structured.\nHuman text indicators: varied sentence length, personal voice, slang/idiom, imperfections, conversational tone, unexpected structure.' },
            { role: 'user', content: 'Analyze this text:\n\n' + text }
          ],
          max_tokens: 400,
          temperature: 0.1
        });

        let detection;
        const rawResp = String(resp.response || resp || '');
        try {
          const m = rawResp.match(/\{[\s\S]*\}/);
          detection = m ? JSON.parse(m[0]) : null;
        } catch {}
        if (!detection || typeof detection.ai_probability === 'undefined') {
          // Fallback: coba ekstrak angka dari respons
          const probMatch = rawResp.match(/ai_probability["\s:]+(\d+)/i);
          const verdictMatch = rawResp.match(/verdict["\s:]+["']?(\w+)/i);
          detection = {
            ai_probability: probMatch ? parseInt(probMatch[1]) : 50,
            confidence: 70,
            indicators: {},
            ai_tells_found: [],
            human_tells_found: [],
            verdict: verdictMatch ? verdictMatch[1] : 'Unknown',
            note: 'LLM response parsed via fallback'
          };
        }

        // Step 2: Heuristic burstiness score (sentence length variance)
        // High std_dev = varied sentence length = human-like (lower AI score)
        // Low std_dev = uniform sentence length = AI-like (higher AI score)
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
        const lengths = sentences.map(s => s.trim().split(/\s+/).length);
        const meanLen = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
        const variance = lengths.length > 1 ? lengths.reduce((a, b) => a + (b - meanLen) ** 2, 0) / lengths.length : 0;
        const burstiness = Math.sqrt(variance);
        // AI uniformity score: low burstiness → high AI probability from this metric
        // std_dev < 3 = very uniform (AI-like), > 8 = very varied (human-like)
        const uniformityScore = Math.max(0, Math.min(100, Math.round(100 - burstiness * 10)));

        // Step 3: Count AI tell patterns
        const aiTellCount = AI_TELLS.filter(([pattern]) => pattern.test(text)).length;
        const aiTellScore = Math.min(100, aiTellCount * 12);

        // Step 4: Combine scores (weighted)
        // If LLM failed (null), rely more on heuristics
        const llmScore = detection.ai_probability !== null ? detection.ai_probability : null;
        let finalScore;
        if (llmScore !== null) {
          finalScore = Math.round(llmScore * 0.5 + uniformityScore * 0.25 + aiTellScore * 0.25);
        } else {
          // LLM failed: heuristics only (uniformity + AI tells)
          finalScore = Math.round(uniformityScore * 0.4 + aiTellScore * 0.6);
        }

        return new Response(JSON.stringify({
          success: true,
          ai_probability: finalScore,
          verdict: finalScore > 70 ? 'Likely AI-Generated' : finalScore > 40 ? 'Mixed / Uncertain' : 'Likely Human-Written',
          confidence: detection.confidence || 70,
          metrics: {
            llm_score: llmScore,
            burstiness: { uniformity_score: uniformityScore, sentence_count: sentences.length, mean_sentence_length: Number(meanLen.toFixed(1)), std_dev: Number(burstiness.toFixed(1)) },
            ai_tell_patterns: { count: aiTellCount, score: aiTellScore }
          },
          ai_tells_found: detection.ai_tells || detection.ai_tells_found || [],
          human_tells_found: detection.human_tells || detection.human_tells_found || [],
          note: detection.note || '',
          disclaimer: 'Hasil deteksi bersifat probabilistik. Tidak ada detektor AI yang 100% akurat. Gunakan sebagai indikator, bukan kepastian.'
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // ============================================================
    // 9. HISTORY LOG (KV-backed)
    // POST /history  {type, text, result, meta}  → simpan (auto-expire 30 hari)
    // GET  /history?limit=20                   → list recent
    // DELETE /history?id=...                   → hapus 1 entry
    // ============================================================
    if (path === '/history') {
      try {
        // GET: list recent history
        if (request.method === 'GET') {
          const limit = Math.min(parseInt(new URL(request.url).searchParams.get('limit') || '20'), 100);
          const list = await env.HISTORY.list({ limit });
          const entries = [];
          for (const k of (list.keys || [])) {
            const val = await env.HISTORY.get(k.name, 'json');
            if (val) entries.push({ id: k.name, ...val });
          }
          // Urutkan desc by timestamp
          entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          return Response.json({ success: true, count: entries.length, history: entries }, { headers: corsHeaders });
        }
        // DELETE: hapus 1 entry
        if (request.method === 'DELETE') {
          const id = new URL(request.url).searchParams.get('id');
          if (!id) return Response.json({ error: 'id wajib diisi' }, { status: 400, headers: corsHeaders });
          await env.HISTORY.delete(id);
          return Response.json({ success: true, message: 'History dihapus' }, { headers: corsHeaders });
        }
        // POST: simpan history baru
        if (request.method === 'POST') {
          const body = await request.json();
          const type = String(body.type || 'check').slice(0, 20);
          const text = String(body.text || '').slice(0, 5000);
          const result = body.result || {};
          const meta = body.meta || {};
          const id = `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const entry = {
            type, type_label: { check: 'Cek Plagiarisme', paraphrase: 'Turnitin', upload: 'Upload', batch: 'Batch', report: 'Report' }[type] || type,
            text_preview: text.slice(0, 200),
            text_length: text.length,
            result_summary: typeof result === 'object' ? {
              status: result.status,
              overall_similarity: result.overall_similarity,
              matches_count: result.matches?.length || (result.results?.length) || 0
            } : String(result).slice(0, 300),
            meta,
            timestamp: Date.now(),
            expires_at: Date.now() + 30 * 24 * 60 * 60 * 1000
          };
          await env.HISTORY.put(id, JSON.stringify(entry), { expirationTtl: 30 * 24 * 60 * 60 });
          return Response.json({ success: true, id, entry }, { headers: corsHeaders });
        }
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
      } catch (error) {
        return Response.json({ error: error.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ============================================================
    // 10. HOME
    // ============================================================
    return new Response(JSON.stringify({
      name: 'OkongzINC Checker API v7.0',
      model: MODEL,
      features: {
        plagiarism_check: 'Deteksi plagiarisme dengan bge-large (1024 dims)',
        file_upload: 'Upload TXT, PDF, DOCX (text-based), HTML, JSON',
        batch_check: 'Cek banyak teks sekaligus',
        report: 'Generate HTML/JSON report',
        paraphrase: 'Parafrase dengan 11 mode (Standard, Fluency, Humanize, Formal, Academic, Simple, Creative, Expand, Shorten, Stealth, Ultra v7.0) + Synonym Level slider (0-100)',
        summarize: 'Ringkas teks dengan 3 panjang (short/medium/long) + format paragraf/bullets',
        ai_detect: 'Deteksi konten AI dengan scoring probabilistik (LLM + burstiness + pattern matching)'
      },
      endpoints: {
        'GET /': 'Daftar endpoint',
        'GET /test-ai': 'Test AI embedding',
        'POST /add': 'Tambah dokumen internal',
        'POST /check': 'Cek plagiarisme',
        'POST /upload': 'Upload file',
        'POST /batch-check': 'Cek batch teks',
        'POST /report': 'Generate report (pdf/word)',
        'POST /paraphrase': 'Parafrase teks (11 mode + synonym level)',
        'POST /summarize': 'Ringkas teks (short/medium/long)',
        'POST /detect-ai': 'Deteksi konten AI',
        'DELETE /delete': 'Hapus dokumen'
      },
      config: {
        threshold: env.PLAGIARISM_THRESHOLD || '0.75',
        max_results: env.MAX_RESULTS || '100'
      }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function cleanLLMOutput(text) {
  let t = String(text || '').trim();
  // Hapus pembuka yg sering muncul: "Berikut...", "Hasil parafrase:", dll
  t = t.replace(/^(berikut\s+ini\s+(adalah\s+)?hasil\s*parafrase\s*[:\-]?)\s*/i, '');
  t = t.replace(/^(hasil\s+parafrase\s*[:\-]?)\s*/i, '');
  t = t.replace(/^(berikut\s+(adalah\s+)?teks\s+yang\s+sudah\s+diubah\s*[:\-]?)\s*/i, '');
  t = t.replace(/^(parafrase\s*[:\-]?)\s*/i, '');
  // Hapus tanda kutip pembungkus
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith('«') && t.endsWith('»'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (_) {}
  // Coba ekstrak JSON object pertama
  const m = String(str).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

// Verify Cloudflare Turnstile token (skip jika secret key kosong)
async function verifyTurnstile(token, env) {
  if (!env.TURNSTILE_SECRET_KEY) return { success: true, skipped: true };
  if (!token) return { success: false, error: 'Turnstile token tidak ditemukan' };
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${encodeURIComponent(env.TURNSTILE_SECRET_KEY)}&response=${encodeURIComponent(token)}`
    });
    const data = await res.json();
    return { success: !!data.success, error: data.success ? null : 'Turnstile verification failed', raw: data };
  } catch (e) {
    return { success: false, error: 'Turnstile verify error: ' + e.message };
  }
}

// ============================================================
// TURNITIN v7.0 — PIPELINE HELPERS (adaptasi VoicePrint)
// Stage 1: scrub (pre-LLM), Stage 4: dysfluency (post-LLM)
// ============================================================

// 130+ AI tells (ID + EN) — ganti/hapus pola khas AI
const AI_TELLS = [
  // Transisi formal khas AI
  [/\b(furthermore|moreover|additionally|in addition)\b/gi, ''],
  [/\b(in conclusion|to conclude|in summary|to summarize)\b/gi, ''],
  [/\b(it is important to note|it should be noted|it is worth noting)\b/gi, ''],
  [/\b(ultimately|consequently|subsequently|nevertheless)\b/gi, ''],
  [/\b(pada dasarnya|pada intinya|secara umum|secara keseluruhan)\b/gi, ''],
  [/\b(oleh karena itu|dengan demikian|selain itu|lebih lanjut)\b/gi, ''],
  [/\b(dalam kesimpulan|sebagai kesimpulan|untuk menyimpulkan)\b/gi, ''],
  [/\b(perlu dicatat|penting untuk dicatat|patut dicatat)\b/gi, ''],
  [/\b(dll\b|dan lain-lain|dan sebagainya)/gi, ''],
  // Hedging
  [/\b(mungkin|kemungkinan|sepertinya|kiranya)\b/gi, ''],
  [/\b(mungkin saja|bisa jadi|sepertinya)\b/gi, ''],
  // Passive → active hints (mark for LLM)
  [/\b( telah dilakukan| sedang dilakukan| akan dilakukan)/gi, ' dilakukan'],
  // Tricolons (A, B, dan C) — break jadi 2 item
  [/(\w+),\s*(\w+),\s*(?:dan|danh)\s*(\w+)/gi, '$1 dan $2'],
];

function scrubText(text) {
  let t = text;
  const changes = [];
  for (const [pattern, replacement] of AI_TELLS) {
    const before = t;
    t = t.replace(pattern, replacement);
    if (before !== t) changes.push(pattern.source.slice(0, 30));
  }
  // Contractions (EN)
  t = t.replace(/\b(do not|donot)\b/gi, "don't");
  t = t.replace(/\b(does not)\b/gi, "doesn't");
  t = t.replace(/\b(cannot)\b/gi, "can't");
  t = t.replace(/\b(will not)\b/gi, "won't");
  t = t.replace(/\b(it is)\b/gi, "it's");
  t = t.replace(/\b(they are)\b/gi, "they're");
  // Cleanup double spaces
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
  return { text: t, changes };
}

// Persona escalation prompts — 8 persona berbeda
const PERSONAS = [
  { name: 'mahasiswa', prompt: 'Tulis ulang seperti mahasiswa yang sedang nulis essay deadline malam: agak santai, kadang pakai bahasa informal, struktur kalimat ngalir natural.' },
  { name: 'jurnalis', prompt: 'Tulis ulang seperti jurnalis berita: kalimat punchy, active voice, hindari jargon, fokus ke fakta.' },
  { name: 'blogger', prompt: 'Tulis ulang seperti blogger personal: gaya conversation, pakai "gw/lu" atau "aku/kamu", tambah opini ringan.' },
  { name: 'akademisi', prompt: 'Tulis ulang seperti dosen menjelaskan ke mahasiswa S1: akademik tapi gak kaku, ada analogi.' },
  { name: 'copywriter', prompt: 'Tulis ulang seperti copywriter marketing: persuasive, kalimat pendek-pendek, ada hook.' },
  { name: 'novel', prompt: 'Tulis ulang dengan gaya novelis: deskriptif, pilih kata penuh nuansa, variasi ritme kalimat panjang-pendek.' },
  { name: 'teknisi', prompt: 'Tulis ulang seperti teknisi/engineer menjelaskan: to the point, logis, step-by-step, gak basa-basi.' },
  { name: 'anak_gaul', prompt: 'Tulis ulang kayak anak gaul zaman now: pakai slang Indonesia ("gokil", "bikin bingung", "keren banget"), santai banget.' },
];

// Dysfluency injection — inject natural imperfeksi (post-LLM)
const DYSFLUENCIES_ID = ['ya', 'sih', 'kayaknya', 'nih', 'kok', 'deh', 'lah'];
const DYSFLUENCIES_EN = ['like', 'you know', 'sort of', 'kind of', 'honestly', 'basically'];

function injectDysfluency(text, lang = 'id') {
  const pool = lang === 'en' ? DYSFLUENCIES_EN : DYSFLUENCIES_ID;
  const sentences = text.split(/([.!?]+\s+)/);
  // Deterministic RNG dari hash text
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) & 0x7fffffff;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let injected = 0;
  for (let i = 0; i < sentences.length; i += 2) {
    if (sentences[i] && sentences[i].length > 40 && rng() < 0.25) {
      // Inject di akhir kalimat sebelum tanda baca
      const word = pool[Math.floor(rng() * pool.length)];
      sentences[i] = sentences[i].replace(/([.!?]+)$/, ` ${word}$1`);
      injected++;
    }
  }
  return { text: sentences.join(''), injected };
}

// Similarity gate via embedding (cosine)
async function embeddingSimilarity(textA, textB, env, model) {
  try {
    const [embA, embB] = await Promise.all([
      getEmbedding(textA.slice(0, 500), env, model),
      getEmbedding(textB.slice(0, 500), env, model),
    ]);
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < embA.length; i++) {
      dot += embA[i] * embB[i];
      magA += embA[i] * embA[i];
      magB += embB[i] * embB[i];
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  } catch (e) {
    // Fallback: Jaccard word overlap
    const setA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const setB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const inter = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? inter / union : 0;
  }
}

async function getEmbedding(text, env, model) {
  const response = await env.AI.run(model, { text: text });
  let embedding;
  if (response && response.data && Array.isArray(response.data) && response.data.length > 0) {
    embedding = response.data[0];
  } else if (Array.isArray(response)) {
    embedding = response;
  } else {
    throw new Error('Format embedding tidak dikenali');
  }
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error('Embedding tidak valid');
  }
  return embedding;
}

function splitText(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const lastSpace = text.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
    }
    chunks.push(text.substring(start, end));
    start = end;
  }
  return chunks;
}

function deduplicateMatches(matches) {
  const seen = new Map();
  for (const match of matches) {
    if (seen.has(match.id)) {
      if (match.score > seen.get(match.id).score) {
        seen.set(match.id, match);
      }
    } else {
      seen.set(match.id, match);
    }
  }
  return Array.from(seen.values());
}

function findSimilarPhrases(text, sourceText) {
  const words = text.split(/\s+/);
  const sourceWords = sourceText.split(/\s+/);
  const highlights = [];
  for (let i = 0; i < words.length; i++) {
    for (let j = 0; j < sourceWords.length; j++) {
      if (words[i].toLowerCase() === sourceWords[j].toLowerCase() && words[i].length > 3) {
        highlights.push({
          word: words[i],
          position: i,
          source_position: j,
          context: words.slice(Math.max(0, i - 2), Math.min(words.length, i + 3)).join(' ')
        });
        break;
      }
    }
  }
  return highlights.slice(0, 20);
}

async function detectParaphrase(text, sourceText, env) {
  try {
    const response = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'Anda adalah detektor parafrase. Tentukan apakah teks kedua adalah parafrase dari teks pertama. Berikan jawaban dalam format JSON: {"isParaphrase": true/false, "reason": "alasan singkat"}' },
        { role: 'user', content: `Teks 1: ${sourceText.substring(0, 1000)}\n\nTeks 2: ${text.substring(0, 1000)}` }
      ],
      max_tokens: 150
    });
    const result = JSON.parse(response.response);
    return { isParaphrase: result.isParaphrase || false, reason: result.reason || '' };
  } catch (error) {
    return { isParaphrase: false, reason: 'LLM error: ' + error.message };
  }
}

async function extractTextFromFile(buffer, filename) {
  const ext = filename.split('.').pop().toLowerCase();

  if (ext === 'txt' || ext === 'md' || ext === 'csv') {
    return new TextDecoder('utf-8').decode(buffer).trim();
  }

  if (ext === 'html' || ext === 'htm') {
    const text = new TextDecoder('utf-8').decode(buffer);
    let cleaned = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    cleaned = cleaned.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    cleaned = cleaned.replace(/<[^>]+>/g, ' ');
    cleaned = cleaned.replace(/&[a-z]+;/g, ' ');
    return cleaned.replace(/\s+/g, ' ').trim();
  }

  if (ext === 'json') {
    try {
      const text = new TextDecoder('utf-8').decode(buffer);
      const json = JSON.parse(text);
      return JSON.stringify(json, null, 2);
    } catch {
      return new TextDecoder('utf-8').decode(buffer);
    }
  }

  // PDF: pakai unpdf (pdfjs-dist yg di-bundle untuk edge runtime)
  if (ext === 'pdf') {
    try {
      const { getDocumentProxy } = await import('unpdf');
      const uint8 = new Uint8Array(buffer);
      const doc = await getDocumentProxy(uint8);
      let fullText = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const pageText = (tc.items || []).map(it => it.str || '').join(' ');
        fullText += pageText + '\n\n';
      }
      await doc.destroy();
      fullText = fullText.replace(/\s+/g, ' ').trim();
      if (fullText.length < 10) {
        return 'PDF berhasil dibuka tapi tidak ada teks (mungkin hasil scan/gambar).';
      }
      return fullText;
    } catch (e) {
      throw new Error('Gagal parse PDF: ' + (e.message || 'format tidak didukung'));
    }
  }

  // DOCX: format ZIP-based OOXML. Unzip dengan fflate, parse word/document.xml.
  if (ext === 'docx') {
    try {
      const { unzipSync, strFromU8 } = await import('fflate');
      const uint8 = new Uint8Array(buffer);
      const files = unzipSync(uint8);
      const docPath = Object.keys(files).find(k => k === 'word/document.xml' || k.endsWith('/word/document.xml'));
      if (!docPath) {
        throw new Error('Struktur DOCX tidak valid (word/document.xml tidak ditemukan).');
      }
      const xml = strFromU8(files[docPath]);
      // <w:p> = paragraf → newline; <w:t> = text run → ekstrak isi; sisanya strip tag
      let fullText = xml
        .replace(/<\/w:p>/g, '\n')
        .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, '$1')
        .replace(/<[^>]+>/g, ' ');
      fullText = fullText
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\s+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
      if (fullText.length < 10) {
        return 'DOCX berhasil dibuka tapi tidak ada teks (mungkin berisi gambar/scan).';
      }
      return fullText;
    } catch (e) {
      throw new Error('Gagal parse DOCX: ' + (e.message || 'format tidak didukung'));
    }
  }

  // Legacy .doc (binary) — tidak bisa di-parse di Workers
  if (ext === 'doc') {
    throw new Error('Format .doc (legacy binary) belum didukung. Silakan convert ke .docx, .txt, atau .pdf terlebih dahulu.');
  }

  // Fallback: coba decode sebagai text
  const text = new TextDecoder('utf-8').decode(buffer);
  let cleaned = text.replace(/[^\w\s.,;:!?\-()]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 20) {
    return 'Tidak ada teks yang bisa diekstrak dari file ini. Pastikan file bukan hasil scan/gambar.';
  }
  return cleaned;
}

function generateReportHTML(text, result) {
  return `
    <html>
    <head><meta charset="UTF-8"><title>OkongzINC Checker Report</title>
    <style>
      body { font-family: 'Outfit', Arial, sans-serif; margin: 40px; color: #1a202c; }
      h1 { color: #1a56db; }
      .score { font-size: 32px; font-weight: 800; color: #1a56db; }
      table { width: 100%; border-collapse: collapse; margin: 20px 0; }
      th, td { border: 1px solid #e2e8f0; padding: 8px 12px; text-align: left; }
      th { background: #f1f5f9; }
      .plagiarism { color: #dc2626; }
      .original { color: #22c55e; }
      .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; text-align: center; color: #6b7280; }
      .brand { font-weight: 700; background: linear-gradient(135deg, #1a56db, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    </style>
    </head>
    <body>
      <h1>🛡️ OkongzINC Checker Report</h1>
      <p><strong>Date:</strong> ${new Date().toISOString()}</p>
      <p><strong>Model:</strong> bge-large-en-v1.5 (1024 dims)</p>
      <h2>Overall Similarity: <span class="score">${result.overall_similarity || '0%'}</span></h2>
      <table>
        <tr><th>ID</th><th>Similarity</th><th>Status</th><th>Source</th></tr>
        ${(result.matches || []).slice(0, 15).map(m => `
          <tr>
            <td>${m.id}</td>
            <td>${m.similarity || '0%'}</td>
            <td class="${m.isPlagiarized ? 'plagiarism' : 'original'}">${m.isPlagiarized ? '⚠️ Plagiarism' : '✅ Original'}</td>
            <td>${m.source || 'internal'}</td>
          </tr>
        `).join('')}
      </table>
      <div class="footer">
        <p>Powered by <span class="brand">OkongzINC</span> 🚀</p>
        <p style="font-size:12px;color:#9ca3af;">&copy; 2026 OkongzINC Checker v7.0</p>
      </div>
    </body>
    </html>
  `;
}