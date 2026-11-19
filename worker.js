/* ---------------- NYAYVERSE AUTH SYSTEM ---------------- */

const AUTH_SESSION_DAYS = 30;
const AUTH_TOKEN_MINUTES = 30;
const AUTH_PASSWORD_ITERATIONS = 310000;

function authRandomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

async function authHash(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function authPasswordHash(password, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    salt: new TextEncoder().encode(salt),
    iterations: AUTH_PASSWORD_ITERATIONS,
    hash: "SHA-256"
  }, key, 256);

  return Array.from(new Uint8Array(bits), b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function authEqual(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function authNow() {
  return new Date().toISOString();
}

function authFutureMinutes(minutes) {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

function authFutureDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

async function ensureAuthSchema(env) {
  if (!env.LEGAL_DB) throw new Error("LEGAL_DB D1 binding is missing.");

  await env.LEGAL_DB.batch([
    env.LEGAL_DB.prepare(`
      CREATE TABLE IF NOT EXISTS nyay_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        email_verified INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      )
    `),
    env.LEGAL_DB.prepare(`
      CREATE TABLE IF NOT EXISTS nyay_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY(user_id) REFERENCES nyay_users(id)
      )
    `),
    env.LEGAL_DB.prepare(`
      CREATE TABLE IF NOT EXISTS nyay_email_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        purpose TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY(user_id) REFERENCES nyay_users(id)
      )
    `),
    env.LEGAL_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_nyay_sessions_user
      ON nyay_sessions(user_id)
    `),
    env.LEGAL_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_nyay_email_tokens_user
      ON nyay_email_tokens(user_id, purpose)
    `)
  ]);
}

async function authSendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY secret is missing.");
  }
  if (!env.AUTH_EMAIL_FROM) {
    throw new Error("AUTH_EMAIL_FROM secret is missing.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM,
      to: [to],
      subject,
      html
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Email delivery failed: ${response.status}`);
  }
  return data;
}

async function authCreateEmailToken(env, userId, purpose) {
  const token = authRandomToken();
  const id = crypto.randomUUID();

  await env.LEGAL_DB.prepare(`
    INSERT INTO nyay_email_tokens
      (id, user_id, token_hash, purpose, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId,
    await authHash(token),
    purpose,
    authFutureMinutes(AUTH_TOKEN_MINUTES),
    authNow()
  ).run();

  return token;
}

async function authSendVerification(env, user) {
  const token = await authCreateEmailToken(env, user.id, "verify");
  const base = String(env.PUBLIC_APP_URL || "").replace(/\/+$/, "");

  if (!base) throw new Error("PUBLIC_APP_URL secret is missing.");

  const link = `${base}/?auth=verify&token=${encodeURIComponent(token)}`;

  await authSendEmail(
    env,
    user.email,
    "Verify your NYAYVERSE AI account",
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
      <h2>Welcome to NYAYVERSE AI</h2>
      <p>Click below to verify your email address.</p>
      <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#b89035;color:#111;text-decoration:none;border-radius:6px">Verify Email</a></p>
      <p>This link expires in 30 minutes. If you did not create this account, ignore this email.</p>
    </div>`
  );
}

async function authCreateSession(env, user) {
  const token = authRandomToken();
  const id = crypto.randomUUID();

  await env.LEGAL_DB.prepare(`
    INSERT INTO nyay_sessions
      (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    id,
    user.id,
    await authHash(token),
    authFutureDays(AUTH_SESSION_DAYS),
    authNow()
  ).run();

  await env.LEGAL_DB.prepare(`
    UPDATE nyay_users SET last_login_at = ?, updated_at = ? WHERE id = ?
  `).bind(authNow(), authNow(), user.id).run();

  return {
    token,
    expires_at: authFutureDays(AUTH_SESSION_DAYS)
  };
}

async function authGetUser(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token || token.length > 200) return null;

  const tokenHash = await authHash(token);
  const row = await env.LEGAL_DB.prepare(`
    SELECT
      u.id, u.email, u.email_verified, u.status,
      s.id AS session_id, s.expires_at
    FROM nyay_sessions s
    JOIN nyay_users u ON u.id = s.user_id
    WHERE s.token_hash = ?
      AND s.revoked_at IS NULL
      AND s.expires_at > ?
      AND u.status = 'active'
    LIMIT 1
  `).bind(tokenHash, authNow()).first();

  return row || null;
}

async function authSignup(request, env) {
  await ensureAuthSchema(env);
  const body = await readBody(request, 20000);

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return errorResponse("Enter a valid email address.", 400);
  }
  if (password.length < 10 || password.length > 128) {
    return errorResponse("Password must be 10 to 128 characters.", 400);
  }

  const existing = await env.LEGAL_DB.prepare(
    "SELECT id FROM nyay_users WHERE email = ? LIMIT 1"
  ).bind(email).first();

  if (existing) {
    return errorResponse("An account with this email already exists. Please log in or reset your password.", 409);
  }

  const id = crypto.randomUUID();
  const salt = authRandomToken();
  const passwordHash = await authPasswordHash(password, salt);

  await env.LEGAL_DB.prepare(`
    INSERT INTO nyay_users
      (id, email, password_hash, password_salt, email_verified,
       status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, 'active', ?, ?)
  `).bind(id, email, passwordHash, salt, authNow(), authNow()).run();

  try {
    await authSendVerification(env, { id, email });
  } catch (error) {
    // Account remains unverified; user can request another verification email.
    return json({
      success: true,
      account_created: true,
      verification_sent: false,
      message: "Account created, but verification email could not be sent. Please request verification again.",
      email
    }, 202);
  }

  return json({
    success: true,
    account_created: true,
    verification_sent: true,
    message: "Account created. Check your email to verify your account."
  }, 201);
}

async function authVerifyEmail(request, env) {
  await ensureAuthSchema(env);
  const body = await readBody(request, 10000);
  const token = String(body.token || "").trim();

  if (!token) return errorResponse("Verification token is required.", 400);

  const row = await env.LEGAL_DB.prepare(`
    SELECT id, user_id FROM nyay_email_tokens
    WHERE token_hash = ? AND purpose = 'verify'
      AND used_at IS NULL AND expires_at > ?
    LIMIT 1
  `).bind(await authHash(token), authNow()).first();

  if (!row) return errorResponse("Verification link is invalid or expired.", 400);

  await env.LEGAL_DB.batch([
    env.LEGAL_DB.prepare(
      "UPDATE nyay_email_tokens SET used_at = ? WHERE id = ?"
    ).bind(authNow(), row.id),
    env.LEGAL_DB.prepare(
      "UPDATE nyay_users SET email_verified = 1, updated_at = ? WHERE id = ?"
    ).bind(authNow(), row.user_id)
  ]);

  return json({
    success: true,
    verified: true,
    message: "Email verified successfully. You can now log in."
  });
}

async function authResendVerification(request, env) {
  await ensureAuthSchema(env);
  const body = await readBody(request, 10000);
  const email = String(body.email || "").trim().toLowerCase();

  if (!email) return errorResponse("Email is required.", 400);

  const user = await env.LEGAL_DB.prepare(`
    SELECT id, email, email_verified FROM nyay_users
    WHERE email = ? AND status = 'active' LIMIT 1
  `).bind(email).first();

  if (user && !user.email_verified) {
    await authSendVerification(env, user);
  }

  return json({
    success: true,
    message: "If the account needs verification, a verification email has been sent."
  });
}

async function authLogin(request, env) {
  await ensureAuthSchema(env);
  const body = await readBody(request, 10000);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email || !password) {
    return errorResponse("Email and password are required.", 400);
  }

  const user = await env.LEGAL_DB.prepare(`
    SELECT id, email, password_hash, password_salt,
           email_verified, status
    FROM nyay_users WHERE email = ? LIMIT 1
  `).bind(email).first();

  if (!user || user.status !== "active") {
    return errorResponse("Invalid email or password.", 401);
  }

  const candidate = await authPasswordHash(password, user.password_salt);
  if (!authEqual(candidate, user.password_hash)) {
    return errorResponse("Invalid email or password.", 401);
  }

  if (!user.email_verified) {
    return errorResponse("Please verify your email before logging in.", 403);
  }

  const session = await authCreateSession(env, user);

  return json({
    success: true,
    token: session.token,
    token_type: "Bearer",
    expires_at: session.expires_at,
    user: {
      id: user.id,
      email: user.email,
      email_verified: true
    }
  });
}

async function authMe(request, env) {
  await ensureAuthSchema(env);
  const user = await authGetUser(request, env);

  if (!user) return errorResponse("Authentication required.", 401);

  return json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      email_verified: Boolean(user.email_verified)
    },
    session_expires_at: user.expires_at
  });
}

async function authLogout(request, env) {
  await ensureAuthSchema(env);
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (token) {
    await env.LEGAL_DB.prepare(`
      UPDATE nyay_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).bind(authNow(), await authHash(token)).run();
  }

  return json({ success: true, message: "Logged out successfully." });
}

async function authLogoutAll(request, env) {
  await ensureAuthSchema(env);
  const user = await authGetUser(request, env);
  if (!user) return errorResponse("Authentication required.", 401);

  await env.LEGAL_DB.prepare(`
    UPDATE nyay_sessions SET revoked_at = ?
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(authNow(), user.id).run();

  return json({ success: true, message: "All sessions have been logged out." });
}

async function authForgotPassword(request, env) {
  await ensureAuthSchema(env);
  const body = await readBody(request, 10000);
  const email = String(body.email || "").trim().toLowerCase();

  if (!email) return errorResponse("Email is required.", 400);

  const user = await env.LEGAL_DB.prepare(`
    SELECT id, email FROM nyay_users
    WHERE email = ? AND status = 'active' AND email_verified = 1
    LIMIT 1
  `).bind(email).first();

  if (user) {
    const token = await authCreateEmailToken(env, user.id, "reset");
    const base = String(env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
    if (!base) throw new Error("PUBLIC_APP_URL secret is missing.");

    const link = `${base}/?auth=reset&token=${encodeURIComponent(token)}`;

    await authSendEmail(
      env,
      user.email,
      "Reset your NYAYVERSE AI password",
      `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
        <h2>Password reset</h2>
        <p>Use the link below to reset your password.</p>
        <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#b89035;color:#111;text-decoration:none;border-radius:6px">Reset Password</a></p>
        <p>This link expires in 30 minutes. If you did not request this, ignore this email.</p>
      </div>`
    );
  }

  return json({
    success: true,
    message: "If a verified account exists for this email, a password reset link has been sent."
  });
}

async function authResetPassword(request, env) {
  await ensureAuthSchema(env);
  const body = await readBody(request, 10000);
  const token = String(body.token || "").trim();
  const password = String(body.password || "");

  if (!token) return errorResponse("Reset token is required.", 400);
  if (password.length < 10 || password.length > 128) {
    return errorResponse("Password must be 10 to 128 characters.", 400);
  }

  const row = await env.LEGAL_DB.prepare(`
    SELECT id, user_id FROM nyay_email_tokens
    WHERE token_hash = ? AND purpose = 'reset'
      AND used_at IS NULL AND expires_at > ?
    LIMIT 1
  `).bind(await authHash(token), authNow()).first();

  if (!row) return errorResponse("Password reset link is invalid or expired.", 400);

  const salt = authRandomToken();
  const passwordHash = await authPasswordHash(password, salt);

  await env.LEGAL_DB.batch([
    env.LEGAL_DB.prepare(`
      UPDATE nyay_users
      SET password_hash = ?, password_salt = ?, updated_at = ?
      WHERE id = ?
    `).bind(passwordHash, salt, authNow(), row.user_id),
    env.LEGAL_DB.prepare(
      "UPDATE nyay_email_tokens SET used_at = ? WHERE id = ?"
    ).bind(authNow(), row.id),
    env.LEGAL_DB.prepare(`
      UPDATE nyay_sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).bind(authNow(), row.user_id)
  ]);

  return json({
    success: true,
    message: "Password reset successfully. Please log in again."
  });
}

async function authDeleteAccount(request, env) {
  await ensureAuthSchema(env);
  const user = await authGetUser(request, env);
  if (!user) return errorResponse("Authentication required.", 401);

  const body = await readBody(request, 10000);
  if (String(body.confirm || "").toUpperCase() !== "DELETE") {
    return errorResponse('Send {"confirm":"DELETE"} to confirm account deletion.', 400);
  }

  await env.LEGAL_DB.batch([
    env.LEGAL_DB.prepare("DELETE FROM nyay_sessions WHERE user_id = ?").bind(user.id),
    env.LEGAL_DB.prepare("DELETE FROM nyay_email_tokens WHERE user_id = ?").bind(user.id),
    env.LEGAL_DB.prepare("DELETE FROM nyay_users WHERE id = ?").bind(user.id)
  ]);

  return json({
    success: true,
    message: "Account and authentication records deleted."
  });
}/* ---------------- HEALTH CHECK + ROUTER ---------------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        ...CORS_HEADERS,
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token"
      }});
    }

    try {
      // AUTH ROUTES
      if (method === "POST" && path === "/auth/signup")
        return await authSignup(request, env);

      if (method === "POST" && path === "/auth/login")
        return await authLogin(request, env);

      if (method === "POST" && path === "/auth/verify")
        return await authVerifyEmail(request, env);

      if (method === "POST" && path === "/auth/resend-verification")
        return await authResendVerification(request, env);

      if (method === "POST" && path === "/auth/forgot-password")
        return await authForgotPassword(request, env);

      if (method === "POST" && path === "/auth/reset-password")
        return await authResetPassword(request, env);

      if (method === "GET" && path === "/auth/me")
        return await authMe(request, env);

      if (method === "POST" && path === "/auth/logout")
        return await authLogout(request, env);

      if (method === "POST" && path === "/auth/logout-all")
        return await authLogoutAll(request, env);

      if (method === "DELETE" && path === "/auth/delete")
        return await authDeleteAccount(request, env);

      // EXISTING HOME
      if (method === "GET" && path === "/") {
        return json({
          success: true,
          service: "NYAYVERSE AI Backend",
          status: "online",
          primary_ai: "Google Gemini",
          search: "Google Search Grounding",
          image_video: "fal.ai",
          fake_media_checker: "Reality Defender",
          authentication: "enabled",
          database_policy: "D1 is not used for AI answers, Library search, News or Translation."
        });
      }

      // HEALTH
      if (method === "GET" && path === "/health") {
        return json({
          success: true,
          status: "online",
          configured: {
            gemini: Boolean(env.GEMINI_API_KEY),
            fal: Boolean(env.FAL_KEY),
            reality_defender: Boolean(env.REALITY_DEFENDER_API_KEY),
            d1_storage: Boolean(env.LEGAL_DB),
            r2_pdf_storage: Boolean(env.LEGAL_PDFS),
            resend: Boolean(env.RESEND_API_KEY),
            auth_email: Boolean(env.AUTH_EMAIL_FROM)
          }
        });
      }

      // CHAT
      if (method === "POST" &&
          (path === "/" || path === "/chat" || path === "/api/chat")) {
        return await handleChat(request, env);
      }

      // LIBRARY SEARCH
      if (method === "POST" &&
          (path === "/library/search" || path === "/api/library/search")) {
        return await handleLibrarySearch(request, env);
      }

      // NEWS
      if (method === "POST" &&
          (path === "/news" || path === "/api/news")) {
        return await handleNews(request, env);
      }

      // TRANSLATION
      if (method === "POST" &&
          (path === "/library/translate" || path === "/api/translate")) {
        return await handleTranslate(request, env);
      }

      // IMAGE
      if (method === "POST" &&
          (path === "/api/image" || path === "/create-image")) {
        return await handleCreateImage(request, env);
      }

      // VIDEO
      if (method === "POST" &&
          (path === "/api/video" || path === "/create-video")) {
        return await handleCreateVideo(request, env);
      }

      // FAL STATUS
      if (method === "GET" &&
          (path === "/api/fal/status" || path === "/fal/status")) {
        return await handleFalStatus(url, env);
      }

      // FAKE MEDIA CHECK
      if (method === "POST" &&
          (path === "/api/media/check" || path === "/media/check")) {
        return await handleMediaCheck(request, env);
      }

      // MEDIA RESULT
      if (method === "GET" &&
          (path === "/api/media/result" || path === "/media/result")) {
        return await handleMediaResult(url, env);
      }

      // PDF
      if (method === "GET" && path === "/library/pdf") {
        return await handlePdf(env);
      }

      // ADMIN INGESTION
      if (method === "POST" && path === "/admin/ingest-chunk") {
        return await handleIngest(request, env);
      }

      // PDF TEST
      if (method === "GET" && path === "/test-pdf") {
        if (!env.LEGAL_PDFS)
          return errorResponse("LEGAL_PDFS binding missing.");

        const object = await env.LEGAL_PDFS.get(
          "constitution_of_india_2026.pdf"
        );

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
