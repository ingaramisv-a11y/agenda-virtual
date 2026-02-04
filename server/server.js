const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const webpush = require('web-push');
const db = require('./db');
const {
  createPlan,
  searchPlan,
  listPlans,
  toggleClase,
  deletePlan,
  upsertPushSubscription,
  getPushSubscriptionByPhone,
  deletePushSubscriptionByPhone,
  getPlanById,
  replacePlanClases,
  resetPlanClases,
  ready: databaseReady,
} = db;

const PORT = process.env.PORT || 4000;

const normalizeHttpsUrl = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('https://')) {
    return null;
  }
  return trimmed.replace(/\/$/, '');
};

const sanitizeOriginString = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === '*') {
    return null;
  }
  const normalized = trimmed.replace(/\/$/, '');
  const lower = normalized.toLowerCase();
  const isLocalhost = lower.startsWith('http://localhost') || lower.startsWith('http://127.0.0.1');
  if (isLocalhost) {
    return normalized;
  }
  if (!lower.startsWith('https://')) {
    return null;
  }
  return lower;
};

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL;
const FRONTEND_BASE_URL = normalizeHttpsUrl(process.env.FRONTEND_BASE_URL);
const RAW_ALLOWED_ORIGINS = process.env.APP_ALLOWED_ORIGINS || '';
const RENDER_PRODUCTION_ORIGIN = 'https://agenda-virtual-backend-di4k.onrender.com';

const ALLOWED_ORIGINS = RAW_ALLOWED_ORIGINS.split(',')
  .map(sanitizeOriginString)
  .filter(Boolean);

const ensureAllowedOrigin = (candidate) => {
  const sanitized = sanitizeOriginString(candidate);
  if (sanitized && !ALLOWED_ORIGINS.includes(sanitized)) {
    ALLOWED_ORIGINS.push(sanitized);
  }
};

ensureAllowedOrigin(FRONTEND_BASE_URL);
ensureAllowedOrigin(RENDER_PRODUCTION_ORIGIN);
const hasVapidConfig = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_CONTACT_EMAIL);
const DEFAULT_ACTION_URL = '/firmar-clase';

const buildFrontendUrl = (path = '/', queryParams = {}) => {
  const searchParams = new URLSearchParams();
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      searchParams.append(key, value);
    }
  });
  const relativeUrl = `${path}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;

  if (!FRONTEND_BASE_URL) {
    return relativeUrl;
  }

  try {
    const fullUrl = new URL(relativeUrl, FRONTEND_BASE_URL);
    return fullUrl.toString();
  } catch (_error) {
    return relativeUrl;
  }
};

const buildFrontendPlanUrl = (planId, queryParams = {}) => buildFrontendUrl(planId ? `/plan/${planId}` : '/', queryParams);
const buildFrontendSignatureUrl = (pendingId, planId, claseIndex) =>
  buildFrontendUrl('/firmar-clase', {
    classId: pendingId,
    planId,
    classIndex: typeof claseIndex === 'number' ? claseIndex : undefined,
  });

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

const classSignatureRequests = new Map();

const saveClassSignatureRecord = ({ planId, claseIndex, phone }) => {
  const record = {
    id: crypto.randomUUID(),
    planId,
    claseIndex,
    phone,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  classSignatureRequests.set(record.id, record);
  return record;
};

const getClassSignatureRecord = (pendingId) => classSignatureRequests.get(pendingId);

const deleteClassSignatureRecord = (pendingId) => classSignatureRequests.delete(pendingId);

const deleteClassSignatureRecordsByPlan = (planId) => {
  if (!planId) {
    return 0;
  }
  let removed = 0;
  classSignatureRequests.forEach((record, key) => {
    if (record.planId === planId) {
      classSignatureRequests.delete(key);
      removed += 1;
    }
  });
  return removed;
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

const mutatePlanClase = async (planId, claseIndex, mutator) => {
  const plan = await getPlanById(planId);
  if (!plan || !Array.isArray(plan.clases)) {
    return { plan: null, clase: null };
  }

  const clases = plan.clases.map((clase) => ({ ...clase }));
  const clase = clases[claseIndex];
  if (!clase) {
    return { plan: null, clase: null };
  }

  const mutationResult = mutator(clase, claseIndex, clases, plan);
  if (mutationResult === false) {
    return { plan: null, clase: null };
  }

  clases[claseIndex] = clase;
  const updatedPlan = await replacePlanClases(planId, clases);
  return { plan: updatedPlan, clase: updatedPlan ? updatedPlan.clases[claseIndex] : null };
};

const resolveActionUrl = (explicitUrl) => {
  const trimmed = explicitUrl?.trim();
  if (trimmed) {
    try {
      return new URL(trimmed).toString();
    } catch (_error) {
      if (FRONTEND_BASE_URL) {
        try {
          return new URL(trimmed, FRONTEND_BASE_URL).toString();
        } catch (_innerError) {
          /* noop */
        }
      }
      return trimmed;
    }
  }
  return buildFrontendUrl(DEFAULT_ACTION_URL);
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

const buildClassSignatureNotification = ({ plan, claseIndex, pendingId }) => {
  const clase = plan?.clases?.[claseIndex];
  const claseNumero = clase?.numero ?? claseIndex + 1;
  const planUrl = buildFrontendSignatureUrl(pendingId, plan?.id, claseIndex);
  return buildPushNotificationPayload({
    title: `Confirma la clase #${claseNumero}`,
    body: `${plan?.nombre || 'El estudiante'} está por iniciar su clase. Confirma para firmarla.`,
    tag: `class-signature-${plan?.id || 'plan'}-${claseNumero}`,
    data: {
      type: 'class-signature',
      planId: plan?.id,
      claseIndex,
      claseNumero,
      alumno: plan?.nombre,
      telefono: plan?.telefono,
      pendingId,
      url: planUrl,
    },
    actions: [
      { action: 'accept-class', title: 'Aceptar clase' },
      { action: 'reject-class', title: 'Rechazar clase' },
    ],
  });
};

const sendClassSignatureNotification = async ({ subscriptionRecord, plan, claseIndex, pendingId }) => {
  if (!subscriptionRecord || !subscriptionRecord.subscription) {
    throw new Error('No existe una suscripción push para este acudiente.');
  }
  const payload = buildClassSignatureNotification({ plan, claseIndex, pendingId });
  await webpush.sendNotification(subscriptionRecord.subscription, JSON.stringify(payload));
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(FRONTEND_STATIC_DIR, 'index.html'));
});

app.get('/plan/:planId', (_req, res) => {
  res.sendFile(path.join(FRONTEND_STATIC_DIR, 'index.html'));
});

app.get('/firmar-clase', (_req, res) => {
  res.sendFile(path.join(FRONTEND_STATIC_DIR, 'index.html'));
});

const handlePushPublicKey = (_req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Las notificaciones push no están configuradas.' });
  }
  res.json({ publicKey: VAPID_PUBLIC_KEY });
};

const handlePushSubscription = async (req, res) => {
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
    const existing = await getPushSubscriptionByPhone(digits);
    const stored = await upsertPushSubscription({ phone: digits, subscription });
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

  const subscriptionRecord = await getPushSubscriptionByPhone(digits);
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
      await deletePushSubscriptionByPhone(digits);
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

app.post('/api/planes/pending/:pendingId/decision', async (req, res) => {
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
      const plan = await createPlan(record.payload);
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

app.get('/api/planes', async (req, res) => {
  const { termino } = req.query;
  if (!termino) {
    return res.status(400).json({ error: 'Debes enviar el parámetro "termino".' });
  }

  try {
    const plan = await searchPlan(termino);
    if (!plan) {
      return res.status(404).json({ error: 'No se encontró un plan con los datos proporcionados.' });
    }
    res.json({ data: plan });
  } catch (error) {
    console.error('Error al buscar plan', error);
    res.status(500).json({ error: 'No se pudo realizar la búsqueda.' });
  }
});

app.get('/api/planes/agenda', async (_req, res) => {
  try {
    const planes = await listPlans();
    res.json({ data: planes });
  } catch (error) {
    console.error('Error al obtener el listado de planes', error);
    res.status(500).json({ error: 'No se pudo obtener el listado de planes.' });
  }
});

app.get('/api/planes/:id', async (req, res) => {
  const { id } = req.params;
  const plan = await getPlanById(id);
  if (!plan) {
    return res.status(404).json({ error: 'No se encontró el plan solicitado.' });
  }
  res.json({ data: plan });
});

app.patch('/api/planes/:id/clases/:index', async (req, res) => {
  const { id, index } = req.params;
  const claseIndex = Number(index);
  if (Number.isNaN(claseIndex)) {
    return res.status(400).json({ error: 'El número de clase es inválido.' });
  }

  try {
    const planActualizado = await toggleClase(id, claseIndex);
    if (!planActualizado) {
      return res.status(404).json({ error: 'No se pudo actualizar la clase solicitada.' });
    }
    res.json({ data: planActualizado });
  } catch (error) {
    console.error('Error al actualizar clase', error);
    res.status(500).json({ error: 'No se pudo actualizar la clase.' });
  }
});

app.post('/api/planes/:planId/clases/:index/firma/request', async (req, res) => {
  if (!hasVapidConfig) {
    return res.status(503).json({ error: 'Las notificaciones push no están disponibles.' });
  }

  const { planId, index } = req.params;
  const claseIndex = Number(index);
  if (!planId || Number.isNaN(claseIndex) || claseIndex < 0) {
    return res.status(400).json({ error: 'Debes enviar un identificador y número de clase válidos.' });
  }

  const plan = await getPlanById(planId);
  if (!plan) {
    return res.status(404).json({ error: 'El plan solicitado no existe.' });
  }

  const clase = plan.clases?.[claseIndex];
  if (!clase) {
    return res.status(404).json({ error: 'La clase solicitada no existe en este plan.' });
  }

  if (clase.firmaEstado === 'pendiente' && clase.firmaPendienteId) {
    return res.status(409).json({ error: 'Ya hay una solicitud pendiente para esta clase.' });
  }

  if (clase.firmaEstado === 'firmada') {
    return res.status(409).json({ error: 'Esta clase ya fue firmada por el tutor.' });
  }

  const digits = sanitizeDigits(plan.telefono);
  if (!digits) {
    return res.status(400).json({ error: 'El plan no tiene un número de teléfono válido para notificar al tutor.' });
  }

  const subscriptionRecord = await getPushSubscriptionByPhone(digits);
  if (!subscriptionRecord || !subscriptionRecord.subscription) {
    return res.status(404).json({ error: 'No existe una suscripción push activa para este tutor.' });
  }

  const pendingRecord = saveClassSignatureRecord({ planId, claseIndex, phone: digits });

  const mutation = await mutatePlanClase(planId, claseIndex, (claseRef) => {
    claseRef.firmaEstado = 'pendiente';
    claseRef.firmaPendienteId = pendingRecord.id;
    return claseRef;
  });

  if (!mutation.plan) {
    deleteClassSignatureRecord(pendingRecord.id);
    return res.status(404).json({ error: 'No se pudo preparar la clase solicitada.' });
  }

  try {
    await sendClassSignatureNotification({
      subscriptionRecord,
      plan: mutation.plan,
      claseIndex,
      pendingId: pendingRecord.id,
    });
    return res.status(202).json({ data: { pendingId: pendingRecord.id, plan: mutation.plan } });
  } catch (error) {
    console.error('Error enviando la notificación de firma de clase', error);
    deleteClassSignatureRecord(pendingRecord.id);
    await mutatePlanClase(planId, claseIndex, (claseRef) => {
      if (claseRef.firmaPendienteId === pendingRecord.id) {
        claseRef.firmaEstado = null;
        claseRef.firmaPendienteId = null;
      }
      return claseRef;
    });
    if (error.statusCode === 404 || error.statusCode === 410) {
      await deletePushSubscriptionByPhone(digits);
      return res.status(410).json({ error: 'La suscripción ya no es válida y fue eliminada.' });
    }
    return res.status(502).json({ error: 'No se pudo enviar la notificación al tutor.' });
  }
});

app.post('/api/planes/:planId/clases/:index/firma/decision', async (req, res) => {
  const { planId, index } = req.params;
  const claseIndex = Number(index);
  const { decision, pendingId } = req.body || {};

  if (!planId || Number.isNaN(claseIndex) || claseIndex < 0) {
    return res.status(400).json({ error: 'Debes enviar un identificador y número de clase válidos.' });
  }

  if (!['accept', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'Debes enviar una decisión válida: accept o reject.' });
  }

  if (!pendingId) {
    return res.status(400).json({ error: 'Falta el identificador de la solicitud pendiente.' });
  }

  const record = getClassSignatureRecord(pendingId);
  if (record && (record.planId !== planId || record.claseIndex !== claseIndex)) {
    return res.status(409).json({ error: 'Los datos de la solicitud pendiente no coinciden.' });
  }

  const mutation = await mutatePlanClase(planId, claseIndex, (claseRef) => {
    if (claseRef.firmaPendienteId && claseRef.firmaPendienteId !== pendingId) {
      return false;
    }
    claseRef.firmaPendienteId = null;
    if (decision === 'accept') {
      claseRef.completada = true;
      claseRef.firmaEstado = 'firmada';
    } else {
      claseRef.completada = false;
      claseRef.firmaEstado = 'rechazada';
      claseRef.firmaReintentos = (claseRef.firmaReintentos || 0) + 1;
    }
    return claseRef;
  });

  deleteClassSignatureRecord(pendingId);

  if (!mutation.plan) {
    return res.status(404).json({ error: 'No se pudo actualizar la clase solicitada.' });
  }

  res.json({ data: { plan: mutation.plan, decision } });
});

app.post('/api/planes/:id/renovar', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Debes enviar un identificador de plan válido.' });
  }

  try {
    const updatedPlan = await resetPlanClases(id);
    if (!updatedPlan) {
      return res.status(404).json({ error: 'El plan solicitado no existe.' });
    }
    deleteClassSignatureRecordsByPlan(id);
    return res.json({ data: updatedPlan });
  } catch (error) {
    console.error('Error al renovar plan', error);
    return res.status(500).json({ error: 'No se pudo renovar el plan.' });
  }
});

app.delete('/api/planes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const planEliminado = await deletePlan(id);
    if (!planEliminado) {
      return res.status(404).json({ error: 'El plan solicitado no existe.' });
    }
    res.json({ data: { id: planEliminado.id } });
  } catch (error) {
    console.error('Error al eliminar plan', error);
    res.status(500).json({ error: 'No se pudo eliminar el plan.' });
  }
});


app.get('/api/planes/clases/firma/:pendingId', async (req, res) => {
  const { pendingId } = req.params;
  if (!pendingId) {
    return res.status(400).json({ error: 'Debes enviar el identificador de la solicitud pendiente.' });
  }

  const record = getClassSignatureRecord(pendingId);
  if (!record) {
    return res.status(404).json({ error: 'No se encontró una solicitud pendiente con el identificador proporcionado.' });
  }

  try {
    const plan = await getPlanById(record.planId);
    const clase = plan?.clases?.[record.claseIndex];
    if (!plan || !clase) {
      deleteClassSignatureRecord(pendingId);
      return res.status(404).json({ error: 'No se pudo cargar la clase pendiente solicitada.' });
    }

    return res.json({
      data: {
        pendingId: record.id,
        status: record.status,
        planId: record.planId,
        claseIndex: record.claseIndex,
        claseNumero: clase.numero || record.claseIndex + 1,
        alumno: plan.nombre,
        telefono: plan.telefono,
        tipoPlan: plan.tipoPlan,
        hora: plan.hora,
        dias: plan.dias,
        createdAt: record.createdAt,
      },
    });
  } catch (error) {
    console.error('Error al cargar clase pendiente', error);
    return res.status(500).json({ error: 'No se pudo cargar la clase pendiente solicitada.' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada.' });
});

app.listen(PORT, () => {
  const allowedOriginsDisplay = ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'cualquier origen (sin restricciones)';
  console.log(`Agenda Pro API lista en puerto ${PORT}. Orígenes permitidos: ${allowedOriginsDisplay}`);
});
