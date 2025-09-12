// Cargar variables de entorno desde .env
require('dotenv').config()

const express = require('express')
const app = express()
app.use(express.json())

// Endpoint público de salud (no pide clave)
app.get('/ping', (req, res) => {
  res.type('text').send('ok')
})

// ---------- Seguridad ----------
const API_KEY = process.env.API_KEY
console.log('API_KEY cargada:', API_KEY)

app.use('/api', (req, res, next) => {
  if (!API_KEY) return res.status(500).json({ error: 'Falta API_KEY en el servidor' })
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// ---------- Helper Bitrix ----------
async function bitrix(method, params = {}) {
  const base = process.env.BITRIX_WEBHOOK_BASE
  if (!base) throw new Error('Falta BITRIX_WEBHOOK_BASE en .env')
  const url = `${base}${method}.json`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error_description || j.error)
  return j.result
}

async function bitrixRaw(method, params = {}) {
  const base = process.env.BITRIX_WEBHOOK_BASE
  if (!base) throw new Error('Falta BITRIX_WEBHOOK_BASE en .env')
  const url = `${base}${method}.json`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error_description || j.error)
  return j
}

const firstValue = arr => (Array.isArray(arr) && arr[0] && arr[0].VALUE) || ''
const joinAddress = c => [
  c.ADDRESS, c.ADDRESS_2, c.ADDRESS_CITY, c.ADDRESS_POSTAL_CODE,
  c.ADDRESS_REGION, c.ADDRESS_PROVINCE, c.ADDRESS_COUNTRY
].filter(Boolean).join(', ')

// ---------- Endpoints básicos ----------
app.get('/api/hello', (req, res) => {
  res.json({ msg: 'Hola Ana, el servidor funciona 🎉' })
})

/* ============================================================
   NORMALIZADORES
============================================================ */
function normalizeField(code, f, source) {
  return {
    code,
    title: f.title || f.editFormLabel || f.listLabel || f.formLabel || f.COLUMN_NAME || code,
    type: f.type || f.DATA_TYPE || f.userTypeId || f.USER_TYPE_ID || f.userType || '',
    multiple: Boolean(f.multiple || f.MULTIPLE === 'Y'),
    mandatory: Boolean(f.isRequired || f.MANDATORY === 'Y'),
    source // 'native' | 'uf'
  }
}

function attachOptions(row, f) {
  const list = f.LIST || f.enum || f.items || []
  if (Array.isArray(list) && list.length) {
    row.options = list.map(o => {
      const id = o.ID ?? o.id ?? o.VALUE ?? ''
      const val = o.VALUE ?? o.value ?? ''
      return `${id}:${val}`
    }).join(' | ')
  } else {
    row.options = ''
  }
  return row
}

/* ============================================================
   DICCIONARIOS CON PAGINACIÓN
   - /api/dict/company
   - /api/dict/deal
   - /api/dict/spa/:id
============================================================ */

// ---- COMPANY dict ----
app.get('/api/dict/company', async (req, res) => {
  try {
    const start = Number(req.query.start) || 0
    const limit = Number(req.query.limit) || 50
    const noOptions = Number(req.query.noOptions) || 0

    const native = await bitrix('crm.company.fields')
    let rows = Object.entries(native).map(([code, f]) =>
      noOptions ? normalizeField(code, f, 'native') : attachOptions(normalizeField(code, f, 'native'), f)
    )

    let s = start
    while (rows.length < limit) {
      const page = await bitrixRaw('crm.company.userfield.list', { order:{ID:'ASC'}, start: s })
      const items = Array.isArray(page.result) ? page.result : []
      for (const uf of items) {
        const code = uf.FIELD_NAME || uf.FIELD
        const row = noOptions ? normalizeField(code, uf, 'uf') : attachOptions(normalizeField(code, uf, 'uf'), uf)
        rows.push(row)
        if (rows.length >= limit) break
      }
      if (page.next == null || rows.length >= limit) break
      s = page.next
    }
    res.json({ result: rows.slice(0, limit) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- DEAL dict ----
app.get('/api/dict/deal', async (req, res) => {
  try {
    const start = Number(req.query.start) || 0
    const limit = Number(req.query.limit) || 50
    const noOptions = Number(req.query.noOptions) || 0

    const native = await bitrix('crm.deal.fields')
    let rows = Object.entries(native).map(([code, f]) =>
      noOptions ? normalizeField(code, f, 'native') : attachOptions(normalizeField(code, f, 'native'), f)
    )

    let s = start
    while (rows.length < limit) {
      const page = await bitrixRaw('crm.deal.userfield.list', { order:{ID:'ASC'}, start: s })
      const items = Array.isArray(page.result) ? page.result : []
      for (const uf of items) {
        const code = uf.FIELD_NAME || uf.FIELD
        const row = noOptions ? normalizeField(code, uf, 'uf') : attachOptions(normalizeField(code, uf, 'uf'), uf)
        rows.push(row)
        if (rows.length >= limit) break
      }
      if (page.next == null || rows.length >= limit) break
      s = page.next
    }
    res.json({ result: rows.slice(0, limit) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- SPA dict por entityTypeId ----
app.get('/api/dict/spa/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'entityTypeId inválido' })

    const start = Number(req.query.start) || 0
    const limit = Number(req.query.limit) || 50
    const noOptions = Number(req.query.noOptions) || 0

    const native = await bitrix('crm.item.fields', { entityTypeId: id })
    let rows = Object.entries(native).map(([code, f]) =>
      noOptions ? normalizeField(code, f, 'native') : attachOptions(normalizeField(code, f, 'native'), f)
    )

    let s = start
    while (rows.length < limit) {
      const page = await bitrixRaw('crm.item.userfield.list', { entityTypeId: id, order:{ID:'ASC'}, start: s })
      const items = Array.isArray(page.result) ? page.result : []
      for (const uf of items) {
        const code = uf.FIELD_NAME || uf.FIELD
        const row = noOptions ? normalizeField(code, uf, 'uf') : attachOptions(normalizeField(code, uf, 'uf'), uf)
        rows.push(row)
        if (rows.length >= limit) break
      }
      if (page.next == null || rows.length >= limit) break
      s = page.next
    }
    res.json({ result: rows.slice(0, limit) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- SPAs dict: lista ----
app.get('/api/dict/spas', async (req, res) => {
  try {
    let start = 0, all = []
    while (true) {
      const data = await bitrixRaw('crm.type.list', { start })
      const result = data.result || {}
      const types = Array.isArray(result.types) ? result.types
                  : (Array.isArray(result) ? result : [])
      all = all.concat(types)
      const next = data.next || (result && result.next)
      if (next == null) break
      start = next
    }
    res.json({ result: all.map(t => ({ id: t.entityTypeId, title: t.title, code: t.code })) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------- Arrancar ----------
app.listen(process.env.PORT || 3000, () => {
  console.log('API on :' + (process.env.PORT || 3000))
})
