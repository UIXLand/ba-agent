import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import axios from 'axios'
import express from 'express'
import cron from 'node-cron'

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const clickup = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: process.env.CLICKUP_API_TOKEN, 'Content-Type': 'application/json' }
})
const LIST_ID = process.env.CLICKUP_LIST_ID
const PM_AGENT_URL = process.env.PM_AGENT_URL || 'https://pm-ai-agent-production.up.railway.app'
const PORT = process.env.PORT || process.env.BA_AGENT_PORT || 3002

const QUESTIONS_PROMPT = `Ты Business Analyst Agent продукта SafeButton — мобильного приложения тревожной кнопки.
На основе паспорта фичи задай уточняющие вопросы для написания детального PRD.
Максимум 5 вопросов — только те которые реально влияют на реализацию.
Верни ТОЛЬКО валидный JSON без markdown-блоков:
{"questions":[{"id":"Q1","question":"...","why_important":"..."}]}`

const PRD_PROMPT = `Ты Business Analyst Agent продукта SafeButton (React Native + Supabase).
Стек: React Native + Expo, Supabase (PostgreSQL + Auth + Edge Functions + Realtime + Storage), Expo Push API + APNs Critical Alerts, Twilio (SMS), Resend (Email), react-native-maps.
Создай детальный PRD на основе паспорта и ответов продакта.
Верни ТОЛЬКО валидный JSON без markdown-блоков:
{"feature_name":"...","overview":"...","user_stories":["..."],"functional_requirements":[{"id":"FR-1","title":"...","description":"...","acceptance_criteria":["..."]}],"non_functional_requirements":[{"id":"NFR-1","title":"...","description":"..."}],"data_model":{"new_tables":[{"name":"...","fields":["..."],"rls":"..."}],"modified_tables":[]},"api_endpoints":[{"method":"POST","path":"...","description":"...","request":"...","response":"..."}],"edge_cases":["..."],"out_of_scope":["..."],"open_questions_resolved":[{"question":"...","answer":"..."}]}`

async function getTask(taskId) { const r = await clickup.get(`/task/${taskId}`); return r.data }
async function getComments(taskId) { try { const r = await clickup.get(`/task/${taskId}/comment`); return r.data.comments ?? [] } catch { return [] } }
async function addComment(taskId, text) { await clickup.post(`/task/${taskId}/comment`, { comment_text: text, notify_all: false }) }
async function createTask(name, desc, tags = []) {
  const r = await clickup.post(`/list/${LIST_ID}/task`, { name, description: desc, tags, status: 'to do' })
  return r.data
}

async function callClaude(system, content, maxTokens = 4000) {
  const r = await claude.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
  const text = r.content[0].text.trim().replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(text)
}

function buildPRDDesc(prd) {
  const fr = prd.functional_requirements?.map(r =>
    `${r.id}: ${r.title}\n${r.description}\nКритерії:\n${r.acceptance_criteria?.map(c => `  ✓ ${c}`).join('\n')}`
  ).join('\n\n') ?? '—'

  const tables = prd.data_model?.new_tables?.map(t =>
    `Таблиця: ${t.name}\nПоля: ${t.fields?.join(', ')}\nRLS: ${t.rls}`
  ).join('\n\n') ?? 'Нових таблиць немає'

  const endpoints = prd.api_endpoints?.map(e =>
    `${e.method} ${e.path} — ${e.description}`
  ).join('\n') ?? 'Немає'

  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 PRD — ${prd.feature_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${prd.overview}

USER STORIES
${prd.user_stories?.map(s => `• ${s}`).join('\n') ?? '—'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ФУНКЦІОНАЛЬНІ ВИМОГИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${fr}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
НЕ-ФУНКЦІОНАЛЬНІ ВИМОГИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${prd.non_functional_requirements?.map(r => `${r.id}: ${r.title}\n${r.description}`).join('\n\n') ?? '—'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
МОДЕЛЬ ДАНИХ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${tables}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
API / EDGE FUNCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${endpoints}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ГРАНИЧНІ ВИПАДКИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${prd.edge_cases?.map(e => `• ${e}`).join('\n') ?? '—'}

OUT OF SCOPE
${prd.out_of_scope?.map(o => `• ${o}`).join('\n') ?? '—'}`
}

async function processTask(taskId) {
  const task = await getTask(taskId)
  const comments = await getComments(taskId)

  // Только задачи с паспортом
  if (!task.description?.includes('ПАСПОРТ ФИЧИ')) return

  // ── КЛЮЧЕВОЕ ИЗМЕНЕНИЕ ──
  // BA-агент начинает работу ТОЛЬКО после "approved"
  const approved = comments.find(c =>
    c.comment_text?.toLowerCase().includes('approved') ||
    c.comment_text?.toLowerCase().includes('апрув') ||
    c.comment_text?.toLowerCase() === '✅'
  )
  if (!approved) {
    console.log(`⏳ Нет апрува для: ${task.name} — ждём`)
    return
  }

  // BA уже запускался?
  const baStarted = comments.find(c => c.comment_text?.includes('BA-агент починає'))
  if (baStarted) {
    await checkForAnswers(taskId, task, comments)
    return
  }

  // Запускаем BA — задаём вопросы
  console.log(`\n✅ Апрув найден: ${task.name}`)
  await addComment(taskId, '🤖 BA-агент починає проробку PRD...\n\nФормулюю уточнюючі питання.')

  const questionsData = await callClaude(QUESTIONS_PROMPT, task.description, 2000)
  const questionsText = questionsData.questions.map((q, i) =>
    `${i + 1}. ${q.question}\n   _Навіщо: ${q.why_important}_`
  ).join('\n\n')

  await addComment(taskId,
    `🤔 BA-агент: питання перед PRD\n\n${questionsText}\n\n──────────\nВідповідайте одним коментарем — створю PRD.`
  )
  console.log(`📋 Задано ${questionsData.questions.length} вопросов`)
}

async function checkForAnswers(taskId, task, comments) {
  const questionsComment = comments.find(c => c.comment_text?.includes('BA-агент: питання'))
  if (!questionsComment) return

  const idx = comments.indexOf(questionsComment)
  const answers = comments.slice(idx + 1).filter(c =>
    !c.comment_text?.includes('BA-агент') && !c.comment_text?.includes('PM-агент')
  )
  if (answers.length === 0) return

  const prdDone = comments.find(c => c.comment_text?.includes('PRD створено'))
  if (prdDone) return

  console.log(`\n📝 Создаём PRD для: ${task.name}`)
  await addComment(taskId, '📝 BA-агент: отримав відповіді, створюю PRD...')

  const answersText = answers.map(c => c.comment_text).join('\n')
  const prd = await callClaude(PRD_PROMPT, `Паспорт фічі:\n${task.description}\n\nВідповіді продакта:\n${answersText}`, 6000)
  const prdDesc = buildPRDDesc(prd)

  const prdTask = await createTask(`[PRD] ${prd.feature_name}`, prdDesc, ['prd', 'ready for pm agent'])

  await addComment(taskId,
    `✅ PRD створено!\n\nЗадача: ${prdTask.url}\n\n──────────\n🤖 PM-агент почне декомпозицію (тег "prd" проставлено).\n\nРучний запуск:\ncurl -X POST ${PM_AGENT_URL}/process -H "Content-Type: application/json" -d '{"task_id": "${prdTask.id}"}'`
  )
  console.log(`✅ PRD создан: ${prdTask.url}`)
}

async function poll() {
  try {
    const r = await clickup.get(`/list/${LIST_ID}/task`, { params: { tags: ['passport'], include_closed: false, page: 0 } })
    for (const task of r.data.tasks ?? []) { await processTask(task.id); await sleep(500) }
  } catch (e) { console.error('Poll error:', e.message) }
}

const app = express()
app.use(express.json())
app.get('/', (req, res) => res.json({ status: 'running', agent: 'BA Agent' }))
app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.post('/process', async (req, res) => {
  const { task_id } = req.body
  if (!task_id) return res.status(400).json({ error: 'task_id обязателен' })
  res.json({ status: 'started', task_id })
  processTask(task_id).catch(console.error)
})

app.post('/webhook', async (req, res) => {
  res.sendStatus(200)
  const { event, comment, task_id } = req.body
  if (event === 'taskCommentPosted') {
    const text = comment?.comment_text?.toLowerCase() ?? ''
    if (text.includes('approved') || text.includes('апрув') || text === '✅') {
      processTask(task_id).catch(console.error)
    }
  }
})

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
cron.schedule('*/5 * * * *', () => poll().catch(console.error))

app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🤔 BA Agent — SafeButton')
  console.log(`📡 Порт: ${PORT}`)
  console.log(`🔗 PM Agent: ${PM_AGENT_URL}`)
  console.log('⏰ Старт тільки після "approved" в коментарі')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
})
