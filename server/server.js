const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const webpush = require('web-push');
const {
  createPlan,
  searchPlan,
  toggleClase,
  deletePlan,
  upsertPushSubscription,
  getPushSubscriptionByPhone,
  deletePushSubscriptionByPhone,
} = require('./db');

const PORT = process.env.PORT || 4000;
const DEFAULT_PUBLIC_BASE_URL = 'https://inalienably-disordered-bart.ngrok-free.dev';

const normalizeHttpsUrl = (value, fallback = DEFAULT_PUBLIC_BASE_URL) => {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('https://')) {
    return fallback;
  }
  return trimmed.replace(/\/$/, '');
};

const sanitizeOriginString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === '*') {
    return null;
  }
  if (trimmed.includes('localhost')) {
    return null;
  }
  if (!trimmed.startsWith('https://')) {
    return null;
  }
  return trimmed.replace(/\/$/, '');
};

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL;
const FRONTEND_BASE_URL = normalizeHttpsUrl(process.env.FRONTEND_BASE_URL);
const RAW_ALLOWED_ORIGINS = process.env.APP_ALLOWED_ORIGINS || FRONTEND_BASE_URL;
const ALLOWED_ORIGINS = RAW_ALLOWED_ORIGINS.split(',')
  .map(sanitizeOriginString)
  .filter(Boolean);
const hasVapidConfig = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_CONTACT_EMAIL);

if (hasVapidConfig) {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('VAPID keys no configuradas. Las notificaciones push continuarán deshabilitadas.');
}

const app = express();
const FRONTEND_STATIC_DIR = path.resolve(__dirname, '..');

const isOriginAllowed = (origin) => {
  if (!ALLOWED_ORIGINS.length) {
    return true;
  }

  // Allow undefined/null origins (e.g., same-origin navigation, service worker fetches)
  if (origin === undefined || origin === null) {
    return true;
  }

  const normalizedOrigin = sanitizeOriginString(origin);
  if (!normalizedOrigin) {
    return false;
  }
  return ALLOWED_ORIGINS.includes(normalizedOrigin);
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      const displayOrigin = origin ?? 'undefined';
      callback(new Error(`Origin ${displayOrigin} is not allowed by CORS`));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(FRONTEND_STATIC_DIR));

const pendingPlans = new Map();

const savePendingPlanRecord = (payload) => {
  const pendingId = payload.id || crypto.randomUUID();
  const record = {
    id: pendingId,
    status: 'pending',
    payload,
    createdAt: new Date().toISOString(),
  };
  pendingPlans.set(pendingId, record);
  return record;
};

const getPendingPlanRecord = (pendingId) => pendingPlans.get(pendingId);

const deletePendingPlanRecord = (pendingId) => pendingPlans.delete(pendingId);

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
  return FRONTEND_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
};

const buildPushNotificationPayload = ({ title, body, data = {}, tag, icon, badge } = {}) => {
  const payloadData = typeof data === 'object' && data !== null ? { ...data } : {};
  payloadData.url = resolveActionUrl(payloadData.url);

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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(FRONTEND_STATIC_DIR, 'index.html'));
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

app.post('/api/planes/pending', (req, res) => {
  const validationError = validatePlanPayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const planPayload = {
    id: crypto.randomUUID(),
    nombre: req.body.nombre,
    edad: Number(req.body.edad) || null,
    acudiente: req.body.acudiente,
    telefono: req.body.telefono,
    tipoPlan: Number(req.body.tipoPlan),
    dias: req.body.dias,
    hora: req.body.hora,
    clases: req.body.clases,
  };

  const pendingRecord = savePendingPlanRecord(planPayload);
  res.status(202).json({ data: { pendingId: pendingRecord.id, status: pendingRecord.status } });
});

app.get('/api/planes/pending/:pendingId', (req, res) => {
  const { pendingId } = req.params;
  const record = getPendingPlanRecord(pendingId);
  if (!record) {
    return res.status(404).json({ error: 'No existe una solicitud pendiente con el identificador proporcionado.' });
  }
  res.json({
    data: {
      pendingId: record.id,
      status: record.status,
      payload: record.payload,
      createdAt: record.createdAt,
      resolvedAt: record.resolvedAt || null,
    },
  });
});

app.post('/api/planes/pending/:pendingId/decision', (req, res) => {
  const { pendingId } = req.params;
  const { decision } = req.body || {};
  if (!['accept', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Debes enviar una decisión válida: accept o reject.' });
  }

  const record = getPendingPlanRecord(pendingId);
  if (!record) {
    return res.status(404).json({ error: 'No existe una solicitud pendiente con el identificador proporcionado.' });
  }
  if (record.status !== 'pending') {
    return res.status(409).json({ error: 'Esta solicitud ya fue resuelta.' });
  }

  const resolveRecord = (status, extra = {}) => {
    record.status = status;
    record.resolvedAt = new Date().toISOString();
    deletePendingPlanRecord(pendingId);
    return res.json({ data: { pendingId: record.id, status: record.status, ...extra } });
  };

  if (decision === 'accept') {
    try {
      const plan = createPlan(record.payload);
      return resolveRecord('accepted', { plan });
    } catch (error) {
      console.error('Error al confirmar el plan pendiente', error);
      return res.status(500).json({ error: 'No se pudo confirmar el plan pendiente.' });
    }
  }

  return resolveRecord('rejected');
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


app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

app.listen(PORT, () => {
  const publicBase = FRONTEND_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  console.log(`Agenda Pro API lista en puerto ${PORT}. Origen permitido: ${publicBase}`);
});
