import { z } from 'zod';
import { updateMonitor, getMonitorByIdOrName, initDB } from '../core/db.js';
import chalk from 'chalk';
import readline from 'readline';

const MonitorSchema = z.object({
  url: z.string().min(1).optional(),
  type: z.enum(['http', 'icmp', 'dns', 'ssl', 'graphql']).optional(),
  interval: z.number().int().min(1).positive().optional(),
  retries: z.number().int().min(0).positive().optional(),
  name: z.string().optional(),
  webhook_url: z.string().nullable().optional(),
  smtp_to: z.string().nullable().optional(),
  group_name: z.string().nullable().optional(),
  check_config: z.string().nullable().optional()
});

export function registerEditCommand(program) {
  program
    .command('edit <idOrName>')
    .description('Edit an existing monitor')
    .option('-u, --url <url>', 'New URL')
    .option('-t, --type <type>', 'New type (http, icmp, dns, ssl, graphql)')
    .option('-i, --interval <seconds>', 'New interval in seconds')
    .option('-r, --retries <number>', 'Check retries before notifications are send', '0')
    .option('-n, --name <name>', 'New name')
    .option('-w, --webhook <url>', 'New webhook URL')
    .option(
      '-s, --smtp-to <recipients>',
      'Email recipient(s) for SMTP notifications (comma-separated, use "none" to remove)'
    )
    .option('-g, --group <group>', 'New group name (use "none" to remove from group)')
    .option('-q, --query <query>', 'New GraphQL query (graphql type only)')
    .action(async (idOrName, options) => {
      try {
        await initDB();
        const monitor = getMonitorByIdOrName(idOrName);

        if (!monitor) {
          console.error(chalk.red(`Monitor '${idOrName}' not found.`));
          return;
        }

        let updates = {};

        // If flags are provided, use them
        if (options.url) updates.url = options.url;
        if (options.type) updates.type = options.type;
        if (options.interval) updates.interval = parseInt(options.interval, 10);
        if (options.retries) updates.retries = parseInt(options.retries, 10);
        if (options.name) updates.name = options.name;
        if (options.webhook) updates.webhook_url = options.webhook;
        if (options.smtpTo !== undefined) {
          updates.smtp_to = options.smtpTo.toLowerCase() === 'none' ? null : options.smtpTo;
        }
        if (options.group !== undefined) {
          updates.group_name = options.group.toLowerCase() === 'none' ? null : options.group;
        }
        if (options.query !== undefined) {
          const query = options.query.trim();
          const currentConfig = monitor.check_config ? JSON.parse(monitor.check_config) : {};
          if (query.toLowerCase() === 'none') {
            delete currentConfig.query;
            updates.check_config = Object.keys(currentConfig).length ? JSON.stringify(currentConfig) : null;
          } else {
            updates.check_config = JSON.stringify({ ...currentConfig, query });
          }
        }

        // If no flags provided, go interactive
        if (Object.keys(updates).length === 0) {
          console.log(chalk.blue(`Editing monitor: ${monitor.name} (${monitor.url})`));
          console.log(chalk.gray('Press Enter to keep current value.'));

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          const question = q => new Promise(resolve => rl.question(q, ans => resolve(ans)));

          const newName = await question(`Name [${monitor.name}]: `);
          if (newName.trim()) updates.name = newName.trim();

          const newUrl = await question(`URL [${monitor.url}]: `);
          if (newUrl.trim()) updates.url = newUrl.trim();

          const newType = await question(`Type [${monitor.type}]: `);
          if (newType.trim()) updates.type = newType.trim();

          const newInterval = await question(`Interval [${monitor.interval}]: `);
          if (newInterval.trim()) updates.interval = parseInt(newInterval.trim(), 10);

          const newRetries = await question(`Retries [${monitor.retries}]: `);
          if (newRetries.trim()) updates.retries = parseInt(newRetries.trim(), 10);

          const currentWebhook = monitor.webhook_url || 'none';
          const newWebhook = await question(`Webhook URL [${currentWebhook}]: `);
          if (newWebhook.trim()) {
            updates.webhook_url = newWebhook.trim() === 'none' ? null : newWebhook.trim();
          }

          const currentSmtpTo = monitor.smtp_to || 'none';
          const newSmtpTo = await question(`SMTP Recipients (comma-separated) [${currentSmtpTo}]: `);
          if (newSmtpTo.trim()) {
            updates.smtp_to = newSmtpTo.trim().toLowerCase() === 'none' ? null : newSmtpTo.trim();
          }

          const currentGroup = monitor.group_name || 'none';
          const newGroup = await question(`Group [${currentGroup}]: `);
          if (newGroup.trim()) {
            updates.group_name = newGroup.trim().toLowerCase() === 'none' ? null : newGroup.trim();
          }

          const currentQuery = monitor.check_config ? JSON.parse(monitor.check_config).query || 'none' : 'none';
          const newQuery = await question(`GraphQL Query (graphql type only) [${currentQuery}]: `);
          if (newQuery.trim()) {
            const currentConfig = monitor.check_config ? JSON.parse(monitor.check_config) : {};
            if (newQuery.trim().toLowerCase() === 'none') {
              delete currentConfig.query;
              updates.check_config = Object.keys(currentConfig).length ? JSON.stringify(currentConfig) : null;
            } else {
              updates.check_config = JSON.stringify({ ...currentConfig, query: newQuery.trim() });
            }
          }

          rl.close();
        }

        if (Object.keys(updates).length === 0) {
          console.log(chalk.yellow('No changes made.'));
          return;
        }

        // Validate updates
        const data = MonitorSchema.parse(updates);

        // Enhanced Validation
        const finalType = data.type || monitor.type;
        const finalUrl = data.url || monitor.url;

        if (finalType === 'http' || finalType === 'graphql') {
          try {
            const u = new URL(finalUrl);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
              console.error(chalk.red('Error: HTTP monitor requires http:// or https:// URL.'));
              return;
            }
          } catch (err) {
            console.error(chalk.red('Error: Invalid URL provided for HTTP monitor.'));
            return;
          }
        } else if (finalType === 'icmp' || finalType === 'dns') {
          // Validate hostname or IP address
          const host = finalUrl
            .replace(/^https?:\/\//, '')
            .replace(/\/.+$/, '')
            .trim();

          const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
          const isIPv4Format = ipv4Regex.test(host);

          let isValid = false;
          if (isIPv4Format) {
            const octets = host.split('.').map(Number);
            isValid = octets.every(octet => octet >= 0 && octet <= 255);
          } else {
            const hostnameRegex = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*$/;
            isValid = hostnameRegex.test(host);
          }

          if (!isValid) {
            console.error(chalk.red(`Error: Invalid hostname or IP '${finalUrl}' for ${finalType} monitor.`));
            return;
          }
        }

        // Ensure GraphQL monitors have a query (default to __typename health check)
        if (finalType === 'graphql' && !data.check_config) {
          const currentConfig = monitor.check_config ? JSON.parse(monitor.check_config) : {};
          data.check_config = JSON.stringify({ ...currentConfig, query: currentConfig.query || '{ __typename }' });
        }

        updateMonitor(monitor.id, data);
        console.log(chalk.green(`Monitor '${monitor.name}' updated successfully.`));
      } catch (err) {
        if (err instanceof z.ZodError) {
          console.error(chalk.red('Validation Error:'));
          err.errors.forEach(e => console.error(`- ${e.path.join('.')}: ${e.message}`));
        } else {
          console.error(chalk.red('Error updating monitor:'), err.message);
        }
      }
    });
}
