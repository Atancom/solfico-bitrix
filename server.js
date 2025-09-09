// Cargar variables de entorno desde .env
require('dotenv').config()

const express = require('express')
const app = express()
app.use(express.json())

// ---------- Seguridad ----------
const API_KEY = process.env.API_KEY
console.log('API_KEY cargada:', API_KEY)

app.use('/api', (req, res, next) => {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
})

// ---------- Helper Bitrix ----------
async function bitrix(method, params = {}) {
  const base = process.env.BITRIX_WEBHOOK_BASE // debe terminar en /
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

// ---------- Endpoints básicos ----------
app.get('/api/hello', (req, res) => {
  res.json({ msg: 'Hola Ana, el servidor funciona 🎉' })
})

// ---------- Búsqueda parcial: TODAS normalizadas ----------
app.get('/api/bitrix/companies/search/normalized', async (req, res) => {
  try {
    const name = (req.query.name || '').trim()
    if (!name) return res.status(400).json({ error: 'Falta el parámetro ?name=' })

    // 1) Buscar todas las compañías cuyo TITLE contenga "name"
    const matches = await bitrix('crm.company.list', {
      filter: { '%TITLE': name },    // coincidencia parcial
      select: ['ID']                 // primero solo IDs
    })
    if (!matches || matches.length === 0) {
      return res.status(404).json({ error: `No se encontraron compañías que contengan: ${name}` })
    }

    // 2) Para cada compañía: detalle + contactos + (intento) requisitos
    const results = await Promise.all(matches.map(async item => {
      const id = item.ID

      // Detalle completo
      const company = await bitrix('crm.company.get', { ID: id })

      // Contactos
      const rel = await bitrix('crm.company.contact.items.get', { ID: id })
      const contacts = await Promise.all((rel || []).map(c =>
        bitrix('crm.contact.get', { ID: c.CONTACT_ID })
      ))

      // Requisitos fiscales (si existen)
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

      // Normalizar
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

// ---------- Arrancar ----------
app.listen(process.env.PORT || 3000, () => {
  console.log('API on :' + (process.env.PORT || 3000))
})
