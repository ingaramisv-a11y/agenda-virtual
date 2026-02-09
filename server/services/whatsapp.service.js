const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const configuredFromNumber = process.env.TWILIO_WHATSAPP_NUMBER;
const defaultCountryCode = (process.env.DEFAULT_WHATSAPP_COUNTRY_CODE || '57').replace(/[^0-9]/g, '');

const missingCreds = !accountSid || !authToken;
const isConfigured = Boolean(!missingCreds && configuredFromNumber);
const twilioClient = !missingCreds ? twilio(accountSid, authToken) : null;

const ensureTwilioClient = () => {
  if (missingCreds) {
    throw new Error('TWILIO_ACCOUNT_SID y TWILIO_AUTH_TOKEN son obligatorios para enviar mensajes de WhatsApp.');
  }
  if (!configuredFromNumber) {
    throw new Error('TWILIO_WHATSAPP_NUMBER es obligatorio para enviar mensajes de WhatsApp.');
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

const normalizeTemplateEnvKey = (templateName = '') => templateName
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, '_');

const inferEnvKeyForTemplate = (templateName) => `TWILIO_TEMPLATE_${normalizeTemplateEnvKey(templateName)}_SID`;

const looksLikeContentSid = (value = '') => /^HX[a-f0-9]{32}$/i.test(value);

const resolveTemplateSid = (templateName) => {
  if (!templateName) {
    throw new Error('Debes especificar la plantilla de WhatsApp a enviar.');
  }

  if (templateSidCache.has(templateName)) {
    return templateSidCache.get(templateName);
  }

  const directValue = templateName.trim();
  if (looksLikeContentSid(directValue)) {
    templateSidCache.set(templateName, directValue);
    return directValue;
  }

  const envKey = inferEnvKeyForTemplate(templateName);
  const envValue = process.env[envKey]?.trim();
  if (!envValue) {
    throw new Error(`Configura la variable de entorno ${envKey} con el SID de la plantilla "${templateName}".`);
  }

  templateSidCache.set(templateName, envValue);
  return envValue;
};

const buildContentVariablesPayload = (variables = []) => {
  return variables.reduce((acc, value, index) => {
    acc[String(index + 1)] = value ?? '';
    return acc;
  }, {});
};

const sendWhatsAppMessage = async (to, templateName, variables = []) => {
  const client = ensureTwilioClient();

  const normalized = normalizeToE164(to);
  if (!normalized) {
    throw new Error('No se pudo normalizar el número de WhatsApp proporcionado.');
  }

  const contentSid = resolveTemplateSid(templateName);
  const toWhatsApp = ensureWhatsAppPrefix(normalized);
  const from = configuredFromNumber.startsWith('whatsapp:')
    ? configuredFromNumber
    : ensureWhatsAppPrefix(configuredFromNumber);

  // WhatsApp delivery relies solely on messages.create; listing templates at runtime caused production errors.
  await client.messages.create({
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
