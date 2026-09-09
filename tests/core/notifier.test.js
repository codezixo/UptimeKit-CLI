/**
 * Unit tests for the notifier module
 * Tests notification functions with mocked dependencies
 */

import { jest } from '@jest/globals';

jest.unstable_mockModule('node-notifier', () => ({
  default: {
    notify: jest.fn()
  }
}));

jest.unstable_mockModule('axios', () => ({
  default: {
    post: jest.fn().mockResolvedValue({ status: 200 })
  }
}));

jest.unstable_mockModule('nodemailer', () => ({
  default: {
    createTransport: jest.fn(() => ({
      sendMail: jest.fn().mockResolvedValue({ accepted: ['alice@example.com'] })
    }))
  }
}));

jest.unstable_mockModule('../../src/core/db.js', () => ({
  getSmtpSettings: jest.fn()
}));

// Import mocked modules
const notifier = (await import('node-notifier')).default;
const axios = (await import('axios')).default;
const nodemailer = (await import('nodemailer')).default;
const { getSmtpSettings } = await import('../../src/core/db.js');

const {
  sendNotification,
  sendWebhook,
  sendEmail,
  notifyMonitorDown,
  notifyMonitorUp,
  notifySSLExpiring,
  notifySSLExpired,
  notifySSLValid
} = await import('../../src/core/notifier.js');

const smtpConfig = {
  host: 'smtp.gmail.com',
  port: '587',
  user: 'alerts@gmail.com',
  pass: 'secret',
  from: 'UptimeKit <alerts@gmail.com>',
  to: 'alice@example.com,bob@example.com'
};

describe('Notifier Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getSmtpSettings.mockReturnValue(null);
  });

  describe('sendNotification', () => {
    it('should call notifier.notify with correct parameters', () => {
      sendNotification('Test Title', 'Test Message');

      expect(notifier.notify).toHaveBeenCalledTimes(1);
      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Test Title',
          message: 'Test Message',
          appID: 'Uptime Kit'
        })
      );
    });

    it('should include custom options', () => {
      sendNotification('Title', 'Message', { sound: false });

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          sound: false
        })
      );
    });
  });

  describe('sendWebhook', () => {
    const mockMonitor = {
      name: 'Test Site',
      url: 'https://test.com',
      webhook_url: 'https://webhook.example.com/hook'
    };

    it('should send webhook for monitor_down event', async () => {
      await sendWebhook(mockMonitor.webhook_url, 'monitor_down', mockMonitor);

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        'https://webhook.example.com/hook',
        expect.objectContaining({
          event: 'monitor_down',
          monitor: expect.objectContaining({
            name: 'Test Site',
            url: 'https://test.com',
            status: 'down'
          })
        })
      );
    });

    it('should send webhook for monitor_up event', async () => {
      await sendWebhook(mockMonitor.webhook_url, 'monitor_up', mockMonitor);

      expect(axios.post).toHaveBeenCalledWith(
        'https://webhook.example.com/hook',
        expect.objectContaining({
          event: 'monitor_up',
          monitor: expect.objectContaining({
            status: 'up'
          })
        })
      );
    });

    it('should not send webhook when webhookUrl is null', async () => {
      await sendWebhook(null, 'monitor_down', mockMonitor);

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should not send webhook when webhookUrl is undefined', async () => {
      await sendWebhook(undefined, 'monitor_down', mockMonitor);

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should handle webhook errors gracefully', async () => {
      axios.post.mockRejectedValueOnce(new Error('Network error'));

      await expect(sendWebhook(mockMonitor.webhook_url, 'monitor_down', mockMonitor)).resolves.not.toThrow();
    });
  });

  describe('sendEmail', () => {
    it('should send email to all global recipients when configured', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);

      await expect(sendEmail('[UptimeKit] Test', '<p>Hello</p>')).resolves.toBe(true);

      expect(nodemailer.createTransport).toHaveBeenCalledWith({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
          user: 'alerts@gmail.com',
          pass: 'secret'
        }
      });

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'UptimeKit <alerts@gmail.com>',
          to: 'alice@example.com, bob@example.com',
          subject: '[UptimeKit] Test',
          html: '<p>Hello</p>'
        })
      );
    });

    it('should use monitor-specific to when provided', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);

      await expect(sendEmail('[UptimeKit] Test', '<p>Hello</p>', 'ops@example.com')).resolves.toBe(true);

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@example.com' }));
    });

    it('should use secure true when port is 465', async () => {
      getSmtpSettings.mockReturnValue({ ...smtpConfig, port: '465' });

      await expect(sendEmail('[UptimeKit] Test', '<p>Hello</p>')).resolves.toBe(true);

      expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
    });

    it('should not send email when SMTP is not configured', async () => {
      getSmtpSettings.mockReturnValue(null);

      await expect(sendEmail('[UptimeKit] Test', '<p>Hello</p>')).resolves.toBe(false);

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('should not send email when no recipients are configured', async () => {
      getSmtpSettings.mockReturnValue({ ...smtpConfig, to: null });

      await expect(sendEmail('[UptimeKit] Test', '<p>Hello</p>')).resolves.toBe(false);

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });

    it('should handle email errors gracefully', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);
      const transport = nodemailer.createTransport();
      transport.sendMail.mockRejectedValueOnce(new Error('SMTP error'));

      await expect(sendEmail('[UptimeKit] Test', '<p>Hello</p>')).resolves.toBe(false);
    });
  });

  describe('notifyMonitorDown', () => {
    it('should send notification with monitor name', async () => {
      const monitor = { name: 'My Site', url: 'https://mysite.com', webhook_url: null };

      await notifyMonitorDown(monitor);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '❌ Monitor Down',
          message: 'My Site is not responding'
        })
      );
    });

    it('should fallback to URL when name is not set', async () => {
      const monitor = { name: null, url: 'https://mysite.com', webhook_url: null };

      await notifyMonitorDown(monitor);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'https://mysite.com is not responding'
        })
      );
    });

    it('should send webhook when webhook_url is set', async () => {
      const monitor = {
        name: 'My Site',
        url: 'https://mysite.com',
        webhook_url: 'https://webhook.example.com'
      };

      await notifyMonitorDown(monitor);

      expect(axios.post).toHaveBeenCalled();
    });

    it('should send email to monitor smtp_to when SMTP is configured', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);
      const monitor = { name: 'My Site', url: 'https://mysite.com', webhook_url: null, smtp_to: 'ops@example.com' };

      await notifyMonitorDown(monitor);

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[UptimeKit] Monitor Down — My Site',
          to: 'ops@example.com'
        })
      );
    });

    it('should send email to global recipients when monitor smtp_to is not set', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);
      const monitor = { name: 'My Site', url: 'https://mysite.com', webhook_url: null };

      await notifyMonitorDown(monitor);

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'alice@example.com, bob@example.com' })
      );
    });

    it('should not send email when SMTP is not configured', async () => {
      const monitor = { name: 'My Site', url: 'https://mysite.com', webhook_url: null, smtp_to: 'ops@example.com' };

      await notifyMonitorDown(monitor);

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });
  });

  describe('notifyMonitorUp', () => {
    it('should send notification with monitor name', async () => {
      const monitor = { name: 'My Site', url: 'https://mysite.com', webhook_url: null };

      await notifyMonitorUp(monitor);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '✅ Monitor Back Up',
          message: 'My Site is now responding'
        })
      );
    });

    it('should send webhook when webhook_url is set', async () => {
      const monitor = {
        name: 'My Site',
        url: 'https://mysite.com',
        webhook_url: 'https://webhook.example.com'
      };

      await notifyMonitorUp(monitor);

      expect(axios.post).toHaveBeenCalled();
    });

    it('should send email when SMTP is configured', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);
      const monitor = { name: 'My Site', url: 'https://mysite.com', webhook_url: null, smtp_to: 'ops@example.com' };

      await notifyMonitorUp(monitor);

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[UptimeKit] Monitor Back Up — My Site'
        })
      );
    });

    it('should not send email when SMTP is not configured', async () => {
      const monitor = { name: 'My Site', url: 'https://mysite.com', webhook_url: null };

      await notifyMonitorUp(monitor);

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });
  });

  describe('notifySSLExpiring', () => {
    const monitor = { name: 'SSL Site', url: 'https://secure.com', webhook_url: null };

    it('should send critical notification when days <= 7', async () => {
      await notifySSLExpiring(monitor, 5);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '🚨 SSL Certificate Critical',
          message: 'SSL Site certificate expires in 5 days!'
        })
      );
    });

    it('should send warning notification when days <= 14', async () => {
      await notifySSLExpiring(monitor, 10);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '⚠️ SSL Certificate Warning',
          message: 'SSL Site certificate expires in 10 days'
        })
      );
    });

    it('should not send notification when days > 14', async () => {
      await notifySSLExpiring(monitor, 30);

      expect(notifier.notify).not.toHaveBeenCalled();
    });

    it('should send webhook for ssl_expiring event', async () => {
      const monitorWithWebhook = {
        ...monitor,
        webhook_url: 'https://webhook.example.com'
      };

      await notifySSLExpiring(monitorWithWebhook, 5);

      expect(axios.post).toHaveBeenCalledWith(
        'https://webhook.example.com',
        expect.objectContaining({
          event: 'ssl_expiring'
        })
      );
    });

    it('should send email when SMTP is configured', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);
      const monitorWithSmtp = { ...monitor, smtp_to: 'ops@example.com' };

      await notifySSLExpiring(monitorWithSmtp, 5);

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[UptimeKit] 🚨 SSL Certificate Critical — SSL Site',
          to: 'ops@example.com'
        })
      );
    });

    it('should not send email when SMTP is not configured', async () => {
      await notifySSLExpiring(monitor, 5);

      expect(nodemailer.createTransport).not.toHaveBeenCalled();
    });
  });

  describe('notifySSLExpired', () => {
    it('should send expired notification', async () => {
      const monitor = { name: 'SSL Site', url: 'https://secure.com', webhook_url: null };

      await notifySSLExpired(monitor);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '❌ SSL Certificate Expired',
          message: 'SSL Site certificate has expired!'
        })
      );
    });

    it('should send email when SMTP is configured', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);
      const monitor = { name: 'SSL Site', url: 'https://secure.com', webhook_url: null, smtp_to: 'ops@example.com' };

      await notifySSLExpired(monitor);

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[UptimeKit] SSL Certificate Expired — SSL Site'
        })
      );
    });
  });

  describe('notifySSLValid', () => {
    it('should send valid notification', async () => {
      const monitor = { name: 'SSL Site', url: 'https://secure.com', webhook_url: null };

      await notifySSLValid(monitor);

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '✅ SSL Certificate Valid',
          message: 'SSL Site certificate is now valid'
        })
      );
    });

    it('should send email when SMTP is configured', async () => {
      getSmtpSettings.mockReturnValue(smtpConfig);
      const monitor = { name: 'SSL Site', url: 'https://secure.com', webhook_url: null, smtp_to: 'ops@example.com' };

      await notifySSLValid(monitor);

      const transport = nodemailer.createTransport.mock.results[0].value;
      expect(transport.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: '[UptimeKit] SSL Certificate Valid — SSL Site'
        })
      );
    });
  });
});
