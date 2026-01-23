const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbFile = path.join(dataDir, "agenda.db");
const db = new Database(dbFile);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS planes (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    edad INTEGER,
    acudiente TEXT,
    telefono TEXT,
    sanitized_telefono TEXT,
    tipo_plan INTEGER NOT NULL,
    dias_json TEXT NOT NULL,
    hora TEXT NOT NULL,
    clases_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    sanitized_phone TEXT NOT NULL,
    subscription_json TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const sanitizeDigits = (value = "") => value.replace(/[^0-9]/g, "");

const mapRow = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    edad: row.edad,
    acudiente: row.acudiente,
    telefono: row.telefono,
    tipoPlan: row.tipo_plan,
    dias: JSON.parse(row.dias_json),
    hora: row.hora,
    clases: JSON.parse(row.clases_json),
    createdAt: row.created_at,
  };
};

const insertPlanStmt = db.prepare(`
  INSERT INTO planes (
    id, nombre, edad, acudiente, telefono, sanitized_telefono,
    tipo_plan, dias_json, hora, clases_json
  ) VALUES (
    @id, @nombre, @edad, @acudiente, @telefono, @sanitized,
    @tipoPlan, @dias, @hora, @clases
  );
`);

const searchPlanStmt = db.prepare(`
  SELECT * FROM planes
  WHERE LOWER(nombre) LIKE @term
     OR telefono LIKE @likeDigits
     OR sanitized_telefono LIKE @likeDigits
  ORDER BY created_at DESC
  LIMIT 1;
`);

const findByIdStmt = db.prepare("SELECT * FROM planes WHERE id = ?");
const updateClasesStmt = db.prepare("UPDATE planes SET clases_json = ? WHERE id = ?");
const deletePlanStmt = db.prepare("DELETE FROM planes WHERE id = ?");

const upsertPushSubscriptionStmt = db.prepare(`
  INSERT INTO push_subscriptions (id, phone, sanitized_phone, subscription_json)
  VALUES (@id, @phone, @sanitized, @subscription)
  ON CONFLICT(phone) DO UPDATE SET
    sanitized_phone = excluded.sanitized_phone,
    subscription_json = excluded.subscription_json,
    updated_at = CURRENT_TIMESTAMP;
`);

const findPushSubscriptionByPhoneStmt = db.prepare(
  "SELECT * FROM push_subscriptions WHERE phone = ? OR sanitized_phone = ?"
);

const deletePushSubscriptionStmt = db.prepare(
  "DELETE FROM push_subscriptions WHERE phone = ? OR sanitized_phone = ?"
);

const createPlan = (payload) => {
  const planRecord = {
    id: payload.id,
    nombre: payload.nombre,
    edad: payload.edad ?? null,
    acudiente: payload.acudiente ?? null,
    telefono: payload.telefono ?? null,
    sanitized: sanitizeDigits(payload.telefono ?? ""),
    tipoPlan: payload.tipoPlan,
    dias: JSON.stringify(payload.dias ?? []),
    hora: payload.hora,
    clases: JSON.stringify(payload.clases ?? []),
  };

  insertPlanStmt.run(planRecord);
  return mapRow(findByIdStmt.get(planRecord.id));
};

const searchPlan = (term) => {
  const cleanedTerm = term?.trim().toLowerCase() ?? "";
  if (!cleanedTerm) {
    return null;
  }

  const digits = sanitizeDigits(term);
  const row = searchPlanStmt.get({
    term: `%${cleanedTerm}%`,
    likeDigits: digits ? `%${digits}%` : "%%",
  });
  return mapRow(row);
};

const toggleClase = (planId, claseIndex) => {
  const row = findByIdStmt.get(planId);
  if (!row) return null;

  const clases = JSON.parse(row.clases_json);
  const clase = clases[claseIndex];
  if (!clase) return null;

  clase.completada = !clase.completada;
  updateClasesStmt.run(JSON.stringify(clases), planId);
  return mapRow(findByIdStmt.get(planId));
};

const deletePlan = (planId) => {
  const row = findByIdStmt.get(planId);
  if (!row) return null;
  deletePlanStmt.run(planId);
  return mapRow(row);
};

const mapPushSubscription = (row) => {
  if (!row) return null;
  let subscription = null;
  try {
    subscription = JSON.parse(row.subscription_json);
  } catch (_error) {
    subscription = null;
  }
  return {
    id: row.id,
    phone: row.phone,
    sanitizedPhone: row.sanitized_phone,
    subscription,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const upsertPushSubscription = ({ phone, subscription }) => {
  const trimmedPhone = (phone || "").trim();
  const digits = sanitizeDigits(trimmedPhone);
  if (!digits || !subscription) {
    return null;
  }

  const record = {
    id: crypto.randomUUID(),
    phone: trimmedPhone,
    sanitized: digits,
    subscription: JSON.stringify(subscription),
  };

  upsertPushSubscriptionStmt.run(record);
  return mapPushSubscription(findPushSubscriptionByPhoneStmt.get(trimmedPhone, digits));
};

const getPushSubscriptionByPhone = (phone) => {
  const trimmedPhone = (phone || "").trim();
  const digits = sanitizeDigits(trimmedPhone);
  if (!trimmedPhone && !digits) {
    return null;
  }
  return mapPushSubscription(findPushSubscriptionByPhoneStmt.get(trimmedPhone, digits));
};

const deletePushSubscriptionByPhone = (phone) => {
  const trimmedPhone = (phone || "").trim();
  const digits = sanitizeDigits(trimmedPhone);
  if (!trimmedPhone && !digits) {
    return false;
  }
  const result = deletePushSubscriptionStmt.run(trimmedPhone, digits);
  return result.changes > 0;
};

module.exports = {
  createPlan,
  searchPlan,
  toggleClase,
  deletePlan,
  upsertPushSubscription,
  getPushSubscriptionByPhone,
  deletePushSubscriptionByPhone,
};
