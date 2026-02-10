const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const configuredFromNumber = (process.env.TWILIO_WHATSAPP_FROM || process.env.TWILIO_WHATSAPP_NUMBER || '').trim();
const defaultCountryCode = (process.env.DEFAULT_WHATSAPP_COUNTRY_CODE || '57').replace(/[^0-9]/g, '');

const missingCreds = !accountSid || !authToken;
const isConfigured = Boolean(!missingCreds && configuredFromNumber);
const twilioClient = !missingCreds ? twilio(accountSid, authToken) : null;

const TEMPLATE_KEYS = {
  PLAN_APPROVAL: 'PLAN_APPROVAL',
  CLASS_SIGNATURE: 'CLASS_SIGNATURE',
};

// Templates must stay aligned with the WhatsApp Content templates approved in Twilio Content API.
// Add or adjust entries here (envKey + slots) whenever a template is updated in Twilio to keep render variables in sync.
const TEMPLATE_DEFINITIONS = {
  [TEMPLATE_KEYS.PLAN_APPROVAL]: {
    friendlyName: 'plan_approval',
    envKey: 'TWILIO_TEMPLATE_PLAN_APPROVAL_SID',
    slots: ['guardianName', 'studentName', 'tutorName', 'planLabel', 'scheduleLabel', 'confirmationUrl'],
    description: 'Notifica al tutor que un plan de clases requiere su aprobación.',
  },
  [TEMPLATE_KEYS.CLASS_SIGNATURE]: {
    friendlyName: 'class_signature_request',
    envKey: 'TWILIO_TEMPLATE_CLASS_SIGNATURE_SID',
    slots: ['guardianName', 'studentName', 'tutorName', 'classLabel', 'signatureUrl'],
    description: 'Solicita la confirmación/firma previa a iniciar cada clase.',
  },
};

const ensureTwilioClient = () => {
  if (missingCreds) {
    throw new Error('TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN son obligatorios para enviar mensajes de WhatsApp.');
  }
  if (!configuredFromNumber) {
    throw new Error('TWILIO_WHATSAPP_FROM es obligatorio para enviar mensajes de WhatsApp.');
  }
  if (!twilioClient) {
    throw new Error('No se pudo inicializar el cliente de Twilio.');
  }
  return twilioClient;
};

const normalizeToE164 = (value) => {
  if (!value) {
    return null;
  }
  const raw = `${value}`.trim();
  if (!raw) {
    return null;
  }

  if (raw.startsWith('+')) {
    const digits = raw.replace(/[^0-9]/g, '');
    return digits ? `+${digits}` : null;
  }

  let digits = raw.replace(/[^0-9]/g, '');
  if (!digits) {
    return null;
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.length > 11) {
    return `+${digits}`;
  }

  const country = defaultCountryCode || '';
  if (!country) {
    return null;
  }

  return `+${country}${digits}`;
};

const ensureWhatsAppPrefix = (value) => {
  if (!value) {
    return null;
  }
  if (value.startsWith('whatsapp:')) {
    return value;
  }
  return `whatsapp:${value}`;
};

const templateSidCache = new Map();

const looksLikeContentSid = (value = '') => /^HX[a-f0-9]{32}$/i.test(value);

const resolveTemplateDefinition = (templateKey) => {
  const def = TEMPLATE_DEFINITIONS[templateKey];
  if (!def) {
    throw new Error(`No existe una definición registrada para la plantilla "${templateKey}".`);
  }
  return def;
};

const resolveTemplateSid = (templateDef) => {
  if (templateSidCache.has(templateDef.envKey)) {
    return templateSidCache.get(templateDef.envKey);
  }

  const envValue = process.env[templateDef.envKey]?.trim();
  if (!envValue) {
    throw new Error(`Configura ${templateDef.envKey} con el SID aprobado en Twilio Content para "${templateDef.friendlyName}".`);
  }
  if (!looksLikeContentSid(envValue)) {
    throw new Error(`El valor definido en ${templateDef.envKey} no parece un SID válido de Twilio Content.`);
  }

  templateSidCache.set(templateDef.envKey, envValue);
  return envValue;
};

const buildOrderedVariables = (templateDef, providedVariables = {}) => {
  return templateDef.slots.map((slotName) => {
    const candidate = providedVariables[slotName];
    if (candidate === undefined || candidate === null) {
      throw new Error(`Falta el valor obligatorio "${slotName}" para la plantilla "${templateDef.friendlyName}".`);
    }
    const normalized = `${candidate}`.trim();
    if (!normalized) {
      throw new Error(`El valor "${slotName}" no puede estar vacío para la plantilla "${templateDef.friendlyName}".`);
    }
    return normalized;
  });
};

const buildContentVariablesPayload = (variables = []) => {
  return variables.reduce((acc, value, index) => {
    acc[String(index + 1)] = value ?? '';
    return acc;
  }, {});
};

const sendWhatsAppTemplate = async ({ to, templateKey, variables = {} }) => {
  const client = ensureTwilioClient();
  const templateDef = resolveTemplateDefinition(templateKey);

  const normalized = normalizeToE164(to);
  if (!normalized) {
    throw new Error('No se pudo normalizar el número de WhatsApp proporcionado.');
  }

  const orderedVariables = buildOrderedVariables(templateDef, variables);
  const contentSid = resolveTemplateSid(templateDef);
  const toWhatsApp = ensureWhatsAppPrefix(normalized);
  const from = configuredFromNumber.startsWith('whatsapp:')
    ? configuredFromNumber
    : ensureWhatsAppPrefix(configuredFromNumber);

  // Twilio Content templates require messages.create with SID + JSON variables to avoid render errors.
  await client.messages.create({
    from,
    to: toWhatsApp,
    contentSid,
    contentVariables: JSON.stringify(buildContentVariablesPayload(orderedVariables)),
  });
};

module.exports = {
  sendWhatsAppTemplate,
  normalizeToE164,
  isWhatsAppConfigured: isConfigured,
  TEMPLATE_KEYS,
};
