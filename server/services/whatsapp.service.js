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

const sendWhatsAppMessage = async ({ to, message }) => {
  if (!isConfigured) {
    throw new Error('El servicio de WhatsApp (Twilio) no está configurado.');
  }
  if (!message || !message.trim()) {
    throw new Error('El mensaje de WhatsApp no puede estar vacío.');
  }

  const normalized = normalizeToE164(to);
  if (!normalized) {
    throw new Error('No se pudo normalizar el número de WhatsApp proporcionado.');
  }

  const toWhatsApp = ensureWhatsAppPrefix(normalized);
  const from = configuredFromNumber.startsWith('whatsapp:')
    ? configuredFromNumber
    : ensureWhatsAppPrefix(configuredFromNumber);

  await twilioClient.messages.create({
    body: message.trim(),
    from,
    to: toWhatsApp,
  });
};

module.exports = {
  sendWhatsAppMessage,
  normalizeToE164,
  isWhatsAppConfigured: isConfigured,
};
