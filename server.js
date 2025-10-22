require('dotenv').config()
const express = require('express')
const { Pool } = require('pg')
const bcrypt = require('bcrypt')
const crypto = require('crypto')
const makeWASocket = require('@whiskeysockets/baileys').default
const { 
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const NodeCache = require('node-cache')

// ============================================
// CONFIGURAÇÕES
// ============================================
const app = express()
const PORT = Number(process.env.PORT || 3000)
const NOTIFY_NUMBER = (process.env.NOTIFY_NUMBER || '559193718097').replace(/\D/g, '')
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://autogiro_user:yewPi2fnUONvMTf20gWcz4cN2MgiVw7D@dpg-d3ff4gali9vc73f4h0tg-a.oregon-postgres.render.com:5432/autogiro'
const WA_DATA_PATH = process.env.WA_DATA_PATH || './auth_info_baileys'
const HUBLA_WEBHOOK_TOKEN = process.env.HUBLA_WEBHOOK_TOKEN || ''

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL não configurado')
  process.exit(1)
}

if (!HUBLA_WEBHOOK_TOKEN) {
  console.warn('⚠️ HUBLA_WEBHOOK_TOKEN não configurado - webhook sem autenticação!')
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// ============================================
// ESTADO GLOBAL WHATSAPP + FILA
// ============================================
let sock = null
let isWhatsappReady = false
let reconnectTimeout = null
let isInitializingWhatsapp = false
let hasStartedWhatsapp = false
let qrAttempts = 0
const MAX_QR_ATTEMPTS = 3
let currentQRCode = null

const msgRetryCounterCache = new NodeCache()

// Fila de mensagens
const messageQueue = []
function enqueueMessage(number, message) {
  messageQueue.push({ number, message })
  console.log(`📬 Mensagem enfileirada. Total na fila: ${messageQueue.length}`)
}

async function flushMessageQueue() {
  if (!isWhatsappReady || !sock) return
  console.log(`📤 Processando ${messageQueue.length} mensagens da fila...`)
  
  while (messageQueue.length > 0) {
    const { number, message } = messageQueue.shift()
    try {
      const jid = `${number}@s.whatsapp.net`
      await sock.sendMessage(jid, { text: message })
      console.log(`✅ Mensagem da fila enviada para ${number}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    } catch (err) {
      console.error('❌ Falha ao enviar mensagem da fila:', err?.message || err)
    }
  }
}

// ============================================
// MIDDLEWARES
// ============================================
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex')
  res.setHeader('X-Request-Id', req.requestId)
  console.log(`➡️  ${req.method} ${req.url} [${req.requestId}]`)
  res.on('finish', () => {
    console.log(`⬅️  ${req.method} ${req.url} [${req.requestId}] ${res.statusCode}`)
  })
  next()
})

// ============================================
// FUNÇÕES DO BANCO DE DADOS
// ============================================
async function queryDB(text, params) {
  const start = Date.now()
  const res = await pool.query(text, params)
  const duration = Date.now() - start
  console.log('🔍 Query executada:', { durationMs: duration, rows: res.rowCount })
  return res
}

async function deactivateUserInDB(phone) {
  try {
    const result = await queryDB(`
      UPDATE users 
      SET is_active = false 
      WHERE phone = $1 
      RETURNING id, phone, name, email, is_active
    `, [phone])

    if (result.rowCount > 0) {
      const user = result.rows[0]
      console.log(`🔴 Usuário desativado: ${user.name} (ID: ${user.id})`)
      return { success: true, user }
    } else {
      console.log(`⚠️ Usuário não encontrado no banco: ${phone}`)
      return { success: false, error: 'Usuário não encontrado' }
    }
  } catch (error) {
    console.error('❌ Erro ao desativar usuário:', error.message)
    return { success: false, error: error.message }
  }
}

async function findUserByPhone(phone) {
  try {
    const result = await queryDB(
      'SELECT id, phone, name, email, credits, role, is_active, created_at FROM users WHERE phone = $1 LIMIT 1',
      [phone]
    )
    return result.rowCount > 0 ? result.rows[0] : null
  } catch (error) {
    console.error('❌ Erro ao buscar usuário:', error.message)
    return null
  }
}

async function createUserInDB(userData) {
  try {
    const { phone, password, name, email, clientId, credits = 0 } = userData

    if (!phone || !name) {
      throw new Error('Dados obrigatórios faltando: phone, name')
    }

    // Verifica se usuário já existe
    const existing = await findUserByPhone(phone)
    if (existing) {
      console.log('ℹ️ Usuário já existe, retornando existente:', existing.id)
      return { success: true, user: existing, code: 'ALREADY_EXISTS' }
    }

    const tempPassword = password && password.length >= 6 ? password : generateRandomPassword()
    const passwordHash = await bcrypt.hash(tempPassword, 10)

    const result = await queryDB(`
      INSERT INTO users (phone, password_hash, name, email, client_id, credits, role, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, 'viewer', true)
      RETURNING id, phone, name, email, credits, role, created_at
    `, [phone, passwordHash, name, email || null, clientId || 'client1', credits])

    const user = result.rows[0]
    user.tempPassword = tempPassword
    
    console.log('✅ Usuário criado com sucesso:', user)

    return { success: true, user }
  } catch (error) {
    console.error('❌ Erro ao criar usuário:', error.message)

    if (error.code === '23505') {
      return {
        success: false,
        error: 'Usuário já existe no banco de dados',
        code: 'DUPLICATE_USER'
      }
    }

    return { success: false, error: error.message }
  }
}

// ============================================
// WHATSAPP BAILEYS
// ============================================
function scheduleReconnect(delayMs = 5000) {
  if (reconnectTimeout) {
    console.log('⏳ Reconexão já agendada, ignorando...')
    return
  }
  
  const delaySec = Math.floor(delayMs / 1000)
  console.log(`🔄 Agendando reconexão em ${delaySec} segundos...`)
  
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null
    console.log('🔄 Iniciando reconexão...')
    initWhatsApp(true).catch(err => {
      console.error('❌ Erro ao reconectar:', err?.message || err)
      scheduleReconnect(Math.min(delayMs * 1.5, 60000))
    })
  }, delayMs)
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(WA_DATA_PATH)
  const { version } = await fetchLatestBaileysVersion()
  
  console.log(`📱 Usando versão do WhatsApp: ${version.join('.')}`)
  
  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    browser: ['AutoGiro', 'Chrome', '4.0.0'],
    getMessage: async (key) => {
      return { conversation: '' }
    }
  })

  sock.ev.on('creds.update', saveCreds)
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    
    if (qr) {
      qrAttempts++
      currentQRCode = qr
      
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      console.log(`📱 QR CODE GERADO (Tentativa ${qrAttempts}/${MAX_QR_ATTEMPTS})`)
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
      console.log(`🌐 ACESSE PELO NAVEGADOR:`)
      console.log(`   👉 https://automacao-autogiro.onrender.com/qr`)
      console.log(`   👉 http://localhost:${PORT}/qr`)
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
      
      if (qrAttempts >= MAX_QR_ATTEMPTS) {
        console.log('⚠️ Muitas tentativas de QR Code. Reiniciando conexão...')
        qrAttempts = 0
        currentQRCode = null
        if (sock) sock.end(undefined)
        scheduleReconnect(10000)
      }
    }
    
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const reason = lastDisconnect?.error?.message || 'Desconhecido'
      
      console.log('❌ Conexão fechada')
      console.log('   Motivo:', reason)
      console.log('   Status Code:', statusCode)
      
      isWhatsappReady = false
      qrAttempts = 0
      
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('⚠️ Você foi deslogado do WhatsApp')
        console.log(`⚠️ Delete a pasta "${WA_DATA_PATH}" e reinicie o servidor`)
      } else if (shouldReconnect) {
        console.log('🔄 Tentando reconectar...')
        scheduleReconnect(5000)
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!')
      isWhatsappReady = true
      qrAttempts = 0
      
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
      }
      
      setTimeout(() => {
        flushMessageQueue().catch(err => {
          console.error('❌ Erro ao processar fila:', err)
        })
      }, 2000)
    } else if (connection === 'connecting') {
      console.log('🔄 Conectando ao WhatsApp...')
    }
  })
  
  return sock
}

async function initWhatsApp(isReconnect = false) {
  if (isInitializingWhatsapp) {
    console.log('⏳ Já está inicializando WhatsApp, ignorando...')
    return
  }
  
  if (!isReconnect && hasStartedWhatsapp) {
    console.log('⏳ WhatsApp já foi iniciado anteriormente')
    return
  }
  
  isInitializingWhatsapp = true
  
  try {
    if (sock) {
      try {
        sock.end(undefined)
      } catch (e) {
        console.warn('⚠️ Erro ao encerrar socket anterior:', e?.message)
      }
      sock = null
      isWhatsappReady = false
    }
    
    console.log('📱 Iniciando Baileys...')
    await connectToWhatsApp()
    hasStartedWhatsapp = true
    
  } catch (error) {
    console.error('❌ Erro ao inicializar Baileys:', error?.message || error)
    scheduleReconnect(10000)
  } finally {
    isInitializingWhatsapp = false
  }
}

async function sendWhatsAppMessage(number, message) {
  try {
    if (!number || !/^\d{10,15}$/.test(number)) {
      throw new Error('Número de telefone inválido')
    }
    if (!message || typeof message !== 'string') {
      throw new Error('Mensagem inválida')
    }
    if (!sock) {
      throw new Error('Socket WhatsApp não inicializado')
    }
    if (!isWhatsappReady) {
      console.log('ℹ️ WhatsApp não pronto, enfileirando mensagem...')
      enqueueMessage(number, message)
      return { success: true, queued: true }
    }

    const jid = `${number}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: message })
    console.log(`✅ Mensagem enviada para ${number}`)
    
    return { success: true }
  } catch (error) {
    console.error('❌ Erro ao enviar mensagem:', error.message)
    return { success: false, error: error.message }
  }
}

// ============================================
// FORMATAÇÃO DE MENSAGENS
// ============================================
function formatWelcomeMessage(user, webhookData) {
  const subscription = webhookData?.event?.subscription
  const product = webhookData?.event?.product
  
  return `🎉 *Bem-vindo(a) ao AutoGiro!*

Olá *${user.name}*! 👋

Sua assinatura foi ativada com sucesso! 🎊

📦 *Detalhes da Assinatura Hub.la:*
━━━━━━━━━━━━━━━━━━━━━
📦 Produto: ${product?.name || 'N/A'}
⏰ Validade: ${subscription?.credits || 0} dias
🔄 Renovação Automática: ${subscription?.autoRenew ? 'Ativada ✅' : 'Desativada'}

🔐 *Seus Dados de Acesso:*
━━━━━━━━━━━━━━━━━━━━
📱 Telefone: ${user.phone}
📧 Email: ${user.email || 'Não informado'}
🔑 Senha Temporária: *${user.tempPassword}*

💰 *Saldo de Créditos no Sistema:*
Créditos disponíveis: ${user.credits} (use dentro da plataforma)

⚠️ *IMPORTANTE:* Por segurança, altere sua senha no primeiro acesso!

💻 *Como acessar:*
1. Acesse a plataforma
2. Faça login com seu telefone/email
3. Use a senha temporária acima
4. Altere para uma senha pessoal

Qualquer dúvida, estamos à disposição! 

Aproveite sua assinatura! 🚀

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Obrigado por escolher nossos serviços!_`
}

function formatExpiringMessage(user, webhookData) {
  const subscription = webhookData?.event?.subscription
  const product = webhookData?.event?.product
  const daysRemaining = subscription?.credits || 0
  
  return `⚠️ *Sua Assinatura Está Expirando!*

Olá *${user.name}*! 

Queremos avisar que sua assinatura está perto de expirar.

📦 *Detalhes da Assinatura:*
━━━━━━━━━━━━━━━━━━━━
📦 Produto: ${product?.name || 'N/A'}
⏰ Dias Restantes: *${daysRemaining} dias*
🔄 Renovação Automática: ${subscription?.autoRenew ? 'ATIVADA ✅' : 'DESATIVADA ❌'}

${subscription?.autoRenew 
  ? `✅ *Não se preocupe!*
Sua assinatura será renovada automaticamente antes de expirar.
Você não perderá o acesso aos serviços.`
  : `⚠️ *ATENÇÃO!*
Sua renovação automática está DESATIVADA.
Para não perder o acesso, renove sua assinatura antes do vencimento.

🔄 *Como renovar:*
1. Acesse a plataforma Hub.la
2. Vá em "Minhas Assinaturas"
3. Clique em "Renovar"`
}

💡 *Precisa de ajuda?*
Entre em contato com nosso suporte.

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sua satisfação é nossa prioridade!_`
}

function formatDeactivatedMessage(user, webhookData) {
  const subscription = webhookData?.event?.subscription
  const product = webhookData?.event?.product
  
  return `🔴 *Assinatura Expirada*

Olá *${user.name}*,

Sua assinatura do AutoGiro expirou e seu acesso foi desativado.

📦 *Detalhes:*
━━━━━━━━━━━━━━━━━━━━
📦 Produto: ${product?.name || 'N/A'}
⏰ Status: *EXPIRADA*
📅 Desativada em: ${new Date().toLocaleDateString('pt-BR')}

😔 *O que acontece agora?*
• Seu acesso à plataforma foi suspenso
• Seus dados estão seguros e preservados
• Você pode renovar a qualquer momento

💚 *Como renovar e reativar:*
1. Acesse a plataforma Hub.la
2. Faça login com suas credenciais
3. Vá em "Minhas Assinaturas"
4. Clique em "Renovar Assinatura"

✨ Após a renovação, seu acesso será reativado automaticamente!

📞 *Precisa de ajuda?*
Nossa equipe está pronta para ajudar você!

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Esperamos você de volta!_`
}

function formatDeactivatedNotificationAdmin(user, webhookData) {
  const subscription = webhookData?.event?.subscription
  const product = webhookData?.event?.product
  const timestamp = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Belem'
  })

  return `🔴 *ASSINATURA DESATIVADA - AÇÃO NECESSÁRIA*

⚠️ Cliente teve assinatura desativada por falta de créditos!

👤 *Dados do Cliente:*
━━━━━━━━━━━━━━━━━━━━
Nome: *${user.name}*
📱 Telefone: ${user.phone}
📧 Email: ${user.email || 'Não informado'}
🆔 ID Banco: ${user.id || 'N/A'}

📦 *Detalhes da Assinatura:*
━━━━━━━━━━━━━━━━━━━━
📦 Produto: ${product?.name || 'N/A'}
⏰ Créditos: ${subscription?.credits || 0} (ZERADO)
🔄 Auto-Renovação: ${subscription?.autoRenew ? 'ESTAVA ATIVA' : 'INATIVA'}
📅 ID Assinatura: ${subscription?.id || 'N/A'}
🕐 Desativada em: ${timestamp}

🎯 *AÇÃO NECESSÁRIA:*
${user.id 
  ? `✅ Usuário foi desativado automaticamente no banco de dados.
⚠️ Remover acesso do cliente aos sistemas/grupos.`
  : `⚠️ Usuário não está cadastrado no banco.
ℹ️ Apenas notificação enviada ao cliente.`
}

📌 *Próximos passos:*
1. Remover cliente de grupos/canais privados
2. Desativar acessos especiais
3. Aguardar renovação do cliente

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sistema Automatizado_`
}

function formatAbandonedCheckoutMessage(lead, products) {
  const productNames = products.map(p => p.name).join(', ')
  const firstName = lead.fullName ? lead.fullName.split(' ')[0] : 'Cliente'
  
  return `🛒 *Ei, ${firstName}!* 

Notamos que você estava quase finalizando sua compra mas algo aconteceu... 😊

📦 *Produtos no carrinho:*
${productNames}

⏰ *Não perca essa oportunidade!*

Sabemos que imprevistos acontecem. Estamos aqui para ajudar você a finalizar sua compra!

💡 *Benefícios de assinar agora:*
✅ Acesso imediato à plataforma
✅ Suporte dedicado
✅ Todas as funcionalidades liberadas
✅ Pagamento seguro

🔗 *Finalize sua compra:*
${lead.session?.url || 'Acesse o link que você recebeu por email'}

❓ *Alguma dúvida?*
Responda esta mensagem que teremos prazer em ajudar!

Estamos te esperando! 🚀

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Estamos aqui para você!_`
}

function formatAbandonedCheckoutNotificationAdmin(lead, products, webhookData) {
  const timestamp = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Belem'
  })
  
  const productsList = products.map(p => 
    `📦 ${p.name} (ID: ${p.id})`
  ).join('\n')

  const utmInfo = lead.session?.utm ? `
📊 *Origem do Tráfego (UTM):*
━━━━━━━━━━━━━━━━━━━━
🔹 Source: ${lead.session.utm.source || 'N/A'}
🔹 Medium: ${lead.session.utm.medium || 'N/A'}
🔹 Campaign: ${lead.session.utm.campaign || 'N/A'}
🔹 Content: ${lead.session.utm.content || 'N/A'}
🔹 Term: ${lead.session.utm.term || 'N/A'}` : ''

  const cookiesInfo = lead.session?.cookies ? `
🍪 *Cookies/IDs:*
━━━━━━━━━━━━━━━━━━━━
• Facebook Pixel: ${lead.session.cookies.fbp ? '✅' : '❌'}
• Google Click ID: ${lead.session.cookies.gclid ? '✅' : '❌'}
• Hub.la ID: ${lead.session.cookies.hbId || 'N/A'}` : ''

  return `🛒 *CARRINHO ABANDONADO - LEAD QUENTE!*

⚠️ Potencial cliente abandonou o checkout após preencher dados!

👤 *Dados do Lead:*
━━━━━━━━━━━━━━━━━━━━
Nome: *${lead.fullName || 'Não informado'}*
📱 Telefone: ${lead.phone || 'Não informado'}
📧 Email: ${lead.email || 'Não informado'}
🆔 Lead ID: ${lead.id}
🕐 Abandonado em: ${timestamp}

📦 *Produtos no Carrinho:*
━━━━━━━━━━━━━━━━━━━━
${productsList}
${utmInfo}
${cookiesInfo}

🔗 *URL do Checkout:*
${lead.session?.url || 'N/A'}

💡 *AÇÃO SUGERIDA:*
✅ Mensagem de recuperação enviada automaticamente ao cliente
📞 Considere fazer follow-up personalizado em 1-2 horas
💬 Cliente demonstrou interesse - está pronto para converter!

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sistema Automatizado_`
}

function formatUserCreatedMessage(user, webhookData) {
  const timestamp = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Belem'
  })

  const subscription = webhookData?.event?.subscription
  const product = webhookData?.event?.product

  return `🤖 *NOVA ASSINATURA ATIVADA*

✅ Usuário registrado com sucesso no banco de dados!

📋 *Dados do Usuário:*
━━━━━━━━━━━━━━━━━━━━
👤 Nome: ${user.name}
📱 Telefone: ${user.phone}
📧 Email: ${user.email || 'Não informado'}
🆔 ID no Banco: ${user.id}
🔑 Senha Gerada: *${user.tempPassword || 'N/A'}*
💰 Créditos Sistema: ${user.credits}

💳 *Dados da Assinatura Hub.la:*
━━━━━━━━━━━━━━━━━━━━
📦 Produto: ${product?.name || 'N/A'}
⏰ Validade: ${subscription?.credits || 0} dias
💵 Pagamento: ${subscription?.paymentMethod === 'credit_card' ? 'Cartão de Crédito' : subscription?.paymentMethod || 'N/A'}
🔄 Renovação: ${subscription?.autoRenew ? 'Sim' : 'Não'}
📅 Ativada em: ${timestamp}

✉️ *Mensagem de boas-vindas enviada ao cliente!*

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sistema Automatizado_`
}

function formatExpiringNotificationAdmin(user, webhookData) {
  const subscription = webhookData?.event?.subscription
  const product = webhookData?.event?.product
  const daysRemaining = subscription?.credits || 0

  return `⚠️ *ASSINATURA EXPIRANDO - ALERTA*

Cliente: *${user.name}*
Telefone: ${user.phone}
Email: ${user.email || 'Não informado'}

📦 *Detalhes:*
━━━━━━━━━━━━━━━━━━━━
📦 Produto: ${product?.name || 'N/A'}
⏰ Dias Restantes: *${daysRemaining} dias*
🔄 Auto-Renovação: ${subscription?.autoRenew ? 'SIM ✅' : 'NÃO ❌'}
📅 ID Assinatura: ${subscription?.id || 'N/A'}

${!subscription?.autoRenew ? '⚠️ *ATENÇÃO:* Cliente sem renovação automática!' : '✅ Renovação automática ativada.'}

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sistema Automatizado_`
}

async function notifyError(error, userData) {
  try {
    if (!NOTIFY_NUMBER) return
    const message = `⚠️ *ERRO AO PROCESSAR WEBHOOK*

❌ Houve um problema ao processar o webhook.

📋 *Dados recebidos:*
${JSON.stringify(userData, null, 2)}

🔴 *Erro:*
${error}

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sistema Automatizado_`
    await sendWhatsAppMessage(NOTIFY_NUMBER, message)
  } catch (err) {
    console.error('❌ Erro ao enviar notificação de erro:', err)
  }
}

function mapHublaDataToUser(webhookData) {
  if (!webhookData?.event?.user) {
    throw new Error('Formato de webhook inválido - dados do usuário não encontrados')
  }

  const { user, subscription, product } = webhookData.event
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim()
  const rawPhone = user.phone || ''
  const cleanPhone = rawPhone.replace(/\D/g, '')

  if (!cleanPhone) {
    throw new Error('Telefone ausente ou inválido no webhook')
  }
  if (!fullName) {
    throw new Error('Nome ausente no webhook')
  }

  return {
    phone: cleanPhone,
    password: generateRandomPassword(),
    name: fullName,
    email: user.email,
    clientId: subscription?.id || 'hubla_' + String(user.id || '').slice(0, 8),
    credits: 0,
    hublaUserId: user.id,
    hublaSubscriptionId: subscription?.id,
    hublaProductName: product?.name,
    hublaSubscriptionCredits: subscription?.credits,
    document: user.document
  }
}

function generateRandomPassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let password = ''
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
}

// ============================================
// ROTAS
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Servidor AutoGiro rodando com Baileys!',
    whatsapp: isWhatsappReady ? 'conectado' : 'desconectado',
    queueSize: messageQueue.length
  })
})

app.get('/qr', (req, res) => {
  if (!currentQRCode) {
    return res.send(`
      <html>
        <body style="font-family: Arial; text-align: center; padding: 50px;">
          <h2>⏳ Aguardando QR Code...</h2>
          <p>O WhatsApp ainda não gerou um QR Code.</p>
          <button onclick="location.reload()">🔄 Recarregar</button>
        </body>
      </html>
    `)
  }

  const QRCode = require('qrcode')
  QRCode.toDataURL(currentQRCode, (err, url) => {
    res.send(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              margin: 0;
              padding: 20px;
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 20px;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 500px;
            }
            h1 { color: #333; margin-bottom: 10px; }
            p { color: #666; margin-bottom: 30px; }
            img { 
              border-radius: 12px;
              box-shadow: 0 4px 6px rgba(0,0,0,0.1);
              max-width: 100%;
              height: auto;
            }
            .steps {
              text-align: left;
              background: #f8f9fa;
              padding: 20px;
              border-radius: 12px;
              margin-top: 20px;
            }
            .steps ol { margin-left: 20px; }
            .steps li { margin: 10px 0; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>📱 WhatsApp QR Code</h1>
            <p>Escaneie com seu WhatsApp</p>
            <img src="${url}" alt="QR Code">
            <div class="steps">
              <strong>Como conectar:</strong>
              <ol>
                <li>Abra o WhatsApp no celular</li>
                <li>Toque em Menu (⋮) > Aparelhos conectados</li>
                <li>Toque em "Conectar um aparelho"</li>
                <li>Escaneie este QR Code</li>
              </ol>
            </div>
          </div>
        </body>
      </html>
    `)
  })
})

app.get('/health', async (req, res) => {
  const healthCheck = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: 'AutoGiro',
    version: '1.0.0',
    checks: {
      server: 'healthy',
      database: 'checking',
      whatsapp: 'checking',
      messageQueue: messageQueue.length
    }
  }

  try {
    const dbStart = Date.now()
    await pool.query('SELECT 1')
    const dbLatency = Date.now() - dbStart
    
    healthCheck.checks.database = 'healthy'
    healthCheck.checks.databaseLatency = `${dbLatency}ms`
  } catch (error) {
    healthCheck.status = 'degraded'
    healthCheck.checks.database = 'unhealthy'
    healthCheck.checks.databaseError = error.message
  }

  if (isWhatsappReady && sock) {
    healthCheck.checks.whatsapp = 'connected'
  } else if (isInitializingWhatsapp) {
    healthCheck.checks.whatsapp = 'connecting'
    healthCheck.status = 'degraded'
  } else {
    healthCheck.checks.whatsapp = 'disconnected'
    healthCheck.status = 'degraded'
  }

  if (messageQueue.length > 100) {
    healthCheck.status = 'degraded'
    healthCheck.checks.messageQueueStatus = 'warning - queue too large'
  } else {
    healthCheck.checks.messageQueueStatus = 'normal'
  }

  const statusCode = healthCheck.status === 'ok' ? 200 : 503
  res.status(statusCode).json(healthCheck)
})

app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'pong',
    timestamp: new Date().toISOString()
  })
})

app.get('/status', async (req, res) => {
  let dbStatus = 'desconectado'
  try {
    await pool.query('SELECT 1')
    dbStatus = 'conectado'
  } catch {
    dbStatus = 'desconectado'
  }
  res.json({
    server: 'online',
    whatsapp: isWhatsappReady ? 'conectado' : 'desconectado',
    database: dbStatus,
    messageQueue: messageQueue.length
  })
})

app.get('/api/users', async (req, res) => {
  try {
    const result = await queryDB(`
      SELECT id, phone, name, email, credits, role, is_active, created_at
      FROM users
      ORDER BY created_at DESC
    `)
    
    res.json(result.rows)
  } catch (error) {
    console.error('❌ Erro ao buscar usuários:', error)
    res.status(500).json({ error: 'Erro ao buscar usuários' })
  }
})

app.get('/dashboard', (req, res) => {
  res.sendFile(__dirname + '/dashboard.html')
})

app.post('/api/users/:id/add-credits', async (req, res) => {
  try {
    const userId = req.params.id
    const { amount, reason } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Quantidade de créditos inválida' })
    }

    const result = await queryDB(`
      UPDATE users 
      SET credits = credits + $1 
      WHERE id = $2 
      RETURNING id, name, phone, credits
    `, [amount, userId])

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' })
    }

    const user = result.rows[0]
    console.log(`💰 Créditos adicionados: ${amount} para usuário ${user.name} (ID: ${userId})`)

    const message = `💰 *Créditos Adicionados!*

Olá *${user.name}*! 

Você recebeu *${amount} créditos* em sua conta! 🎉

📊 *Seu saldo atual:*
💰 ${user.credits} créditos

${reason ? `📝 Motivo: ${reason}` : ''}

Aproveite! 🚀

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sistema de Créditos_`

    await sendWhatsAppMessage(user.phone, message)

    res.json({
      success: true,
      message: 'Créditos adicionados com sucesso',
      user
    })
  } catch (error) {
    console.error('❌ Erro ao adicionar créditos:', error)
    res.status(500).json({ error: 'Erro ao adicionar créditos' })
  }
})

app.post('/api/users/:id/use-credits', async (req, res) => {
  try {
    const userId = req.params.id
    const { amount, service } = req.body

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Quantidade de créditos inválida' })
    }

    const checkBalance = await queryDB(
      'SELECT credits FROM users WHERE id = $1',
      [userId]
    )

    if (checkBalance.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' })
    }

    const currentCredits = checkBalance.rows[0].credits

    if (currentCredits < amount) {
      return res.status(400).json({ 
        error: 'Créditos insuficientes',
        available: currentCredits,
        required: amount
      })
    }

    const result = await queryDB(`
      UPDATE users 
      SET credits = credits - $1 
      WHERE id = $2 
      RETURNING id, name, phone, credits
    `, [amount, userId])

    const user = result.rows[0]
    console.log(`📉 Créditos consumidos: ${amount} do usuário ${user.name} (ID: ${userId})`)

    res.json({
      success: true,
      message: 'Créditos consumidos com sucesso',
      user,
      consumed: amount,
      remaining: user.credits
    })
  } catch (error) {
    console.error('❌ Erro ao consumir créditos:', error)
    res.status(500).json({ error: 'Erro ao consumir créditos' })
  }
})

// ============================================
// FUNÇÃO AUXILIAR: NORMALIZAR TELEFONE (HUB.LA)
// ============================================
function normalizePhone(phone) {
  if (!phone) return null
  
  // Remove tudo que não é número
  let clean = String(phone).replace(/\D/g, '')
  
  // Remove zeros à esquerda
  clean = clean.replace(/^0+/, '')
  
  // Remove DDI 55 duplicado (ex: 5555119... -> 55119...)
  if (clean.startsWith('5555') && clean.length > 12) {
    clean = '55' + clean.substring(4)
  }
  
  // Se tem mais de 13 dígitos, pega os últimos 13
  if (clean.length > 13) {
    clean = clean.slice(-13)
  }
  
  // Se já tem 13 dígitos e começa com 55, está OK
  if (clean.length === 13 && clean.startsWith('55')) {
    return clean
  }
  
  // Se tem 12 dígitos e começa com 55, está OK
  if (clean.length === 12 && clean.startsWith('55')) {
    return clean
  }
  
  // Se tem 11 dígitos (DDD + número), adiciona DDI 55
  if (clean.length === 11) {
    return '55' + clean
  }
  
  // Se tem 10 dígitos (DDD + número sem o 9), adiciona DDI 55
  if (clean.length === 10) {
    return '55' + clean
  }
  
  // Formato inválido
  return null
}

// ============================================
// FUNÇÃO AUXILIAR: MAPEAR CAMPOS DA HUB.LA
// ============================================
function mapHublaContact(contact) {
  // Mapeamento de colunas da Hub.la para formato padrão
  const mapped = {
    // Nomes possíveis
    nome: contact['Nome do cliente'] || 
          contact['nome'] || 
          contact['name'] || 
          contact['Nome'] || 
          '',
    
    // Telefones possíveis
    telefone: contact['Telefone do cliente'] || 
              contact['telefone'] || 
              contact['phone'] || 
              contact['tel'] || 
              contact['whatsapp'] || 
              '',
    
    // Emails possíveis
    email: contact['Email do cliente'] || 
           contact['email'] || 
           contact['e-mail'] || 
           '',
    
    // CPF/Documento
    cpf: contact['Documento do cliente'] || 
         contact['cpf'] || 
         contact['documento'] || 
         '',
    
    // Status
    status: contact['Status da assinatura'] || 
            contact['status'] || 
            '',
    
    // Plano
    plano: contact['Plano'] || 
           contact['plano'] || 
           '',
    
    // Produto
    produto: contact['Nome do produto'] || 
             contact['produto'] || 
             contact['product'] || 
             ''
  }
  
  // Retorna o objeto mapeado com todos os campos originais também
  return { ...contact, ...mapped }
}

// ============================================
// ROTA DE ENVIO EM MASSA
// ============================================
app.post('/api/bulk-send', async (req, res) => {
  try {
    const { contacts, message, delaySeconds = 3 } = req.body

    console.log('📬 Iniciando envio em massa...')
    console.log(`   Total de contatos: ${contacts?.length || 0}`)
    console.log(`   Intervalo: ${delaySeconds}s`)

    // Validações básicas
    if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nenhum contato fornecido'
      })
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Mensagem inválida ou vazia'
      })
    }

    // Processar contatos e separar válidos/inválidos
    const validContacts = []
    const invalidContacts = []

    contacts.forEach((contact, index) => {
      // Mapeia campos da Hub.la para formato padrão
      const mappedContact = mapHublaContact(contact)
      
      // Tenta encontrar o campo de telefone
      const phoneField = mappedContact.telefone
      
      if (!phoneField) {
        invalidContacts.push({ 
          index, 
          reason: 'Telefone ausente', 
          data: contact,
          nome: mappedContact.nome 
        })
        return
      }

      // USA A FUNÇÃO DE NORMALIZAÇÃO
      const cleanPhone = normalizePhone(phoneField)
      
      if (!cleanPhone) {
        invalidContacts.push({ 
          index, 
          reason: 'Formato inválido', 
          phone: phoneField, 
          data: contact,
          nome: mappedContact.nome
        })
        return
      }

      validContacts.push({
        phone: cleanPhone,
        data: mappedContact  // Usa os dados mapeados
      })
    })

    console.log(`✅ Contatos válidos: ${validContacts.length}`)
    console.log(`❌ Contatos inválidos: ${invalidContacts.length}`)

    // Se não houver contatos válidos, retornar erro
    if (validContacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nenhum contato válido encontrado',
        total: contacts.length,
        valid: 0,
        invalid: invalidContacts.length,
        invalidContacts: invalidContacts
      })
    }

    // Responder imediatamente ao frontend
    res.status(200).json({
      success: true,
      message: 'Envio em massa iniciado',
      total: contacts.length,
      valid: validContacts.length,
      invalid: invalidContacts.length
    })

    // Processar envios em background (não bloqueia a resposta)
    console.log('🚀 Iniciando envios em background...')
    
    processQueueInBackground(validContacts, message, delaySeconds)

  } catch (error) {
    console.error('❌ Erro na rota /api/bulk-send:', error)
    return res.status(500).json({
      success: false,
      error: 'Erro interno do servidor',
      details: error.message
    })
  }
})

// ============================================
// FUNÇÃO AUXILIAR: PROCESSAR FILA EM BACKGROUND
// ============================================
async function processQueueInBackground(validContacts, messageTemplate, delaySeconds) {
  let successCount = 0
  let failCount = 0

  for (let i = 0; i < validContacts.length; i++) {
    const contact = validContacts[i]
    
    try {
      // Personalizar mensagem com variáveis
      let personalizedMessage = messageTemplate
      
      // Substituir todas as variáveis {{nome}}, {{email}}, etc
      Object.keys(contact.data).forEach(key => {
        const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi')
        personalizedMessage = personalizedMessage.replace(regex, contact.data[key] || '')
      })

      // Enviar mensagem
      const result = await sendWhatsAppMessage(contact.phone, personalizedMessage)
      
      if (result.success) {
        successCount++
        console.log(`✅ [${i + 1}/${validContacts.length}] Enviado para ${contact.phone}`)
      } else {
        failCount++
        console.error(`❌ [${i + 1}/${validContacts.length}] Falha para ${contact.phone}: ${result.error}`)
      }

      // Aguardar intervalo antes do próximo envio (exceto no último)
      if (i < validContacts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000))
      }

    } catch (error) {
      failCount++
      console.error(`❌ [${i + 1}/${validContacts.length}] Erro ao enviar para ${contact.phone}:`, error.message)
    }
  }

  console.log('\n📊 RELATÓRIO FINAL:')
  console.log(`   ✅ Sucesso: ${successCount}`)
  console.log(`   ❌ Falhas: ${failCount}`)
  console.log(`   📦 Total: ${validContacts.length}`)

  // Notificar admin sobre conclusão
  if (NOTIFY_NUMBER) {
    const reportMessage = `📬 *ENVIO EM MASSA CONCLUÍDO*

📊 *Relatório:*
━━━━━━━━━━━━━━━━━━━━
✅ Enviadas: ${successCount}
❌ Falhas: ${failCount}
📦 Total: ${validContacts.length}

⏱️ Tempo estimado: ~${Math.ceil((validContacts.length * delaySeconds) / 60)} minutos

━━━━━━━━━━━━━━━━━━━━
_AutoGiro - Sistema Automatizado_`

    try {
      await sendWhatsAppMessage(NOTIFY_NUMBER, reportMessage)
    } catch (err) {
      console.error('⚠️ Erro ao notificar admin:', err.message)
    }
  }
}

// ============================================
// WEBHOOK HUBLA
// ============================================
app.post('/webhook/hubla', async (req, res) => {
  try {
    console.log('📥 Webhook recebido da Hub.la')
    console.log('Type:', req.body?.type)

    // ========== VALIDAR TOKEN DE AUTENTICAÇÃO ==========
    if (HUBLA_WEBHOOK_TOKEN) {
      const receivedToken = req.headers['x-hubla-token'] || 
                           req.headers['x-hubla-signature'] || 
                           req.headers['authorization']?.replace('Bearer ', '') ||
                           req.body?.token

      console.log('🔐 Validando token...')
      console.log('   Token esperado:', HUBLA_WEBHOOK_TOKEN.substring(0, 10) + '...')
      console.log('   Token recebido:', receivedToken ? receivedToken.substring(0, 10) + '...' : 'NENHUM')

      if (receivedToken !== HUBLA_WEBHOOK_TOKEN) {
        console.error('❌ Token inválido ou ausente!')
        return res.status(401).json({
          success: false,
          error: 'Token de autenticação inválido ou ausente',
          hint: 'Envie o token no header x-hubla-token'
        })
      }
      
      console.log('✅ Token validado com sucesso')
    } else {
      console.warn('⚠️ Webhook sem validação de token - configure HUBLA_WEBHOOK_TOKEN')
    }

    const eventType = req.body?.type

    // ========== SUBSCRIPTION ACTIVATED ==========
    if (eventType === 'subscription.activated') {
      const userData = mapHublaDataToUser(req.body)
      console.log('👤 Dados mapeados:', {
        phone: userData.phone,
        name: userData.name,
        email: userData.email
      })

      const result = await createUserInDB(userData)

      if (result.success) {
        if (NOTIFY_NUMBER) {
          const adminMessage = formatUserCreatedMessage(result.user, req.body)
          await sendWhatsAppMessage(NOTIFY_NUMBER, adminMessage)
        }
        
        const welcomeMessage = formatWelcomeMessage(result.user, req.body)
        await sendWhatsAppMessage(result.user.phone, welcomeMessage)
        
        return res.status(200).json({
          success: true,
          message: result.code === 'ALREADY_EXISTS'
            ? 'Usuário já existia e notificações enviadas'
            : 'Usuário criado e notificações enviadas',
          user: result.user
        })
      } else {
        await notifyError(result.error, userData)
        return res.status(result.code === 'DUPLICATE_USER' ? 409 : 400).json({
          success: false,
          error: result.error,
          code: result.code
        })
      }
    }

    // ========== SUBSCRIPTION EXPIRING ==========
    if (eventType === 'subscription.expiring') {
      const webhookData = req.body
      const user = webhookData?.event?.user
      
      if (!user || !user.phone) {
        return res.status(400).json({
          success: false,
          error: 'Dados do usuário ausentes no webhook'
        })
      }

      const cleanPhone = user.phone.replace(/\D/g, '')
      const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim()
      const subscription = webhookData?.event?.subscription
      const daysRemaining = subscription?.credits || 0

      console.log(`⚠️ Assinatura expirando para ${fullName} (${cleanPhone}) - ${daysRemaining} dias restantes`)

      const dbUser = await findUserByPhone(cleanPhone)
      
      if (dbUser) {
        const expiringMessage = formatExpiringMessage(
          { ...dbUser, name: fullName }, 
          webhookData
        )
        await sendWhatsAppMessage(cleanPhone, expiringMessage)

        if (NOTIFY_NUMBER) {
          const adminNotification = formatExpiringNotificationAdmin(
            { ...dbUser, name: fullName },
            webhookData
          )
          await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
        }

        return res.status(200).json({
          success: true,
          message: 'Notificação de expiração enviada',
          user: {
            name: fullName,
            phone: cleanPhone,
            daysRemaining: daysRemaining
          }
        })
      } else {
        console.log(`⚠️ Usuário não encontrado no banco, mas enviando notificação de expiração`)
        
        const tempUser = {
          name: fullName,
          phone: cleanPhone,
          email: user.email || 'Não informado'
        }

        const expiringMessage = formatExpiringMessage(tempUser, webhookData)
        await sendWhatsAppMessage(cleanPhone, expiringMessage)

        if (NOTIFY_NUMBER) {
          const adminNotification = formatExpiringNotificationAdmin(tempUser, webhookData)
          await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
        }

        return res.status(200).json({
          success: true,
          message: 'Notificação de expiração enviada (usuário não cadastrado)',
          user: tempUser
        })
      }
    }

    // ========== SUBSCRIPTION DEACTIVATED ==========
    if (eventType === 'subscription.deactivated') {
      const webhookData = req.body
      const user = webhookData?.event?.user
      
      if (!user || !user.phone) {
        return res.status(400).json({
          success: false,
          error: 'Dados do usuário ausentes no webhook'
        })
      }

      const cleanPhone = user.phone.replace(/\D/g, '')
      const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim()

      console.log(`🔴 Assinatura DESATIVADA para ${fullName} (${cleanPhone})`)

      const dbUser = await findUserByPhone(cleanPhone)
      
      if (dbUser) {
        await deactivateUserInDB(cleanPhone)

        const deactivatedMessage = formatDeactivatedMessage(
          { ...dbUser, name: fullName }, 
          webhookData
        )
        await sendWhatsAppMessage(cleanPhone, deactivatedMessage)

        if (NOTIFY_NUMBER) {
          const adminNotification = formatDeactivatedNotificationAdmin(
            { ...dbUser, name: fullName },
            webhookData
          )
          await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
        }

        return res.status(200).json({
          success: true,
          message: 'Assinatura desativada e notificações enviadas',
          user: {
            id: dbUser.id,
            name: fullName,
            phone: cleanPhone,
            deactivated: true
          }
        })
      } else {
        console.log(`⚠️ Usuário não encontrado no banco para desativação`)
        
        const tempUser = {
          name: fullName,
          phone: cleanPhone,
          email: user.email || 'Não informado'
        }

        const deactivatedMessage = formatDeactivatedMessage(tempUser, webhookData)
        await sendWhatsAppMessage(cleanPhone, deactivatedMessage)

        if (NOTIFY_NUMBER) {
          const adminNotification = formatDeactivatedNotificationAdmin(tempUser, webhookData)
          await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
        }

        return res.status(200).json({
          success: true,
          message: 'Notificação de desativação enviada (usuário não cadastrado)',
          user: tempUser
        })
      }
    }

    // ========== CARRINHO ABANDONADO ==========
    if (eventType === 'lead.abandoned_checkout' || eventType === 'AbandonedCheckout') {
      console.log('🛒 Processando carrinho abandonado...')
      console.log('📦 Payload completo:', JSON.stringify(req.body, null, 2))
      
      const webhookData = req.body
      const eventData = webhookData.event

      const lead = {
        fullName: eventData.userName,
        phone: eventData.userPhone,
        email: eventData.userEmail,
        id: eventData.userId || 'N/A',
        session: {
          url: eventData.checkoutUrl || 'N/A' 
        }
      }

      const products = eventData.productName ? [{ name: eventData.productName, id: eventData.productId }] : []
      
      console.log('👤 Lead encontrado:', lead ? 'SIM' : 'NÃO')
      console.log('📱 Telefone do lead:', lead?.phone)
      
      if (!lead || !lead.phone) {
        console.error('❌ Validação falhou: dados do lead ausentes')
        return res.status(400).json({
          success: false,
          error: 'Dados do lead ausentes no webhook',
          received: {
            hasLead: !!lead,
            hasPhone: !!lead?.phone,
            leadData: lead
          }
        })
      }

      let cleanPhone = lead.phone.replace(/\D/g, '')

      // Garante que o número de telefone tenha o código do país (55)
      if (cleanPhone.length >= 10 && cleanPhone.length <= 11) {
        cleanPhone = `55${cleanPhone}`
      }

      console.log(`🛒 Carrinho abandonado: ${lead.fullName || 'Lead'} (${cleanPhone})`)
      console.log(`📦 Produtos: ${products.map(p => p.name).join(', ')}`)

      const recoveryMessage = formatAbandonedCheckoutMessage(lead, products)
      await sendWhatsAppMessage(cleanPhone, recoveryMessage)

      if (NOTIFY_NUMBER) {
        const adminNotification = formatAbandonedCheckoutNotificationAdmin(lead, products, webhookData)
        await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
      }

      return res.status(200).json({
        success: true,
        message: 'Mensagem de recuperação de carrinho enviada',
        lead: {
          name: lead.fullName,
          phone: cleanPhone,
          email: lead.email,
          products: products.map(p => p.name)
        }
      })
    }

    // ========== OUTROS EVENTOS ==========
    console.log('⚠️ Evento ignorado:', eventType)
    return res.status(200).json({
      success: true,
      message: `Evento ${eventType} recebido mas não processado`
    })

  } catch (error) {
    console.error('❌ Erro no webhook:', error)
    await notifyError(error.message, req.body)
    return res.status(500).json({
      success: false,
      error: 'Erro interno do servidor',
      details: error.message
    })
  }
})

// ============================================
// ROTAS DE TESTE
// ============================================
app.post('/test/create-user', async (req, res) => {
  try {
    console.log('🧪 Teste manual de criação de usuário')

    const phone = (req.body.phone || '11999999999').replace(/\D/g, '')
    const name = req.body.name || 'Usuário Teste'
    
    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Telefone inválido' })
    }

    const userData = {
      phone,
      password: req.body.password || 'teste123',
      name,
      email: req.body.email || 'teste@email.com',
      clientId: req.body.clientId || 'client1',
      credits: Number(req.body.credits || 0)
    }

    const result = await createUserInDB(userData)

    if (result.success) {
      if (NOTIFY_NUMBER) {
        const fakeWebhook = {
          event: {
            product: { name: 'Produto Teste' },
            subscription: {
              credits: userData.credits,
              paymentMethod: 'credit_card',
              autoRenew: true
            }
          }
        }
        const message = formatUserCreatedMessage(result.user, fakeWebhook)
        await sendWhatsAppMessage(NOTIFY_NUMBER, message)
      }

      return res.json({
        success: true,
        message: 'Usuário teste criado com sucesso',
        user: result.user
      })
    } else {
      return res.status(400).json(result)
    }
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post('/test/expiring', async (req, res) => {
  try {
    console.log('🧪 Teste manual de assinatura expirando')

    const phone = (req.body.phone || '11999999999').replace(/\D/g, '')
    const name = req.body.name || 'Usuário Teste'
    const daysRemaining = Number(req.body.daysRemaining || 3)
    const autoRenew = req.body.autoRenew !== false
    
    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Telefone inválido' })
    }

    const fakeWebhook = {
      type: 'subscription.expiring',
      event: {
        product: {
          id: 'test-product-id',
          name: 'Produto Teste'
        },
        subscription: {
          id: 'test-subscription-id',
          credits: daysRemaining,
          autoRenew: autoRenew,
          paymentMethod: 'credit_card'
        },
        user: {
          id: 'test-user-id',
          firstName: name.split(' ')[0],
          lastName: name.split(' ').slice(1).join(' '),
          phone: phone,
          email: req.body.email || 'teste@email.com'
        }
      }
    }

    const dbUser = await findUserByPhone(phone)
    
    const userForMessage = dbUser || {
      name: name,
      phone: phone,
      email: req.body.email || 'teste@email.com'
    }

    const expiringMessage = formatExpiringMessage(userForMessage, fakeWebhook)
    await sendWhatsAppMessage(phone, expiringMessage)

    if (NOTIFY_NUMBER) {
      const adminNotification = formatExpiringNotificationAdmin(userForMessage, fakeWebhook)
      await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
    }

    return res.json({
      success: true,
      message: 'Teste de expiração enviado',
      user: {
        name: name,
        phone: phone,
        daysRemaining: daysRemaining,
        autoRenew: autoRenew,
        existsInDB: !!dbUser
      }
    })
  } catch (error) {
    console.error('❌ Erro no teste:', error)
    return res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post('/test/deactivated', async (req, res) => {
  try {
    console.log('🧪 Teste manual de assinatura desativada')

    const phone = (req.body.phone || '11999999999').replace(/\D/g, '')
    const name = req.body.name || 'Usuário Teste'
    
    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Telefone inválido' })
    }

    const fakeWebhook = {
      type: 'subscription.deactivated',
      event: {
        product: {
          id: 'test-product-id',
          name: 'Produto Teste'
        },
        subscription: {
          id: 'test-subscription-id',
          credits: 0,
          status: 'inactive',
          autoRenew: false,
          paymentMethod: 'credit_card',
          inactivatedAt: new Date().toISOString()
        },
        user: {
          id: 'test-user-id',
          firstName: name.split(' ')[0],
          lastName: name.split(' ').slice(1).join(' '),
          phone: phone,
          email: req.body.email || 'teste@email.com'
        }
      }
    }

    const dbUser = await findUserByPhone(phone)
    
    if (dbUser) {
      await deactivateUserInDB(phone)
    }

    const userForMessage = dbUser || {
      name: name,
      phone: phone,
      email: req.body.email || 'teste@email.com'
    }

    const deactivatedMessage = formatDeactivatedMessage(userForMessage, fakeWebhook)
    await sendWhatsAppMessage(phone, deactivatedMessage)

    if (NOTIFY_NUMBER) {
      const adminNotification = formatDeactivatedNotificationAdmin(userForMessage, fakeWebhook)
      await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
    }

    return res.json({
      success: true,
      message: 'Teste de desativação enviado',
      user: {
        name: name,
        phone: phone,
        deactivated: true,
        existsInDB: !!dbUser
      }
    })
  } catch (error) {
    console.error('❌ Erro no teste:', error)
    return res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

app.post('/test/abandoned-checkout', async (req, res) => {
  try {
    console.log('🧪 Teste manual de carrinho abandonado')

    const phone = (req.body.phone || '11999999999').replace(/\D/g, '')
    const fullName = req.body.name || 'João da Silva'
    const email = req.body.email || 'teste@email.com'
    const productName = req.body.productName || 'Assinatura AutoGiro Premium'
    
    if (!/^\d{10,15}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Telefone inválido' })
    }

    const fakeWebhook = {
      type: 'lead.abandoned_checkout',
      event: {
        products: [{
          id: 'test-product-id',
          name: productName,
          offers: [{
            id: 'test-offer-id',
            name: 'Principal'
          }]
        }],
        lead: {
          id: 'test-lead-' + Date.now(),
          fullName: fullName,
          email: email,
          phone: phone,
          session: {
            url: 'https://pay.hub.la/test-checkout-url',
            utm: {
              source: req.body.utmSource || 'whatsapp',
              medium: req.body.utmMedium || 'direct',
              campaign: req.body.utmCampaign || 'recuperacao',
              content: 'teste',
              term: 'teste'
            }
          },
          createdAt: new Date().toISOString()
        }
      },
      version: '2.0.0'
    }

    const lead = fakeWebhook.event.lead
    const products = fakeWebhook.event.products

    const recoveryMessage = formatAbandonedCheckoutMessage(lead, products)
    await sendWhatsAppMessage(phone, recoveryMessage)

    if (NOTIFY_NUMBER) {
      const adminNotification = formatAbandonedCheckoutNotificationAdmin(lead, products, fakeWebhook)
      await sendWhatsAppMessage(NOTIFY_NUMBER, adminNotification)
    }

    return res.json({
      success: true,
      message: 'Teste de carrinho abandonado enviado',
      lead: {
        name: fullName,
        phone: phone,
        email: email,
        product: productName
      }
    })
  } catch (error) {
    console.error('❌ Erro no teste:', error)
    return res.status(500).json({
      success: false,
      error: error.message
    })
  }
})

// ============================================
// INICIALIZAR SERVIDOR
// ============================================
async function start() {
  try {
    console.log('🚀 Inicializando AutoGiro com Baileys...')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    console.log('🔍 Testando conexão com banco...')
    await pool.query('SELECT NOW()')
    console.log('✅ Banco conectado!')

    app.listen(PORT, () => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log(`✅ Servidor na porta ${PORT}`)
      console.log(`📡 Webhook: http://localhost:${PORT}/webhook/hubla`)
      console.log(`🧪 Teste Criação: http://localhost:${PORT}/test/create-user`)
      console.log(`🧪 Teste Expiração: http://localhost:${PORT}/test/expiring`)
      console.log(`🧪 Teste Desativação: http://localhost:${PORT}/test/deactivated`)
      console.log(`🧪 Teste Carrinho: http://localhost:${PORT}/test/abandoned-checkout`)
      console.log(`📊 Status: http://localhost:${PORT}/status`)
      console.log(`🖥️  Dashboard: http://localhost:${PORT}/dashboard`)
      console.log(`📬 Envio em Massa: http://localhost:${PORT}/dashboard (aba Envio em Massa)`)
      console.log(`📞 Notificações: +${NOTIFY_NUMBER}`)
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
      
      initWhatsApp(false).catch(err => {
        console.error('❌ Erro ao iniciar WhatsApp:', err)
        scheduleReconnect(10000)
      })
    })
  } catch (error) {
    console.error('❌ Erro fatal:', error)
    process.exit(1)
  }
}

async function shutdown(signal) {
  console.log(`\n⏹️ Recebido ${signal}, encerrando...`)
  
  try {
    isWhatsappReady = false
    if (sock) {
      sock.end(undefined)
      console.log('🟢 WhatsApp encerrado')
    }
  } catch (e) {
    console.warn('⚠️ Erro ao encerrar WhatsApp:', e?.message)
  }
  
  try {
    await pool.end()
    console.log('🟢 Banco encerrado')
  } catch (e) {
    console.warn('⚠️ Erro ao encerrar banco:', e?.message)
  }
  
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

start()
