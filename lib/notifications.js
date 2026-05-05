'use strict';

// Push notifications via ntfy.sh (or a self-hosted ntfy server).
// Fire-and-forget: failures are logged but never propagate to callers.

const https = require('https');
const { config } = require('./config');

// ---------------------------------------------------------------------------
// postNtfy
// ---------------------------------------------------------------------------
/**
 * POST a plain-text message to the configured ntfy topic.
 * Does nothing if notifications.ntfyTopic is unset.
 */
function postNtfy(title, message) {
  const n = config.notifications;
  if (!n || !n.ntfyTopic) return;

  const server = (n.ntfyServer || 'ntfy.sh').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const body   = Buffer.from(message, 'utf8');

  const req = https.request(
    {
      host   : server,
      path   : '/' + encodeURIComponent(n.ntfyTopic),
      method : 'POST',
      headers: {
        'Content-Type'  : 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        ...(title            ? { Title    : title               } : {}),
        ...(n.ntfyPriority   ? { Priority : String(n.ntfyPriority) } : {}),
      },
    },
    (res) => { res.resume(); },
  );
  req.on('error', (e) => console.warn('ntfy post failed:', e.message));
  req.write(body);
  req.end();
}

// ---------------------------------------------------------------------------
// notifyAction
// ---------------------------------------------------------------------------
/**
 * Fire a human-readable ntfy notification for Fox ESS write actions.
 * Called after a successful (errno === 0) proxy write response.
 */
function notifyAction(foxPath, body, responseParsed) {
  if (responseParsed?.errno !== 0) return; // only notify on success
  const b = body || {};

  if (foxPath === '/op/v3/device/scheduler/enable' || foxPath === '/op/v1/device/scheduler/enable') {
    // v3: no top-level enable flag — count non-remain-mode groups as active slots.
    // v1: count groups with enable === 1.
    const slots = Array.isArray(b.groups)
      ? b.groups.filter((g) => !g.isRemainMode && (g.enable == null || g.enable === 1)).length
      : 0;
    postNtfy('Fox ESS', `Scheduler updated (${slots} active slot${slots === 1 ? '' : 's'})`);
    return;
  }

  if (foxPath === '/op/v0/device/setting/set') {
    postNtfy('Fox ESS', `Setting "${b.key}" set to ${b.value}`);
    return;
  }

  // Fallback for any other admin write.
  postNtfy('Fox ESS', `Action: ${foxPath}`);
}

// ---------------------------------------------------------------------------
module.exports = { postNtfy, notifyAction };
