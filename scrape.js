#!/usr/bin/env node
/**
 * Scrapes a page, asks an OpenRouter free model to extract society events,
 * and writes the result to events.json.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node scrape.js https://example.com/events
 *
 * Optional env vars:
 *   OPENROUTER_MODEL  default "openrouter/free" (auto-picks an available free model)
 *   TARGET_URL        used if no URL is passed as an argument
 *   OUTPUT_FILE       default "events.json"
 *
 * Requires Node 18+ (built-in fetch). No npm packages needed.
 */
const fs = require("fs");
const path = require("path");

const TARGET_URL = "https://ucdsocieties.ie/";
const API_KEY = "";
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";
const OUTPUT_FILE = path.resolve(process.env.OUTPUT_FILE || path.join(__dirname, "events.json"));
const MAX_CHARS = 24000; // free models have small context windows
const MAX_ATTEMPTS = 3;

if (!TARGET_URL) fail("Pass the page to scrape: node scrape.js https://example.com/events");
if (!API_KEY) fail("Set OPENROUTER_API_KEY (get a free key at https://openrouter.ai/keys)");

main().catch((err) => fail(err.message));

async function main() {
  console.log(`Fetching ${TARGET_URL}`);
  const html = await fetchPage(TARGET_URL);
  const text = htmlToText(html).slice(0, MAX_CHARS);
  console.log(`Extracted ${text.length} characters of text`);

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`Asking ${MODEL} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      const reply = await askModel(text);
      const events = normalise(parseJson(reply));
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ events }, null, 2));
      const count = Object.values(events).reduce((n, list) => n + list.length, 0);
      console.log(`Wrote ${count} events from ${Object.keys(events).length} societies to ${OUTPUT_FILE}`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`  Failed: ${err.message}`);
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`Gave up after ${MAX_ATTEMPTS} attempts. Last error: ${lastError.message}`);
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SocietyEventsScraper/1.0)" },
  });
  if (!res.ok) throw new Error(`Could not fetch page: HTTP ${res.status}`);
  return res.text();
}

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

async function askModel(pageText) {
  const today = new Date().toISOString().slice(0, 10);

  const system =
    "You extract university society events from web page text. " +
    "Reply with ONLY a valid JSON object, no markdown fences and no commentary.";

  const user = `Today's date is ${today}.
Extract every society event from the page text below and return JSON in exactly this shape:

{
  "events": {
    "<Society name>": [
      { "event_name": "<string>", "date": "<string>", "location": "<string>" }
    ]
  }
}

Rules:
- Group events under the name of the society that hosts them.
- Write "date" as YYYY-MM-DD (with time as "YYYY-MM-DD HH:mm" if given). If the year is missing, assume the next upcoming occurrence. If no date is found, use "TBC".
- If the location is missing, use "TBC".
- Do not invent events. If there are none, return {"events": {}}.

PAGE TEXT:
"""
${pageText}
"""`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost",
      "X-Title": "Society Events Scraper",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body.error?.message || JSON.stringify(body)}`);

  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model returned an empty reply");
  return content;
}

// Free models sometimes wrap JSON in ``` fences or add chatter, so cut out the outermost {...}.
function parseJson(reply) {
  const cleaned = reply.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object found in reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Make sure the output is always { society: [ {event_name, date, location} ] }.
function normalise(parsed) {
  const raw = parsed.events;
  if (!raw || typeof raw !== "object") throw new Error('Reply is missing an "events" object');

  const out = {};
  for (const [society, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    const cleaned = list
      .filter((e) => e && (e.event_name || e.name))
      .map((e) => ({
        event_name: String(e.event_name || e.name).trim(),
        date: String(e.date || "TBC").trim(),
        location: String(e.location || "TBC").trim(),
      }));
    if (cleaned.length) out[society.trim()] = cleaned;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
