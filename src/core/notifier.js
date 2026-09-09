import notifier from 'node-notifier';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { getSmtpSettings } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function sendWebhook(webhookUrl, event, monitor) {
  if (!webhookUrl) return;

  try {
    const payload = {
      event: event,
      monitor: {
        name: monitor.name,
        url: monitor.url,
        status: event === 'monitor_down' ? 'down' : 'up',
        time: new Date().toISOString()
      }
    };

    await axios.post(webhookUrl, payload);
  } catch (error) {
    console.error(`Failed to send webhook to ${webhookUrl}:`, error.message);
  }
}

export function sendNotification(title, message, options = {}) {
  try {
    const iconPath = path.join(__dirname, '../assets/icon.png');

    notifier.notify({
      title: title,
      message: message,
      icon: iconPath,
      contentImage: iconPath,
      appID: 'Uptime Kit',
      sound: options.sound !== false,
      wait: false,
      ...options
    });
  } catch (error) {
    console.error('Failed to send notification:', error.message);
  }
}

export async function sendEmail(subject, htmlBody, to = null) {
  const settings = getSmtpSettings();
  if (!settings) return false;

  const recipients = (to || settings.to || '')
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
  if (recipients.length === 0) return false;

  try {
    const port = parseInt(settings.port, 10);
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: port,
      secure: port === 465,
      auth: {
        user: settings.user,
        pass: settings.pass
      }
    });

    await transport.sendMail({
      from: settings.from || settings.user,
      to: recipients.join(', '),
      subject: subject,
      html: htmlBody
    });

    return true;
  } catch (error) {
    console.error('Failed to send email:', error.message);
    return false;
  }
}

function buildEmailHtml(title, monitor, extra = '') {
  const displayName = monitor.name || monitor.url;
  const time = new Date().toISOString();
  return `
    <div style="font-family: Arial, sans-serif; padding: 16px; background: #f5f5f5;">
      <h2 style="color: #333; margin-top: 0;">${title}</h2>
      <table style="background: #fff; border-radius: 6px; padding: 16px; border-collapse: collapse;">
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Monitor</td><td style="padding: 4px;"><strong>${displayName}</strong></td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">URL</td><td style="padding: 4px;">${monitor.url || '—'}</td></tr>
        <tr><td style="padding: 4px 12px 4px 0; color: #666;">Time</td><td style="padding: 4px;">${time}</td></tr>
        ${extra}
      </table>
    </div>
  `;
}

export async function notifyMonitorDown(monitor) {
  const displayName = monitor.name || monitor.url;
  sendNotification('❌ Monitor Down', `${displayName} is not responding`, { sound: true });

  if (monitor.webhook_url) {
    sendWebhook(monitor.webhook_url, 'monitor_down', monitor);
  }

  await sendEmail(
    `[UptimeKit] Monitor Down — ${displayName}`,
    buildEmailHtml(
      '❌ Monitor Down',
      monitor,
      `<tr><td style="padding: 4px 12px 4px 0; color: #666;">Status</td><td style="padding: 4px;"><strong style="color: #d32f2f;">down</strong></td></tr>`
    ),
    monitor.smtp_to
  );
}

export async function notifyMonitorUp(monitor) {
  const displayName = monitor.name || monitor.url;
  sendNotification('✅ Monitor Back Up', `${displayName} is now responding`, { sound: true });

  if (monitor.webhook_url) {
    sendWebhook(monitor.webhook_url, 'monitor_up', monitor);
  }

  await sendEmail(
    `[UptimeKit] Monitor Back Up — ${displayName}`,
    buildEmailHtml(
      '✅ Monitor Back Up',
      monitor,
      `<tr><td style="padding: 4px 12px 4px 0; color: #666;">Status</td><td style="padding: 4px;"><strong style="color: #2e7d32;">up</strong></td></tr>`
    ),
    monitor.smtp_to
  );
}

export async function notifySSLExpiring(monitor, daysRemaining) {
  const displayName = monitor.name || monitor.url;
  let title, message;

  if (daysRemaining <= 7) {
    title = '🚨 SSL Certificate Critical';
    message = `${displayName} certificate expires in ${daysRemaining} days!`;
  } else if (daysRemaining <= 14) {
    title = '⚠️ SSL Certificate Warning';
    message = `${displayName} certificate expires in ${daysRemaining} days`;
  } else {
    return;
  }

  sendNotification(title, message, { sound: true });

  if (monitor.webhook_url) {
    sendWebhook(monitor.webhook_url, 'ssl_expiring', {
      ...monitor,
      daysRemaining
    });
  }

  await sendEmail(
    `[UptimeKit] ${title} — ${displayName}`,
    buildEmailHtml(
      title,
      monitor,
      `<tr><td style="padding: 4px 12px 4px 0; color: #666;">Expires in</td><td style="padding: 4px;"><strong>${daysRemaining} days</strong></td></tr>`
    ),
    monitor.smtp_to
  );
}

export async function notifySSLExpired(monitor) {
  const displayName = monitor.name || monitor.url;
  sendNotification('❌ SSL Certificate Expired', `${displayName} certificate has expired!`, { sound: true });

  if (monitor.webhook_url) {
    sendWebhook(monitor.webhook_url, 'ssl_expired', monitor);
  }

  await sendEmail(
    `[UptimeKit] SSL Certificate Expired — ${displayName}`,
    buildEmailHtml('❌ SSL Certificate Expired', monitor),
    monitor.smtp_to
  );
}

export async function notifySSLValid(monitor) {
  const displayName = monitor.name || monitor.url;
  sendNotification('✅ SSL Certificate Valid', `${displayName} certificate is now valid`, { sound: true });

  if (monitor.webhook_url) {
    sendWebhook(monitor.webhook_url, 'ssl_valid', monitor);
  }

  await sendEmail(
    `[UptimeKit] SSL Certificate Valid — ${displayName}`,
    buildEmailHtml('✅ SSL Certificate Valid', monitor),
    monitor.smtp_to
  );
}
