/**
 * Cloudflare Workers — AI代理层
 * 部署: wrangler deploy
 * 环境变量: SILICONFLOW_API_KEY (在 Cloudflare Dashboard → Workers → Settings → Variables 中设置)
 *
 * 从 GitHub Pages 前端接收AI请求 → 附加API Key → 转发到 SiliconFlow → 透传响应
 */

const ALLOWED_ORIGINS = [
  "https://womeihao.github.io",
  "http://localhost:8080",
  "http://localhost:5500",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:5500",
];

const SILICONFLOW_API_URL = "https://api.siliconflow.cn/v1/chat/completions";
const MODEL = "deepseek-ai/DeepSeek-V4-Flash";

export default {
  async fetch(request, env, ctx) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(request.headers.get("Origin") || "*"),
        status: 204,
      });
    }

    // Origin检查
    const origin = request.headers.get("Origin") || "";
    const isLocalDev = origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1");
    const isAllowed = ALLOWED_ORIGINS.some(o => origin.endsWith(o.replace("https://", ""))) || isLocalDev;

    if (!isAllowed) {
      return new Response(JSON.stringify({
        error: "Forbidden: this proxy only serves authorized origins.",
        origin: origin,
      }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // 仅在 POST 时处理AI请求
    if (request.method !== "POST") {
      return new Response(JSON.stringify({
        status: "ok",
        message: "Heritage Analysis AI Proxy is running.",
        allowed_origins: ALLOWED_ORIGINS.map(o => o.split("://")[1]),
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    try {
      const body = await request.json();

      // 构建 SiliconFlow 请求体
      const aiPayload = {
        model: MODEL,
        messages: buildMessages(body),
        max_tokens: body.max_tokens || 1500,
        temperature: body.temperature || 0.3,
        stream: false,
      };

      const apiKey = env.SILICONFLOW_API_KEY;
      if (!apiKey) {
        return new Response(JSON.stringify({
          error: "Server configuration error: API key not set.",
        }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
        });
      }

      const aiResp = await fetch(SILICONFLOW_API_URL, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(aiPayload),
      });

      const result = await aiResp.json();

      return new Response(JSON.stringify(result), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders(origin),
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: "Proxy error: " + (err.message || "Unknown error"),
      }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
  },
};

function buildMessages(body) {
  const messages = [];

  // 系统提示词: 绑定上下文
  const contextType = body.context_type || "national";
  const contextId = body.context_id || "";
  const contextData = body.context_data || {};

  let systemPrompt = "You are a cultural heritage digitalization analyst. Answer questions based on the provided context data.";

  if (contextType === "province") {
    systemPrompt = `你是一位文物数字化商务分析师。当前数据范围仅限于 ${contextId.replace("province_", "")} 省的中标数据。
如果用户的问题超出此范围，请礼貌提醒："我目前只能基于${contextId.replace("province_", "")}省的数据回答您的问题。"\n\n当前省份数据摘要: ${JSON.stringify(contextData, null, 0)}`;
  } else if (contextType === "museum") {
    systemPrompt = `你是一位文物数字化商务分析师。当前数据范围仅限于 ${contextId.replace("museum_", "").replace("_", " — ")} 的项目数据。
如果用户的问题超出此范围，请礼貌提醒。\n\n当前博物馆数据摘要: ${JSON.stringify(contextData, null, 0)}`;
  }

  messages.push({ role: "system", content: systemPrompt });

  // 历史对话
  const history = body.history || [];
  messages.push(...history.slice(-10));

  // 当前问题
  messages.push({ role: "user", content: body.question || "Hello" });

  return messages;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
