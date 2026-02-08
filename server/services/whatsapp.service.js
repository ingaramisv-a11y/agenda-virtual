const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const configuredFromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
const defaultCountryCode = (process.env.DEFAULT_WHATSAPP_COUNTRY_CODE || '57').replace(/[^0-9]/g, '');

const isConfigured = Boolean(accountSid && authToken && configuredFromNumber);
const twilioClient = isConfigured ? twilio(accountSid, authToken) : null;

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

const resolveTemplateSid = async (templateName) => {
  if (!templateName) {
    throw new Error('Debes especificar la plantilla de WhatsApp a enviar.');
  }
  if (templateSidCache.has(templateName)) {
    return templateSidCache.get(templateName);
  }
  if (!twilioClient?.content) {
    throw new Error('El cliente de Twilio no permite consultar plantillas de contenido.');
  }

  const templates = await twilioClient.content.v1.templates.list({ limit: 100 });
  const match = templates.find((template) => {
    const friendlyName = template?.friendlyName?.trim();
    const uniqueName = template?.uniqueName?.trim();
    return friendlyName === templateName || uniqueName === templateName;
  });

  if (!match) {
    throw new Error(`No se encontró la plantilla de WhatsApp "${templateName}" en Twilio.`);
  }

  templateSidCache.set(templateName, match.sid);
  return match.sid;
};

const buildContentVariablesPayload = (variables = []) => {
  return variables.reduce((acc, value, index) => {
    acc[String(index + 1)] = value ?? '';
    return acc;
  }, {});
};

const sendWhatsAppMessage = async (to, templateName, variables = []) => {
  if (!isConfigured) {
    throw new Error('El servicio de WhatsApp (Twilio) no está configurado.');
  }

  const normalized = normalizeToE164(to);
  if (!normalized) {
    throw new Error('No se pudo normalizar el número de WhatsApp proporcionado.');
  }

  const contentSid = await resolveTemplateSid(templateName);
  const toWhatsApp = ensureWhatsAppPrefix(normalized);
  const from = configuredFromNumber.startsWith('whatsapp:')
    ? configuredFromNumber
    : ensureWhatsAppPrefix(configuredFromNumber);

  await twilioClient.messages.create({
    from,
    to: toWhatsApp,
    contentSid,
    contentVariables: JSON.stringify(buildContentVariablesPayload(variables)),
  });
};

module.exports = {
  sendWhatsAppMessage,
  normalizeToE164,
  isWhatsAppConfigured: isConfigured,
};
