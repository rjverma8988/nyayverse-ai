
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
  "Access-Control-Max-Age": "86400"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function languageRule(language = "English") {
  if (language === "Hindi") {
    return "Answer in clear Hindi using Devanagari script.";
  }
  if (language === "Hinglish") {
    return "Answer in natural Hinglish using Roman script.";
  }
  return "Answer in clear English.";
}

async function askGemini(env, prompt, language = "English") {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY secret is missing.");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `${languageRule(language)}

You are NYAYVERSE AI, an Indian legal information assistant.
Give accurate, structured and understandable information.
Use Indian laws and legal provisions only when relevant.
Never invent sections, judgments, citations or amendments.
Clearly say when information is uncertain.
This is educational information, not legal advice.

${prompt}`
          }]
        }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "Gemini API request failed."
    );
  }

  return data?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("\n") || "No answer generated.";
}

async function getLegalContext(env, question) {
  if (!env.LEGAL_DB) return [];

  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(word => word.length > 2)
    .slice(0, 8);

  if (!words.length) return [];

  const conditions = words
    .map(() => "(content LIKE ? OR section_title LIKE ?)")
    .join(" OR ");

  const bindings = [];
  for (const word of words) {
    const value = `%${word}%`;
    bindings.push(value, value);
  }

  const query = `
    SELECT document_id, chunk_index, section_title, content
    FROM legal_chunks
    WHERE ${conditions}
    ORDER BY document_id, chunk_index
    LIMIT 5
  `;

  const result = await env.LEGAL_DB
    .prepare(query)
    .bind(...bindings)
    .all();

  return result.results || [];
}

async function handleChat(request, env) {
  const body = await request.json();
  const message = String(body.message || "").trim();
  const language = body.language || "English";

  if (!message) {
    return jsonResponse({
      success: false,
      error: "Message is required."
    }, 400);
  }

  const context = await getLegalContext(env, message);

  const legalContext = context.length
    ? context.map(item =>
        `Document ID: ${item.document_id}
Page/Chunk: ${item.chunk_index}
Title: ${item.section_title || ""}
Content:
${item.content}`
      ).join("\n\n")
    : "No matching content was found in the internal legal database.";

  const prompt = `
User question:
${message}

Internal legal database context:
${legalContext}

Instructions:
1. First use relevant internal database context.
2. Do not pretend that missing database content was found.
3. Explain legal concepts in simple language.
4. Mention relevant sections only when reliable.
5. Clearly distinguish database information from general explanation.
6. If the database has no relevant information, say so.
`;

  const answer = await askGemini(env, prompt, language);

  return jsonResponse({
    success: true,
    answer,
    sources: context.map(item => ({
      document_id: item.document_id,
      page: item.chunk_index,
      title: item.section_title
    })),
    database_matches: context.length
  });
}

async function handleSearch(url, env) {
  const query = (url.searchParams.get("q") || "").trim();

  if (!query) {
    return jsonResponse({
      success: false,
      error: "Search query is required."
    }, 400);
  }

  const results = await getLegalContext(env, query);

  return jsonResponse({
    success: true,
    count: results.length,
    results
  });
}

async function handlePDF(env) {
  if (!env.LEGAL_PDFS) {
    return jsonResponse({
      success: false,
      error: "R2 bucket binding is missing."
    }, 500);
  }

  const object = await env.LEGAL_PDFS.get(
    "constitution_of_india_2026.pdf"
  );

  if (!object) {
    return jsonResponse({
      success: false,
      error: "PDF not found in R2."
    }, 404);
  }

  const headers = new Headers(corsHeaders);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", "inline; filename=constitution_of_india_2026.pdf");
  headers.set("Cache-Control", "public, max-age=3600");

  return new Response(object.body, {
    headers
  });
}

async function handleIngest(request, env) {
  if (!env.LEGAL_DB) {
    return jsonResponse({
      success: false,
      error: "D1 database binding is missing."
    }, 500);
  }

  const token = request.headers.get("x-admin-token");

  if (!env.INGEST_ADMIN_TOKEN ||
      token !== env.INGEST_ADMIN_TOKEN) {
    return jsonResponse({
      success: false,
      error: "Unauthorized."
    }, 401);
  }

  const body = await request.json();
  const documentId = Number(body.document_id);
  const pages = body.pages;

  if (!Number.isInteger(documentId) || documentId < 1) {
    return jsonResponse({
      success: false,
      error: "Valid document_id is required."
    }, 400);
  }

  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 5) {
    return jsonResponse({
      success: false,
      error: "Send between 1 and 5 pages per batch."
    }, 400);
  }

  const statements = [];

  for (const page of pages) {
    const pageNumber = Number(page.pageNumber);
    const content = String(page.text || "").trim();

    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return jsonResponse({
        success: false,
        error: "Invalid page number."
      }, 400);
    }

    if (!content || content.length > 50000) {
      return jsonResponse({
        success: false,
        error: `Invalid text on page ${pageNumber}.`
      }, 400);
    }

    statements.push(
      env.LEGAL_DB.prepare(`
        INSERT INTO legal_chunks
        (document_id, chunk_index, section_title, content)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(document_id, chunk_index)
        DO UPDATE SET
          section_title = excluded.section_title,
          content = excluded.content
      `).bind(
        documentId,
        pageNumber,
        `Page ${pageNumber}`,
        content
      )
    );
  }

  await env.LEGAL_DB.batch(statements);

  return jsonResponse({
    success: true,
    message: "Pages ingested successfully.",
    document_id: documentId,
    pages_saved: pages.length,
    page_numbers: pages.map(page => Number(page.pageNumber))
  });
}

async function handleTranslate(request, env) {
  const body = await request.json();

  const documentId = Number(body.document_id);
  const chunkIndex = Number(body.chunk_index);
  const targetLanguage = String(body.target_language || "").trim();

  if (!Number.isInteger(documentId) ||
      !Number.isInteger(chunkIndex) ||
      !targetLanguage) {
    return jsonResponse({
      success: false,
      error: "document_id, chunk_index and target_language are required."
    }, 400);
  }

  const source = await env.LEGAL_DB.prepare(`
    SELECT content
    FROM legal_chunks
    WHERE document_id = ? AND chunk_index = ?
  `).bind(documentId, chunkIndex).first();

  if (!source) {
    return jsonResponse({
      success: false,
      error: "Legal text not found."
    }, 404);
  }

  const translatedText = await askGemini(
    env,
    `Translate the following legal text into ${targetLanguage}.
Preserve its legal meaning, section numbers and structure.
Do not add or remove legal provisions.

${source.content}`,
    targetLanguage
  );

  await env.LEGAL_DB.prepare(`
    INSERT INTO legal_translations
    (document_id, chunk_index, target_language, translated_text)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(document_id, chunk_index, target_language)
    DO UPDATE SET
      translated_text = excluded.translated_text
  `).bind(
    documentId,
    chunkIndex,
    targetLanguage,
    translatedText
  ).run();

  return jsonResponse({
    success: true,
    document_id: documentId,
    chunk_index: chunkIndex,
    target_language: targetLanguage,
    translated_text: translatedText
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      if (request.method === "GET" && path === "/") {
        return jsonResponse({
          success: true,
          service: "NYAYVERSE AI Backend",
          status: "online"
        });
      }

      if (request.method === "GET" && path === "/test-pdf") {
        const object = await env.LEGAL_PDFS.get(
          "constitution_of_india_2026.pdf"
        );

        return jsonResponse({
          success: true,
          pdf_exists: Boolean(object),
          pdf_size: object?.size || 0
        });
      }

      if (request.method === "GET" && path === "/library/pdf") {
        return await handlePDF(env);
      }

      if (request.method === "GET" && path === "/library/search") {
        return await handleSearch(url, env);
      }

      if (request.method === "POST" &&
          path === "/admin/ingest-chunk") {
        return await handleIngest(request, env);
      }

      if (request.method === "POST" &&
          path === "/library/translate") {
        return await handleTranslate(request, env);
      }

      if (request.method === "POST" &&
          (path === "/" || path === "/chat")) {
        return await handleChat(request, env);
      }

      return jsonResponse({
        success: false,
        error: "Route not found."
      }, 404);

    } catch (error) {
      return jsonResponse({
        success: false,
        error: error.message || "Internal server error."
      }, 500);
    }
  }
};
