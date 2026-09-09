import chalk from 'chalk';
import readline from 'readline';
import {
  initDB,
  getNotificationSettings,
  setNotificationSettings,
  getSmtpSettings,
  setSmtpSettings,
  clearSmtpSettings
} from '../core/db.js';
import { sendEmail } from '../core/notifier.js';

function maskPassword(pass) {
  if (!pass) return null;
  return '•'.repeat(Math.max(4, Math.min(pass.length, 12)));
}

export function registerNotificationsCommand(program) {
  const notificationsCmd = program
    .command('notifications')
    .alias('notif')
    .description('Manage desktop and SMTP notifications');

  notificationsCmd
    .command('enable')
    .description('Enable desktop notifications')
    .action(() => {
      const success = setNotificationSettings(true);
      if (success) {
        console.log(chalk.green('✓ Desktop notifications enabled'));
      } else {
        console.log(chalk.red('✗ Failed to enable notifications'));
        process.exit(1);
      }
    });

  notificationsCmd
    .command('disable')
    .description('Disable desktop notifications')
    .action(() => {
      const success = setNotificationSettings(false);
      if (success) {
        console.log(chalk.yellow('✓ Desktop notifications disabled'));
      } else {
        console.log(chalk.red('✗ Failed to disable notifications'));
        process.exit(1);
      }
    });

  notificationsCmd
    .command('status')
    .description('Show notification status')
    .action(() => {
      const enabled = getNotificationSettings();
      if (enabled) {
        console.log(chalk.green('✓ Desktop notifications are enabled'));
      } else {
        console.log(chalk.yellow('○ Desktop notifications are disabled'));
      }
    });

  const smtpCmd = notificationsCmd
    .command('smtp')
    .description('Configure SMTP email notifications (run with no flags for interactive setup)')
    .option('--host <host>', 'SMTP server host (e.g. smtp.gmail.com)')
    .option('--port <port>', 'SMTP server port (e.g. 587)')
    .option('--user <user>', 'SMTP username (usually an email address)')
    .option('--pass <pass>', 'SMTP password or app-specific password')
    .option('--from <from>', 'Sender address (defaults to username)')
    .option('--to <recipients>', 'Default recipients, comma-separated (per-monitor smtp_to overrides this)')
    .action(async options => {
      await initDB();
      let host = options.host;
      let port = options.port;
      let user = options.user;
      let pass = options.pass;
      let from = options.from;
      let to = options.to;

      if (!host || !port || !user || !pass) {
        console.log(chalk.blue('SMTP interactive setup (press Enter to keep defaults):'));
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        const question = q => new Promise(resolve => rl.question(q, ans => resolve(ans)));

        const existing = getSmtpSettings();
        host =
          host ||
          (await question(`SMTP host [${existing?.host || 'smtp.gmail.com'}]: `)) ||
          existing?.host ||
          'smtp.gmail.com';
        port = port || (await question(`SMTP port [${existing?.port || '587'}]: `)) || existing?.port || '587';
        user = user || (await question(`SMTP username [${existing?.user || ''}]: `)) || existing?.user;
        pass = pass || (await question(`SMTP password [${existing?.pass ? 'set' : ''}]: `)) || existing?.pass;
        from = from || (await question(`From address [${existing?.from || user}]: `)) || existing?.from;
        to =
          to ||
          (await question(`Default recipients (comma-separated) [${existing?.to || 'none'}]: `)) ||
          existing?.to ||
          null;
        rl.close();
      }

      if (!host || !user || !pass) {
        console.log(chalk.red('✗ SMTP host, username, and password are required.'));
        return;
      }

      const parsedPort = parseInt(port, 10);
      if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        console.log(chalk.red('✗ Invalid SMTP port. Must be a number between 1 and 65535.'));
        return;
      }

      const success = setSmtpSettings({ host, port: parsedPort, user, pass, from, to });
      if (success) {
        console.log(chalk.green('✓ SMTP settings saved'));
      } else {
        console.log(chalk.red('✗ Failed to save SMTP settings'));
        process.exit(1);
      }
    });

  smtpCmd
    .command('status')
    .description('Show SMTP configuration')
    .action(async () => {
      await initDB();
      const settings = getSmtpSettings();
      if (!settings) {
        console.log(chalk.yellow('○ SMTP is not configured. Run `upkit notif smtp` to set it up.'));
        return;
      }

      console.log(chalk.bold('SMTP Configuration'));
      console.log(`  Host:   ${settings.host}`);
      console.log(`  Port:   ${settings.port}`);
      console.log(`  User:   ${settings.user}`);
      console.log(`  Pass:   ${maskPassword(settings.pass)}`);
      if (settings.from) console.log(`  From:   ${settings.from}`);
      if (settings.to) console.log(`  To:     ${settings.to}`);
    });

  smtpCmd
    .command('test')
    .description('Send a test email')
    .action(async () => {
      await initDB();
      const settings = getSmtpSettings();
      if (!settings) {
        console.log(chalk.red('✗ SMTP is not configured. Run `upkit notif smtp` first.'));
        return;
      }

      const recipients = (settings.to || '')
        .split(',')
        .map(r => r.trim())
        .filter(Boolean);
      const to = recipients.length > 0 ? recipients.join(', ') : settings.from || settings.user;

      console.log(chalk.blue(`Sending test email to ${to}...`));
      const sent = await sendEmail(
        '[UptimeKit] Test Email',
        `<div style="font-family: Arial, sans-serif;"><h2>✅ UptimeKit Test Email</h2><p>If you received this, SMTP notifications are working correctly.</p><p>Time: ${new Date().toISOString()}</p></div>`,
        to
      );
      if (sent) {
        console.log(chalk.green('✓ Test email sent (check recipient inbox for delivery confirmation).'));
      } else {
        console.log(chalk.red('✗ Failed to send test email. Check your SMTP settings and network.'));
      }
    });

  smtpCmd
    .command('clear')
    .description('Remove SMTP configuration')
    .action(async () => {
      await initDB();
      const success = clearSmtpSettings();
      if (success) {
        console.log(chalk.yellow('✓ SMTP settings cleared'));
      } else {
        console.log(chalk.red('✗ Failed to clear SMTP settings'));
        process.exit(1);
      }
    });
}
