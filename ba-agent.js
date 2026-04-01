import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import axios from 'axios'
import express from 'express'
import cron from 'node-cron'

// ─────────────────────────────────────────
// КОНФИГУРАЦИЯ
// ─────────────────────────────────────────

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const clickup = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: {
    Authorization: process.env.CLICKUP_API_TOKEN,
    'Content-Type': 'application/json'
  }
})

const LIST_ID = process.env.CLICKUP_LIST_ID
const PM_AGENT_URL = process.env.PM_AGENT_URL || 'https://pm-ai-agent-production.up.railway.app'
const PORT = process.env.PORT || process.env.PORT || process.env.PORT || process.env.BA_AGENT_PORT || 3002

// ─────────────────────────────────────────
// ПРОМПТЫ
// ─────────────────────────────────────────

const QUESTIONS_PROMPT = `Ты Business Analyst Agent продукта SafeButton — мобильного приложения тревожной кнопки.

На основе паспорта фичи задай уточняющие вопросы для написания детального PRD.
Максимум 5 вопросов — только те которые реально влияют на реализацию.

Верни ТОЛЬКО валидный JSON без markdown-блоков:

{
  "questions": [
    {
      "id": "Q1",
      "question": "Текст вопроса",
      "why_important": "Почему важно для реализации"
    }
  ]
}`

const PRD_PROMPT = `Ты Business Analyst Agent продукта SafeButton — мобильного приложения тревожной кнопки (React Native + Supabase).

SafeButton стек:
- Frontend: React Native + Expo
- Backend: Supabase (PostgreSQL + Auth + Edge Functions + Realtime + Storage)
- Push: Expo Push API + APNs Critical Alerts
- SMS: Twilio | Email: Resend | Карты: react-native-maps

На основе паспорта фичи и ответов продакта создай детальный PRD.
PRD должен быть достаточно детальным чтобы разработчик мог сразу писать код.

Верни ТОЛЬКО валидный JSON без markdown-блоков:

{
  "feature_name": "Название фичи",
  "overview": "Краткое описание что делает фича",
  "user_stories": ["Как [кто], я хочу [что], чтобы [зачем]"],
  "functional_requirements": [
    {
      "id": "FR-1",
      "title": "Название требования",
      "description": "Детальное описание",
      "acceptance_criteria": ["Критерий 1", "Критерий 2"]
    }
  ],
  "non_functional_requirements": [
    {
      "id": "NFR-1",
      "title": "Название",
      "description": "Производительность, безопасность, UX"
    }
  ],
  "data_model": {
    "new_tables": [
      {
        "name": "table_name",
        "fields": ["id uuid PK", "user_id FK → users", "field type"],
        "rls": "Описание политик доступа"
      }
    ],
    "modified_tables": []
  },
  "api_endpoints": [
    {
      "method": "POST",
      "path": "/endpoint",
      "description": "Что делает",
      "request": "Тело запроса",
      "response": "Ответ"
    }
  ],
  "edge_cases": ["Граничный случай и как обрабатывать"],
  "out_of_scope": ["Что не входит в эту фичу"],
  "open_questions_resolved": [
    {
      "question": "Вопрос из паспорта",
      "answer": "Ответ"
    }
  ]
}`

// ─────────────────────────────────────────
// CLICKUP
// ─────────────────────────────────────────

async function getTask(taskId) {
  const r = await clickup.get(`/task/${taskId}`)
  return r.data
}

async function getComments(taskId) {
  try {
    const r = await clickup.get(`/task/${taskId}/comment`)
    return r.data.comments ?? []
  } catch { return [] }
}

async function addComment(taskId, text) {
  await clickup.post(`/task/${taskId}/comment`, {
    comment_text: text,
    notify_all: false
  })
}

async function createTask(name, description, tags = []) {
  const r = await clickup.post(`/list/${LIST_ID}/task`, {
    name,
    description,
    tags,
    status: 'to do'
  })
  return r.data
}

// ─────────────────────────────────────────
// BA ЛОГИКА
// ─────────────────────────────────────────

async function askQuestions(passportContent) {
  console.log('🤔 BA Agent: формулирует вопросы...')

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: QUESTIONS_PROMPT,
    messages: [{ role: 'user', content: passportContent }]
  })

  const text = response.content[0].text.trim()
  const cleaned = text.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(cleaned)
}

async function buildPRD(passportContent, answers) {
  console.log('📝 BA Agent: создаёт PRD...')

  const context = `Паспорт фичи:\n${passportContent}\n\nОтветы продакта:\n${answers}`

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 6000,
    system: PRD_PROMPT,
    messages: [{ role: 'user', content: context }]
  })

  const text = response.content[0].text.trim()
  const cleaned = text.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim()
  return JSON.parse(cleaned)
}

function buildPRDDescription(prd) {
  const fr = prd.functional_requirements?.map(r =>
    `${r.id}: ${r.title}\n${r.description}\nКритерии:\n${r.acceptance_criteria?.map(c => `  ✓ ${c}`).join('\n')}`
  ).join('\n\n') ?? '—'

  const nfr = prd.non_functional_requirements?.map(r =>
    `${r.id}: ${r.title}\n${r.description}`
  ).join('\n\n') ?? '—'

  const tables = prd.data_model?.new_tables?.map(t =>
    `Таблица: ${t.name}\nПоля: ${t.fields?.join(', ')}\nRLS: ${t.rls}`
  ).join('\n\n') ?? 'Нет новых таблиц'

  const endpoints = prd.api_endpoints?.map(e =>
    `${e.method} ${e.path} — ${e.description}\nRequest: ${e.request}\nResponse: ${e.response}`
  ).join('\n\n') ?? 'Нет'

  const resolved = prd.open_questions_resolved?.map(q =>
    `Q: ${q.question}\nA: ${q.answer}`
  ).join('\n\n') ?? ''

  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 PRD — ${prd.feature_name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${prd.overview}

USER STORIES
${prd.user_stories?.map(s => `• ${s}`).join('\n') ?? '—'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ФУНКЦИОНАЛЬНЫЕ ТРЕБОВАНИЯ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${fr}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
НЕ-ФУНКЦИОНАЛЬНЫЕ ТРЕБОВАНИЯ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${nfr}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
МОДЕЛЬ ДАННЫХ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${tables}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
API / EDGE FUNCTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${endpoints}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ГРАНИЧНЫЕ СЛУЧАИ
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${prd.edge_cases?.map(e => `• ${e}`).join('\n') ?? '—'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUT OF SCOPE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${prd.out_of_scope?.map(o => `• ${o}`).join('\n') ?? '—'}

${resolved ? `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nОТВЕТЫ НА ВОПРОСЫ\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${resolved}` : ''}`
}

// ─────────────────────────────────────────
// ОБРАБОТКА ЗАДАЧИ
// ─────────────────────────────────────────

async function processTask(taskId) {
  const task = await getTask(taskId)
  const comments = await getComments(taskId)

  // Только задачи с паспортом
  if (!task.description?.includes('ПАСПОРТ ФИЧИ')) return

  // Проверяем апрув
  const approved = comments.find(c =>
    c.comment_text?.toLowerCase().includes('approved') ||
    c.comment_text?.toLowerCase().includes('апрув') ||
    c.comment_text?.toLowerCase().includes('✅')
  )
  if (!approved) return

  // BA уже запускался?
  const baStarted = comments.find(c => c.comment_text?.includes('BA-агент начинает'))
  if (baStarted) {
    await checkForAnswers(taskId, task, comments)
    return
  }

  // Запускаем BA — задаём вопросы
  console.log(`\n✅ Апрув найден: ${task.name}`)
  await addComment(taskId, '🤖 BA-агент начинает проработку PRD...\n\nФормулирую уточняющие вопросы.')

  const questionsData = await askQuestions(task.description)
  const questionsText = questionsData.questions.map((q, i) =>
    `${i + 1}. ${q.question}\n   _Зачем: ${q.why_important}_`
  ).join('\n\n')

  await addComment(taskId,
    `🤔 BA-агент: вопросы перед PRD\n\n${questionsText}\n\n──────────\nОтветьте одним комментарием — создам PRD.`
  )

  console.log(`📋 Задано ${questionsData.questions.length} вопросов`)
}

async function checkForAnswers(taskId, task, comments) {
  const questionsComment = comments.find(c => c.comment_text?.includes('BA-агент: вопросы'))
  if (!questionsComment) return

  const idx = comments.indexOf(questionsComment)
  const answers = comments.slice(idx + 1).filter(c =>
    !c.comment_text?.includes('BA-агент') &&
    !c.comment_text?.includes('PM-агент')
  )
  if (answers.length === 0) return

  // PRD уже создан?
  const prdDone = comments.find(c => c.comment_text?.includes('PRD создан'))
  if (prdDone) return

  // Создаём PRD
  console.log(`\n📝 Создаём PRD для: ${task.name}`)
  await addComment(taskId, '📝 BA-агент: получил ответы, создаю PRD...')

  const answersText = answers.map(c => c.comment_text).join('\n')
  const prd = await buildPRD(task.description, answersText)
  const prdDescription = buildPRDDescription(prd)

  const prdTask = await createTask(
    `[PRD] ${prd.feature_name}`,
    prdDescription,
    ['prd', 'ready for pm agent']
  )

  await addComment(taskId,
    `✅ PRD создан!\n\nЗадача: ${prdTask.url}\n\n──────────\n🤖 PM-агент начнёт декомпозицию (тег "prd" проставлен).\n\nРучной запуск:\ncurl -X POST ${PM_AGENT_URL}/process -H "Content-Type: application/json" -d '{"task_id": "${prdTask.id}"}'`
  )

  console.log(`✅ PRD создан: ${prdTask.url}`)
}

// ─────────────────────────────────────────
// POLLING
// ─────────────────────────────────────────

async function poll() {
  try {
    const r = await clickup.get(`/list/${LIST_ID}/task`, {
      params: { tags: ['passport'], include_closed: false, page: 0 }
    })
    const tasks = r.data.tasks ?? []
    for (const task of tasks) {
      await processTask(task.id)
      await new Promise(r => setTimeout(r, 500))
    }
  } catch (e) {
    console.error('Polling error:', e.message)
  }
}

// ─────────────────────────────────────────
// СЕРВЕР
// ─────────────────────────────────────────

const app = express()
app.use(express.json())

app.get('/', (req, res) => res.json({ status: 'running', agent: 'BA Agent' }))
app.get('/health', (req, res) => res.json({ status: 'ok' }))

// Ручной запуск для конкретной задачи
// POST /process { "task_id": "..." }
app.post('/process', async (req, res) => {
  const { task_id } = req.body
  if (!task_id) return res.status(400).json({ error: 'task_id обязателен' })
  res.json({ status: 'started', task_id })
  processTask(task_id).catch(console.error)
})

// Webhook от ClickUp
app.post('/webhook', async (req, res) => {
  res.sendStatus(200)
  const { event, comment, task_id } = req.body
  if (event === 'taskCommentPosted') {
    const text = comment?.comment_text?.toLowerCase() ?? ''
    if (text.includes('approved') || text.includes('апрув') || text.includes('✅')) {
      processTask(task_id).catch(console.error)
    }
  }
})

// Polling каждые 5 минут
cron.schedule('*/5 * * * *', () => poll().catch(console.error))

app.listen(PORT, () => {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🤔 BA Agent — SafeButton')
  console.log(`📡 Порт: ${PORT}`)
  console.log(`🔗 PM Agent: ${PM_AGENT_URL}`)
  console.log('⏰ Polling апрувов: каждые 5 минут')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('POST /process { "task_id": "..." } → обработать задачу вручную')
})
