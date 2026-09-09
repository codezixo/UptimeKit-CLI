import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { mkdirp } from 'mkdirp';
import { formatDistanceToNow } from 'date-fns';

const DB_DIR = path.join(os.homedir(), '.uptimekit');
const DB_PATH = path.join(DB_DIR, 'uptimekit.db');

let db;

export async function initDB() {
  if (!fs.existsSync(DB_DIR)) {
    await mkdirp(DB_DIR);
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      port INTEGER,
      interval INTEGER NOT NULL,
      retries INTEGER DEFAULT 0,
      webhook_url TEXT,
      smtp_to TEXT,
      group_name TEXT,
      check_config TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency INTEGER,
      retries INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ssl_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL UNIQUE,
      issuer TEXT,
      subject TEXT,
      valid_from TEXT,
      valid_to TEXT,
      days_remaining INTEGER,
      serial_number TEXT,
      fingerprint TEXT,
      last_checked TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE
    );
  `);

  try {
    const monitorCols = db.prepare("PRAGMA table_info('monitors')").all();

    if (!monitorCols.some(c => c.name === 'name')) {
      db.prepare('ALTER TABLE monitors ADD COLUMN name TEXT').run();
    }

    if (!monitorCols.some(c => c.name === 'webhook_url')) {
      db.prepare('ALTER TABLE monitors ADD COLUMN webhook_url TEXT').run();
    }

    if (!monitorCols.some(c => c.name === 'group_name')) {
      db.prepare('ALTER TABLE monitors ADD COLUMN group_name TEXT').run();
    }

    if (!monitorCols.some(c => c.name === 'retries')) {
      db.prepare('ALTER TABLE monitors ADD COLUMN retries INTEGER DEFAULT 0').run();
    }

    if (!monitorCols.some(c => c.name === 'smtp_to')) {
      db.prepare('ALTER TABLE monitors ADD COLUMN smtp_to TEXT').run();
    }

    if (!monitorCols.some(c => c.name === 'check_config')) {
      db.prepare('ALTER TABLE monitors ADD COLUMN check_config TEXT').run();
    }

    const heartbeatCols = db.prepare("PRAGMA table_info('heartbeats')").all();

    if (!heartbeatCols.some(c => c.name === 'retries')) {
      db.prepare('ALTER TABLE heartbeats ADD COLUMN retries INTEGER').run();
    }
  } catch (err) {
    console.error('Database column migration error:', err);
  }

  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_heartbeats_monitor_id ON heartbeats(monitor_id);
      CREATE INDEX IF NOT EXISTS idx_heartbeats_timestamp ON heartbeats(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ssl_certificates_monitor_id ON ssl_certificates(monitor_id);
      CREATE INDEX IF NOT EXISTS idx_monitors_group_name ON monitors(group_name);
    `);
  } catch (err) {
    console.error('Database index creation error:', err);
  }
  try {
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('notifications_enabled', '1')").run();
  } catch (err) {
    console.error('Settings initialization error:', err);
  }

  // Prune old data on startup
  pruneOldHeartbeats();
}

export function getDB() {
  if (!db) {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

export function pruneOldHeartbeats() {
  try {
    const db = getDB();
    db.prepare("DELETE FROM heartbeats WHERE timestamp < datetime('now', '-30 days')").run();
  } catch (err) {
    console.error('Failed to prune old heartbeats:', err);
  }
}

export function resetDB() {
  const db = getDB();
  db.exec(`
    DROP TABLE IF EXISTS heartbeats;
    DROP TABLE IF EXISTS ssl_certificates;
    DROP TABLE IF EXISTS monitors;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      port INTEGER,
      interval INTEGER NOT NULL,
      retries INTEGER DEFAULT 0,
      webhook_url TEXT,
      smtp_to TEXT,
      group_name TEXT,
      check_config TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency INTEGER,
      retries INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ssl_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL UNIQUE,
      issuer TEXT,
      subject TEXT,
      valid_from TEXT,
      valid_to TEXT,
      days_remaining INTEGER,
      serial_number TEXT,
      fingerprint TEXT,
      last_checked TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_heartbeats_monitor_id ON heartbeats(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_heartbeats_timestamp ON heartbeats(timestamp);
    CREATE INDEX IF NOT EXISTS idx_ssl_certificates_monitor_id ON ssl_certificates(monitor_id);
    CREATE INDEX IF NOT EXISTS idx_monitors_group_name ON monitors(group_name);
  `);
}

export function addMonitor(
  type,
  url,
  interval,
  retries = null,
  name = null,
  webhookUrl = null,
  groupName = null,
  smtpTo = null,
  checkConfig = null
) {
  const db = getDB();

  // Validate interval
  if (interval < 1 || !Number.isInteger(interval)) {
    throw new Error('Interval must be a positive integer (minimum 1 second).');
  }

  // Validate retries
  if (retries < 0 || !Number.isInteger(retries)) {
    throw new Error('Retries must be an integer (minimum 0).');
  }

  if (name) {
    const existing = db.prepare('SELECT id FROM monitors WHERE lower(name) = lower(?)').get(name);
    if (existing) {
      throw new Error(`Monitor with name '${name}' already exists.`);
    }
  }
  const stmt = db.prepare(
    'INSERT INTO monitors (type, url, interval, retries, name, webhook_url, smtp_to, group_name, check_config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  return stmt.run(type, url, interval, retries, name, webhookUrl, smtpTo, groupName, checkConfig);
}

export function updateMonitor(id, updates) {
  const db = getDB();
  const { name, url, type, interval, retries, webhook_url, group_name, smtp_to, check_config } = updates;

  if (interval !== undefined && (interval < 1 || !Number.isInteger(interval))) {
    throw new Error('Interval must be a positive integer (minimum 1 second).');
  }

  if (retries !== undefined && (retries < 0 || !Number.isInteger(retries))) {
    throw new Error('Retries must be an integer greater than or equal to 0.');
  }

  if (name) {
    const existing = db.prepare('SELECT id FROM monitors WHERE lower(name) = lower(?) AND id != ?').get(name, id);
    if (existing) {
      throw new Error(`Monitor with name '${name}' already exists.`);
    }
  }

  const fields = [];
  const values = [];

  if (name !== undefined) {
    fields.push('name = ?');
    values.push(name);
  }
  if (url !== undefined) {
    fields.push('url = ?');
    values.push(url);
  }
  if (type !== undefined) {
    fields.push('type = ?');
    values.push(type);
  }
  if (interval !== undefined) {
    fields.push('interval = ?');
    values.push(interval);
  }
  if (retries !== undefined) {
    fields.push('retries = ?');
    values.push(retries);
  }
  if (webhook_url !== undefined) {
    fields.push('webhook_url = ?');
    values.push(webhook_url);
  }
  if (smtp_to !== undefined) {
    fields.push('smtp_to = ?');
    values.push(smtp_to);
  }
  if (group_name !== undefined) {
    fields.push('group_name = ?');
    values.push(group_name);
  }

  if (check_config !== undefined) {
    fields.push('check_config = ?');
    values.push(check_config);
  }

  if (fields.length === 0) return;

  values.push(id);
  const sql = `UPDATE monitors SET ${fields.join(', ')} WHERE id = ?`;
  return db.prepare(sql).run(...values);
}

export function getMonitors() {
  return getDB().prepare('SELECT * FROM monitors').all();
}

export function getMonitorByIdOrName(idOrName) {
  const db = getDB();
  const s = String(idOrName || '').trim();

  if (!s || s.length === 0) return null;

  if (/^[0-9]+$/.test(s)) {
    const byId = db.prepare('SELECT * FROM monitors WHERE id = ?').get(Number(s));
    if (byId) return byId;
  }

  const byName = db.prepare('SELECT * FROM monitors WHERE lower(name) = lower(?)').get(s);
  if (byName) return byName;

  const byUrl = db.prepare('SELECT * FROM monitors WHERE lower(url) = lower(?)').get(s);
  if (byUrl) return byUrl;

  const likePattern = `%${s}%`;
  const fuzzy = db
    .prepare('SELECT * FROM monitors WHERE lower(name) LIKE lower(?) OR lower(url) LIKE lower(?) LIMIT 1')
    .get(likePattern, likePattern);
  if (fuzzy) return fuzzy;

  const byHost = db.prepare('SELECT * FROM monitors WHERE lower(url) LIKE lower(?) LIMIT 1').get(`%${s}%`);
  return byHost || null;
}

export function getHeartbeatsForMonitor(monitorId, limit = 60) {
  return getDB()
    .prepare(
      'SELECT status, retries, timestamp, latency FROM heartbeats WHERE monitor_id = ? ORDER BY timestamp DESC LIMIT ?'
    )
    .all(monitorId, limit);
}

export function logHeartbeat(monitorId, status, retries, latency) {
  const stmt = getDB().prepare('INSERT INTO heartbeats (monitor_id, status, retries, latency) VALUES (?, ?, ?, ?)');
  return stmt.run(monitorId, status, retries, latency);
}

export function getStats() {
  const db = getDB();

  // Single optimized query to get latest status and aggregate stats for all monitors
  const sql = `
    SELECT
      m.*,
      COUNT(h.id) as total_checks,
      SUM(CASE WHEN h.status = 'up' THEN 1 ELSE 0 END) as success_checks,
      AVG(h.latency) as avg_latency,
      (SELECT status FROM heartbeats WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as current_status,
      (SELECT retries FROM heartbeats WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as current_retries,
      (SELECT latency FROM heartbeats WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as current_latency,
      (SELECT timestamp FROM heartbeats WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as last_check_ts,
      (SELECT timestamp FROM heartbeats WHERE monitor_id = m.id AND status = 'down' ORDER BY timestamp DESC LIMIT 1) as last_down_ts,
      ssl.issuer as ssl_issuer,
      ssl.subject as ssl_subject,
      ssl.valid_from as ssl_valid_from,
      ssl.valid_to as ssl_valid_to,
      ssl.days_remaining as ssl_days_remaining,
      ssl.serial_number as ssl_serial_number,
      ssl.fingerprint as ssl_fingerprint,
      ssl.last_checked as ssl_last_checked
    FROM monitors m
    LEFT JOIN heartbeats h ON m.id = h.monitor_id
    LEFT JOIN ssl_certificates ssl ON m.id = ssl.monitor_id
    GROUP BY m.id
  `;

  const rows = db.prepare(sql).all();

  return rows.map(row => {
    const uptime = row.total_checks > 0 ? ((row.success_checks / row.total_checks) * 100).toFixed(2) : 0;

    // Helper to parse SQLite UTC string to Date object
    const parseDBTimestamp = ts => {
      if (!ts) return null;
      return new Date(ts.replace(' ', 'T') + 'Z');
    };

    const lastCheckTime = row.last_check_ts
      ? formatDistanceToNow(parseDBTimestamp(row.last_check_ts), {
          addSuffix: true
        })
      : 'Never';

    let lastDowntimeText = 'No downtime';
    if (row.last_down_ts) {
      lastDowntimeText = formatDistanceToNow(parseDBTimestamp(row.last_down_ts), { addSuffix: true });
    }

    // If currently down, try to calculate how long it's been down
    if (row.current_status === 'down' && row.last_down_ts) {
      lastDowntimeText = `Since ${formatDistanceToNow(parseDBTimestamp(row.last_down_ts), { addSuffix: true })}`;
    }

    // Build SSL info for SSL monitors
    let sslInfo = null;
    if (row.type === 'ssl') {
      sslInfo = {
        issuer: row.ssl_issuer,
        subject: row.ssl_subject,
        validFrom: row.ssl_valid_from,
        validTo: row.ssl_valid_to,
        daysRemaining: row.ssl_days_remaining,
        serialNumber: row.ssl_serial_number,
        fingerprint: row.ssl_fingerprint,
        lastChecked: row.ssl_last_checked
      };
    }

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      url: row.url,
      interval: row.interval,
      retries: row.retries,
      groupName: row.group_name,
      webhookUrl: row.webhook_url,
      smtpTo: row.smtp_to,
      checkConfig: row.check_config,
      uptime: uptime,
      lastDowntime: lastDowntimeText,
      status: row.current_status || 'unknown',
      current_retries: row.current_retries || 0,
      latency: Math.round(row.current_latency || 0),
      lastCheck: lastCheckTime,
      ssl: sslInfo
    };
  });
}

export function getNotificationSettings() {
  const db = getDB();
  try {
    const result = db.prepare("SELECT value FROM settings WHERE key = 'notifications_enabled'").get();
    return result ? result.value === '1' : true;
  } catch (err) {
    console.error('Failed to get notification settings:', err);
    return true;
  }
}

export function setNotificationSettings(enabled) {
  const db = getDB();
  try {
    const value = enabled ? '1' : '0';
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('notifications_enabled', ?)").run(value);
    return true;
  } catch (err) {
    console.error('Failed to set notification settings:', err);
    return false;
  }
}

const SMTP_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'smtp_to'];

export function getSmtpSettings() {
  const db = getDB();
  try {
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'smtp_%'").all();
    const settings = {};
    for (const row of rows) {
      settings[row.key.replace('smtp_', '')] = row.value;
    }
    if (!settings.host || !settings.port || !settings.user || !settings.pass) {
      return null;
    }
    return settings;
  } catch (err) {
    console.error('Failed to get SMTP settings:', err);
    return null;
  }
}

export function setSmtpSettings(config) {
  const db = getDB();
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    stmt.run('smtp_host', config.host);
    stmt.run('smtp_port', String(config.port));
    stmt.run('smtp_user', config.user);
    stmt.run('smtp_pass', config.pass);
    stmt.run('smtp_from', config.from || config.user);
    if (config.to) {
      stmt.run('smtp_to', config.to);
    } else {
      db.prepare("DELETE FROM settings WHERE key = 'smtp_to'").run();
    }
    return true;
  } catch (err) {
    console.error('Failed to set SMTP settings:', err);
    return false;
  }
}

export function clearSmtpSettings() {
  const db = getDB();
  try {
    const placeholders = SMTP_KEYS.map(() => '?').join(', ');
    db.prepare(`DELETE FROM settings WHERE key IN (${placeholders})`).run(...SMTP_KEYS);
    return true;
  } catch (err) {
    console.error('Failed to clear SMTP settings:', err);
    return false;
  }
}

export function isSmtpConfigured() {
  return getSmtpSettings() !== null;
}

// SSL Certificate functions
export function upsertSSLCertificate(monitorId, certData) {
  const db = getDB();
  const { issuer, subject, validFrom, validTo, daysRemaining, serialNumber, fingerprint } = certData;

  const stmt = db.prepare(`
    INSERT INTO ssl_certificates (monitor_id, issuer, subject, valid_from, valid_to, days_remaining, serial_number, fingerprint, last_checked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(monitor_id) DO UPDATE SET
      issuer = excluded.issuer,
      subject = excluded.subject,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      days_remaining = excluded.days_remaining,
      serial_number = excluded.serial_number,
      fingerprint = excluded.fingerprint,
      last_checked = CURRENT_TIMESTAMP
  `);

  return stmt.run(monitorId, issuer, subject, validFrom, validTo, daysRemaining, serialNumber, fingerprint);
}

export function getSSLCertificate(monitorId) {
  const db = getDB();
  return db.prepare('SELECT * FROM ssl_certificates WHERE monitor_id = ?').get(monitorId);
}

export function getAllSSLCertificates() {
  const db = getDB();
  return db.prepare('SELECT * FROM ssl_certificates').all();
}

// Group management functions

export function getGroups() {
  const db = getDB();
  return db
    .prepare(
      `
    SELECT group_name, COUNT(*) as count
    FROM monitors
    WHERE group_name IS NOT NULL AND group_name != ''
    GROUP BY group_name
    ORDER BY group_name
  `
    )
    .all();
}

export function groupExists(groupName) {
  const db = getDB();
  const result = db.prepare('SELECT 1 FROM monitors WHERE lower(group_name) = lower(?) LIMIT 1').get(groupName);
  return !!result;
}

export function renameGroup(oldName, newName) {
  const db = getDB();

  if (!groupExists(oldName)) {
    throw new Error(`Group '${oldName}' does not exist.`);
  }

  const existingNew = db
    .prepare('SELECT 1 FROM monitors WHERE lower(group_name) = lower(?) AND lower(group_name) != lower(?) LIMIT 1')
    .get(newName, oldName);
  if (existingNew) {
    throw new Error(`Group '${newName}' already exists.`);
  }

  const stmt = db.prepare('UPDATE monitors SET group_name = ? WHERE lower(group_name) = lower(?)');
  return stmt.run(newName, oldName);
}

export function deleteGroup(groupName, deleteMonitors = false) {
  const db = getDB();

  if (!groupExists(groupName)) {
    throw new Error(`Group '${groupName}' does not exist.`);
  }

  if (deleteMonitors) {
    db.prepare(
      `
      DELETE FROM heartbeats
      WHERE monitor_id IN (SELECT id FROM monitors WHERE lower(group_name) = lower(?))
    `
    ).run(groupName);

    db.prepare(
      `
      DELETE FROM ssl_certificates
      WHERE monitor_id IN (SELECT id FROM monitors WHERE lower(group_name) = lower(?))
    `
    ).run(groupName);

    return db.prepare('DELETE FROM monitors WHERE lower(group_name) = lower(?)').run(groupName);
  } else {
    return db.prepare('UPDATE monitors SET group_name = NULL WHERE lower(group_name) = lower(?)').run(groupName);
  }
}

export function getMonitorsByGroup(groupName) {
  const db = getDB();
  if (groupName === null || groupName === 'ungrouped') {
    return db.prepare('SELECT * FROM monitors WHERE group_name IS NULL OR group_name = ""').all();
  }
  return db.prepare('SELECT * FROM monitors WHERE lower(group_name) = lower(?)').all(groupName);
}

export function getStatsByGroup(groupName) {
  const allStats = getStats();

  if (groupName === null || groupName === 'ungrouped') {
    return allStats.filter(s => !s.groupName || s.groupName === '');
  }

  return allStats.filter(s => s.groupName && s.groupName.toLowerCase() === groupName.toLowerCase());
}
