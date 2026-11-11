/**
 * Cloudflare Worker: fegoname-api
 * Creative naming engine with KV IP quota enforcement, Gumroad license verification,
 * and AppSumo/Lifetime Deal KV redemption & validation.
 * Enforces BYOK (Bring Your Own Key) for Pro users to protect server Groq API limits.
 */

// =========================================================================
// SECTION 1: CONFIG & CONSTANTS
// =========================================================================
const FREE_TRIAL_LIMIT = 3;
const IP_EXPIRATION_TTL = 2592000; // 30 days in seconds (30 * 24 * 60 * 60)
const GUMROAD_PRODUCT_ID = "HnF4ytGDq_yFFnbAVEUA_g=="; // FegoName Lifetime Deal Product ID

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, x-groq-key, x-gemini-key, x-license-key, x-license-type",
};

// =========================================================================
// SECTION 2: KV IP QUOTA ENGINE (USAGE_KV)
// =========================================================================
async function checkIpQuota(env, clientIp) {
  if (!env.USAGE_KV) {
    throw new Error("Server USAGE_KV namespace is not bound in Cloudflare settings.");
  }

  const recordStr = await env.USAGE_KV.get(clientIp);
  const currentUsage = recordStr ? parseInt(recordStr, 10) : 0;
  const isAllowed = currentUsage < FREE_TRIAL_LIMIT;
  const remaining = Math.max(0, FREE_TRIAL_LIMIT - currentUsage);

  return { isAllowed, currentUsage, remaining };
}

async function incrementIpQuota(env, clientIp, currentUsage) {
  if (!env.USAGE_KV) return;
  await env.USAGE_KV.put(clientIp, (currentUsage + 1).toString(), {
    expirationTtl: IP_EXPIRATION_TTL,
  });
}

// =========================================================================
// SECTION 3: LIFETIME DEAL REDEMPTION & KV VALIDATION (LIFETIME_KV)
// =========================================================================

/**
 * Handle verification directly against APPSUMO_ACTIVE_LIST in LIFETIME_KV
 */
async function isLifetimeCodeValid(env, code) {
  if (!env.LIFETIME_KV || !code) return false;

  const cleanCode = code.trim().toUpperCase();
  const activeListStr = await env.LIFETIME_KV.get("APPSUMO_ACTIVE_LIST");
  if (!activeListStr) return false;

  let activeList = [];
  try {
    activeList = JSON.parse(activeListStr);
  } catch (e) {
    // Fallback if saved as comma-separated string
    activeList = activeListStr.split(",").map((c) => c.trim().toUpperCase());
  }

  return activeList.some((c) => c.toUpperCase() === cleanCode);
}

/**
 * Handle initial redemption from lifetime-deal.html
 */
async function handleLifetimeDealRedeem(request, env) {
  if (!env.LIFETIME_KV) {
    return new Response(
      JSON.stringify({ success: false, error: "Server LIFETIME_KV namespace is not bound." }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const body = await request.json().catch(() => ({}));
  const rawCode = body.code;

  if (!rawCode || typeof rawCode !== "string") {
    return new Response(
      JSON.stringify({ success: false, error: "Please enter a valid redemption code." }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const code = rawCode.trim().toUpperCase();
  const isValid = await isLifetimeCodeValid(env, code);

  if (!isValid) {
    return new Response(
      JSON.stringify({ success: false, error: "Invalid redemption code. Please check your purchase receipt." }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      license_key: code,
      license_type: "lifetimedeal",
      message: "Lifetime access activated successfully!",
    }),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
}

// =========================================================================
// SECTION 4: GUMROAD LICENSE VERIFIER (LOCKED TO FEGONAME)
// =========================================================================
async function handleLicenseVerification(request, env) {
  const { license_key, license_type } = await request.json().catch(() => ({}));

  if (!license_key || typeof license_key !== "string") {
    return new Response(JSON.stringify({ success: false, error: "License key is required." }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const cleanKey = license_key.trim();

  // BRANCH A: Lifetime Deal Key -> Fast KV lookup (NEVER hits Gumroad)
  if (license_type === "lifetimedeal" || cleanKey.toUpperCase().startsWith("FEGO-") || cleanKey.toUpperCase().startsWith("SCROLL-")) {
    const isLifetimeValid = await isLifetimeCodeValid(env, cleanKey);
    if (isLifetimeValid) {
      return new Response(
        JSON.stringify({ success: true, license_type: "lifetimedeal", message: "Lifetime Deal license valid" }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ success: false, error: "Invalid Lifetime Deal code." }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  // BRANCH B: Gumroad License -> Query api.gumroad.com
  const gumroadRes = await fetch("https://api.gumroad.com/v2/licenses/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      product_id: GUMROAD_PRODUCT_ID,
      license_key: cleanKey,
      increment_uses_count: "false",
    }),
  });

  const data = await gumroadRes.json().catch(() => ({}));

  if (gumroadRes.ok && data.success && !data.purchase?.refunded && !data.purchase?.chargebacked) {
    return new Response(JSON.stringify({ success: true, license_type: "gumroad", message: "License valid" }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      success: false,
      error: data.message || "Invalid or inactive license key for FegoName.",
    }),
    {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    }
  );
}

// =========================================================================
// SECTION 5: GROQ AI GENERATION ENGINE
// =========================================================================
async function generateNamesWithGroq({ idea, excludeList, count, mode, apiKey }) {
  const systemPrompt = `You are a creative naming genius who invents fresh, memorable, and novel names for ${mode === "brand" ? "brands" : "products"}.

TOTAL CREATIVE FREEDOM:
- You have zero restrictions on how you craft names.
- You can blend, trim, slice, telescope, or fuse any number of words together.
- You can take a single word and modify it, invent fresh roots, or add acoustic tone letters and syllables anywhere (at the start, middle, or end).
- Names must be single-word neologisms, easy to say, TitleCase, and between 5 to 10 characters.
- Strict ban: Never produce generic or literal compound names (e.g., do not make FastApp, CoffeeBrew, or SmartTool). Every name must feel like a distinctive, proprietary brand.

EXPLANATION FORMAT (NATURAL & PLAIN ENGLISH):
Explain how the name was built in simple, human terms without robotic labels or rigid formulas. 
Clearly mention:
1. What word(s), trimmed pieces, or sound elements were used to shape it.
2. What those original words or sounds represent.
3. What the whole name communicates and feels like for the customer.

OUTPUT FORMAT:
Return ONLY a valid JSON object with a "names" array:
{
  "names": [
    {
      "name": "Brewvelo",
      "meaning": "Brewvelo is created by taking 'Brew' for authentic craft coffee and fusing it with 'Velo' (from velocity) and a smooth '-o' finish. 'Brew' grounds the product in quality coffee, while 'Velo' represents swift, jitter-free energy. Together, it represents a coffee experience built to give developers effortless, rapid morning focus."
    }
  ]
}`;

  let userPrompt = `Brief: ${idea}\n\nCoin ${count} completely novel untaken names with plain English conversational explanations.`;
  if (Array.isArray(excludeList) && excludeList.length > 0) {
    userPrompt += `\nCRITICAL: Do NOT reuse or suggest any of these previously evaluated names:\n${excludeList.slice(-50).join(", ")}`;
  }

  const candidateModels = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
  let lastErrorText = "";
  let groqResponse;

  for (const model of candidateModels) {
    groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.95,
      }),
    });

    if (groqResponse.ok) break;
    lastErrorText = await groqResponse.text();
  }

  if (!groqResponse || !groqResponse.ok) {
    let parsedError = lastErrorText;
    try {
      const errJson = JSON.parse(lastErrorText);
      parsedError = errJson.error?.message || lastErrorText;
    } catch (e) {}

    const status = groqResponse ? groqResponse.status : 500;
    const errorObj = new Error(parsedError);
    errorObj.status = status;
    throw errorObj;
  }

  const groqData = await groqResponse.json();
  const rawContent = groqData.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw new Error("No response received from AI model.");
  }

  const parsed = JSON.parse(rawContent);
  const candidateList = Array.isArray(parsed) ? parsed : (parsed.names || []);

  // Guarantee single-word requirement: filter out any multi-word/spaced names
  return candidateList.filter((item) => item.name && !item.name.trim().includes(" "));
}

// =========================================================================
// SECTION 6: MAIN ROUTER
// =========================================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      // Endpoint 1: AppSumo / Lifetime Deal Redemption
      if (url.pathname === "/api/redeem-code") {
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
        }
        return await handleLifetimeDealRedeem(request, env);
      }

      // Endpoint 2: License Verification (Both Gumroad and Lifetime Deal)
      if (url.pathname === "/api/verify-license") {
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
        }
        return await handleLicenseVerification(request, env);
      }

      // Endpoint 3: Quota Status Check (Used by frontend on load)
      if (url.pathname === "/api/quota-status") {
        const clientIp = request.headers.get("cf-connecting-ip") || "unknown-ip";
        const quota = await checkIpQuota(env, clientIp);
        return new Response(JSON.stringify(quota), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      // Endpoint 4: Name Generation
      if (url.pathname === "/api/process/brand-name" || url.pathname === "/api/process/product-name") {
        if (request.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
        }

        const mode = url.pathname.includes("brand-name") ? "brand" : "product";
        const clientIp = request.headers.get("cf-connecting-ip") || "unknown-ip";
        const userGroqKey = request.headers.get("x-groq-key");
        const userLicenseKey = request.headers.get("x-license-key");

        // Parse request body first to detect replenishment/retry status
        const reqBody = await request.json().catch(() => ({}));
        const { idea, excludeList = [], count = 20, isReplenish = false } = reqBody;

        let activeApiKey = "";
        let isFreeTrialUser = false;
        let currentUsage = 0;

        // RULE 1: If custom Groq API key is passed -> use it directly (bypasses KV IP checks)
        if (userGroqKey && userGroqKey.trim().startsWith("gsk_")) {
          activeApiKey = userGroqKey.trim();
        } 
        // RULE 2: Pro user (has license key) but DID NOT supply their own Groq key
        else if (userLicenseKey && userLicenseKey.trim().length > 5) {
          return new Response(
            JSON.stringify({
              error: "Pro tier requires your own free Groq API key. Please add your key in Settings.",
            }),
            {
              status: 401,
              headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
            }
          );
        } 
        // RULE 3: Free trial user without license -> enforce IP quota in KV
        else {
          isFreeTrialUser = true;
          const quota = await checkIpQuota(env, clientIp);
          currentUsage = quota.currentUsage;

          // Block ONLY if this is a brand new search and quota is exhausted
          if (!quota.isAllowed && !isReplenish) {
            return new Response(
              JSON.stringify({
                error: "Free trial limit reached on your IP. Unlock Pro or paste your Groq key in Settings.",
              }),
              {
                status: 403,
                headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
              }
            );
          }

          activeApiKey = env.GROQ_API_KEY;
        }

        if (!activeApiKey) {
          return new Response(
            JSON.stringify({ error: "Server GROQ_API_KEY secret is not configured in Cloudflare." }),
            {
              status: 500,
              headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
            }
          );
        }

        if (!idea || typeof idea !== "string" || idea.trim().length < 5) {
          return new Response(JSON.stringify({ error: "A valid business description is required." }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
          });
        }

        // Run AI Generation
        const names = await generateNamesWithGroq({
          idea,
          excludeList,
          count,
          mode,
          apiKey: activeApiKey,
        });

        // INCREMENT AFTER SUCCESS: Only on round 1 of free tier (never on internal replenishment retries)
        if (isFreeTrialUser && !isReplenish) {
          ctx.waitUntil(incrementIpQuota(env, clientIp, currentUsage));
        }

        return new Response(JSON.stringify(names), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Endpoint not found" }), {
        status: 404,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    } catch (err) {
      const status = err.status || 500;
      return new Response(JSON.stringify({ error: err.message || "Internal server error" }), {
        status: status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
  },
};