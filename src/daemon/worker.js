import { initDB, getMonitors, logHeartbeat, getNotificationSettings, upsertSSLCertificate } from '../core/db.js';
import { log } from '../core/log.js';
import {
  notifyMonitorDown,
  notifyMonitorUp,
  notifySSLExpiring,
  notifySSLExpired,
  notifySSLValid
} from '../core/notifier.js';
import axios from 'axios';
import ping from 'ping';
import dns from 'dns/promises';
import tls from 'tls';
import { URL } from 'url';

const activeMonitors = new Map();

// SSL Certificate checking function
async function checkSSLCertificate(hostname, port = 443) {
  return new Promise((resolve, reject) => {
    const options = {
      host: hostname,
      port: port,
      servername: hostname,
      rejectUnauthorized: false,
      timeout: 10000
    };

    const socket = tls.connect(options, () => {
      try {
        const cert = socket.getPeerCertificate();
        socket.end();

        if (!cert || Object.keys(cert).length === 0) {
          reject(new Error('No certificate found'));
          return;
        }

        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const now = new Date();
        const daysRemaining = Math.floor((validTo - now) / (1000 * 60 * 60 * 24));

        resolve({
          issuer: cert.issuer ? cert.issuer.O || cert.issuer.CN || 'Unknown' : 'Unknown',
          subject: cert.subject ? cert.subject.CN || cert.subject.O || hostname : hostname,
          validFrom: validFrom.toISOString(),
          validTo: validTo.toISOString(),
          daysRemaining: daysRemaining,
          serialNumber: cert.serialNumber || 'Unknown',
          fingerprint: cert.fingerprint || 'Unknown',
          isValid: now >= validFrom && now <= validTo && daysRemaining > 0
        });
      } catch (err) {
        socket.end();
        reject(err);
      }
    });

    socket.on('error', err => {
      reject(err);
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

async function checkMonitor(monitor) {
  const start = Date.now();
  let status = 'down';
  let retries = 0;
  let latency = 0;

  try {
    if (monitor.type === 'http') {
      const res = await axios.get(monitor.url, {
        timeout: 5000,
        validateStatus: () => true
      });
      if (res.status >= 200 && res.status < 300) {
        status = 'up';
      }
      monitor._lastHttpCode = res.status;
      latency = Date.now() - start;
    } else if (monitor.type === 'icmp') {
      const isWindows = process.platform === 'win32';
      const res = await ping.promise.probe(monitor.url, {
        timeout: 5,
        extra: [isWindows ? '-n' : '-c', '1']
      });
      status = res.alive ? 'up' : 'down';
      latency = res.time === 'unknown' ? 0 : parseFloat(res.time) || 0;
    } else if (monitor.type === 'dns') {
      await dns.resolve(monitor.url);
      status = 'up';
      latency = Date.now() - start;
    } else if (monitor.type === 'ssl') {
      // SSL certificate monitoring
      let hostname = monitor.url;
      let port = 443;

      try {
        if (hostname.includes('://')) {
          const parsed = new URL(hostname);
          hostname = parsed.hostname;
          port = parsed.port ? parseInt(parsed.port) : 443;
        } else if (hostname.includes(':')) {
          const parts = hostname.split(':');
          hostname = parts[0];
          port = parseInt(parts[1]) || 443;
        }
      } catch (e) {
        console.error('Error parsing SSL monitor URL:', e);
      }

      const certInfo = await checkSSLCertificate(hostname, port);
      latency = Date.now() - start;

      upsertSSLCertificate(monitor.id, certInfo);

      status = certInfo.isValid ? 'up' : 'down';

      monitor._sslCertInfo = certInfo;
    }
  } catch (error) {
    status = 'down';
    latency = Date.now() - start;
    console.error(`Check failed for monitor ${monitor.name || monitor.url} (${monitor.type}):`, error.message);
  }

  // Get previous status and retry state
  const monitorData = activeMonitors.get(monitor.id) || {};
  const previousStatus = monitorData.lastStatus;
  const previousRetries = monitorData.lastRetries || 0;

  if (status === 'down') {
    retries = previousStatus === 'down' ? previousRetries + 1 : 1;
  } else {
    retries = 0;
  }

  // Log heartbeat
  try {
    logHeartbeat(monitor.id, status, retries, Math.round(latency));
  } catch (err) {
    console.error('Failed to log heartbeat:', err);
  }

  const notificationsEnabled = getNotificationSettings();

  const notifySSLDown = monitor.type === 'ssl' && status === 'down' && !!previousStatus && previousStatus !== status;
  const notifySSLUp = monitor.type === 'ssl' && status === 'up' && !!previousStatus && previousStatus !== status;
  const notifyDown =
    monitor.type !== 'ssl' && status === 'down' && (monitor.retries === 0 || retries === monitor.retries);
  const notifyUp = monitor.type !== 'ssl' && status === 'up' && previousStatus === 'down';

  log(
    'check',
    `monitor=${monitor.name || monitor.url} type=${monitor.type} status=${status} prev=${previousStatus ?? 'null'} ` +
      `retries=${retries} retryLimit=${monitor.retries} httpCode=${monitor._lastHttpCode ?? '-'} ` +
      `notifDisabled=${!notificationsEnabled} down=${notifyDown} up=${notifyUp} sslDown=${notifySSLDown} sslUp=${notifySSLUp}`
  );

  if (notificationsEnabled) {
    if (monitor.type === 'ssl') {
      if (notifySSLDown) {
        notifySSLExpired(monitor);
      } else if (notifySSLUp) {
        notifySSLValid(monitor);
      }
    } else {
      if (notifyDown) {
        notifyMonitorDown(monitor);
      }

      if (notifyUp) {
        notifyMonitorUp(monitor);
      }
    }
  }

  activeMonitors.set(monitor.id, {
    ...monitorData,
    lastStatus: status,
    lastRetries: retries,
    intervalId: monitorData.intervalId,
    monitor
  });

  if (monitor.type === 'ssl' && monitor._sslCertInfo && status === 'up') {
    const notificationsEnabled = getNotificationSettings();
    if (notificationsEnabled) {
      const days = monitor._sslCertInfo.daysRemaining;
      const monitorData = activeMonitors.get(monitor.id);
      const lastNotifiedThreshold = monitorData?.lastSSLNotifiedThreshold || 0;

      const thresholds = [30, 14, 7, 3, 1];
      for (const threshold of thresholds) {
        if (days <= threshold && lastNotifiedThreshold < threshold) {
          notifySSLExpiring(monitor, days);
          if (monitorData) {
            monitorData.lastSSLNotifiedThreshold = threshold;
          }
          break;
        }
      }
    }
  }

  // Update last status
  if (monitorData) {
    monitorData.lastStatus = status;
    monitorData.lastRetries = retries;
  }
}

function startMonitorLoop(monitor, initialStatus = null) {
  checkMonitor(monitor);

  const intervalId = setInterval(() => {
    checkMonitor(monitor);
  }, monitor.interval * 1000);

  activeMonitors.set(monitor.id, {
    intervalId,
    monitor,
    lastStatus: initialStatus, // Track last known status
    lastRetries: 0 // Track last known retries
  });
}

function monitorChanged(a, b) {
  return (
    a.interval !== b.interval ||
    a.url !== b.url ||
    a.type !== b.type ||
    a.retries !== b.retries ||
    a.name !== b.name ||
    a.webhook_url !== b.webhook_url ||
    a.smtp_to !== b.smtp_to ||
    a.group_name !== b.group_name
  );
}

function changedFields(a, b) {
  return ['interval', 'url', 'type', 'retries', 'name', 'webhook_url', 'smtp_to', 'group_name'].filter(
    k => a[k] !== b[k]
  );
}

async function refreshMonitors() {
  try {
    const monitors = getMonitors();
    const currentIds = new Set(monitors.map(m => m.id));

    // Remove deleted monitors
    for (const [id, data] of activeMonitors) {
      if (!currentIds.has(id)) {
        clearInterval(data.intervalId);
        activeMonitors.delete(id);
        log('refresh', `removed monitor id=${id}`);
      }
    }

    // Add new or update existing monitors
    for (const monitor of monitors) {
      if (!activeMonitors.has(monitor.id)) {
        startMonitorLoop(monitor);
        log(
          'refresh',
          `added monitor id=${monitor.id} name=${monitor.name || monitor.url} type=${monitor.type} interval=${monitor.interval} retries=${monitor.retries}`
        );
      } else {
        const current = activeMonitors.get(monitor.id);
        if (monitorChanged(current.monitor, monitor)) {
          clearInterval(current.intervalId);
          startMonitorLoop(monitor, current.lastStatus);
          log(
            'refresh',
            `restarted monitor id=${monitor.id} name=${monitor.name || monitor.url} changed=[${changedFields(current.monitor, monitor).join(',')}]`
          );
        }
      }
    }
  } catch (err) {
    console.error('Error refreshing monitors:', err);
  }
}

async function start() {
  await initDB();
  log('daemon', 'worker started, monitoring...');
  console.log('Daemon started. Monitoring...');

  refreshMonitors();
  // Check for new monitors every 10 seconds
  setInterval(refreshMonitors, 10000);
}

start();
