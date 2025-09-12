// Cargar variables de entorno desde .env
require('dotenv').config()

const express = require('express')
const app = express()
app.use(express.json())

// Nota: en Node 18+ existe fetch global. Si tu runtime no lo tiene,
// usa node 18 en Render o añade un polyfill de fetch.

// Endpoint público de salud (no pide clave)
app.get('/ping', (req, res) => {
  res.type('text').send('ok')
})

// ---------- Seguridad ----------
const API_KEY = process.env.API_KEY
console.log('API_KEY cargada:', API_KEY)

// Todas las rutas bajo /api requieren Authorization: Bearer <API_KEY>
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
  const base = process.env.BITRIX_WEBHOOK_BASE // debe terminar en /
  if (!base) throw new Error('Falta BITRIX_WEBHOOK_BASE en .env')
  const url = `${base}${method}.json`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error_description || j.error)
  return j.result // SOLO result
}

// Cuando necesitamos paginación (necesitamos también "next"), usamos este:
async function bitrixRaw(method, params = {}) {
  const base = process.env.BITRIX_WEBHOOK_BASE // debe terminar en /
  if (!base) throw new Error('Falta BITRIX_WEBHOOK_BASE en .env')
  const url = `${base}${method}.json`
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error_description || j.error)
  return j // JSON completo (incluye next)
}

const firstValue = arr => (Array.isArray(arr) && arr[0] && arr[0].VALUE) || ''
const joinAddress = c => [
  c.ADDRESS,
  c.ADDRESS_2,
  c.ADDRESS_CITY,
  c.ADDRESS_POSTAL_CODE,
  c.ADDRESS_REGION,
  c.ADDRESS_PROVINCE,
  c.ADDRESS_COUNTRY
].filter(Boolean).join(', ')

// ---------- Endpoints básicos existentes ----------
app.get('/api/hello', (req, res) => {
  res.json({ msg: 'Hola Ana, el servidor funciona 🎉' })
})

// Búsqueda parcial: TODAS normalizadas
app.get('/api/bitrix/companies/search/normalized', async (req, res) => {
  try {
    const name = (req.query.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Falta el parámetro ?name=' })

    // 1) Buscar IDs
    const matches = await bitrix('crm.company.list', {
      filter: { '%TITLE': name },
      select: ['ID']
    })
    if (!matches || matches.length === 0) {
      return res.status(404).json({ error: `No se encontraron compañías que contengan: ${name}` })
    }

    // 2) Para cada compañía: detalle + contactos + requisitos
    const results = await Promise.all(matches.map(async item => {
      const id = item.ID
      const company = await bitrix('crm.company.get', { ID: id })
      const rel = await bitrix('crm.company.contact.items.get', { ID: id })
      const contacts = await Promise.all((rel || []).map(c =>
        bitrix('crm.contact.get', { ID: c.CONTACT_ID })
      ))

      let legal = { legalName: '', vatNumber: '' }
      try {
        const reqs = await bitrix('crm.requisite.list', { filter: { ENTITY_TYPE_ID: 4, ENTITY_ID: id } })
        const r = Array.isArray(reqs) ? reqs[0] : null
        if (r) {
          legal = {
            legalName: r.RQ_COMPANY_NAME || '',
            vatNumber: r.RQ_VAT || r.RQ_VAT_ID || r.RQ_INN || ''
          }
        }
      } catch (_) {}

      return {
        company: {
          id: String(company.ID),
          title: company.TITLE,
          type: company.COMPANY_TYPE || '',
          industry: company.INDUSTRY || '',
          email: firstValue(company.EMAIL),
          phone: firstValue(company.PHONE),
          website: (company.WEB && company.WEB[0] && company.WEB[0].VALUE) || '',
          address: joinAddress(company),
          legal
        },
        contacts: (contacts || []).map(ct => ({
          id: String(ct.ID),
          name: [ct.HONORIFIC, ct.NAME, ct.LAST_NAME].filter(Boolean).join(' ').trim(),
          position: ct.POST || '',
          email: firstValue(ct.EMAIL),
          phone: firstValue(ct.PHONE)
        }))
      }
    }))

    res.json(results)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ============================================================
   ENDPOINTS de campos (nativos + UF por separado)
============================================================ */

// ===== COMPAÑÍAS =====
app.get('/api/bitrix/company/fields', async (req, res) => {
  try {
    const result = await bitrix('crm.company.fields')
    res.json({ result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/bitrix/company/userfields', async (req, res) => {
  try {
    let start = 0, all = []
    while (true) {
      const data = await bitrixRaw('crm.company.userfield.list', { order: { ID: 'ASC' }, start })
      const items = Array.isArray(data.result) ? data.result : []
      all = all.concat(items)
      if (data.next == null) break
      start = data.next
    }
    res.json({ result: all })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ===== NEGOCIACIONES (DEALS) =====
app.get('/api/bitrix/deal/fields', async (req, res) => {
  try {
    const result = await bitrix('crm.deal.fields')
    res.json({ result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/bitrix/deal/userfields', async (req, res) => {
  try {
    let start = 0, all = []
    while (true) {
      const data = await bitrixRaw('crm.deal.userfield.list', { order: { ID: 'ASC' }, start })
      const items = Array.isArray(data.result) ? data.result : []
      all = all.concat(items)
      if (data.next == null) break
      start = data.next
    }
    res.json({ result: all })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/bitrix/deal/userfields/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' })
    const result = await bitrix('crm.deal.userfield.get', { id })
    res.json({ result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ===== SPAs =====
app.get('/api/bitrix/types', async (req, res) => {
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
    res.json({ result: all })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/bitrix/types/:id/fields', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'entityTypeId inválido' })
    const result = await bitrix('crm.item.fields', { entityTypeId: id })
    res.json({ result })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/bitrix/types/:id/userfields', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'entityTypeId inválido' })
    let start = 0, all = []
    while (true) {
      const data = await bitrixRaw('crm.item.userfield.list', { entityTypeId: id, order: { ID: 'ASC' }, start })
      const items = Array.isArray(data.result) ? data.result : []
      all = all.concat(items)
      if (data.next == null) break
      start = data.next
    }
    res.json({ result: all })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ============================================================
   DICCIONARIOS EN VIVO (nativos + UF + opciones)
   - /api/dict/company
   - /api/dict/deal
   - /api/dict/spas
   - /api/dict/spa/:id
============================================================ */

// Normaliza un campo a un formato común
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

// Añade opciones si el campo es enumeration
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

// ---- COMPANY dict ----
app.get('/api/dict/company', async (req, res) => {
  try {
    const native = await bitrix('crm.company.fields') // { CODE: {...} }
    const rows = Object.entries(native).map(([code, f]) =>
      attachOptions(normalizeField(code, f, 'native'), f)
    )

    let start = 0
    while (true) {
      const page = await bitrixRaw('crm.company.userfield.list', { order:{ID:'ASC'}, start })
      const items = Array.isArray(page.result) ? page.result : []
      for (const uf of items) {
        const code = uf.FIELD_NAME || uf.FIELD
        const row = attachOptions(normalizeField(code, uf, 'uf'), uf)
        rows.push(row)
      }
      if (page.next == null) break
      start = page.next
    }
    res.json({ result: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- DEAL dict ----
app.get('/api/dict/deal', async (req, res) => {
  try {
    const native = await bitrix('crm.deal.fields')
    const rows = Object.entries(native).map(([code, f]) =>
      attachOptions(normalizeField(code, f, 'native'), f)
    )

    let start = 0
    while (true) {
      const page = await bitrixRaw('crm.deal.userfield.list', { order:{ID:'ASC'}, start })
      const items = Array.isArray(page.result) ? page.result : []
      for (const uf of items) {
        const code = uf.FIELD_NAME || uf.FIELD
        const row = attachOptions(normalizeField(code, uf, 'uf'), uf)
        rows.push(row)
      }
      if (page.next == null) break
      start = page.next
    }
    res.json({ result: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- SPAs dict: lista
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

// ---- SPA dict por entityTypeId
app.get('/api/dict/spa/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'entityTypeId inválido' })

    const native = await bitrix('crm.item.fields', { entityTypeId: id })
    const rows = Object.entries(native).map(([code, f]) =>
      attachOptions(normalizeField(code, f, 'native'), f)
    )

    let start = 0
    while (true) {
      const page = await bitrixRaw('crm.item.userfield.list', { entityTypeId: id, order:{ID:'ASC'}, start })
      const items = Array.isArray(page.result) ? page.result : []
      for (const uf of items) {
        const code = uf.FIELD_NAME || uf.FIELD
        const row = attachOptions(normalizeField(code, uf, 'uf'), uf)
        rows.push(row)
      }
      if (page.next == null) break
      start = page.next
    }
    res.json({ result: rows })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---------- Arrancar ----------
app.listen(process.env.PORT || 3000, () => {
  console.log('API on :' + (process.env.PORT || 3000))
})
