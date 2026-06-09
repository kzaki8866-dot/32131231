const http = require('http');

const BUMP_INTERVAL_MS = 120 * 60 * 1000;
const API_BASE = 'https://discord.com/api/v10';
const MANAGE_GUILD_PERMISSION = '32';
const EPHEMERAL_FLAG = 64;

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const defaultGuildId = process.env.GUILD_ID || null;
const defaultChannelId = process.env.REMINDER_CHANNEL_ID || null;
const autoStart = process.env.AUTO_START === 'true';
const port = Number(process.env.PORT || 3000);

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID environment variables.');
  process.exit(1);
}

const guildConfigs = new Map();
const timers = new Map();

const commands = [
  {
    name: 'setup',
    description: 'Set the channel for bump reminders',
    options: [
      {
        name: 'channel',
        description: 'Channel to post reminders in',
        type: 7,
        required: true,
        channel_types: [0, 5],
      },
    ],
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    dm_permission: false,
  },
  {
    name: 'start',
    description: 'Start automatic bump reminders every 120 minutes',
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    dm_permission: false,
  },
  {
    name: 'stop',
    description: 'Stop automatic bump reminders',
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    dm_permission: false,
  },
  {
    name: 'bump',
    description: 'Mark a bump as done and reset the 120-minute timer',
    dm_permission: false,
  },
  {
    name: 'status',
    description: 'Show bump reminder status for this server',
    dm_permission: false,
  },
  {
    name: 'remind',
    description: 'Send a bump reminder right now',
    default_member_permissions: MANAGE_GUILD_PERMISSION,
    dm_permission: false,
  },
];

function getGuildConfig(guildId) {
  if (!guildConfigs.has(guildId)) {
    guildConfigs.set(guildId, {
      channelId: guildId === defaultGuildId ? defaultChannelId : null,
      enabled: false,
      lastBumpAt: null,
      nextReminderAt: null,
    });
  }

  return guildConfigs.get(guildId);
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  if (minutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

async function discordRequest(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function registerCommands() {
  const route = defaultGuildId
    ? `/applications/${clientId}/guilds/${defaultGuildId}/commands`
    : `/applications/${clientId}/commands`;

  await discordRequest(route, {
    method: 'PUT',
    body: JSON.stringify(commands),
  });

  console.log(`Registered ${commands.length} slash commands.`);
}

function buildReminderEmbed() {
  return {
    color: 0x5865f2,
    title: 'Time to bump the server',
    description:
      "Run Disboard's `/bump` slash command now to promote this server.\n\nAfter bumping, run this bot's `/bump` command to reset the timer.",
    footer: { text: 'Reminders run every 120 minutes' },
  };
}

async function sendChannelMessage(channelId, payload) {
  return discordRequest(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function sendBumpReminder(guildId) {
  const config = getGuildConfig(guildId);

  if (!config.channelId) {
    return false;
  }

  await sendChannelMessage(config.channelId, {
    embeds: [buildReminderEmbed()],
  });

  config.nextReminderAt = Date.now() + BUMP_INTERVAL_MS;
  return true;
}

function clearGuildTimer(guildId) {
  const existing = timers.get(guildId);
  if (existing) {
    clearTimeout(existing);
    timers.delete(guildId);
  }
}

function scheduleGuildReminder(guildId, delayMs = BUMP_INTERVAL_MS) {
  clearGuildTimer(guildId);

  const config = getGuildConfig(guildId);
  config.nextReminderAt = Date.now() + delayMs;

  const timeout = setTimeout(async () => {
    timers.delete(guildId);

    const current = getGuildConfig(guildId);
    if (!current.enabled) {
      return;
    }

    try {
      await sendBumpReminder(guildId);
      scheduleGuildReminder(guildId, BUMP_INTERVAL_MS);
    } catch (error) {
      console.error(`Failed to send reminder for guild ${guildId}:`, error);
      scheduleGuildReminder(guildId, 60 * 1000);
    }
  }, delayMs);

  timers.set(guildId, timeout);
}

async function replyToInteraction(interaction, payload) {
  await discordRequest(`/interactions/${interaction.id}/${interaction.token}/callback`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

function getOption(interaction, name) {
  return interaction.data.options?.find((option) => option.name === name) || null;
}

async function handleInteraction(interaction) {
  if (interaction.type !== 2 || !interaction.guild_id) {
    return;
  }

  const guildId = interaction.guild_id;
  const guildConfig = getGuildConfig(guildId);
  const commandName = interaction.data.name;

  try {
    switch (commandName) {
      case 'setup': {
        const channelOption = getOption(interaction, 'channel');
        const channelId = channelOption?.value;

        if (!channelId) {
          await replyToInteraction(interaction, {
            type: 4,
            data: {
              content: 'You must choose a channel.',
              flags: EPHEMERAL_FLAG,
            },
          });
          break;
        }

        guildConfig.channelId = channelId;

        await replyToInteraction(interaction, {
          type: 4,
          data: {
            content: `Bump reminders will be sent in <#${channelId}>. Run \`/start\` to begin the 120-minute schedule.`,
            flags: EPHEMERAL_FLAG,
          },
        });
        break;
      }

      case 'start': {
        if (!guildConfig.channelId) {
          await replyToInteraction(interaction, {
            type: 4,
            data: {
              content: 'Set a reminder channel first with `/setup`, or set REMINDER_CHANNEL_ID on Render.',
              flags: EPHEMERAL_FLAG,
            },
          });
          break;
        }

        guildConfig.enabled = true;
        guildConfig.lastBumpAt = Date.now();
        scheduleGuildReminder(guildId, BUMP_INTERVAL_MS);

        await replyToInteraction(interaction, {
          type: 4,
          data: {
            content: `Automatic bump reminders started. Next reminder in **${formatDuration(BUMP_INTERVAL_MS)}**.`,
          },
        });
        break;
      }

      case 'stop': {
        guildConfig.enabled = false;
        guildConfig.nextReminderAt = null;
        clearGuildTimer(guildId);

        await replyToInteraction(interaction, {
          type: 4,
          data: {
            content: 'Automatic bump reminders stopped for this server.',
          },
        });
        break;
      }

      case 'bump': {
        guildConfig.lastBumpAt = Date.now();

        if (guildConfig.enabled && guildConfig.channelId) {
          scheduleGuildReminder(guildId, BUMP_INTERVAL_MS);
        }

        await replyToInteraction(interaction, {
          type: 4,
          data: {
            content: guildConfig.enabled
              ? `Bump recorded. Next reminder in **${formatDuration(BUMP_INTERVAL_MS)}**.`
              : 'Bump recorded. Run `/start` to enable automatic reminders.',
          },
        });
        break;
      }

      case 'status': {
        const lines = [
          `**Channel:** ${guildConfig.channelId ? `<#${guildConfig.channelId}>` : 'Not set'}`,
          `**Reminders:** ${guildConfig.enabled ? 'Running' : 'Stopped'}`,
        ];

        if (guildConfig.lastBumpAt) {
          lines.push(`**Last bump:** <t:${Math.floor(guildConfig.lastBumpAt / 1000)}:R>`);
        }

        if (guildConfig.enabled && guildConfig.nextReminderAt) {
          lines.push(`**Next reminder:** <t:${Math.floor(guildConfig.nextReminderAt / 1000)}:R>`);
        }

        await replyToInteraction(interaction, {
          type: 4,
          data: {
            embeds: [
              {
                color: 0x57f287,
                title: 'Bump Reminder Status',
                description: lines.join('\n'),
              },
            ],
            flags: EPHEMERAL_FLAG,
          },
        });
        break;
      }

      case 'remind': {
        if (!guildConfig.channelId) {
          await replyToInteraction(interaction, {
            type: 4,
            data: {
              content: 'Set a reminder channel first with `/setup`.',
              flags: EPHEMERAL_FLAG,
            },
          });
          break;
        }

        await sendBumpReminder(guildId);

        if (guildConfig.enabled) {
          scheduleGuildReminder(guildId, BUMP_INTERVAL_MS);
        }

        await replyToInteraction(interaction, {
          type: 4,
          data: {
            content: `Reminder sent in <#${guildConfig.channelId}>.`,
            flags: EPHEMERAL_FLAG,
          },
        });
        break;
      }

      default:
        await replyToInteraction(interaction, {
          type: 4,
          data: {
            content: 'Unknown command.',
            flags: EPHEMERAL_FLAG,
          },
        });
    }
  } catch (error) {
    console.error('Interaction error:', error);

    try {
      await replyToInteraction(interaction, {
        type: 4,
        data: {
          content: 'Something went wrong while running that command.',
          flags: EPHEMERAL_FLAG,
        },
      });
    } catch (replyError) {
      console.error('Failed to send error response:', replyError);
    }
  }
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'discord-bump-bot' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, () => {
    console.log(`Health server listening on port ${port}`);
  });
}

async function connectGateway() {
  const gateway = await discordRequest('/gateway/bot');
  let heartbeatInterval = null;
  let lastSequence = null;
  let sessionId = null;
  let resumeGatewayUrl = gateway.url;

  function spawnSocket(resume = false) {
    const params = new URLSearchParams({
      v: '10',
      encoding: 'json',
    });

    const ws = new WebSocket(`${resumeGatewayUrl}?${params}`);

    ws.addEventListener('open', () => {
      console.log(resume ? 'Resuming Discord gateway session...' : 'Connected to Discord gateway.');
    });

    ws.addEventListener('message', async (event) => {
      const payload = JSON.parse(event.data);

      if (payload.s !== null && payload.s !== undefined) {
        lastSequence = payload.s;
      }

      switch (payload.op) {
        case 10: {
          const interval = payload.d.heartbeat_interval;

          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
          }

          heartbeatInterval = setInterval(() => {
            ws.send(JSON.stringify({ op: 1, d: lastSequence }));
          }, interval);

          if (resume && sessionId) {
            ws.send(
              JSON.stringify({
                op: 6,
                d: {
                  token: `Bot ${token}`,
                  session_id: sessionId,
                  seq: lastSequence,
                },
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                op: 2,
                d: {
                  token: `Bot ${token}`,
                  intents: 1,
                  properties: {
                    os: 'linux',
                    browser: 'render',
                    device: 'render',
                  },
                },
              }),
            );
          }
          break;
        }

        case 11:
          break;

        case 0: {
          const { t, d } = payload;

          if (t === 'READY') {
            sessionId = d.session_id;
            resumeGatewayUrl = d.resume_gateway_url;
            console.log(`Logged in as ${d.user.username}#${d.user.discriminator}`);

            if (defaultGuildId && defaultChannelId && autoStart) {
              const config = getGuildConfig(defaultGuildId);
              config.channelId = defaultChannelId;
              config.enabled = true;
              config.lastBumpAt = Date.now();
              scheduleGuildReminder(defaultGuildId, BUMP_INTERVAL_MS);
              console.log(`Auto-started reminders for guild ${defaultGuildId}`);
            }
          }

          if (t === 'INTERACTION_CREATE') {
            await handleInteraction(d);
          }

          break;
        }

        case 7:
        case 9:
          ws.close();
          break;

        default:
          break;
      }
    });

    ws.addEventListener('close', () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      const shouldResume = Boolean(sessionId);
      console.log(shouldResume ? 'Gateway closed, resuming...' : 'Gateway closed, reconnecting...');

      setTimeout(() => {
        spawnSocket(shouldResume);
      }, 5000);
    });

    ws.addEventListener('error', (error) => {
      console.error('Gateway socket error:', error);
    });
  }

  spawnSocket(false);
}

async function start() {
  startHealthServer();
  await registerCommands();
  await connectGateway();
}

start().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});