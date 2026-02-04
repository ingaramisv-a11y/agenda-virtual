const crypto = require('crypto');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required to run Agenda Pro backend.');
}

const useSsl = process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  ssl: useSsl,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error', error);
});

const sanitizeDigits = (value = '') => value.replace(/[^0-9]/g, '');

const safeJsonParse = (value, fallback) => {
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
};

const normalizeClaseRecord = (clase = {}, index = 0) => {
  const numero = typeof clase?.numero === 'number' ? clase.numero : index + 1;
  return {
    numero,
    completada: Boolean(clase?.completada),
    firmaEstado: clase?.firmaEstado || null,
    firmaPendienteId: clase?.firmaPendienteId || null,
    firmaReintentos: Number.isFinite(clase?.firmaReintentos) ? clase.firmaReintentos : 0,
  };
};

const normalizeClasesCollection = (clasesInput = [], desiredLength = null) => {
  const source = Array.isArray(clasesInput) ? clasesInput : [];
  const targetLength = desiredLength ?? source.length ?? 0;
  const normalized = [];
  for (let index = 0; index < targetLength; index += 1) {
    normalized.push(normalizeClaseRecord(source[index], index));
  }
  return normalized;
};

const mapRow = (row) => {
  if (!row) return null;
  const clases = safeJsonParse(row.clases_json, []);
  return {
    id: row.id,
    nombre: row.nombre,
    edad: row.edad,
    acudiente: row.acudiente,
    telefono: row.telefono,
    tipoPlan: row.tipo_plan,
    dias: safeJsonParse(row.dias_json, []),
    hora: row.hora,
    clases: normalizeClasesCollection(clases),
    createdAt: row.created_at,
  };
};

const mapPushSubscription = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    sanitizedPhone: row.sanitized_phone,
    subscription: safeJsonParse(row.subscription_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const initializeDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS plans (
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
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS classes (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        clase_index INTEGER NOT NULL,
        payload JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tutors (
        id TEXT PRIMARY KEY,
        nombre TEXT,
        telefono TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        phone TEXT NOT NULL UNIQUE,
        sanitized_phone TEXT,
        subscription_json TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_plans_sanitized_telefono ON plans (sanitized_telefono)'
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_sanitized ON push_subscriptions (sanitized_phone)'
    );

    console.log('Connected to PostgreSQL and ensured schema is ready.');
  } finally {
    client.release();
  }
};

const ready = initializeDatabase().catch((error) => {
  console.error('Failed to initialize PostgreSQL schema', error);
  throw error;
});

const createPlan = async (payload) => {
  const normalizedClases = normalizeClasesCollection(
    payload.clases ?? [],
    Number(payload.tipoPlan) || undefined
  );
  const planId = payload.id || crypto.randomUUID();
  await pool.query(
    `INSERT INTO plans (
      id, nombre, edad, acudiente, telefono, sanitized_telefono,
      tipo_plan, dias_json, hora, clases_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (id) DO UPDATE SET
      nombre = EXCLUDED.nombre,
      edad = EXCLUDED.edad,
      acudiente = EXCLUDED.acudiente,
      telefono = EXCLUDED.telefono,
      sanitized_telefono = EXCLUDED.sanitized_telefono,
      tipo_plan = EXCLUDED.tipo_plan,
      dias_json = EXCLUDED.dias_json,
      hora = EXCLUDED.hora,
      clases_json = EXCLUDED.clases_json
    ;`,
    [
      planId,
      payload.nombre,
      payload.edad ?? null,
      payload.acudiente ?? null,
      payload.telefono ?? null,
      sanitizeDigits(payload.telefono ?? ''),
      Number(payload.tipoPlan),
      JSON.stringify(payload.dias ?? []),
      payload.hora,
      JSON.stringify(normalizedClases),
    ]
  );

  return getPlanById(planId);
};

const searchPlan = async (term) => {
  const cleanedTerm = term?.trim().toLowerCase() ?? '';
  if (!cleanedTerm) {
    return null;
  }

  const digits = sanitizeDigits(term);
  const likeDigits = digits ? `%${digits}%` : '%';
  const { rows } = await pool.query(
    `SELECT * FROM plans
     WHERE LOWER(nombre) LIKE $1
        OR telefono LIKE $2
        OR sanitized_telefono LIKE $2
     ORDER BY created_at DESC
     LIMIT 1;`,
    [`%${cleanedTerm}%`, likeDigits]
  );

  return mapRow(rows[0]);
};

const listPlans = async () => {
  const { rows } = await pool.query('SELECT * FROM plans ORDER BY created_at ASC;');
  return rows.map(mapRow);
};

const getPlanById = async (planId) => {
  if (!planId) {
    return null;
  }
  const { rows } = await pool.query('SELECT * FROM plans WHERE id = $1 LIMIT 1;', [planId]);
  return mapRow(rows[0]);
};

const replacePlanClases = async (planId, clases) => {
  if (!planId || !Array.isArray(clases)) {
    return null;
  }
  const normalized = normalizeClasesCollection(clases, clases.length || null);
  await pool.query('UPDATE plans SET clases_json = $1 WHERE id = $2;', [
    JSON.stringify(normalized),
    planId,
  ]);
  return getPlanById(planId);
};

const toggleClase = async (planId, claseIndex) => {
  const plan = await getPlanById(planId);
  if (!plan || !Array.isArray(plan.clases)) {
    return null;
  }
  const clases = plan.clases.map((clase) => ({ ...clase }));
  const clase = clases[claseIndex];
  if (!clase) {
    return null;
  }
  clase.completada = !clase.completada;
  return replacePlanClases(planId, clases);
};

const deletePlan = async (planId) => {
  const plan = await getPlanById(planId);
  if (!plan) {
    return null;
  }
  await pool.query('DELETE FROM plans WHERE id = $1;', [planId]);
  return plan;
};

const upsertPushSubscription = async ({ phone, subscription }) => {
  const trimmedPhone = (phone || '').trim();
  const digits = sanitizeDigits(trimmedPhone);
  if ((!trimmedPhone && !digits) || !subscription) {
    return null;
  }

  const storedPhone = trimmedPhone || digits;
  const serializedSubscription = JSON.stringify(subscription);
  const { rows } = await pool.query(
    `INSERT INTO push_subscriptions (id, phone, sanitized_phone, subscription_json)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone) DO UPDATE SET
       sanitized_phone = EXCLUDED.sanitized_phone,
       subscription_json = EXCLUDED.subscription_json,
       updated_at = NOW()
     RETURNING *;`,
    [crypto.randomUUID(), storedPhone, digits || null, serializedSubscription]
  );

  return mapPushSubscription(rows[0]);
};

const getPushSubscriptionByPhone = async (phone) => {
  const trimmedPhone = (phone || '').trim();
  const digits = sanitizeDigits(trimmedPhone);
  if (!trimmedPhone && !digits) {
    return null;
  }

  const { rows } = await pool.query(
    `SELECT * FROM push_subscriptions
     WHERE phone = $1 OR sanitized_phone = $2
     ORDER BY updated_at DESC
     LIMIT 1;`,
    [trimmedPhone || null, digits || null]
  );

  return mapPushSubscription(rows[0]);
};

const deletePushSubscriptionByPhone = async (phone) => {
  const trimmedPhone = (phone || '').trim();
  const digits = sanitizeDigits(trimmedPhone);
  if (!trimmedPhone && !digits) {
    return false;
  }
  const result = await pool.query(
    'DELETE FROM push_subscriptions WHERE phone = $1 OR sanitized_phone = $2;',
    [trimmedPhone || null, digits || null]
  );
  return result.rowCount > 0;
};

module.exports = {
  ready,
  createPlan,
  searchPlan,
  listPlans,
  toggleClase,
  deletePlan,
  getPlanById,
  replacePlanClases,
  upsertPushSubscription,
  getPushSubscriptionByPhone,
  deletePushSubscriptionByPhone,
};
