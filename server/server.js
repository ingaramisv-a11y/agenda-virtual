const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { sendWhatsAppMessage, normalizeToE164, isWhatsAppConfigured } = require('./services/whatsapp.service');
const db = require('./db');
const {
  createPlan,
  searchPlan,
  searchPlans,
  listPlans,
  toggleClase,
  deletePlan,
  upsertPushSubscription,
  getPushSubscriptionByPhone,
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
const hasWhatsAppConfig = Boolean(isWhatsAppConfigured);
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

if (!hasWhatsAppConfig) {
  console.warn('El servicio de WhatsApp (Twilio) no está completamente configurado.');
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

const DEFAULT_TUTOR_NAME = process.env.DEFAULT_TUTOR_NAME || 'Profe Diana';

const formatDaysLabel = (dias = []) => {
  if (!Array.isArray(dias) || !dias.length) {
    return 'Horario por confirmar';
  }
  return dias
    .map((dia) => {
      if (!dia) {
        return '';
      }
      const normalized = `${dia}`.trim();
      if (!normalized) {
        return '';
      }
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .filter(Boolean)
    .join(' · ');
};

const formatScheduleSummary = (planLike = {}) => {
  const daysLabel = formatDaysLabel(planLike.dias);
  if (planLike.hora) {
    return `${daysLabel} · ${planLike.hora}`;
  }
  return daysLabel;
};

const buildPlanConfirmationUrl = (pendingId, candidateUrl) => {
  const explicit = resolveActionUrl(candidateUrl);
  if (explicit) {
    return explicit;
  }
  if (!pendingId) {
    return null;
  }
  return buildFrontendUrl('/', { pending: pendingId });
};

const sendPlanApprovalTemplate = async ({ contactRecord, planPayload, confirmationUrl }) => {
  if (!contactRecord || !contactRecord.whatsappOptIn) {
    throw new Error('No existe un contacto de WhatsApp activo para este tutor.');
  }
  if (!planPayload) {
    throw new Error('No se encontró la información del plan para preparar la notificación.');
  }

  const destination = contactRecord.normalizedPhone || contactRecord.phone;
  const planTypeLabel = planPayload.tipoPlan ? `${planPayload.tipoPlan} clases` : 'Plan personalizado';
  const variables = [
    planPayload.acudiente || 'Acudiente',
    planPayload.nombre || 'Alumno',
    DEFAULT_TUTOR_NAME,
    planTypeLabel,
    formatScheduleSummary(planPayload),
    confirmationUrl || buildFrontendUrl('/'),
  ];

  // Template "plan_approval" recoge los detalles del plan y el enlace de confirmación.
  await sendWhatsAppMessage(destination, 'plan_approval', variables);
};

const buildClassTimingLabel = (plan, claseIndex) => {
  const clase = plan?.clases?.[claseIndex];
  const claseNumero = clase?.numero ?? claseIndex + 1;
  const schedule = formatScheduleSummary(plan);
  return `Clase #${claseNumero} · ${schedule}`;
};

const sendClassSignatureTemplate = async ({ contactRecord, plan, claseIndex, pendingId }) => {
  if (!contactRecord || !contactRecord.whatsappOptIn) {
    throw new Error('No existe un contacto de WhatsApp activo para este tutor.');
  }
  if (!plan) {
    throw new Error('No se encontró la información del plan para solicitar la firma.');
  }

  const destination = contactRecord.normalizedPhone || contactRecord.phone || plan.telefono;
  const signatureLink = buildFrontendSignatureUrl(pendingId, plan.id, claseIndex);
  const variables = [
    plan.acudiente || 'Acudiente',
    plan.nombre || 'Alumno',
    DEFAULT_TUTOR_NAME,
    buildClassTimingLabel(plan, claseIndex),
    signatureLink,
  ];

  // Template "class_signature_request" se envía antes de iniciar la clase para capturar la firma.
  await sendWhatsAppMessage(destination, 'class_signature_request', variables);
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
  res.json({ message: 'Las notificaciones ahora se envían vía WhatsApp.' });
};

const handlePushSubscription = async (req, res) => {
  if (!hasWhatsAppConfig) {
    return res.status(503).json({ error: 'El servicio de WhatsApp no está disponible.' });
  }

  const { phone, whatsappOptIn = true } = req.body || {};
  const normalized = normalizeToE164(phone);
  const digits = sanitizeDigits(phone);
  if (!normalized || !digits) {
    return res.status(400).json({ error: 'Debes enviar un número de teléfono válido.' });
  }

  try {
    const existing = await getPushSubscriptionByPhone(normalized);
    const stored = await upsertPushSubscription({ phone: normalized, whatsappOptIn });
    if (!stored) {
      return res.status(500).json({ error: 'No se pudo guardar el contacto de WhatsApp.' });
    }
    const statusCode = existing ? 200 : 201;
    const message = existing
      ? 'Contacto de WhatsApp actualizado correctamente.'
      : 'Contacto de WhatsApp registrado correctamente.';
    res.status(statusCode).json({ message, data: { phone: stored.phone } });
  } catch (error) {
    console.error('Error guardando el contacto de WhatsApp', error);
    res.status(500).json({ error: 'No se pudo guardar el contacto de WhatsApp.' });
  }
};

const handlePushSend = async (req, res) => {
  if (!hasWhatsAppConfig) {
    return res.status(503).json({ error: 'El servicio de WhatsApp no está disponible.' });
  }

  const { phone, notification = {} } = req.body || {};
  const normalized = normalizeToE164(phone);
  if (!normalized) {
    return res.status(400).json({ error: 'Debes enviar un número de teléfono válido.' });
  }

  const contactRecord = await getPushSubscriptionByPhone(normalized);
  if (!contactRecord || !contactRecord.whatsappOptIn) {
    return res.status(404).json({ error: 'No existe un contacto de WhatsApp activo para este número.' });
  }
  const notificationData = notification.data || {};
  const pendingId = notification.pendingId || notificationData.pendingId;
  if (!pendingId) {
    return res.status(400).json({ error: 'Falta el identificador del plan pendiente.' });
  }

  const pendingRecord = getPendingPlanRecord(pendingId);
  if (!pendingRecord) {
    return res.status(404).json({ error: 'No existe una solicitud pendiente con el identificador proporcionado.' });
  }

  const confirmationUrl = buildPlanConfirmationUrl(pendingId, notificationData.url || notificationData.link);

  try {
    await sendPlanApprovalTemplate({
      contactRecord,
      planPayload: pendingRecord.payload,
      confirmationUrl,
    });
    res.json({ message: 'Notificación de aprobación enviada correctamente por WhatsApp.' });
  } catch (error) {
    console.error('Error enviando la notificación de aprobación de plan', error);
    res.status(502).json({ error: 'No se pudo enviar la notificación de WhatsApp.' });
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
    const planes = await searchPlans(termino);
    if (!planes.length) {
      return res.status(404).json({ error: 'No se encontró un plan con los datos proporcionados.' });
    }
    res.json({ data: planes });
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
  if (!hasWhatsAppConfig) {
    return res.status(503).json({ error: 'Las notificaciones de WhatsApp no están disponibles.' });
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
  if (!subscriptionRecord || !subscriptionRecord.whatsappOptIn) {
    return res.status(404).json({ error: 'El tutor aún no ha registrado un número de WhatsApp válido.' });
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
    await sendClassSignatureTemplate({
      contactRecord: subscriptionRecord,
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
