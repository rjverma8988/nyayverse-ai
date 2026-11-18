
/**
 * NYAYVERSE AI — API-FIRST WORKER
 * Keep index.html unchanged.
 *
 * Primary AI: Google Gemini
 * Web search: Gemini Google Search Grounding
 * Image / Video: fal.ai Queue API
 * Fake media detection: Reality Defender
 * Database: NOT used for AI answers, Library search or translation.
 * D1/R2: retained only for existing PDF storage and admin ingestion.
 *
 * Required secrets:
 * GEMINI_API_KEY
 * FAL_KEY
 * REALITY_DEFENDER_API_KEY
 * INGEST_ADMIN_TOKEN
 *
 * Optional Worker variables:
 * GEMINI_MODEL       = gemini-3.8-flash
 * FAL_IMAGE_MODEL    = fal-ai/flux/dev
 * FAL_VIDEO_MODEL    = fal-ai/kling-video/v2.1/standard
 */

const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_MEDIA_BYTES = 18 * 1024 * 1024;
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const REALITY_BASE = "https://api.prd.realitydefender.xyz";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
  "Access-Control-Max-Age": "86400"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function errorResponse(error, status = 500) {
  return json({
    success: false,
    error: String(error || "Internal server error")
  }, status);
}

async function readBody(request, maxBytes = MAX_JSON_BYTES) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("Request body is too large.");

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > maxBytes) {
    throw new Error("Request body is too large.");
  }

  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new Error("Invalid JSON request.");
  }
}

function languageInstruction(language) {
  const value = String(language || "").toLowerCase();

  if (value.includes("hindi") || value.includes("हिंदी")) {
    return "Respond in clear, natural Hindi using Devanagari script.";
  }
  if (value.includes("hinglish")) {
    return "Respond in natural Hinglish using Roman script.";
  }
  return "Respond in clear, natural English.";
}

function extractGemini(data) {
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  const answer = parts
    .map(p => typeof p.text === "string" ? p.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();

  const metadata = candidate?.groundingMetadata || {};
  const sources = (metadata.groundingChunks || [])
    .map(item => item?.web)
    .filter(item => item?.uri)
    .map(item => ({
      title: item.title || item.uri,
      url: item.uri
    }))
    .filter((item, index, arr) =>
      arr.findIndex(x => x.url === item.url) === index
    );

  return {
    answer,
    sources,
    searchQueries: metadata.webSearchQueries || [],
    searchUsed: Boolean(
      metadata.groundingChunks?.length ||
      metadata.searchEntryPoint
    )
  };
}

/* ---------------- GEMINI + GOOGLE SEARCH ---------------- */

async function gemini(env, prompt, language = "English", search = true) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY secret is missing.");
  }

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  const system = `
You are NYAYVERSE AI, an Indian legal information and general
knowledge assistant.

${languageInstruction(language)}

Rules:
- Answer the actual question directly.
- Do not treat greetings as legal questions.
- Never invent laws, sections, case names, judgments, dates,
  statistics, citations, quotations or source URLs.
- Prefer official Indian government, Parliament, Supreme Court,
  High Courts, regulators and other primary sources.
- Distinguish enacted law from bills, draft rules, proposals,
  notifications and court judgments.
- Mention the relevant jurisdiction and date where useful.
- If a fact is uncertain, say so clearly.
- Do not claim to have searched unless search grounding metadata
  is returned by the API.
- Do not use or claim access to NYAYVERSE's D1 database.
- This is general educational information, not legal advice.

USER REQUEST:
${prompt}
`;

  const payload = {
    contents: [{
      role: "user",
      parts: [{ text: system }]
    }],
    generationConfig: {
      temperature: search ? 1 : 0.4,
      maxOutputTokens: 4096
    }
  };

  if (search) {
    payload.tools = [{ google_search: {} }];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error?.message || `Gemini API error: ${response.status}`
    );
  }

  const result = extractGemini(data);
  if (!result.answer) {
    throw new Error("Gemini returned an empty response.");
  }

  return result;
}

function sourceList(sources) {
  return (sources || []).slice(0, 10).map((source, index) => ({
    number: index + 1,
    title: source.title,
    url: source.url
  }));
}

function withSources(answer, sources) {
  if (!sources?.length) return answer;

  return answer + "\n\nSources:\n" +
    sources.slice(0, 8).map((s, i) =>
      `${i + 1}. ${s.title}\n${s.url}`
    ).join("\n");
}

/* ---------------- CHAT ---------------- */

async function handleChat(request, env) {
  const body = await readBody(request);
  const message = String(body.message || body.question || "").trim();
  const language = body.language || "English";

  if (!message) return errorResponse("Message is required.", 400);
  if (message.length > 12000) {
    return errorResponse("Message exceeds 12,000 characters.", 413);
  }

  // Gemini is the primary AI.
  // Google Search Grounding is enabled.
  // No D1 or R2 query occurs in this function.
  const result = await gemini(env, message, language, true);
  const reply = withSources(result.answer, result.sources);

  return json({
    success: true,
    answer: reply,
    reply,
    response: reply,
    provider: "gemini",
    google_search_used: result.searchUsed,
    search_queries: result.searchQueries,
    sources: sourceList(result.sources),
    database_used: false
  });
}

/* ---------------- LAW LIBRARY SEARCH ---------------- */

async function handleLibrarySearch(request, env) {
  const body = await readBody(request);
  const query = String(body.query || body.q || "").trim();

  if (!query) return errorResponse("Search query is required.", 400);

  const prompt = `
Search for this Indian legal topic using Google Search.
Prioritize official sources such as India Code, Legislative
Department, e-Gazette, Supreme Court of India, High Courts,
India's government ministries and statutory regulators.

Topic: ${query}

Return:
1. A simple explanation of the topic.
2. Relevant Act / Rules / Regulations / constitutional provisions,
   only when verified.
3. Relevant official documents or judgments.
4. Effective date or current status where available.
5. Direct source URLs.

Clearly label anything that could not be verified.
`;

  const result = await gemini(env, prompt, body.language || "English", true);

  return json({
    success: true,
    query,
    answer: result.answer,
    results: sourceList(result.sources),
    sources: sourceList(result.sources),
    search_queries: result.searchQueries,
    provider: "gemini_google_search",
    database_used: false
  });
}

/* ---------------- LAW NEWS ---------------- */

async function handleNews(request, env) {
  const body = await readBody(request);
  const topic = String(body.topic || body.query || "latest Indian legal updates").trim();

  const prompt = `
Find the latest Indian legal news and updates about:
${topic}

Use Google Search. Prioritize official court websites,
government departments, India Code, e-Gazette and regulators.
For each update include:
- Headline
- What happened
- Date of event / notification / judgment
- Current status
- Official source URL

Do not present an old report as breaking news.
If the date or current status cannot be verified, say so.
`;

  const result = await gemini(env, prompt, body.language || "English", true);

  return json({
    success: true,
    answer: result.answer,
    news: result.answer,
    sources: sourceList(result.sources),
    search_queries: result.searchQueries,
    provider: "gemini_google_search",
    database_used: false
  });
}

/* ---------------- TRANSLATION ---------------- */

async function handleTranslate(request, env) {
  const body = await readBody(request);
  const text = String(body.text || body.content || "").trim();
  const target = String(body.target_language || body.targetLanguage || "").trim();

  if (!text) return errorResponse("Text to translate is required.", 400);
  if (!target) return errorResponse("Target language is required.", 400);
  if (text.length > 20000) {
    return errorResponse("Text exceeds 20,000 characters.", 413);
  }

  const result = await gemini(
    env,
    `Translate the following text into ${target}.
Preserve legal meaning, section numbers, citations, headings,
formatting and defined terms. Do not add or remove provisions.
If a legal term has no exact equivalent, retain the original
term in brackets with a clear translation.

TEXT:
${text}`,
    target,
    false
  );

  return json({
    success: true,
    translated_text: result.answer,
    translation: result.answer,
    target_language: target,
    provider: "gemini",
    database_used: false
  });
}

/* ---------------- FAL.AI HELPERS ---------------- */

function validFalModel(model) {
  return typeof model === "string" &&
    /^[a-zA-Z0-9._-]+(\/[a-zA-Z0-9._-]+){1,4}$/.test(model);
}

function aspectDimensions(ratio) {
  const values = {
    "1:1": { width: 1024, height: 1024 },
    "9:16": { width: 768, height: 1365 },
    "16:9": { width: 1365, height: 768 },
    "4:5": { width: 1024, height: 1280 }
  };
  return values[ratio] || values["1:1"];
}

async function falSubmit(env, model, input) {
  if (!env.FAL_KEY) throw new Error("FAL_KEY secret is missing.");
  if (!validFalModel(model)) throw new Error("Invalid fal.ai model ID.");

  const response = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${env.FAL_KEY}`,
      "Content-Type": "application/json",
      "X-Fal-Store-IO": "1"
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(55000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      data?.detail || data?.error || `fal.ai submit failed: ${response.status}`
    );
  }

  return { ...data, model };
}

async function handleCreateImage(request, env) {
  const body = await readBody(request);
  const prompt = String(body.prompt || body.description || "").trim();
  const ratio = String(body.aspect_ratio || body.ratio || "1:1");

  if (!prompt) return errorResponse("Image prompt is required.", 400);
  if (prompt.length > 4000) return errorResponse("Prompt is too long.", 413);

  const model = env.FAL_IMAGE_MODEL || "fal-ai/flux/dev";
  const dimensions = aspectDimensions(ratio);

  const job = await falSubmit(env, model, {
    prompt,
    image_size: dimensions,
    num_images: 1,
    enable_safety_checker: true
  });

  return json({
    success: true,
    provider: "fal.ai",
    type: "image",
    model,
    status: job.status || "IN_QUEUE",
    request_id: job.request_id,
    status_url: job.status_url,
    response_url: job.response_url,
    message: "Image generation request submitted."
  }, 202);
}

async function handleCreateVideo(request, env) {
  const body = await readBody(request);
  const prompt = String(body.prompt || body.description || "").trim();
  const ratio = String(body.aspect_ratio || body.ratio || "9:16");
  const durationRaw = String(body.duration || "5").toLowerCase();
  const duration = Number.parseInt(durationRaw, 10);

  if (!prompt) return errorResponse("Video prompt is required.", 400);
  if (prompt.length > 4000) return errorResponse("Prompt is too long.", 413);
  if (![5, 10, 15, 30].includes(duration)) {
    return errorResponse("Duration must be 5, 10, 15 or 30 seconds.", 400);
  }

  const model = env.FAL_VIDEO_MODEL || "fal-ai/kling-video/v2.1/standard";

  // Video model input schemas vary. Configure FAL_VIDEO_MODEL
  // to a model whose schema accepts prompt, aspect_ratio, duration.
  const job = await falSubmit(env, model, {
    prompt,
    aspect_ratio: ratio,
    duration
  });

  return json({
    success: true,
    provider: "fal.ai",
    type: "video",
    model,
    status: job.status || "IN_QUEUE",
    request_id: job.request_id,
    status_url: job.status_url,
    response_url: job.response_url,
    message: "Video generation request submitted."
  }, 202);
}

async function handleFalStatus(url, env) {
  if (!env.FAL_KEY) throw new Error("FAL_KEY secret is missing.");

  const model = url.searchParams.get("model") || "";
  const requestId = url.searchParams.get("request_id") || "";

  if (!validFalModel(model)) return errorResponse("Valid model parameter is required.", 400);
  if (!/^[a-zA-Z0-9-]+$/.test(requestId)) {
    return errorResponse("Valid request_id is required.", 400);
  }

  const base = `https://queue.fal.run/${model}/requests/${requestId}`;

  const statusResponse = await fetch(`${base}/status`, {
    headers: { "Authorization": `Key ${env.FAL_KEY}` }
  });
  const statusData = await statusResponse.json().catch(() => ({}));

  if (!statusResponse.ok) {
    throw new Error(statusData?.detail || `fal.ai status error: ${statusResponse.status}`);
  }

  if (statusData.status !== "COMPLETED") {
    return json({
      success: true,
      status: statusData.status,
      request_id: requestId,
      queue_position: statusData.queue_position ?? null,
      result: null
    });
  }

  if (statusData.error) {
    return json({
      success: false,
      status: "FAILED",
      error: statusData.error
    }, 502);
  }

  const resultResponse = await fetch(base, {
    headers: { "Authorization": `Key ${env.FAL_KEY}` }
  });
  const resultData = await resultResponse.json().catch(() => ({}));

  if (!resultResponse.ok) {
    throw new Error(resultData?.detail || `fal.ai result error: ${resultResponse.status}`);
  }

  return json({
    success: true,
    status: "COMPLETED",
    request_id: requestId,
    result: resultData
  });
}

/* ---------------- REALITY DEFENDER ---------------- */

function decodeBase64(value) {
  const clean = String(value || "").replace(/^data:[^,]+,/, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function handleMediaCheck(request, env) {
  if (!env.REALITY_DEFENDER_API_KEY) {
    throw new Error("REALITY_DEFENDER_API_KEY secret is missing.");
  }

  const body = await readBody(request);
  const fileName = String(body.file_name || body.filename || "upload.bin");
  const base64 = body.file_base64 || body.base64;
  const mimeType = String(body.mime_type || body.content_type || "application/octet-stream");

  if (!base64) return errorResponse("file_base64 is required.", 400);
  if (!/^[a-zA-Z0-9._ -]{1,160}$/.test(fileName)) {
    return errorResponse("Invalid file name.", 400);
  }

  const bytes = decodeBase64(base64);
  if (!bytes.length) return errorResponse("Empty media file.", 400);
  if (bytes.length > MAX_MEDIA_BYTES) {
    return errorResponse("Media file exceeds 18 MB. Choose a smaller file.", 413);
  }

  const headers = {
    "X-API-KEY": env.REALITY_DEFENDER_API_KEY,
    "Content-Type": "application/json"
  };

  // Step 1: request a signed upload URL.
  const signedResponse = await fetch(
    `${REALITY_BASE}/api/files/aws-presigned`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ fileName }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const signedData = await signedResponse.json().catch(() => ({}));
  if (!signedResponse.ok) {
    throw new Error(
      signedData?.message || signedData?.error ||
      `Reality Defender signed URL error: ${signedResponse.status}`
    );
  }

  const signedUrl =
    signedData?.response?.signedUrl ||
    signedData?.signedUrl;

  const requestId =
    signedData?.response?.requestId ||
    signedData?.requestId ||
    signedData?.response?.id;

  if (!signedUrl) {
    throw new Error("Reality Defender did not return a signed upload URL.");
  }

  // Step 2: upload raw file bytes to the signed URL.
  const uploadResponse = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType },
    body: bytes,
    signal: AbortSignal.timeout(55000)
  });

  if (!uploadResponse.ok) {
    throw new Error(`Reality Defender media upload failed: ${uploadResponse.status}`);
  }

  if (!requestId) {
    return json({
      success: true,
      status: "UPLOADED",
      message: "Media uploaded. The API did not return a request ID, so a verdict cannot yet be fetched. Check your Reality Defender API account or SDK workflow.",
      file_name: fileName
    }, 202);
  }

  // Step 3: fetch current detection result.
  const resultResponse = await fetch(
    `${REALITY_BASE}/api/media/users/${encodeURIComponent(requestId)}`,
    { headers, signal: AbortSignal.timeout(30000) }
  );

  const resultData = await resultResponse.json().catch(() => ({}));
  if (!resultResponse.ok) {
    throw new Error(
      resultData?.message || `Reality Defender result error: ${resultResponse.status}`
    );
  }

  return json({
    success: true,
    provider: "reality_defender",
    request_id: requestId,
    status: resultData?.response?.status || resultData?.status || "PROCESSING",
    result: resultData,
    message: "Detection request submitted. If processing is not complete, poll the result endpoint."
  }, 202);
}

async function handleMediaResult(url, env) {
  if (!env.REALITY_DEFENDER_API_KEY) {
    throw new Error("REALITY_DEFENDER_API_KEY secret is missing.");
  }

  const requestId = url.searchParams.get("request_id") || "";
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(requestId)) {
    return errorResponse("Valid request_id is required.", 400);
  }

  const response = await fetch(
    `${REALITY_BASE}/api/media/users/${encodeURIComponent(requestId)}`,
    {
      headers: {
        "X-API-KEY": env.REALITY_DEFENDER_API_KEY,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(30000)
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `Reality Defender result error: ${response.status}`);
  }

  return json({
    success: true,
    provider: "reality_defender",
    request_id: requestId,
    status: data?.response?.status || data?.status || "PROCESSING",
    result: data
  });
}

/* ---------------- EXISTING D1/R2 STORAGE ONLY ---------------- */

async function handlePdf(env) {
  if (!env.LEGAL_PDFS) {
    return errorResponse("LEGAL_PDFS R2 binding is missing.");
  }

  const object = await env.LEGAL_PDFS.get("constitution_of_india_2026.pdf");
  if (!object) return errorResponse("Constitution PDF not found in R2.", 404);

  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", "inline; filename=constitution_of_india_2026.pdf");
  headers.set("Cache-Control", "private, max-age=3600");

  return new Response(object.body, { headers });
}

async function handleIngest(request, env) {
  if (!env.LEGAL_DB) return errorResponse("LEGAL_DB D1 binding is missing.");

  const token = request.headers.get("x-admin-token");
  if (!env.INGEST_ADMIN_TOKEN || token !== env.INGEST_ADMIN_TOKEN) {
    return errorResponse("Unauthorized.", 401);
  }

  const body = await readBody(request);
  const documentId = Number(body.document_id);
  const pages = body.pages;

  if (!Number.isInteger(documentId) || documentId < 1) {
    return errorResponse("Valid document_id is required.", 400);
  }
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 5) {
    return errorResponse("Send 1 to 5 pages per batch.", 400);
  }

  const statements = [];

  for (const page of pages) {
    const pageNumber = Number(page.pageNumber);
    const content = String(page.text || "").trim();

    if (!Number.isInteger(pageNumber) || pageNumber < 1 ||
        !content || content.length > 50000) {
      return errorResponse("Invalid page number or page text.", 400);
    }

    statements.push(
      env.LEGAL_DB.prepare(`
        INSERT INTO legal_chunks
          (document_id, chunk_index, section_title, content)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(document_id, chunk_index)
        DO UPDATE SET content = excluded.content
      `).bind(documentId, pageNumber, `Page ${pageNumber}`, content)
    );
  }

  await env.LEGAL_DB.batch(statements);

  return json({
    success: true,
    document_id: documentId,
    pages_saved: pages.length,
    message: "PDF text saved to the legal storage database."
  });
}

/* ---------------- HEALTH CHECK + ROUTER ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (request.method === "GET" && path === "/") {
        return json({
          success: true,
          service: "NYAYVERSE AI Backend",
          status: "online",
          primary_ai: "Google Gemini",
          search: "Google Search Grounding",
          image_video: "fal.ai",
          fake_media_checker: "Reality Defender",
          database_policy: "D1 is not used for AI answers, Library search, News or Translation."
        });
      }

      if (request.method === "GET" && path === "/health") {
        return json({
          success: true,
          status: "online",
          configured: {
            gemini: Boolean(env.GEMINI_API_KEY),
            fal: Boolean(env.FAL_KEY),
            reality_defender: Boolean(env.REALITY_DEFENDER_API_KEY),
            d1_storage: Boolean(env.LEGAL_DB),
            r2_pdf_storage: Boolean(env.LEGAL_PDFS)
          }
        });
      }

      if (request.method === "POST" &&
          (path === "/" || path === "/chat" || path === "/api/chat")) {
        return await handleChat(request, env);
      }

      if (request.method === "POST" &&
          (path === "/library/search" || path === "/api/library/search")) {
        return await handleLibrarySearch(request, env);
      }

      if (request.method === "POST" &&
          (path === "/news" || path === "/api/news")) {
        return await handleNews(request, env);
      }

      if (request.method === "POST" &&
          (path === "/library/translate" || path === "/api/translate")) {
        return await handleTranslate(request, env);
      }

      if (request.method === "POST" &&
          (path === "/api/image" || path === "/create-image")) {
        return await handleCreateImage(request, env);
      }

      if (request.method === "POST" &&
          (path === "/api/video" || path === "/create-video")) {
        return await handleCreateVideo(request, env);
      }

      if (request.method === "GET" &&
          (path === "/api/fal/status" || path === "/fal/status")) {
        return await handleFalStatus(url, env);
      }

      if (request.method === "POST" &&
          (path === "/api/media/check" || path === "/media/check")) {
        return await handleMediaCheck(request, env);
      }

      if (request.method === "GET" &&
          (path === "/api/media/result" || path === "/media/result")) {
        return await handleMediaResult(url, env);
      }

      if (request.method === "GET" && path === "/library/pdf") {
        return await handlePdf(env);
      }

      if (request.method === "POST" && path === "/admin/ingest-chunk") {
        return await handleIngest(request, env);
      }

      if (request.method === "GET" && path === "/test-pdf") {
        if (!env.LEGAL_PDFS) return errorResponse("LEGAL_PDFS binding missing.");
        const object = await env.LEGAL_PDFS.get("constitution_of_india_2026.pdf");
        return json({
          success: true,
          pdf_exists: Boolean(object),
          pdf_size: object?.size || 0
        });
      }

      return errorResponse("Route not found.", 404);

    } catch (error) {
      const message = error?.message || "Internal server error.";
      const status = /too large/i.test(message) ? 413 : 500;

      return errorResponse(message, status);
    }
  }
};
