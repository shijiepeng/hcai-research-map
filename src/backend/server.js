import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "./config/env.js";
import { directions, researchQuestionSeeds } from "./config/taxonomy.js";
import { nextDailyDelayMs } from "./lib/utils.js";
import { buildDashboard, buildPaperFacets, buildSearch, getDirectionDetail, getPaper, getReviewPapers, listDirections, listPapers } from "./services/analytics.js";
import { runUpdateJob } from "./services/updateJob.js";
import { ensureDb, readDb, updatePaper } from "./store/fileStore.js";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4"
};

const assistantRateLimit = new Map();

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", env.publicBaseUrl);
      if (req.method === "OPTIONS") return sendJson(res, 204, {});
      if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
        return await routeApi(req, res, url);
      }
      return await serveStatic(req, res, url);
    } catch (error) {
      console.error("Request failed:", error instanceof Error ? error.message : String(error));
      return sendJson(res, 500, { error: "internal_error", message: "Internal server error." });
    }
  });
}

async function routeApi(req, res, url) {
  const db = await readDb();
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "hcai-research-map",
      time: new Date().toISOString(),
      papers: db.papers.length,
      lastUpdateAt: db.meta.lastUpdateAt,
      liveFetch: env.enableLiveFetch
    });
  }

  if (req.method === "GET" && pathname === "/api/meta") {
    return sendJson(res, 200, {
      name: "HCAI Research Map",
      version: "0.1.0",
      defaultLanguage: "zh",
      update: {
        timezone: env.updateTimezone,
        hour: env.updateHour,
        windowHours: env.updateWindowHours,
        liveFetch: env.enableLiveFetch,
        updateOnStart: env.updateOnStart,
        sources: env.liveSources
      },
      taxonomy: {
        directions,
        researchQuestions: researchQuestionSeeds
      },
      counts: {
        papers: db.papers.length,
        updateLogs: db.updateLogs.length
      }
    });
  }

  if (req.method === "GET" && pathname === "/api/dashboard") {
    return sendJson(res, 200, buildDashboard(db));
  }

  if (req.method === "GET" && pathname === "/api/papers") {
    return sendJson(res, 200, listPapers(db, Object.fromEntries(url.searchParams)));
  }

  if (req.method === "GET" && pathname === "/api/facets") {
    return sendJson(res, 200, buildPaperFacets(db, Object.fromEntries(url.searchParams)));
  }

  const paperMatch = pathname.match(/^\/api\/papers\/([^/]+)$/);
  if (req.method === "GET" && paperMatch) {
    const paper = getPaper(db, decodeURIComponent(paperMatch[1]));
    return paper ? sendJson(res, 200, paper) : sendJson(res, 404, { error: "paper_not_found" });
  }

  if (req.method === "GET" && pathname === "/api/directions") {
    return sendJson(res, 200, { items: listDirections(db) });
  }

  const directionMatch = pathname.match(/^\/api\/directions\/([^/]+)$/);
  if (req.method === "GET" && directionMatch) {
    const direction = getDirectionDetail(db, decodeURIComponent(directionMatch[1]));
    return direction ? sendJson(res, 200, direction) : sendJson(res, 404, { error: "direction_not_found" });
  }

  if (req.method === "GET" && pathname === "/api/review/papers") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, { items: getReviewPapers(db) });
  }

  const reviewMatch = pathname.match(/^\/api\/review\/papers\/([^/]+)$/);
  if (req.method === "PATCH" && reviewMatch) {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req);
    const updated = await updatePaper(decodeURIComponent(reviewMatch[1]), sanitizePaperPatch(body));
    return updated ? sendJson(res, 200, updated) : sendJson(res, 404, { error: "paper_not_found" });
  }

  if (req.method === "POST" && pathname === "/api/jobs/update") {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req).catch(() => ({}));
    const log = await runUpdateJob({ source: "api", liveFetch: body.liveFetch, windowHours: body.windowHours });
    return sendJson(res, 200, log);
  }

  if (req.method === "GET" && pathname === "/api/update-logs") {
    return sendJson(res, 200, { items: db.updateLogs });
  }

  if (req.method === "GET" && pathname === "/api/search") {
    return sendJson(res, 200, buildSearch(db, url.searchParams.get("q")));
  }

  if (req.method === "POST" && pathname === "/api/assistant/chat") {
    if (!env.assistantEnabled) return sendJson(res, 503, { error: "assistant_disabled" });
    const limited = checkAssistantRateLimit(req);
    if (limited) return sendJson(res, 429, { error: "rate_limited", message: "Too many assistant requests. Please wait a moment." });
    const body = await readJsonBody(req);
    const message = sanitizeAssistantMessage(body.message);
    if (!message) return sendJson(res, 400, { error: "empty_message" });
    const lang = body.lang === "en" ? "en" : "zh";
    const selectedPapers = selectAssistantPapers(db, body.paperIds, message);
    const answer = await runAssistant({ message, lang, selectedPapers }).catch((error) => {
      console.warn("Assistant failed:", error instanceof Error ? error.message : String(error));
      return lang === "zh"
        ? "助手暂时没有成功返回结果。可能是模型服务、联网检索或服务器配置暂时不可用，请稍后再试。"
        : "The assistant could not return a result right now. The model service, web search, or server configuration may be temporarily unavailable.";
    });
    return sendJson(res, 200, { answer, papers: selectedPapers.map((paper) => paper.id) });
  }

  return sendJson(res, 404, { error: "not_found" });
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method_not_allowed" });

  const pathname = decodeURIComponent(url.pathname);
  const filePath = resolveStaticPath(pathname);
  if (!filePath) return sendJson(res, 404, { error: "not_found" });

  try {
    const data = await fs.readFile(filePath);
    const type = contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const shouldBypassCache = type.startsWith("text/html") || filePath.endsWith("hcai-live.js");
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": shouldBypassCache ? "no-store, no-cache, must-revalidate" : "public, max-age=3600"
    });
    if (req.method !== "HEAD") res.end(data);
    else res.end();
  } catch {
    sendJson(res, 404, { error: "not_found" });
  }
}

function resolveStaticPath(pathname) {
  if (pathname === "/" || pathname === "/zh") return path.join(env.rootDir, "hcai-radar-zh.html");
  if (pathname === "/en") return path.join(env.rootDir, "hcai-radar-en.html");
  if (pathname === "/hcai-radar-zh.html") return path.join(env.rootDir, "hcai-radar-zh.html");
  if (pathname === "/hcai-radar-en.html") return path.join(env.rootDir, "hcai-radar-en.html");
  if (pathname.startsWith("/public/")) return safeJoin(env.rootDir, pathname.slice(1));
  return null;
}

function safeJoin(root, relativePath) {
  const target = path.resolve(root, relativePath);
  return target.startsWith(root) ? target : null;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS"
  });
  if (status === 204) return res.end();
  return res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function isAuthorized(req) {
  if (env.nodeEnv === "development" && env.adminApiToken === "change-me") return true;
  return req.headers.authorization === `Bearer ${env.adminApiToken}`;
}

function sanitizePaperPatch(body) {
  const allowed = [
    "reviewStatus",
    "hcaiScore",
    "primaryDirection",
    "secondaryDirections",
    "researchQuestions",
    "researchMethods",
    "applicationContexts",
    "userGroups",
    "aiSystemTypes",
    "interactionModes",
    "evaluationMetrics",
    "contributionTypes",
    "classificationReason",
    "reviewNote"
  ];
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => allowed.includes(key)));
}

function checkAssistantRateLimit(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const maxRequests = 8;
  const bucket = (assistantRateLimit.get(ip) || []).filter((time) => now - time < windowMs);
  if (bucket.length >= maxRequests) {
    assistantRateLimit.set(ip, bucket);
    return true;
  }
  bucket.push(now);
  assistantRateLimit.set(ip, bucket);
  return false;
}

function sanitizeAssistantMessage(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, env.assistantMaxPromptChars);
}

function selectAssistantPapers(db, paperIds, message = "") {
  const ids = Array.isArray(paperIds) ? paperIds.map((id) => String(id || "").trim()).filter(Boolean).slice(0, 8) : [];
  const selected = ids.map((id) => getPaper(db, id)).filter(Boolean);
  const related = findAssistantRelevantPapers(db, message, selected);
  const merged = uniquePapers([...selected, ...related]);
  if (merged.length) return merged.slice(0, 18);
  return listPapers(db, { sort: "score", publishedWithinDays: "365", minScore: "70", limit: "18" }).items;
}

function findAssistantRelevantPapers(db, message, selected = []) {
  const text = String(message || "").toLowerCase();
  const selectedDirections = selected.flatMap((paper) => [paper.primaryDirection, ...(paper.secondaryDirections || [])]).filter(Boolean);
  const matchedDirections = directions
    .filter((direction) => assistantTextMatchesDirection(text, direction))
    .map((direction) => direction.id);
  const directionIds = [...new Set([...matchedDirections, ...selectedDirections])];
  const candidates = [];

  for (const directionId of directionIds.slice(0, 4)) {
    candidates.push(...listPapers(db, {
      direction: directionId,
      sort: "score",
      publishedWithinDays: "365",
      minScore: "70",
      limit: "10"
    }).items);
  }

  for (const query of assistantSearchQueries(message).slice(0, 4)) {
    candidates.push(...listPapers(db, {
      q: query,
      sort: "score",
      publishedWithinDays: "365",
      minScore: "70",
      limit: "8"
    }).items);
  }

  if (!candidates.length && selected.length) {
    candidates.push(...listPapers(db, {
      sort: "score",
      publishedWithinDays: "365",
      minScore: "70",
      limit: "12"
    }).items);
  }

  return uniquePapers(candidates)
    .map((paper) => ({ paper, score: assistantPaperRelevance(paper, message, directionIds, selected) }))
    .sort((a, b) => b.score - a.score || (b.paper.hcaiScore || 0) - (a.paper.hcaiScore || 0))
    .map((item) => item.paper);
}

function assistantTextMatchesDirection(text, direction) {
  const terms = [direction.id, direction.name, direction.nameZh, ...(direction.aliases || [])]
    .map((term) => String(term || "").toLowerCase())
    .filter(Boolean);
  return terms.some((term) => text.includes(term));
}

function assistantSearchQueries(message) {
  const raw = String(message || "").replace(/\s+/g, " ").trim();
  const queries = new Set();
  if (raw) queries.add(raw.slice(0, 120));
  for (const direction of directions) {
    if (assistantTextMatchesDirection(raw.toLowerCase(), direction)) {
      queries.add(direction.name);
      for (const alias of (direction.aliases || []).slice(0, 3)) queries.add(alias);
    }
  }
  const englishTerms = raw.match(/[A-Za-z][A-Za-z0-9\- ]{3,60}/g) || [];
  englishTerms
    .map((term) => term.trim())
    .filter((term) => term.length >= 5 && !/^(please|write|based|about|with|from|into)$/i.test(term))
    .slice(0, 6)
    .forEach((term) => queries.add(term));
  return [...queries].filter(Boolean);
}

function assistantPaperRelevance(paper, message, directionIds, selected) {
  const text = [
    paper.title,
    paper.titleZh,
    paper.abstract,
    paper.abstractZh,
    paper.venue,
    paper.source,
    ...(paper.authors || []),
    ...(paper.researchQuestions || []),
    ...(paper.researchMethods || []),
    ...(paper.applicationContexts || []),
    ...(paper.aiSystemTypes || [])
  ].join(" ").toLowerCase();
  const queryTokens = assistantQueryTokens(message);
  let score = 0;
  if (selected.some((item) => item.id === paper.id)) score += 80;
  if (directionIds.some((id) => paper.primaryDirection === id)) score += 45;
  if (directionIds.some((id) => (paper.secondaryDirections || []).includes(id))) score += 30;
  score += queryTokens.filter((token) => text.includes(token)).length * 8;
  score += Math.min(Number(paper.hcaiScore || 0) / 5, 20);
  score += Math.min(Number(paper.citationCount || 0), 20);
  return score;
}

function assistantQueryTokens(message) {
  const raw = String(message || "").toLowerCase();
  const english = raw.match(/[a-z][a-z0-9-]{3,}/g) || [];
  const chinese = raw.match(/[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set([...english, ...chinese])]
    .filter((token) => !["这个", "文献", "综述", "研究", "论文", "帮我", "一下", "please", "write", "review", "paper", "papers", "about"].includes(token))
    .slice(0, 24);
}

function uniquePapers(papers) {
  const seen = new Set();
  const result = [];
  for (const paper of papers) {
    if (!paper?.id || seen.has(paper.id)) continue;
    seen.add(paper.id);
    result.push(paper);
  }
  return result;
}

function assistantPaperContext(papers) {
  return papers.map((paper, index) => {
    const fields = [
      `序号: ${index + 1}`,
      `ID: ${paper.id}`,
      `标题: ${paper.title}`,
      paper.titleZh ? `中文标题: ${paper.titleZh}` : "",
      `作者: ${(paper.authors || []).slice(0, 8).join(", ") || "-"}`,
      `发表: ${paper.publishedAt || paper.year || "-"}`,
      `来源: ${[paper.source, paper.venue, paper.url || paper.doi].filter(Boolean).join(" · ")}`,
      `方向: ${[paper.primaryDirection, ...(paper.secondaryDirections || [])].filter(Boolean).join(", ")}`,
      `研究问题: ${(paper.researchQuestions || []).join(", ") || "-"}`,
      `方法: ${(paper.researchMethods || []).join(", ") || "-"}`,
      `场景: ${(paper.applicationContexts || []).join(", ") || "-"}`,
      `用户群体: ${(paper.userGroups || []).join(", ") || "-"}`,
      `摘要: ${String(paper.abstract || "").replace(/\s+/g, " ").slice(0, 900) || "-"}`,
      paper.abstractZh ? `中文导读: ${String(paper.abstractZh).replace(/\s+/g, " ").slice(0, 650)}` : ""
    ].filter(Boolean);
    return fields.join("\n");
  }).join("\n\n---\n\n");
}

async function runAssistant({ message, lang, selectedPapers }) {
  const webContext = await fetchAcademicContext(message);
  const system = lang === "zh"
    ? "你是 HCAI Research Radar 的 Claude Code 研究工作台。你可以帮助用户做主题级文献综述、方向对比、研究问题拆解、作业/论文写作提纲、文献矩阵和选题建议。优先使用下方从网站真实论文库自动召回的多篇论文，并结合后端联网学术检索到的公开资料。请用中文回答。做综述时要综合多篇文献的主题、研究问题、方法、变量、场景、发现、争议和不足，而不是只总结单篇论文。不要编造 DOI、样本量、结果或引用；无法确认的地方要说明。若信息来自联网检索，请标明来源名称或链接。"
    : "You are the Claude Code research workbench for HCAI Research Radar. Help with topic-level literature reviews, direction comparisons, research-question decomposition, outlines, literature matrices, and topic discovery. Prioritize the automatically retrieved real site papers below and combine them with public academic records fetched by the backend. Synthesize across multiple papers rather than summarizing just one paper. Do not invent citations, DOI, sample sizes, findings, or statistics.";
  const prompt = [
    system,
    "",
    "网站真实论文库自动召回结果（可能包含当前论文、同方向论文和关键词相关论文）:",
    assistantPaperContext(selectedPapers),
    "",
    "后端联网学术检索补充资料:",
    webContext || "未获得额外联网检索结果。",
    "",
    "用户问题:",
    message
  ].join("\n");
  const args = [
    "-p",
    "--bare",
    "--permission-mode",
    "dontAsk",
    "--model",
    env.assistantModel,
    "--max-budget-usd",
    String(env.assistantMaxBudgetUsd),
    prompt
  ];
  if (env.assistantWebEnabled) args.splice(1, 0, "--tools", "WebSearch,WebFetch");
  else args.splice(1, 0, "--tools", "");
  return runProcess(env.assistantClaudePath, args, {
    cwd: "/tmp",
    timeoutMs: env.assistantTimeoutMs,
    env: {
      ...process.env,
      HOME: env.assistantHome || process.env.HOME,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    }
  });
}

async function fetchAcademicContext(message) {
  const query = String(message || "")
    .replace(/[^\p{L}\p{N}\s\-:()&]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  if (!query) return "";
  const searches = await Promise.allSettled([
    searchOpenAlex(query),
    searchArxiv(query),
    searchCrossref(query)
  ]);
  return searches
    .flatMap((result) => result.status === "fulfilled" ? result.value : [])
    .slice(0, 9)
    .map((item, index) => [
      `检索结果 ${index + 1}`,
      `来源: ${item.source}`,
      `标题: ${item.title}`,
      item.authors ? `作者: ${item.authors}` : "",
      item.year ? `年份: ${item.year}` : "",
      item.url ? `链接: ${item.url}` : "",
      item.abstract ? `摘要: ${item.abstract}` : ""
    ].filter(Boolean).join("\n"))
    .join("\n\n---\n\n");
}

async function searchOpenAlex(query) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", "3");
  if (env.openAlexEmail) url.searchParams.set("mailto", env.openAlexEmail);
  const payload = await fetchJson(url);
  return (payload.results || []).map((item) => ({
    source: "OpenAlex",
    title: item.title || item.display_name || "",
    authors: (item.authorships || []).map((authorship) => authorship.author?.display_name).filter(Boolean).slice(0, 6).join(", "),
    year: item.publication_year,
    url: item.doi || item.id,
    abstract: reconstructOpenAlexAbstract(item.abstract_inverted_index).slice(0, 900)
  })).filter((item) => item.title);
}

async function searchArxiv(query) {
  const url = new URL("https://export.arxiv.org/api/query");
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", "3");
  const text = await fetchText(url);
  return [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    return {
      source: "arXiv",
      title: xmlText(entry, "title").replace(/\s+/g, " "),
      authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>\s*<\/author>/g)].map((m) => decodeXml(m[1])).slice(0, 6).join(", "),
      year: xmlText(entry, "published").slice(0, 4),
      url: xmlText(entry, "id"),
      abstract: xmlText(entry, "summary").replace(/\s+/g, " ").slice(0, 900)
    };
  }).filter((item) => item.title);
}

async function searchCrossref(query) {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query", query);
  url.searchParams.set("rows", "3");
  if (env.crossrefEmail) url.searchParams.set("mailto", env.crossrefEmail);
  const payload = await fetchJson(url);
  return (payload.message?.items || []).map((item) => ({
    source: "Crossref",
    title: (item.title || [])[0] || "",
    authors: (item.author || []).map((author) => [author.given, author.family].filter(Boolean).join(" ")).slice(0, 6).join(", "),
    year: item.published?.["date-parts"]?.[0]?.[0],
    url: item.DOI ? `https://doi.org/${item.DOI}` : item.URL,
    abstract: stripTags(item.abstract || "").slice(0, 900)
  })).filter((item) => item.title);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`fetch_${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { Accept: "application/atom+xml,text/xml" }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`fetch_${response.status}`);
  return response.text();
}

function reconstructOpenAlexAbstract(index) {
  if (!index || typeof index !== "object") return "";
  const words = [];
  Object.entries(index).forEach(([word, positions]) => {
    (positions || []).forEach((position) => {
      words[position] = word;
    });
  });
  return words.filter(Boolean).join(" ");
}

function xmlText(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match ? decodeXml(match[1]).trim() : "";
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("assistant_timeout"));
    }, options.timeoutMs).unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) return resolve(stdout.trim());
      reject(new Error(stderr.trim() || `assistant_exit_${code}`));
    });
  });
}

export function startScheduler() {
  if (!env.enableScheduler) return;

  const scheduleNext = () => {
    const delay = nextDailyDelayMs(env.updateTimezone, env.updateHour);
    setTimeout(async () => {
      await runUpdateJob({ source: "scheduler" });
      scheduleNext();
    }, delay).unref();
  };

  scheduleNext();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateProductionConfig();
  await ensureDb();
  const server = createServer();
  server.listen(env.port, env.host, () => {
    console.log(`HCAI Research Map listening on http://${env.host}:${env.port}`);
  });
  startScheduler();
  void runStartupUpdate();
}

function validateProductionConfig() {
  if (env.nodeEnv === "production" && env.adminApiToken === "change-me") {
    throw new Error("ADMIN_API_TOKEN must be set to a strong secret in production.");
  }
}

async function runStartupUpdate() {
  if (!env.enableLiveFetch) return;
  const db = await readDb();
  if (!env.updateOnStart && db.papers.length > 0) return;
  const log = await runUpdateJob({ source: "startup" });
  console.log(`Startup update ${log.status}: fetched ${log.fetched}, inserted ${log.inserted}, updated ${log.updated}`);
}
