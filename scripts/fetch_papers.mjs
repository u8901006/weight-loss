#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DOCS = join(ROOT, 'docs');
const DATA = join(DOCS, 'data');

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const HEADERS = { 'User-Agent': 'WeightLossResearchBot/1.0 (research aggregator)' };

const SEARCH_STRATEGIES = [
  {
    name: 'General weight loss interventions',
    term: '(weight loss[Title/Abstract] OR obesity treatment[Title/Abstract] OR weight management[Title/Abstract] OR body weight reduction[Title/Abstract]) AND (intervention*[Title/Abstract] OR treatment*[Title/Abstract] OR trial[Title/Abstract] OR program*[Title/Abstract])'
  },
  {
    name: 'Anti-obesity medications',
    term: '(obesity[Title/Abstract] OR overweight[Title/Abstract]) AND (anti-obesity medication[Title/Abstract] OR obesity pharmacotherapy[Title/Abstract] OR semaglutide[Title/Abstract] OR liraglutide[Title/Abstract] OR tirzepatide[Title/Abstract] OR orlistat[Title/Abstract] OR GLP-1 receptor agonist[Title/Abstract] OR phentermine topiramate[Title/Abstract] OR naltrexone bupropion[Title/Abstract])'
  },
  {
    name: 'Bariatric and metabolic surgery',
    term: '(obesity[Title/Abstract] OR severe obesity[Title/Abstract]) AND (bariatric surgery[Title/Abstract] OR metabolic surgery[Title/Abstract] OR sleeve gastrectomy[Title/Abstract] OR gastric bypass[Title/Abstract] OR Roux-en-Y[Title/Abstract] OR endoscopic sleeve gastroplasty[Title/Abstract])'
  },
  {
    name: 'Nutrition and diet',
    term: '(obesity[Title/Abstract] OR weight loss[Title/Abstract]) AND (dietary intervention[Title/Abstract] OR calorie restriction[Title/Abstract] OR energy restriction[Title/Abstract] OR Mediterranean diet[Title/Abstract] OR low-carbohydrate diet[Title/Abstract] OR ketogenic diet[Title/Abstract] OR intermittent fasting[Title/Abstract] OR time-restricted eating[Title/Abstract] OR high-protein diet[Title/Abstract] OR satiety[Title/Abstract] OR appetite control[Title/Abstract])'
  },
  {
    name: 'Exercise and physical activity',
    term: '(obesity[Title/Abstract] OR weight loss[Title/Abstract]) AND (exercise[Title/Abstract] OR physical activity[Title/Abstract] OR resistance training[Title/Abstract] OR aerobic exercise[Title/Abstract] OR HIIT[Title/Abstract] OR high-intensity interval training[Title/Abstract] OR strength training[Title/Abstract]) AND (fat mass[Title/Abstract] OR body composition[Title/Abstract] OR visceral fat[Title/Abstract] OR waist circumference[Title/Abstract] OR energy expenditure[Title/Abstract])'
  },
  {
    name: 'Behavioral and psychological',
    term: '(obesity[Title/Abstract] OR weight loss[Title/Abstract]) AND (behavioral weight loss[Title/Abstract] OR behavior change[Title/Abstract] OR self-monitoring[Title/Abstract] OR dietary adherence[Title/Abstract] OR emotional eating[Title/Abstract] OR binge eating[Title/Abstract] OR cognitive behavioral therapy[Title/Abstract] OR mindful eating[Title/Abstract] OR motivational interviewing[Title/Abstract] OR acceptance and commitment therapy[Title/Abstract] OR self-regulation[Title/Abstract])'
  },
  {
    name: 'Neuroscience and mechanisms',
    term: '(obesity[Title/Abstract] OR weight loss[Title/Abstract]) AND (neuroimaging[Title/Abstract] OR fMRI[Title/Abstract] OR reward circuitry[Title/Abstract] OR inhibitory control[Title/Abstract] OR executive function[Title/Abstract] OR hypothalamus[Title/Abstract] OR food cue reactivity[Title/Abstract] OR appetite regulation[Title/Abstract] OR gut-brain axis[Title/Abstract] OR microbiome[Title/Abstract] OR leptin[Title/Abstract] OR ghrelin[Title/Abstract])'
  },
  {
    name: 'Social determinants and policy',
    term: '(obesity[Title/Abstract] OR overweight[Title/Abstract]) AND (weight stigma[Title/Abstract] OR social determinants of health[Title/Abstract] OR food environment[Title/Abstract] OR socioeconomic status[Title/Abstract] OR health disparit*[Title/Abstract] OR food insecurity[Title/Abstract] OR built environment[Title/Abstract] OR obesogenic environment[Title/Abstract])'
  },
  {
    name: 'Weight maintenance and diabetes',
    term: '(weight-loss maintenance[Title/Abstract] OR weight maintenance[Title/Abstract] OR weight regain[Title/Abstract] OR long-term weight loss[Title/Abstract] OR metabolic adaptation[Title/Abstract] OR adaptive thermogenesis[Title/Abstract] OR (type 2 diabetes[Title/Abstract] AND (weight loss[Title/Abstract] OR obesity treatment[Title/Abstract] OR GLP-1[Title/Abstract] OR lifestyle intervention[Title/Abstract])))'
  },
  {
    name: 'Pediatric weight management',
    term: '(pediatric obesity[Title/Abstract] OR child obesity[Title/Abstract] OR adolescent obesity[Title/Abstract]) AND (weight management[Title/Abstract] OR lifestyle intervention[Title/Abstract] OR family-based treatment[Title/Abstract] OR school-based intervention[Title/Abstract])'
  }
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 15, output: '-', totalMax: 40 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i]);
    else if (args[i] === '--max-papers' && args[i + 1]) opts.maxPapers = parseInt(args[++i]);
    else if (args[i] === '--total' && args[i + 1]) opts.totalMax = parseInt(args[++i]);
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function buildDateFilter(days) {
  const since = new Date(Date.now() - days * 86400000);
  const y = since.getFullYear();
  const m = String(since.getMonth() + 1).padStart(2, '0');
  const d = String(since.getDate()).padStart(2, '0');
  return `"${y}/${m}/${d}"[Date - Publication] : "3000"[Date - Publication]`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function searchPapers(query, retmax = 50) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const ids = pmids.join(',');
  const url = `${PUBMED_FETCH}?db=pubmed&id=${ids}&retmode=xml`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    const xml = await resp.text();
    return parseXML(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parseXML(xml) {
  const papers = [];
  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => ['PubmedArticle', 'AbstractText', 'Keyword'].includes(name)
    });
    const root = parser.parse(xml);

    const articles = root?.PubmedArticleSet?.PubmedArticle || [];
    for (const article of articles) {
      const medline = article?.MedlineCitation;
      const art = medline?.Article;
      if (!art) continue;

      const titleEl = art?.ArticleTitle;
      const title = typeof titleEl === 'string' ? titleEl.trim() : (titleEl?.['#text'] || titleEl || '').toString().trim();

      const abstractParts = [];
      const abstractTexts = art?.Abstract?.AbstractText;
      if (Array.isArray(abstractTexts)) {
        for (const abs of abstractTexts) {
          const label = abs?.['@_Label'] || '';
          const text = typeof abs === 'string' ? abs : (abs?.['#text'] || abs || '').toString();
          if (label && text.trim()) abstractParts.push(`${label}: ${text.trim()}`);
          else if (text.trim()) abstractParts.push(text.trim());
        }
      } else if (abstractTexts) {
        const text = typeof abstractTexts === 'string' ? abstractTexts : (abstractTexts?.['#text'] || '').toString();
        if (text.trim()) abstractParts.push(text.trim());
      }
      const abstract = abstractParts.join(' ').slice(0, 2000);

      const journal = art?.Journal?.Title || '';
      const pubDate = art?.Journal?.JournalIssue?.PubDate;
      let dateStr = '';
      if (pubDate) {
        const parts = [pubDate.Year, pubDate.Month, pubDate.Day].filter(Boolean);
        dateStr = parts.join(' ');
      }

      const pmidRaw = medline?.PMID;
      const pmid = typeof pmidRaw === 'object' && pmidRaw !== null
        ? String(pmidRaw['#text'] || '')
        : String(pmidRaw || '');
      const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

      const keywords = [];
      const keywordList = medline?.KeywordList?.Keyword;
      if (Array.isArray(keywordList)) {
        for (const kw of keywordList) {
          const t = typeof kw === 'string' ? kw : (kw?.['#text'] || '');
          if (t) keywords.push(t.trim());
        }
      } else if (keywordList) {
        const t = typeof keywordList === 'string' ? keywordList : (keywordList?.['#text'] || '');
        if (t) keywords.push(t.trim());
      }

      if (title || abstract) {
        papers.push({ pmid, title, journal, date: dateStr, abstract, url: link, keywords });
      }
    }
  } catch (e) {
    console.error(`[ERROR] XML parse failed: ${e.message}`);
  }
  return papers;
}

function loadHistory() {
  const path = join(DATA, 'pmid_history.json');
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { last_updated: '', pmids: [] };
    }
  }
  return { last_updated: '', pmids: [] };
}

function getTaipeiDate() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

async function main() {
  const opts = parseArgs();
  const dateFilter = buildDateFilter(opts.days);

  console.error(`[INFO] Searching PubMed for weight loss papers from last ${opts.days} days...`);

  const allPmids = new Set();
  for (const strategy of SEARCH_STRATEGIES) {
    const query = `(${strategy.term}) AND ${dateFilter}`;
    console.error(`[INFO] Strategy: ${strategy.name}`);
    const pmids = await searchPapers(query, opts.maxPapers);
    console.error(`[INFO]   Found ${pmids.length} PMIDs`);
    pmids.forEach(id => allPmids.add(id));
    await sleep(350);
  }

  console.error(`[INFO] Total unique PMIDs: ${allPmids.size}`);

  if (!allPmids.size) {
    console.error('[INFO] No papers found');
    const output = { date: getTaipeiDate(), count: 0, papers: [] };
    const str = JSON.stringify(output, null, 2);
    if (opts.output === '-') console.log(str);
    else writeFileSync(opts.output, str, 'utf8');
    return;
  }

  const pmidArr = [...allPmids];
  const papers = [];
  const batchSize = 50;
  for (let i = 0; i < pmidArr.length; i += batchSize) {
    const batch = pmidArr.slice(i, i + batchSize);
    console.error(`[INFO] Fetching details for batch ${Math.floor(i / batchSize) + 1} (${batch.length} PMIDs)...`);
    const details = await fetchDetails(batch);
    papers.push(...details);
    if (i + batchSize < pmidArr.length) await sleep(350);
  }

  const history = loadHistory();
  const historySet = new Set(history.pmids);
  const newPapers = papers.filter(p => !historySet.has(p.pmid));

  console.error(`[INFO] Fetched ${papers.length} papers, ${newPapers.length} are new (not in history)`);

  const selected = newPapers
    .sort((a, b) => {
      const aHasAbs = a.abstract ? 1 : 0;
      const bHasAbs = b.abstract ? 1 : 0;
      if (bHasAbs !== aHasAbs) return bHasAbs - aHasAbs;
      return b.date?.localeCompare(a.date || '') || 0;
    })
    .slice(0, opts.totalMax);

  console.error(`[INFO] Selected top ${selected.length} papers (max ${opts.totalMax})`);

  const today = getTaipeiDate();
  const output = { date: today, count: selected.length, papers: selected };
  const str = JSON.stringify(output, null, 2);

  if (opts.output === '-') console.log(str);
  else {
    writeFileSync(opts.output, str, 'utf8');
    console.error(`[INFO] Saved to ${opts.output}`);
  }
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
