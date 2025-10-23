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
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://autogiro_user:yewPi2fnUONvMTf20gWcz4cN2MgiVw7D@dpg-d3ff4gali9vc73f4h0tg-a.oregon-postgres.render.com:5432/fmpcatalogo'
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

function generateRandomPassword() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let password = ''
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return password
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
    browser: ['FMP REPASSES', 'Chrome', '4.0.0'],
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
      console.log(`🌐 ACESSE: http://localhost:${PORT}/qr`)
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
  
  return `🎉 *Bem-vindo(a) ao FMP REPASSES!*

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
🌐 Link da plataforma: https://fmpcatalogo.onrender.com/

1. Acesse o link acima
2. Faça login com seu telefone/email
3. Use a senha temporária acima
4. Altere para uma senha pessoal

Qualquer dúvida, estamos à disposição! 

Aproveite sua assinatura! 🚀

━━━━━━━━━━━━━━━━━━━━
_FMP REPASSES - Obrigado por escolher nossos serviços!_`
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
🌐 Acesse: https://fmpcatalogo.onrender.com/
1. Faça login na plataforma
2. Vá em "Minhas Assinaturas"
3. Clique em "Renovar"`
}

💡 *Precisa de ajuda?*
Entre em contato com nosso suporte.

━━━━━━━━━━━━━━━━━━━━
_FMP REPASSES - Sua satisfação é nossa prioridade!_`
}

function formatDeactivatedMessage(user, webhookData) {
  const subscription = webhookData?.event?.subscription
  const product = webhookData?.event?.product
  
  return `🔴 *Assinatura Expirada*

Olá *${user.name}*,

Sua assinatura do FMP REPASSES expirou e seu acesso foi desativado.

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
🌐 Acesse: https://fmpcatalogo.onrender.com/

1. Faça login com suas credenciais
2. Vá em "Minhas Assinaturas"
3. Clique em "Renovar Assinatura"

✨ Após a renovação, seu acesso será reativado automaticamente!

📞 *Precisa de ajuda?*
Nossa equipe está pronta para ajudar você!

━━━━━━━━━━━━━━━━━━━━
_FMP REPASSES - Esperamos você de volta!_`
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
_FMP REPASSES - Sistema Automatizado_`
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
_FMP REPASSES - Sistema Automatizado_`
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
_FMP REPASSES - Sistema Automatizado_`
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
_FMP REPASSES - Sistema Automatizado_`
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

// ============================================
// ROTAS
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'FMP REPASSES - Servidor Webhook',
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
            <h1>📱 FMP REPASSES - WhatsApp QR Code</h1>
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
    service: 'FMP REPASSES',
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
// INICIALIZAR SERVIDOR
// ============================================
async function start() {
  try {
    console.log('🚀 Inicializando FMP REPASSES...')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

    console.log('🔍 Testando conexão com banco...')
    await pool.query('SELECT NOW()')
    console.log('✅ Banco conectado!')

    app.listen(PORT, () => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log(`✅ Servidor na porta ${PORT}`)
      console.log(`📡 Webhook: http://localhost:${PORT}/webhook/hubla`)
      console.log(`📊 Status: http://localhost:${PORT}/status`)
      console.log(`💚 Health: http://localhost:${PORT}/health`)
      console.log(`📱 QR Code: http://localhost:${PORT}/qr`)
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
