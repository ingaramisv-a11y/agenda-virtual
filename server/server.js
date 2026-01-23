const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const webpush = require('web-push');
const {
  createPlan,
  searchPlan,
  toggleClase,
  deletePlan,
  upsertParentContact,
  getContactByPhone,
  savePendingPlan,
  attachMessageToPending,
  getLatestPendingByChat,
  markPendingAsConfirmed,
  markPendingAsRejected,
  removePendingPlan,
  upsertPushSubscription,
  getPushSubscriptionByPhone,
  deletePushSubscriptionByPhone,
} = require('./db');

const PORT = process.env.PORT || 4000;
const TELEGRAM_BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API_BASE = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : null;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL;
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || '';
const RAW_ALLOWED_ORIGINS = process.env.APP_ALLOWED_ORIGINS || '';
const ALLOWED_ORIGINS = RAW_ALLOWED_ORIGINS.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const hasVapidConfig = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_CONTACT_EMAIL);

if (hasVapidConfig) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID keys no configuradas. Las notificaciones push no estarán disponibles.');
}

const app = express();

const isOriginAllowed = (origin) => {
  if (!ALLOWED_ORIGINS.length || !origin) {
    return true;
  }
  return ALLOWED_ORIGINS.some((allowed) => {
    if (allowed === '*') {
      return true;
    }
    return allowed === origin;
  });
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

const confirmationKeyboard = {
  keyboard: [[{ text: 'SI' }, { text: 'NO' }]],
  one_time_keyboard: true,
  resize_keyboard: true,
};

const sanitizeDigits = (value = '') => value.replace(/[^0-9]/g, '');
const isValidPushSubscription = (candidate) => {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  if (typeof candidate.endpoint !== 'string' || !candidate.endpoint.trim()) {
    return false;
  }
  if (candidate.keys && typeof candidate.keys === 'object') {
    const { p256dh, auth } = candidate.keys;
    if (typeof p256dh !== 'string' || typeof auth !== 'string') {
      return false;
    }
  }
  return true;
};

const resolveActionUrl = (explicitUrl) => {
  const trimmed = explicitUrl?.trim();
  if (trimmed) {
    return trimmed;
  }
  const frontendUrl = FRONTEND_BASE_URL?.trim();
  if (frontendUrl) {
    return frontendUrl;
  }
  return '/';
};

const buildPushNotificationPayload = ({ title, body, data = {}, tag, icon, badge } = {}) => {
  const payloadData = {
    ...data,
    url: resolveActionUrl(data.url),
  };

  return {
    title: title || 'Agenda Pro',
    body: body || 'Tienes una solicitud pendiente por confirmar.',
    tag: tag || 'agenda-pro-plan',
    icon,
    badge,
    data: payloadData,
    requireInteraction: true,
    actions: [
      { action: 'accept-plan', title: 'Aceptar plan' },
      { action: 'reject-plan', title: 'Rechazar plan' },
    ],
  };
};

const ensureBotConfigured = () => {
  if (!TELEGRAM_API_BASE) {
    throw new Error('El BOT_TOKEN no está configurado en el servidor.');
  }
};

const buildConfirmationMessage = (plan) => {
  const dias = Array.isArray(plan.dias) && plan.dias.length ? plan.dias.join(', ') : 'sin días asignados';
  return [
    'Hola 👋',
    `Alumno: *${plan.nombre}*`,
    `Plan seleccionado: *${plan.tipoPlan} clases*`,
    `Horario: ${dias} · ${plan.hora}`,
    '',
    'Responde *SI* para confirmar o *NO* para rechazar.',
  ].join('\n');
};

const sendTelegramMessage = async (chatId, text, extraPayload = {}) => {
  ensureBotConfigured();
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...extraPayload,
  };
  const { data } = await axios.post(`${TELEGRAM_API_BASE}/sendMessage`, payload);
  if (!data?.ok) {
    throw new Error(data?.description || 'Error desconocido al contactar Telegram');
  }
  return data.result;
};

if (!TELEGRAM_API_BASE) {
  console.warn('BOT_TOKEN no configurado. El flujo de confirmación por Telegram no estará disponible.');
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const handlePushPublicKey = (_req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Las notificaciones push no están configuradas.' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
};

const handlePushSubscription = (req, res) => {
  if (!hasVapidConfig) {
    return res.status(503).json({ error: 'Las notificaciones push no están disponibles.' });
  }

  const { phone, subscription } = req.body || {};
  const digits = sanitizeDigits(phone);
  if (!digits) {
    return res.status(400).json({ error: 'Debes enviar un número de teléfono válido.' });
  }

  if (!isValidPushSubscription(subscription)) {
    return res.status(400).json({ error: 'La suscripción enviada no es válida.' });
  }

  try {
    const existing = getPushSubscriptionByPhone(digits);
    const stored = upsertPushSubscription({ phone: digits, subscription });
    if (!stored) {
      return res.status(500).json({ error: 'No se pudo guardar la suscripción.' });
    }
    const statusCode = existing ? 200 : 201;
    const message = existing
      ? 'Suscripción actualizada correctamente.'
      : 'Suscripción registrada correctamente.';
    res.status(statusCode).json({ message, data: { phone: stored.phone } });
  } catch (error) {
    console.error('Error guardando la suscripción push', error);
    res.status(500).json({ error: 'No se pudo guardar la suscripción push.' });
  }
};

const handlePushSend = async (req, res) => {
  if (!hasVapidConfig) {
    return res.status(503).json({ error: 'Las notificaciones push no están disponibles.' });
  }

  const { phone, notification = {} } = req.body || {};
  const digits = sanitizeDigits(phone);
  if (!digits) {
    return res.status(400).json({ error: 'Debes enviar un número de teléfono válido.' });
  }

  const subscriptionRecord = getPushSubscriptionByPhone(digits);
  if (!subscriptionRecord || !subscriptionRecord.subscription) {
    return res.status(404).json({ error: 'No existe una suscripción push activa para este número.' });
  }

  const payload = buildPushNotificationPayload({
    ...notification,
    data: {
      phone: digits,
      pendingId: notification.pendingId || notification.data?.pendingId,
      ...notification.data,
    },
  });

  try {
    await webpush.sendNotification(subscriptionRecord.subscription, JSON.stringify(payload));
    res.json({ message: 'Notificación enviada correctamente.' });
  } catch (error) {
    console.error('Error enviando la notificación push', error);
    if (error.statusCode === 404 || error.statusCode === 410) {
      deletePushSubscriptionByPhone(digits);
      return res.status(410).json({ error: 'La suscripción ya no es válida y fue eliminada.' });
    }
    res.status(502).json({ error: 'No se pudo enviar la notificación push.' });
  }
};

['/api/push/public-key', '/push/public-key'].forEach((path) => {
  app.get(path, handlePushPublicKey);
});

['/api/push/subscriptions', '/push/subscriptions'].forEach((path) => {
  app.post(path, handlePushSubscription);
});

['/api/push/send', '/push/send'].forEach((path) => {
  app.post(path, handlePushSend);
});

const validatePlanPayload = (body) => {
  const requiredFields = ['nombre', 'edad', 'acudiente', 'telefono', 'tipoPlan', 'dias', 'hora', 'clases'];
  for (const field of requiredFields) {
    if (body[field] === undefined || body[field] === null) {
      return `El campo "${field}" es obligatorio.`;
    }
  }
  if (!Array.isArray(body.dias) || !body.dias.length) {
    return 'Debes proporcionar al menos un día en el horario.';
  }
  if (!Array.isArray(body.clases) || !body.clases.length) {
    return 'Debes definir las clases asociadas al plan.';
  }
  return null;
};

app.post('/api/planes/pending', async (req, res) => {
  const validationError = validatePlanPayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  if (!TELEGRAM_API_BASE) {
    return res.status(503).json({ error: 'El BOT_TOKEN no está configurado en el servidor.' });
  }

  const telefonoOriginal = req.body.telefono;
  const contacto = getContactByPhone(telefonoOriginal);
  if (!contacto) {
    return res.status(409).json({
      error:
        'El acudiente aún no ha registrado su chat en Telegram. Pídale que envíe "REGISTRAR <su teléfono>" al bot para habilitar las confirmaciones.',
    });
  }

  const pendingActual = getLatestPendingByChat(contacto.chatId);
  if (pendingActual && pendingActual.status === 'pending') {
    return res.status(409).json({ error: 'Ya existe una confirmación pendiente para este acudiente.' });
  }

  const planPayload = {
    id: crypto.randomUUID(),
    nombre: req.body.nombre,
    edad: Number(req.body.edad) || null,
    acudiente: req.body.acudiente,
    telefono: telefonoOriginal,
    tipoPlan: Number(req.body.tipoPlan),
    dias: req.body.dias,
    hora: req.body.hora,
    clases: req.body.clases,
  };

  const pendingId = crypto.randomUUID();
  const pendingRecord = savePendingPlan({
    id: pendingId,
    telefono: telefonoOriginal,
    chatId: contacto.chatId,
    payload: planPayload,
  });

  if (!pendingRecord) {
    return res.status(400).json({ error: 'No se pudo preparar la solicitud de confirmación.' });
  }

  try {
    const telegramMessage = await sendTelegramMessage(contacto.chatId, buildConfirmationMessage(planPayload), {
      reply_markup: confirmationKeyboard,
    });
    if (telegramMessage?.message_id) {
      attachMessageToPending(pendingId, telegramMessage.message_id);
    }
    res.status(202).json({ data: { pendingId, status: 'waiting-confirmation' } });
  } catch (error) {
    console.error('Error enviando confirmación a Telegram', error?.response?.data || error.message);
    removePendingPlan(pendingId);
    res.status(502).json({ error: 'No se pudo enviar la confirmación por Telegram.' });
  }
});

app.post('/api/planes', (_req, res) => {
  res.status(410).json({ error: 'Esta ruta fue reemplazada por /api/planes/pending.' });
});

app.get('/api/planes', (req, res) => {
  const { termino } = req.query;
  if (!termino) {
    return res.status(400).json({ error: 'Debes enviar el parámetro "termino".' });
  }

  try {
    const plan = searchPlan(termino);
    if (!plan) {
      return res.status(404).json({ error: 'No se encontró un plan con los datos proporcionados.' });
    }
    res.json({ data: plan });
  } catch (error) {
    console.error('Error al buscar plan', error);
    res.status(500).json({ error: 'No se pudo realizar la búsqueda.' });
  }
});

app.patch('/api/planes/:id/clases/:index', (req, res) => {
  const { id, index } = req.params;
  const claseIndex = Number(index);
  if (Number.isNaN(claseIndex)) {
    return res.status(400).json({ error: 'El número de clase es inválido.' });
  }

  try {
    const planActualizado = toggleClase(id, claseIndex);
    if (!planActualizado) {
      return res.status(404).json({ error: 'No se pudo actualizar la clase solicitada.' });
    }
    res.json({ data: planActualizado });
  } catch (error) {
    console.error('Error al actualizar clase', error);
    res.status(500).json({ error: 'No se pudo actualizar la clase.' });
  }
});

app.delete('/api/planes/:id', (req, res) => {
  const { id } = req.params;
  try {
    const planEliminado = deletePlan(id);
    if (!planEliminado) {
      return res.status(404).json({ error: 'El plan solicitado no existe.' });
    }
    res.json({ data: { id: planEliminado.id } });
  } catch (error) {
    console.error('Error al eliminar plan', error);
    res.status(500).json({ error: 'No se pudo eliminar el plan.' });
  }
});

app.post('/webhooks/telegram', async (req, res) => {
  res.sendStatus(200);
  if (!TELEGRAM_API_BASE) {
    return;
  }

  try {
    await handleTelegramUpdate(req.body);
  } catch (error) {
    console.error('Error procesando actualización de Telegram', error);
  }
});

const handleTelegramUpdate = async (update) => {
  const message = update.message || update.edited_message;
  if (!message || !message.text) {
    return;
  }

  const chatId = String(message.chat.id);
  const text = message.text.trim();

  if (/^\/start/i.test(text)) {
    await sendTelegramMessage(
      chatId,
      'Hola, soy la agenda de Profe Diana. Escribe *REGISTRAR <tu teléfono>* para enlazarte y luego responde SI o NO cuando recibas nuevas solicitudes.'
    );
    return;
  }

  const registrarMatch = text.match(/^(?:\/)?(?:registrar|registro)\s+(\+?\d[\d\s-]+)/i);
  if (registrarMatch) {
    await handleRegisterCommand(chatId, registrarMatch[1]);
    return;
  }

  const normalized = text.toUpperCase();
  if (normalized === 'SI') {
    await confirmPendingPlanForChat(chatId);
    return;
  }

  if (normalized === 'NO') {
    await rejectPendingPlanForChat(chatId);
    return;
  }

  await sendTelegramMessage(
    chatId,
    'No entendí tu mensaje. Usa *REGISTRAR <tu teléfono>* para vincularte o responde *SI* / *NO* a las solicitudes.'
  );
};

const handleRegisterCommand = async (chatId, telefonoTexto) => {
  const telefono = sanitizeDigits(telefonoTexto);
  if (!telefono) {
    await sendTelegramMessage(chatId, 'No pude leer tu número. Escríbelo así: REGISTRAR 3001234567');
    return;
  }

  const contacto = upsertParentContact(telefono, chatId);
  if (contacto) {
    await sendTelegramMessage(
      chatId,
      `Perfecto. Guardé el número ${telefono}. Cuando Profe Diana registre un plan, podrás responder *SI* para confirmarlo.`
    );
  }
};

const confirmPendingPlanForChat = async (chatId) => {
  const pending = getLatestPendingByChat(chatId);
  if (!pending) {
    await sendTelegramMessage(chatId, 'No tienes solicitudes pendientes en este momento.');
    return;
  }

  if (pending.status !== 'pending') {
    await sendTelegramMessage(chatId, 'Ya procesamos la última solicitud. Espera a que te enviemos una nueva.');
    return;
  }

  try {
    const planConfirmado = createPlan(pending.payload);
    markPendingAsConfirmed(pending.id, planConfirmado.id);
    await sendTelegramMessage(
      chatId,
      `¡Gracias! Confirmamos el plan de ${planConfirmado.nombre}. Nos vemos en la piscina 🏊`
    );
  } catch (error) {
    console.error('Error confirmando plan', error);
    await sendTelegramMessage(chatId, 'No pude guardar el plan. Intenta responder de nuevo en unos minutos.');
  }
};

const rejectPendingPlanForChat = async (chatId) => {
  const pending = getLatestPendingByChat(chatId);
  if (!pending) {
    await sendTelegramMessage(chatId, 'No tengo solicitudes activas para este chat.');
    return;
  }

  if (pending.status !== 'pending') {
    await sendTelegramMessage(chatId, 'Ya registramos tu respuesta anterior para esta solicitud.');
    return;
  }

  markPendingAsRejected(pending.id);
  await sendTelegramMessage(chatId, 'Perfecto, notificaremos a Profe Diana que no deseas continuar con este plan.');
};

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

app.listen(PORT, () => {
  console.log(`Agenda Pro API escuchando en http://localhost:${PORT}`);
});
