// server.js
// Fetch departures for allowed stops. Uses fast HTML scrape first,
// and falls back to Puppeteer (headless Chromium) if service labels are missing.
//
// Requires: npm install express node-fetch@2 cheerio cors luxon puppeteer

const express = require('express')
const fetch = require('node-fetch') // v2 style
const cheerio = require('cheerio')
const cors = require('cors')
const path = require('path')
const { DateTime } = require('luxon')
const puppeteer = require('puppeteer')

const PORT = process.env.PORT || 3000
const ALLOWED_STOPS = new Set(['9400ZZSYDVS1', '9400ZZSYDVS2'])
const DEFAULT_STOP = '9400ZZSYDVS1'
const MAX_RESULTS = 8 // show more trains per your earlier suggestion
const CACHE_TTL_MS = 10 * 1000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 supertram-next-departures-web/1.0'
const ZONE = 'Europe/London'
const GRACE_SEC = 30 // allow 'due/now' edge cases

const app = express()
app.use(cors())
app.use(express.static('public'))

const cache = Object.create(null)

// Known class -> friendly label mapping (used by both scrapers)
const LINE_CLASS_MAP = {
  yell: 'Yellow',
  blue: 'Blue',
  red: 'Red',
  purp: 'Purple',
  tt: 'Tram Train'
}

function makeTsyUrl (atco) {
  return `https://journeyplanner.travelsouthyorkshire.com/?fromcode=${encodeURIComponent(
    atco
  )}&stoptype=bus_stop`
}

function truncate (s, n = 800) {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…(truncated)' : s
}

/* --------- lightweight HTML scraper (cheerio) --------- */
function extractDeparturesFromTsyHtml (html) {
  const anchorStart = 'Data Last Updated'
  const anchorEnd = 'Times Explained'
  let startIdx = html.indexOf(anchorStart)
  if (startIdx === -1) startIdx = 0
  let endIdx = html.indexOf(anchorEnd, startIdx)
  if (endIdx === -1) endIdx = startIdx + 6000
  const slice = html.slice(startIdx, Math.min(endIdx, startIdx + 9000))
  const $ = cheerio.load(slice)

  const timeRe = /\b([01]\d|2[0-3]):[0-5]\d\b/g
  const SERVICE_SELECTORS = [
    '.service',
    '.serviceCode',
    '.service-number',
    '.route',
    '.service-name',
    '.line',
    '.mode',
    '.serviceLabel',
    '.routeName',
    '.serviceNo',
    '.operator',
    '.busDepartService',
    '.busTramServices',
    '.busTramExpected'
  ]

  const LINE_CODE_MAP = {
    YELL: 'Tram — Yellow',
    BLUE: 'Tram — Blue',
    RED: 'Tram — Red',
    PURP: 'Tram — Purple',
    GRN: 'Tram — Green', // add if applicable
    TT: 'Tram train' // fallback if nothing better
  }

  // regex to detect short uppercase line codes shown on the page (e.g. YELL, BLUE)
  const LINE_CODE_RE = /\b([A-Z]{2,6})\b/

  function findServiceNearby_el ($el, timeText) {
    // prefer checking for a parent departures row class (yell/tt/blue/etc)
    try {
      const tr = $el.closest && $el.closest('.departures-tr')
      if (tr && tr.attr) {
        const cls = (tr.attr('class') || '')
          .split(/\s+/)
          .map(s => s.trim().toLowerCase())
        for (const c of cls) {
          if (LINE_CLASS_MAP[c]) return LINE_CLASS_MAP[c]
        }
      }
    } catch (e) {
      /* ignore */
    }
    // 1) try known selectors inside element (unchanged)
    for (const sel of SERVICE_SELECTORS) {
      const found = $el.find(sel).first()
      if (found && found.text().trim()) {
        const t = found.text().trim()
        // if found text contains a line code (YELL etc), prefer that
        const m = t.match(LINE_CODE_RE)
        if (m && LINE_CODE_MAP[m[1]]) return LINE_CODE_MAP[m[1]]
        // otherwise return the raw text (but we'll normalize later)
        return t
      }
      if (found) {
        const attr = (
          found.attr('title') ||
          found.attr('aria-label') ||
          found.attr('alt') ||
          found.attr('data-service') ||
          ''
        ).trim()
        if (attr) {
          const m2 = attr.match(LINE_CODE_RE)
          if (m2 && LINE_CODE_MAP[m2[1]]) return LINE_CODE_MAP[m2[1]]
          return attr
        }
      }
    }

    // 1.b) direct element attributes / <abbr>
    const abbr = $el.find('abbr').first()
    if (abbr && (abbr.attr('title') || abbr.text().trim())) {
      const val = (abbr.attr('title') || abbr.text()).trim()
      const ma = val.match(LINE_CODE_RE)
      if (ma && LINE_CODE_MAP[ma[1]]) return LINE_CODE_MAP[ma[1]]
      return val
    }
    const selfAttr =
      ($el.attr &&
        ($el.attr('title') ||
          $el.attr('aria-label') ||
          $el.attr('alt') ||
          $el.attr('data-service'))) ||
      ''
    if (selfAttr && String(selfAttr).trim()) {
      const mv = String(selfAttr).trim().match(LINE_CODE_RE)
      if (mv && LINE_CODE_MAP[mv[1]]) return LINE_CODE_MAP[mv[1]]
      return String(selfAttr).trim()
    }

    // 2) use heuristics on surrounding text, but try to find an uppercase code first
    const elText = $el.text().trim()
    if (elText) {
      // look for an uppercase code (prefer this)
      const up = elText.match(LINE_CODE_RE)
      if (up && LINE_CODE_MAP[up[1]]) return LINE_CODE_MAP[up[1]]

      // fallbacks as before
      const idx = elText.indexOf(timeText)
      const before = idx >= 0 ? elText.slice(0, idx).trim() : elText
      const after = idx >= 0 ? elText.slice(idx + timeText.length).trim() : ''
      const shortToken = before.split(/\s+/).slice(-3).join(' ').trim()
      if (
        shortToken &&
        shortToken.length <= 36 &&
        /[A-Za-z0-9]/.test(shortToken)
      )
        return shortToken
      if (after && after.length <= 36 && /[A-Za-z0-9]/.test(after))
        return after.split(/\s+/).slice(0, 3).join(' ')
    }

    // 3) walk parents and prefer any uppercase code in parent text or attributes
    let parent = $el.parent()
    for (let i = 0; i < 4 && parent && parent.length; ++i) {
      // check parent classes first (e.g. 'yell' / 'tt')
      try {
        const pcls = (parent.attr && parent.attr('class')) || ''
        if (pcls) {
          const toks = String(pcls)
            .split(/\s+/)
            .map(s => s.trim().toLowerCase())
          for (const t of toks) if (LINE_CLASS_MAP[t]) return LINE_CLASS_MAP[t]
        }
      } catch (e) {}
      // detect a line code in the parent's text or attributes
      const ptext = parent.text && parent.text() ? parent.text().trim() : ''
      if (ptext) {
        const pu = ptext.match(LINE_CODE_RE)
        if (pu && LINE_CODE_MAP[pu[1]]) return LINE_CODE_MAP[pu[1]]
      }
      for (const sel of SERVICE_SELECTORS) {
        const f = parent.find(sel).first()
        if (f && f.text().trim()) {
          const ft = f.text().trim()
          const m = ft.match(LINE_CODE_RE)
          if (m && LINE_CODE_MAP[m[1]]) return LINE_CODE_MAP[m[1]]
          return ft
        }
        if (f) {
          const a = (
            f.attr('title') ||
            f.attr('aria-label') ||
            f.attr('alt') ||
            f.attr('data-service') ||
            ''
          ).trim()
          if (a) {
            const ma = a.match(LINE_CODE_RE)
            if (ma && LINE_CODE_MAP[ma[1]]) return LINE_CODE_MAP[ma[1]]
            return a
          }
        }
      }
      // check parent attributes too
      if (parent && parent.attr) {
        const pa = (
          parent.attr('title') ||
          parent.attr('aria-label') ||
          parent.attr('alt') ||
          parent.attr('data-service') ||
          ''
        ).trim()
        if (pa) {
          const mpa = pa.match(LINE_CODE_RE)
          if (mpa && LINE_CODE_MAP[mpa[1]]) return LINE_CODE_MAP[mpa[1]]
          return pa
        }
      }
      parent = parent.parent()
    }

    // final fallback: try to find "to/towards ..." near time in raw slice
    const dest = findDestinationNearText_inSlice(timeText)
    if (dest) return dest
    return ''
  }

  // fallback: search the raw sliced HTML for a nearby 'to/towards' destination
  function findDestinationNearText_inSlice (timeText) {
    try {
      const ctxLen = 160
      const idx = slice.indexOf(timeText)
      if (idx === -1) return ''
      const start = Math.max(0, idx - ctxLen)
      const end = Math.min(slice.length, idx + timeText.length + ctxLen)
      const ctx = slice.slice(start, end)
      const m = ctx.match(
        /(?:to|towards|→|headed to)\s+([A-Za-z0-9\-\s]{1,60})/i
      )
      if (m && m[1]) return m[1].trim()
    } catch (e) {
      /* ignore */
    }
    return ''
  }

  const departures = []
  // Prefer parsing explicit departure rows; these contain class tokens like 'yell' or 'tt'
  const rows = $('[class*=departures-tr]')
  rows.each((i, r) => {
    if (!r) return
    const $r = $(r)
    // service: prefer class token, then visible service text
    const cls = ($r.attr('class') || '')
      .split(/\s+/)
      .map(s => s.trim().toLowerCase())
    let service = ''
    for (const c of cls) {
      if (LINE_CLASS_MAP[c]) {
        service = LINE_CLASS_MAP[c]
        break
      }
    }
    if (!service) {
      const sEl = $r
        .find(
          '.busDepartService p, .busTramServices p, .service, .service-name'
        )
        .first()
      if (sEl && sEl.text && sEl.text().trim()) {
        service = sEl.text().trim()
      }
    }

    // time: look for known time container or fallback to regex on row text
    let timeText = ''
    const tEl = $r
      .find('.busTramExpected p, .busTramExpected, .busTramServices p')
      .last()
    if (tEl && tEl.text && tEl.text().trim()) timeText = tEl.text().trim()
    if (!timeText) {
      const m = ($r.text() || '').match(timeRe)
      if (m && m.length) timeText = m[0]
    }

    if (timeText) departures.push({ time: timeText, service: service || '' })
  })
  return departures
}

/* --------- Puppeteer renderer for SPA fallback --------- */
async function fetchWithPuppeteer (atco) {
  const url = makeTsyUrl(atco)
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  })
  try {
    const page = await browser.newPage()
    await page.setUserAgent(USER_AGENT)
    // increase timeout; the site may load resources
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })

    // Wait a bit for dynamic content to appear
    await page.waitForTimeout(800) // quick pause to let scripts run

    // Evaluate in page: find all text nodes with time pattern and attempt to find nearby service labels
    const items = await page.evaluate(() => {
      const TIME_RE = /\b([01]\d|2[0-3]):[0-5]\d\b/g
      const SERVICE_KEYWORDS = [
        'service',
        'route',
        'line',
        'mode',
        'operator',
        'tram',
        'supertram',
        'serviceNo',
        'service-code',
        'platform'
      ]

      function findNearbyService (el, timeText) {
        // prefer checking for a parent departures row class (yell/tt/blue/etc)
        try {
          const row = el.closest && el.closest('.departures-tr')
          if (row && row.className) {
            const cls = String(row.className)
              .split(/\s+/)
              .map(s => s.trim().toLowerCase())
            for (const c of cls) {
              if (c === 'yell') return 'Tram — Yellow'
              if (c === 'blue') return 'Tram — Blue'
              if (c === 'red') return 'Tram — Red'
              if (c === 'purp') return 'Tram — Purple'
              if (c === 'tt') return 'Tram train'
            }
          }
        } catch (e) {}
        // 1) children: look for explicit line-code-like text
        const children = Array.from(el.querySelectorAll('*'))
        for (const c of children) {
          const ct = (c.innerText || '').trim()
          if (ct) {
            const lc = ct.match(/\b([A-Z]{2,6})\b/)
            if (lc) {
              // map common codes client-side (minimal map)
              const code = lc[1]
              if (code === 'YELL') return 'Tram — Yellow'
              if (code === 'BLUE') return 'Tram — Blue'
              if (code === 'RED') return 'Tram — Red'
              if (code === 'PURP') return 'Tram — Purple'
              // else prefer short uppercase token if it looks like a code
              if (/^[A-Z]{2,6}$/.test(code)) return code
            }
          }
          // attributes on child
          const cTitle =
            c.getAttribute &&
            (c.getAttribute('title') ||
              c.getAttribute('aria-label') ||
              c.getAttribute('alt') ||
              c.getAttribute('data-service'))
          if (cTitle && String(cTitle).trim()) {
            const ctT = String(cTitle).trim()
            const lc2 = ctT.match(/\b([A-Z]{2,6})\b/)
            if (lc2) {
              const code2 = lc2[1]
              if (code2 === 'YELL') return 'Tram — Yellow'
              if (code2 === 'BLUE') return 'Tram — Blue'
              if (code2 === 'RED') return 'Tram — Red'
              if (code2 === 'PURP') return 'Tram — Purple'
              return ctT
            }
          }
        }

        // 2) siblings (look *above* the time first — that's where line code appears on TSY)
        if (el.previousElementSibling) {
          const ps = el.previousElementSibling
          const ptxt = (ps.innerText || '').trim()
          if (ptxt) {
            const m = ptxt.match(/\b([A-Z]{2,6})\b/)
            if (m) {
              const code = m[1]
              if (code === 'YELL') return 'Tram — Yellow'
              if (code === 'BLUE') return 'Tram — Blue'
              if (code === 'RED') return 'Tram — Red'
              if (code === 'PURP') return 'Tram — Purple'
              return code
            }
          }
          const pTitle =
            ps.getAttribute &&
            (ps.getAttribute('title') ||
              ps.getAttribute('aria-label') ||
              ps.getAttribute('data-service'))
          if (pTitle && String(pTitle).trim()) {
            const m2 = String(pTitle)
              .trim()
              .match(/\b([A-Z]{2,6})\b/)
            if (m2) {
              const code2 = m2[1]
              if (code2 === 'YELL') return 'Tram — Yellow'
              if (code2 === 'BLUE') return 'Tram — Blue'
              if (code2 === 'RED') return 'Tram — Red'
              if (code2 === 'PURP') return 'Tram — Purple'
              return String(pTitle).trim()
            }
          }
        }

        // 3) parents up to depth 4: look for short uppercase code_first, then class-name heuristics
        let p = el.parentElement
        for (let i = 0; i < 4 && p; i++) {
          const pt = (p.innerText || '').trim()
          if (pt) {
            const m = pt.match(/\b([A-Z]{2,6})\b/)
            if (m) {
              const code = m[1]
              if (code === 'YELL') return 'Tram — Yellow'
              if (code === 'BLUE') return 'Tram — Blue'
              if (code === 'RED') return 'Tram — Red'
              if (code === 'PURP') return 'Tram — Purple'
              return code
            }
          }
          if (p.className && typeof p.className === 'string') {
            for (const k of SERVICE_KEYWORDS) {
              if (p.className.toLowerCase().includes(k)) {
                const candidate = (p.innerText || '')
                  .trim()
                  .split('\n')
                  .map(s => s.trim())
                  .filter(Boolean)[0]
                if (candidate) return candidate
              }
            }
          }
          // explicit attributes on parent
          const pTitle =
            p.getAttribute &&
            (p.getAttribute('title') ||
              p.getAttribute('aria-label') ||
              p.getAttribute('data-service'))
          if (pTitle && String(pTitle).trim()) {
            const m2 = String(pTitle)
              .trim()
              .match(/\b([A-Z]{2,6})\b/)
            if (m2) {
              const code2 = m2[1]
              if (code2 === 'YELL') return 'Tram — Yellow'
              if (code2 === 'BLUE') return 'Tram — Blue'
              if (code2 === 'RED') return 'Tram — Red'
              if (code2 === 'PURP') return 'Tram — Purple'
              return String(pTitle).trim()
            }
          }
          p = p.parentElement
        }

        // 4) fallback: existing heuristics (short token, "to/towards" context)
        // [leave original heuristics here if needed]
        return ''
      }

      const out = []
      // Prefer explicit departure rows which have class tokens like 'yell' or 'tt'
      const rows = Array.from(
        document.querySelectorAll('[class*=departures-tr]')
      )
      for (const row of rows) {
        try {
          const rowCls = (row.className || '')
            .split(/\s+/)
            .map(s => s.trim().toLowerCase())
          let svc = ''
          for (const c of rowCls) {
            if (c === 'yell') {
              svc = 'Tram — Yellow'
              break
            }
            if (c === 'blue') {
              svc = 'Tram — Blue'
              break
            }
            if (c === 'red') {
              svc = 'Tram — Red'
              break
            }
            if (c === 'purp') {
              svc = 'Tram — Purple'
              break
            }
            if (c === 'tt') {
              svc = 'Tram train'
              break
            }
          }
          if (!svc) {
            const sEl = row.querySelector(
              '.busDepartService p, .busTramServices p, .service, .service-name'
            )
            if (sEl && sEl.innerText) svc = sEl.innerText.trim()
          }
          // time: prefer expected time element
          let time = ''
          const tEl = row.querySelector(
            '.busTramExpected p, .busTramExpected, .busTramServices p'
          )
          if (tEl && tEl.innerText) time = tEl.innerText.trim()
          if (!time) {
            const m = (row.innerText || '').match(TIME_RE)
            if (m && m.length) time = m[0]
          }
          if (time) out.push({ time, service: svc })
        } catch (e) {
          /* ignore row parse errors */
        }
        if (out.length >= 200) break
      }
      return out
    })

    return items // array of {time, service}
  } finally {
    await browser.close()
  }
}

/* --------- helper: convert HH:MM to next datetime in Europe/London (luxon) --------- */
function hhmmToNextDateTime (hhmm, now) {
  const [hh, mm] = hhmm.split(':').map(s => parseInt(s, 10))
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null
  const today = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 })
  const tomorrow = today.plus({ days: 1 })
  const graceWindow = now.minus({ seconds: GRACE_SEC })
  const candidates = [today, tomorrow].filter(dt => dt >= graceWindow)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.toMillis() - b.toMillis())
  return candidates[0]
}

// Expand short service abbreviations to more readable labels
function expandServiceLabel (s) {
  if (!s) return ''
  const raw = String(s).trim()
  const up = raw.toUpperCase()
  // If already a friendly label, keep it
  if (raw.toLowerCase().includes('tram')) return raw
  // map known short codes (YELL, TT, etc.) using the global map
  const mapped = LINE_CLASS_MAP[up.toLowerCase()]
  if (mapped) return mapped
  // if it's an uppercase token like YELL or TT, try map
  if (/^[A-Z]{2,6}$/.test(up) && LINE_CLASS_MAP[up.toLowerCase()])
    return LINE_CLASS_MAP[up.toLowerCase()]
  return raw
}

/* --------- main fetch function: tries lightweight then puppeteer fallback if needed --------- */
async function fetchDeparturesForStop (atco) {
  if (!ALLOWED_STOPS.has(atco)) throw new Error('stop not allowed')
  const now = DateTime.now().setZone(ZONE)

  // cached raw scraped items are kept so we can re-filter per-request
  const entry = cache[atco]
  if (
    entry &&
    Date.now() - entry.fetchedAt < CACHE_TTL_MS &&
    entry.items &&
    entry.items.length
  ) {
    // re-filter by now
    const reFiltered = entry.items
      .map(it => {
        const dt = hhmmToNextDateTime(it.time, now)
        return dt
          ? { time: it.time, service: it.service || '', datetime: dt.toISO() }
          : null
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
    // If cached data seems OK, return it
    if (reFiltered.length)
      return { items: reFiltered, cached: true, fetchedAt: entry.fetchedAt }
  }

  // 1) Fast fetch + cheerio scrape
  try {
    const url = makeTsyUrl(atco)
    console.log('[fetch] attempting lightweight fetch:', url)
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      timeout: 15000
    })
    if (!resp.ok) {
      const body = await resp.text().catch(() => '<no body>')
      console.warn(
        '[fetch] upstream non-OK',
        resp.status,
        resp.statusText,
        '— snippet:',
        truncate(body, 400)
      )
      // fall through to puppeteer fallback
    } else {
      const html = await resp.text()
      const scraped = extractDeparturesFromTsyHtml(html)
      cache[atco] = { items: scraped, fetchedAt: Date.now() }
      // Map to datetimes and check service coverage
      const mapped = scraped
        .map(it => {
          const dt = hhmmToNextDateTime(it.time, now)
          return dt
            ? {
                time: it.time,
                service: expandServiceLabel(it.service || ''),
                datetime: dt.toISO()
              }
            : null
        })
        .filter(Boolean)
        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))

      // If we got times AND at least 50% of visible items have a non-empty service, use it
      const nonEmptySvc = mapped.filter(
        it => it.service && it.service.trim()
      ).length
      const svcRatio = mapped.length ? nonEmptySvc / mapped.length : 0

      if (mapped.length && svcRatio >= 0.5 && !process.env.FORCE_PUPPETEER) {
        console.log(
          `[fetch] lightweight scrape OK; found ${
            mapped.length
          } items, service-ratio=${svcRatio.toFixed(2)}`
        )
        return {
          items: mapped,
          cached: false,
          fetchedAt: cache[atco].fetchedAt
        }
      }

      console.log(
        `[fetch] lightweight scrape insufficient (items=${
          mapped.length
        }, svcRatio=${svcRatio.toFixed(2)}), falling back to Puppeteer`
      )
      // else fall through to Puppeteer
    }
  } catch (err) {
    console.warn(
      '[fetch] lightweight fetch error:',
      err && err.message ? err.message : err
    )
    // fall through to puppeteer
  }

  // 2) Puppeteer fallback to capture rendered DOM
  try {
    console.log('[fetch] launching Puppeteer fallback for', atco)
    const rendered = await fetchWithPuppeteer(atco)
    cache[atco] = { items: rendered, fetchedAt: Date.now() }
    const mapped = rendered
      .map(it => {
        const dt = hhmmToNextDateTime(it.time, now)
        return dt
          ? {
              time: it.time,
              service: expandServiceLabel(it.service || ''),
              datetime: dt.toISO()
            }
          : null
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
    console.log(`[fetch] puppeteer returned ${mapped.length} items`)
    return { items: mapped, cached: false, fetchedAt: cache[atco].fetchedAt }
  } catch (err) {
    console.error(
      '[fetch] puppeteer fallback failed:',
      err && err.stack ? err.stack : err
    )
    throw new Error('Failed to fetch upstream (puppeteer fallback failed)')
  }
}

/* --------- API endpoints --------- */
app.get('/api/times', async (req, res) => {
  const atco = String(
    req.query.fromcode || req.query.stop || DEFAULT_STOP
  ).trim()
  if (!ALLOWED_STOPS.has(atco)) {
    return res.status(400).json({
      error: 'invalid or missing fromcode; allowed: 9400ZZSYDVS1, 9400ZZSYDVS2'
    })
  }
  try {
    const data = await fetchDeparturesForStop(atco)
    const out = data.items.slice(0, MAX_RESULTS).map(it => ({
      time: it.time,
      service: it.service || '',
      datetime: it.datetime
    }))
    res.json({
      stop: atco,
      times: out,
      fetched_at: new Date(data.fetchedAt).toISOString(),
      cached: data.cached
    })
  } catch (err) {
    console.error(
      '[api] Error fetching times for',
      atco,
      err && err.stack ? err.stack : err
    )
    res.status(500).json({ error: 'failed to fetch times' })
  }
})

app.get('/debug', async (req, res) => {
  const atco = String(req.query.fromcode || DEFAULT_STOP).trim()
  if (!ALLOWED_STOPS.has(atco))
    return res.status(400).json({ error: 'invalid fromcode' })
  const url = makeTsyUrl(atco)
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      timeout: 15000
    })
    const body = await resp.text().catch(() => '<could not read body>')
    const wantFull = req.query.full === '1' || req.query.full === 'true'
    const maxReturn = 200000
    return res.json({
      upstream_url: url,
      status: resp.status,
      statusText: resp.statusText,
      body_snippet: wantFull ? body.slice(0, maxReturn) : truncate(body, 2000),
      truncated: wantFull ? body.length > maxReturn : undefined
    })
  } catch (err) {
    console.error('[debug] fetch failed:', err && err.stack ? err.stack : err)
    return res.status(500).json({
      error: 'debug fetch failed',
      message: String(err && err.message ? err.message : err)
    })
  }
})

// Return raw scraped/rendered items plus mapped output for inspection
app.get('/debug/raw', async (req, res) => {
  const atco = String(req.query.fromcode || DEFAULT_STOP).trim()
  if (!ALLOWED_STOPS.has(atco))
    return res.status(400).json({ error: 'invalid fromcode' })
  try {
    const data = await fetchDeparturesForStop(atco)
    const raw = (cache[atco] && cache[atco].items) || null
    return res.json({
      stop: atco,
      raw,
      mapped: data.items,
      fetched_at: new Date(data.fetchedAt).toISOString(),
      cached: data.cached
    })
  } catch (err) {
    console.error('[debug/raw] failed:', err && err.stack ? err.stack : err)
    return res.status(500).json({
      error: 'debug raw failed',
      message: String(err && err.message ? err.message : err)
    })
  }
})

app.get('/', (req, res) =>
  res.sendFile(path.resolve(__dirname, 'public', 'index.html'))
)

app.listen(PORT, () => {
  console.log(
    `Server running at http://localhost:${PORT} — allowed stops: ${[
      ...ALLOWED_STOPS
    ].join(', ')}`
  )
})
