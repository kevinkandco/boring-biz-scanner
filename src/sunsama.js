// Sunsama integration: one digest task per day with "On Market" (listings) and
// "Off Market" (outreach targets) sections. Whichever scan runs first creates
// the task; later scans append their section.
//
// Transport: Sunsama MCP (SUNSAMA_ACCESS_TOKEN, preferred) with email/password
// fallback via sunsama-api. Skips gracefully if neither is configured.
//
// Formatting rules learned the hard way: Sunsama's markdown converter treats
// single newlines as soft-wraps (use blank lines between everything) and does
// not support blockquotes (use italics). Headers here never exceed ###.

const { SunsamaClient } = require("sunsama-api");

const MCP_URL = "https://api.sunsama.com/mcp";

// --- MCP plumbing ---

async function mcpRequest(body, sessionId) {
  const token = process.env.SUNSAMA_ACCESS_TOKEN;
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const newSessionId = res.headers.get("mcp-session-id") || sessionId;
  if (!res.ok) {
    const text = (await res.text()).substring(0, 150);
    throw new Error(`Sunsama MCP ${res.status}: ${text}`);
  }
  if (body.id === undefined) return { result: null, sessionId: newSessionId };

  const ctype = res.headers.get("content-type") || "";
  let payload;
  if (ctype.includes("text/event-stream")) {
    const text = await res.text();
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    payload = JSON.parse(dataLines[dataLines.length - 1]);
  } else {
    payload = await res.json();
  }

  if (payload.error) throw new Error(`Sunsama MCP error: ${payload.error.message}`);
  return { result: payload.result, sessionId: newSessionId };
}

let mcpId = 10;

async function mcpSession() {
  const init = await mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "boring-biz-scanner", version: "1.0.0" },
    },
  });
  const sid = init.sessionId;
  await mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, sid);
  const { result } = await mcpRequest(
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sid
  );
  return { sid, tools: result?.tools || [] };
}

async function mcpToolCall(session, name, args) {
  const { result } = await mcpRequest(
    {
      jsonrpc: "2.0",
      id: mcpId++,
      method: "tools/call",
      params: { name, arguments: args },
    },
    session.sid
  );
  if (result?.isError) {
    throw new Error(`Sunsama ${name} error: ${JSON.stringify(result.content).substring(0, 200)}`);
  }
  return result;
}

// map our fields onto whatever the tool schema actually names them
function adaptArgs(session, toolName, mapping) {
  const tool = session.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Sunsama MCP has no tool "${toolName}"`);
  const props = tool.inputSchema?.properties || {};
  const args = {};
  for (const [value, candidates] of mapping) {
    if (value === undefined || value === null) continue;
    for (const c of candidates) {
      if (c in props) {
        args[c] = value;
        break;
      }
    }
  }
  return args;
}

function todayStr() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

async function mcpCreateTask(session, title, notes, timeEstimate) {
  const args = adaptArgs(session, "create_task", [
    [title, ["title", "text", "name"]],
    [notes, ["notes", "description", "notesMarkdown"]],
    [timeEstimate, ["timeEstimate", "time_estimate", "timeEstimateMinutes"]],
    [todayStr(), ["day"]],
  ]);
  return mcpToolCall(session, "create_task", args);
}

async function mcpFindTaskByTitle(session, title) {
  const result = await mcpToolCall(session, "search_tasks", { searchTerm: title });
  const text = (result?.content || []).map((c) => c.text || "").join("\n");
  try {
    const parsed = JSON.parse(text);
    return (parsed.tasks || []).find((t) => t.title === title) || null;
  } catch {
    return null;
  }
}

async function mcpAppendNotes(session, taskId, markdown) {
  const args = adaptArgs(session, "append_task_notes", [
    [taskId, ["taskId", "task_id", "id"]],
    [markdown, ["notes", "content", "markdown", "text", "notesMarkdown"]],
  ]);
  return mcpToolCall(session, "append_task_notes", args);
}

// --- Digest content ---

function fmtMoney(n) {
  return n != null ? `$${n.toLocaleString()}` : "—";
}

function digestTitle() {
  const dateStr = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `🏢 Deal Flow Digest — ${dateStr}`;
}

function sheetLink() {
  return process.env.SPREADSHEET_ID
    ? `[Deal flow sheet](https://docs.google.com/spreadsheets/d/${process.env.SPREADSHEET_ID})`
    : null;
}

function buildOnMarketSection(listings) {
  const parts = [`### 🏢 On Market — ${listings.length} new listing${listings.length === 1 ? "" : "s"}`];

  for (const l of listings) {
    const headline = [`**[${l.overall_score}/10] ${l.title || "Untitled listing"}**`];
    if (l.business_type) headline.push(l.business_type);
    if (l.go_no_go) headline.push(l.go_no_go);
    parts.push(headline.join(" · "));

    const facts = [
      `Asking ${fmtMoney(l.asking_price)}`,
      `SDE ${fmtMoney(l.sde || l.cash_flow)}`,
    ];
    if (l.dscr != null) facts.push(`DSCR ${l.dscr}`);
    if (l.sde_multiple != null) facts.push(`${l.sde_multiple}x SDE`);
    parts.push(facts.join(" · "));

    if (Array.isArray(l.signals) && l.signals.length > 0) {
      parts.push(`Signals: ${l.signals.join("; ")}`);
    }
    if (l.advisor_take || l.deal_summary) {
      parts.push(`*${l.advisor_take || l.deal_summary}*`);
    }
    if (l.url) parts.push(`[View listing](${l.url})`);
  }

  const link = sheetLink();
  if (link) parts.push(link);
  return parts.join("\n\n");
}

function buildOffMarketSection(targets) {
  const parts = [`### 🎯 Off Market — ${targets.length} target${targets.length === 1 ? "" : "s"}`];

  // group by region
  const byRegion = {};
  for (const t of targets) {
    const key = t.region || "Targets";
    (byRegion[key] = byRegion[key] || []).push(t);
  }

  for (const [region, list] of Object.entries(byRegion)) {
    parts.push(`**— ${region} —**`);
    for (const t of list) {
      const headline = [`**[${t.fit_score}/10] ${t.name}**`, t.category];
      if (t.rating != null) headline.push(`${t.rating}★ (${t.reviewCount || 0})`);
      if (t.est_value_range) headline.push(`Est. ${t.est_value_range}`);
      parts.push(headline.join(" · "));

      const take = t.advisor_take || t.outreach_angle;
      if (take) parts.push(`*${take}*`);

      const links = [];
      if (t.mapsUrl) links.push(`[Map](${t.mapsUrl})`);
      if (t.website) links.push(`[Website](${t.website})`);
      if (links.length > 0) parts.push(links.join(" · "));
    }
  }

  const link = sheetLink();
  if (link) parts.push(link);
  return parts.join("\n\n");
}

// --- Task creation / upsert ---

// fallback path when no MCP token: standalone task via email/password login
async function createSunsamaTask(title, notes, timeEstimate) {
  if (!process.env.SUNSAMA_EMAIL || !process.env.SUNSAMA_PASSWORD) {
    console.log("  No SUNSAMA_ACCESS_TOKEN or SUNSAMA_EMAIL/PASSWORD set, skipping Sunsama task.");
    return { created: false, reason: "credentials not set" };
  }
  const client = new SunsamaClient();
  await client.login(process.env.SUNSAMA_EMAIL, process.env.SUNSAMA_PASSWORD);
  const task = await client.createTask(title, { notes, timeEstimate });
  console.log(`  Created Sunsama task: "${title}"`);
  return { created: true, task };
}

// One digest task per day: create it if missing, append the section if it exists.
async function upsertDailyDigest(sectionMarkdown, { timeEstimate = 25 } = {}) {
  const title = digestTitle();

  try {
    if (!process.env.SUNSAMA_ACCESS_TOKEN) {
      return await createSunsamaTask(title, sectionMarkdown, timeEstimate);
    }

    const session = await mcpSession();
    const existing = await mcpFindTaskByTitle(session, title);
    if (existing) {
      await mcpAppendNotes(session, existing._id, sectionMarkdown);
      console.log(`  Appended section to today's Sunsama digest: "${title}"`);
      return { created: false, appended: true };
    }

    await mcpCreateTask(session, title, sectionMarkdown, timeEstimate);
    console.log(`  Created Sunsama digest via MCP: "${title}"`);
    return { created: true };
  } catch (err) {
    console.error(`  Sunsama digest failed: ${(err.message || "").substring(0, 150)}`);
    return { created: false, reason: err.message };
  }
}

module.exports = {
  upsertDailyDigest,
  buildOnMarketSection,
  buildOffMarketSection,
  digestTitle,
};
