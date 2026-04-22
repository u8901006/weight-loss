#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS = join(ROOT, 'docs');
const DATA = join(DOCS, 'data');

const API_BASE = process.env.ZHIPU_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODELS = ['glm-5-turbo', 'glm-4.7', 'glm-4.7-flash'];
const MAX_RETRIES = 3;
const TIMEOUT_MS = 660000;
const MAX_TOKENS = 16384;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: '', output: '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function buildPrompt(papers) {
  const paperList = papers.map((p, i) => {
    return `--- Paper ${i + 1} ---
PMID: ${p.pmid}
Title: ${p.title}
Journal: ${p.journal}
Date: ${p.date}
Abstract: ${p.abstract}
Keywords: ${(p.keywords || []).join(', ')}`;
  }).join('\n\n');

  return `你是一位專業的減重與肥胖醫學研究員，同時也是一位科學傳播者。你的任務是分析最新的減重相關研究文獻，為醫療專業人員和一般讀者提供清晰、有用的繁體中文摘要。

請仔細閱讀以下 ${papers.length} 篇減重相關研究文獻，然後進行分析：

${paperList}

請提供以下分析，並以 **嚴格的 JSON 格式** 回覆（不要用 markdown code block 包裹）：

{
  "top_picks": [
    {
      "rank": 1,
      "emoji": "🔥",
      "original_title": "原文標題",
      "chinese_title": "繁體中文標題翻譯",
      "summary": "精簡摘要（繁體中文，150-200字，說明研究背景、方法、主要發現與臨床意義）",
      "utility": "高/中/低",
      "pico": {
        "patient": "研究對象描述",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "tags": ["標籤1", "標籤2"],
      "pmid": "PMID"
    }
  ],
  "all_papers": [
    {
      "emoji": "📄",
      "original_title": "原文標題",
      "chinese_title": "繁體中文標題",
      "summary": "簡短摘要（繁體中文，50-100字）",
      "utility": "高/中/低",
      "tags": ["標籤1"],
      "pmid": "PMID"
    }
  ],
  "topic_distribution": {
    "藥物治療": 5,
    "飲食介入": 3,
    "運動與體能活動": 2,
    "行為與心理": 4,
    "減重手術": 1,
    "神經科學": 1,
    "社會決定因素": 1,
    "體重維持": 1,
    "小兒肥胖": 1,
    "糖尿病與代謝": 2
  },
  "keywords": ["關鍵字1", "關鍵字2"]
}

規則：
1. 從 ${papers.length} 篇中選出 5-8 篇最重要、最值得關注的研究作為 top_picks
2. 所有文獻都必須出現在 all_papers 中（包括 top_picks）
3. utility 評分標準：高=可直接影響臨床決策或重大突破、中=有參考價值、低=初步或間接相關
4. 標籤請從以下分類中選擇：藥物治療、飲食介入、運動與體能活動、行為與心理、減重手術、神經科學與機制、社會決定因素與政策、體重維持、小兒肥胖、糖尿病與代謝、公共衛生、其他
5. emoji 請使用與研究主題相關的表情符號
6. 所有摘要必須以繁體中文撰寫
7. topic_distribution 的數字加總應等於 ${papers.length}
8. keywords 提取 15-25 個最常出現的關鍵字
9. 必須回覆純 JSON，不要用 \`\`\`json 包裹`;
}

async function callGLM(prompt, model, apiKey) {
  const url = `${API_BASE}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: '你是一位專業的減重與肥胖醫學研究分析師，擅長將研究文獻轉譯為易懂的繁體中文摘要。你必須以純 JSON 格式回覆，不要使用 markdown code block。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: MAX_TOKENS
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API error ${resp.status}: ${text.slice(0, 500)}`);
  }

  const data = await resp.json();
  return data?.choices?.[0]?.message?.content || '';
}

function parseJSON(text) {
  // Attempt 1: direct parse
  try { return JSON.parse(text); } catch {}

  // Attempt 2: extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try { return JSON.parse(codeBlockMatch[1].trim()); } catch {}
  }

  // Attempt 3: find outermost JSON object
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch {}
      }
    }
  }

  // Attempt 4: fix common issues (trailing commas, BOM, etc.)
  let cleaned = text.replace(/^\uFEFF/, '').trim();
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}

  // Attempt 5: try with code block extraction on cleaned text
  const cb2 = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (cb2) {
    let inner = cb2[1].trim().replace(/,\s*([}\]])/g, '$1');
    try { return JSON.parse(inner); } catch {}
  }

  return null;
}

function buildFallbackAnalysis(papers) {
  return {
    top_picks: papers.slice(0, 5).map((p, i) => ({
      rank: i + 1,
      emoji: ['🔥', '💊', '🥗', '🏃', '🧠'][i] || '📄',
      original_title: p.title,
      chinese_title: p.title,
      summary: p.abstract?.slice(0, 200) || '摘要 unavailable',
      utility: '中',
      pico: { patient: '-', intervention: '-', comparison: '-', outcome: '-' },
      tags: ['減重研究'],
      pmid: p.pmid
    })),
    all_papers: papers.map(p => ({
      emoji: '📄',
      original_title: p.title,
      chinese_title: p.title,
      summary: p.abstract?.slice(0, 100) || '摘要 unavailable',
      utility: '中',
      tags: ['減重研究'],
      pmid: p.pmid
    })),
    topic_distribution: { '減重研究': papers.length },
    keywords: ['weight loss', 'obesity']
  };
}

function generateHTML(analysis, date, paperCount) {
  const [y, m, d] = date.split('-');
  const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const dateStr = `${y}年${parseInt(m)}月${parseInt(d)}日`;
  const weekday = weekdays[dateObj.getDay()];

  const topPicksHTML = (analysis.top_picks || []).map(pick => {
    const utilClass = pick.utility === '高' ? 'high' : pick.utility === '中' ? 'mid' : 'low';
    const picoHTML = `
      <div class="pico-grid">
        <div class="pico-item"><span class="pico-label">Patient</span><span class="pico-text">${esc(pick.pico?.patient || '-')}</span></div>
        <div class="pico-item"><span class="pico-label">Intervention</span><span class="pico-text">${esc(pick.pico?.intervention || '-')}</span></div>
        <div class="pico-item"><span class="pico-label">Comparison</span><span class="pico-text">${esc(pick.pico?.comparison || '-')}</span></div>
        <div class="pico-item"><span class="pico-label">Outcome</span><span class="pico-text">${esc(pick.pico?.outcome || '-')}</span></div>
      </div>`;
    const tagsHTML = (pick.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    return `
      <div class="card featured">
        <div class="card-header">
          <span class="rank">#${pick.rank}</span>
          <span class="emoji">${pick.emoji || '📄'}</span>
          <div class="card-titles">
            <h3 class="zh-title">${esc(pick.chinese_title || pick.original_title)}</h3>
            <p class="en-title">${esc(pick.original_title)}</p>
          </div>
        </div>
        <p class="summary">${esc(pick.summary)}</p>
        ${picoHTML}
        <div class="card-footer">
          <span class="utility ${utilClass}">臨床實用性：${pick.utility}</span>
          <div class="tags">${tagsHTML}</div>
          ${pick.pmid ? `<a class="pubmed-link" href="https://pubmed.ncbi.nlm.nih.gov/${pick.pmid}/" target="_blank">PubMed →</a>` : ''}
        </div>
      </div>`;
  }).join('');

  const allPapersHTML = (analysis.all_papers || []).map(p => {
    const utilClass = p.utility === '高' ? 'high' : p.utility === '中' ? 'mid' : 'low';
    const tagsHTML = (p.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('');
    return `
      <div class="card">
        <div class="card-header-simple">
          <span class="emoji">${p.emoji || '📄'}</span>
          <div class="card-titles">
            <h4 class="zh-title-sm">${esc(p.chinese_title || p.original_title)}</h4>
            <p class="en-title-sm">${esc(p.original_title)}</p>
          </div>
        </div>
        <p class="summary-sm">${esc(p.summary)}</p>
        <div class="card-footer">
          <span class="utility ${utilClass}">實用性：${p.utility}</span>
          <div class="tags">${tagsHTML}</div>
          ${p.pmid ? `<a class="pubmed-link" href="https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/" target="_blank">PubMed →</a>` : ''}
        </div>
      </div>`;
  }).join('');

  const topicDist = analysis.topic_distribution || {};
  const maxCount = Math.max(...Object.values(topicDist), 1);
  const topicBarsHTML = Object.entries(topicDist)
    .sort((a, b) => b[1] - a[1])
    .map(([topic, count]) => {
      const pct = Math.round((count / maxCount) * 100);
      return `
        <div class="bar-row">
          <span class="bar-label">${esc(topic)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <span class="bar-count">${count}</span>
        </div>`;
    }).join('');

  const keywordsHTML = (analysis.keywords || []).map(k => `<span class="keyword-pill">${esc(k)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>減重研究日報 - ${dateStr}（星期${weekday}）</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f1e8;--surface:#fffaf2;--line:#d8c5ab;--text:#2b2118;--muted:#766453;--accent:#8c4f2b;--accent-soft:#ead2bf;--card-bg:color-mix(in srgb,var(--surface) 92%,white)}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Noto Sans TC","PingFang TC","Helvetica Neue",Arial,sans-serif;background:radial-gradient(circle at top,#fff6ea 0,var(--bg) 55%,#ead8c6 100%);color:var(--text);line-height:1.75;min-height:100vh}
.container{max-width:880px;margin:0 auto;padding:60px 32px 80px}
@keyframes fadeDown{from{opacity:0;transform:translateY(-18px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
header{text-align:center;margin-bottom:48px;animation:fadeDown .6s ease-out both}
header h1{font-size:1.75rem;font-weight:700;color:var(--accent);margin-bottom:4px;letter-spacing:.04em}
header .date{font-size:1.1rem;color:var(--muted);margin-bottom:8px}
header .stats{display:inline-block;background:var(--accent-soft);color:var(--accent);font-size:.85rem;padding:4px 16px;border-radius:20px;font-weight:500}
section{margin-bottom:40px;animation:fadeUp .6s ease-out both}
section h2{font-size:1.3rem;font-weight:700;color:var(--accent);border-bottom:2px solid var(--line);padding-bottom:8px;margin-bottom:20px;display:flex;align-items:center;gap:8px}
.card{background:var(--card-bg);border:1px solid var(--line);border-radius:24px;padding:24px;margin-bottom:16px;box-shadow:0 2px 8px rgba(43,33,24,.06);transition:box-shadow .2s}
.card:hover{box-shadow:0 4px 16px rgba(43,33,24,.1)}
.card.featured{border-left:3px solid var(--accent)}
.card-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.card-header-simple{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}
.rank{background:var(--accent);color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.85rem;font-weight:700;flex-shrink:0}
.emoji{font-size:1.5rem;flex-shrink:0;margin-top:2px}
.card-titles{flex:1;min-width:0}
.zh-title{font-size:1.05rem;font-weight:600;line-height:1.5;margin-bottom:2px}
.en-title{font-size:.82rem;color:var(--muted);line-height:1.4}
.zh-title-sm{font-size:.95rem;font-weight:500;line-height:1.5;margin-bottom:1px}
.en-title-sm{font-size:.78rem;color:var(--muted);line-height:1.35}
.summary{font-size:.92rem;line-height:1.8;margin-bottom:14px;color:var(--text)}
.summary-sm{font-size:.85rem;line-height:1.7;margin-bottom:10px;color:var(--text)}
.pico-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.pico-item{background:rgba(140,79,43,.05);border-radius:10px;padding:8px 12px}
.pico-label{display:block;font-size:.72rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}
.pico-text{display:block;font-size:.82rem;line-height:1.5;color:var(--text)}
.card-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px}
.utility{display:inline-block;font-size:.75rem;padding:3px 10px;border-radius:12px;font-weight:600}
.utility.high{background:rgba(90,122,58,.1);color:#5a7a3a}
.utility.mid{background:rgba(159,122,46,.1);color:#9f7a2e}
.utility.low{background:rgba(118,100,83,.08);color:var(--muted)}
.tags{display:flex;gap:6px;flex-wrap:wrap;flex:1}
.tag{background:var(--accent-soft);color:var(--accent);font-size:.72rem;padding:2px 10px;border-radius:12px;font-weight:500}
.pubmed-link{font-size:.8rem;color:var(--accent);text-decoration:none;font-weight:500;white-space:nowrap}
.pubmed-link:hover{text-decoration:underline}
.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.bar-label{width:130px;text-align:right;font-size:.82rem;color:var(--text);flex-shrink:0}
.bar-track{flex:1;height:20px;background:rgba(216,197,171,.3);border-radius:10px;overflow:hidden}
.bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent-soft));border-radius:10px;transition:width .4s ease}
.bar-count{width:30px;font-size:.85rem;font-weight:600;color:var(--muted)}
.keywords{display:flex;flex-wrap:wrap;gap:8px}
.keyword-pill{background:var(--surface);border:1px solid var(--line);color:var(--muted);font-size:.78rem;padding:4px 14px;border-radius:16px}
footer{text-align:center;margin-top:56px;padding-top:24px;border-top:1px solid var(--line)}
footer .footer-links{display:flex;justify-content:center;gap:20px;flex-wrap:wrap;margin-bottom:16px}
footer .footer-links a{color:var(--accent);text-decoration:none;font-size:.88rem;font-weight:500}
footer .footer-links a:hover{text-decoration:underline}
footer .footer-meta{font-size:.78rem;color:var(--muted)}
footer .coffee{display:inline-block;background:#ff813f;color:#fff;font-size:.85rem;padding:6px 18px;border-radius:20px;text-decoration:none;font-weight:500;margin-top:12px}
footer .coffee:hover{background:#e07030}
footer .section-divider{height:1px;background:var(--line);margin:20px 0}
footer .subscribe{text-align:center;margin-bottom:12px}
footer .subscribe a{color:var(--accent);text-decoration:none;font-size:.88rem;font-weight:500}
footer .subscribe a:hover{text-decoration:underline}
@media(max-width:600px){
  .container{padding:32px 16px 48px}
  header h1{font-size:1.3rem}
  .card{padding:16px;border-radius:16px}
  .pico-grid{grid-template-columns:1fr}
  .bar-label{width:90px;font-size:.75rem}
  footer .footer-links{flex-direction:column;gap:10px}
}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>減重研究日報</h1>
    <p class="date">${dateStr}（星期${weekday}）</p>
    <span class="stats">本日收錄 ${paperCount} 篇文獻</span>
  </header>

  ${analysis.top_picks?.length ? `<section style="animation-delay:.1s">
    <h2>⭐ 今日精選</h2>
    ${topPicksHTML}
  </section>` : ''}

  ${analysis.all_papers?.length ? `<section style="animation-delay:.2s">
    <h2>📚 所有文獻</h2>
    ${allPapersHTML}
  </section>` : `<section style="animation-delay:.2s">
    <div class="card" style="text-align:center;padding:40px;color:var(--muted)">
      <p>今日無新的減重研究文獻</p>
    </div>
  </section>`}

  ${Object.keys(topicDist).length ? `<section style="animation-delay:.3s">
    <h2>📊 主題分布</h2>
    ${topicBarsHTML}
  </section>` : ''}

  ${analysis.keywords?.length ? `<section style="animation-delay:.4s">
    <h2>🏷️ 熱門關鍵字</h2>
    <div class="keywords">${keywordsHTML}</div>
  </section>` : ''}

  <footer>
    <div class="footer-links">
      <a href="https://www.leepsyclinic.com/" target="_blank">🏥 李政洋身心診所</a>
      <a href="https://blog.leepsyclinic.com/" target="_blank">📬 訂閱電子報</a>
    </div>
    <div class="section-divider"></div>
    <a class="coffee" href="https://buymeacoffee.com/CYlee" target="_blank">☕ Buy Me a Coffee</a>
    <div class="section-divider"></div>
    <p class="footer-meta">
      Powered by GLM-5-Turbo &middot; 資料來源：PubMed &middot;
      <a href="https://github.com/u8901006/weight-loss" target="_blank" style="color:var(--muted)">GitHub</a>
    </p>
  </footer>
</div>
</body>
</html>`;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function loadHistory() {
  const path = join(DATA, 'pmid_history.json');
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch {}
  }
  return { last_updated: '', pmids: [] };
}

function saveHistory(history) {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'pmid_history.json'), JSON.stringify(history, null, 2), 'utf8');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tryWithFallback(prompt, apiKey) {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.error(`[INFO] Calling ${model} (attempt ${attempt}/${MAX_RETRIES})...`);
        const text = await callGLM(prompt, model, apiKey);
        if (text) {
          const parsed = parseJSON(text);
          if (parsed) {
            console.error(`[INFO] ${model} succeeded on attempt ${attempt}`);
            return parsed;
          }
          console.error(`[WARN] ${model} returned non-JSON response on attempt ${attempt}`);
        }
      } catch (e) {
        console.error(`[WARN] ${model} attempt ${attempt} failed: ${e.message}`);
      }
      if (attempt < MAX_RETRIES) await sleep(Math.min(2000 * Math.pow(2, attempt), 30000));
    }
    console.error(`[WARN] ${model} exhausted all retries, trying next model...`);
  }
  return null;
}

async function main() {
  const opts = parseArgs();
  if (!opts.input || !opts.output) {
    console.error('Usage: node generate_report.mjs --input papers.json --output docs/weight-loss-DATE.html');
    process.exit(1);
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] ZHIPU_API_KEY environment variable is required');
    process.exit(1);
  }

  if (!existsSync(opts.input)) {
    console.error(`[ERROR] Input file not found: ${opts.input}`);
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(opts.input, 'utf8'));
  const papers = data.papers || [];
  const date = data.date || new Date().toISOString().slice(0, 10);

  console.error(`[INFO] Processing ${papers.length} papers for date ${date}`);

  let analysis;
  if (papers.length === 0) {
    analysis = { top_picks: [], all_papers: [], topic_distribution: {}, keywords: [] };
  } else {
    const prompt = buildPrompt(papers);
    console.error(`[INFO] Prompt length: ${prompt.length} chars`);
    analysis = await tryWithFallback(prompt, apiKey);
    if (!analysis) {
      console.error('[WARN] All models failed, using fallback analysis');
      analysis = buildFallbackAnalysis(papers);
    }
  }

  const html = generateHTML(analysis, date, papers.length);
  const outDir = dirname(opts.output);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(opts.output, html, 'utf8');
  console.error(`[INFO] Report saved to ${opts.output}`);

  if (papers.length > 0) {
    const history = loadHistory();
    const existingSet = new Set(history.pmids);
    for (const p of papers) {
      if (p.pmid && !existingSet.has(p.pmid)) {
        history.pmids.push(p.pmid);
      }
    }
    history.last_updated = date;
    saveHistory(history);
    console.error(`[INFO] Updated history: ${history.pmids.length} total PMIDs`);
  }
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
