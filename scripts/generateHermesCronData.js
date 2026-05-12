import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

const root = resolve(new URL('..', import.meta.url).pathname);
const cronPath = process.env.HERMES_CRON_JOBS_PATH || resolve(homedir(), '.hermes/cron/jobs.json');
const publicOutPath = resolve(root, 'public/data/hermes-cron-status.json');
const distOutPath = resolve(root, 'dist/data/hermes-cron-status.json');

const DISCORD_CHANNEL_NAMES = {
  '1492875309299662951': '#📈｜美股',
  '1493029413481222198': '#⚙️｜运维',
  '1494090512414543952': '#📌｜panel',
};

const formatLocalTimeFromUtc = (hour, minute) => {
  const sample = new Date();
  sample.setUTCHours(hour, minute, 0, 0);
  return new Intl.DateTimeFormat('de-DE', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Europe/Berlin',
  }).format(sample);
};

const dayName = (day) => ({
  '0': '周日',
  '1': '周一',
  '2': '周二',
  '3': '周三',
  '4': '周四',
  '5': '周五',
  '6': '周六',
  '7': '周日',
}[day] || day);

const describeDayOfWeek = (dow) => {
  if (!dow || dow === '*') return '每天';
  if (dow === '1-5') return '工作日';
  if (dow === '0,6' || dow === '6,0') return '周末';
  if (dow.includes('-')) {
    const [start, end] = dow.split('-');
    return `${dayName(start)}至${dayName(end)}`;
  }
  return dow.split(',').map(dayName).join('、');
};

const describeDayOfMonth = (dom) => {
  if (!dom || dom === '*') return null;
  return `每月 ${dom.split(',').join('、')} 日`;
};

const describeCronSchedule = (schedule) => {
  const expression = typeof schedule === 'string' ? schedule : schedule?.expr || schedule?.display;
  if (!expression) return '—';
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;

  const [minute, hour, dom, month, dow] = parts;
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== '*') return expression;

  const localTime = formatLocalTimeFromUtc(Number(hour), Number(minute));
  const monthly = describeDayOfMonth(dom);
  const dayPart = monthly || describeDayOfWeek(dow);
  return `${dayPart} ${localTime} Berlin`;
};

const formatDeliverTarget = (deliver) => {
  const value = deliver || 'local';
  if (value === 'origin') return '当前会话';
  if (value === 'local') return '本地保存';
  if (value === 'discord') return 'Discord Home';
  if (value.startsWith('discord:#')) return value;
  if (!value.startsWith('discord:')) return value;

  const [, channelId, threadId] = value.split(':');
  const channelName = DISCORD_CHANNEL_NAMES[channelId];
  if (!channelName) return 'discord:未知频道';
  return threadId ? `discord:${channelName} / thread` : `discord:${channelName}`;
};

const normalizeRepeat = (repeat) => {
  if (!repeat) return { label: '—', completed: 0, times: null };
  if (typeof repeat === 'string') return { label: repeat, completed: 0, times: repeat };
  const completed = Number(repeat.completed || 0);
  const times = repeat.times ?? null;
  return {
    label: times === null ? '∞' : `${completed}/${times}`,
    completed,
    times,
  };
};

const deriveUiStatus = (job) => {
  const enabled = Boolean(job.enabled);
  const state = job.state || (enabled ? 'scheduled' : 'paused');
  const lastStatus = job.last_status || null;
  const lastStatusFailed = lastStatus === 'error' || lastStatus === 'failed';

  if (!enabled || state === 'paused') {
    return { group: 'paused', label: 'Paused' };
  }

  if (state === 'completed') {
    return { group: 'completed', label: 'Completed' };
  }

  if (state === 'error' || job.last_error || lastStatusFailed) {
    return { group: 'failed', label: 'Failed' };
  }

  if (job.last_delivery_error) {
    return { group: 'delivery_failed', label: 'Delivery Failed' };
  }

  if (state === 'scheduled') {
    return job.last_run_at
      ? { group: 'scheduled', label: 'Scheduled' }
      : { group: 'pending', label: 'Pending' };
  }

  return { group: state, label: state.replace(/_/g, ' ') };
};

const summarizeJob = (job) => {
  const repeat = normalizeRepeat(job.repeat);
  const skills = Array.isArray(job.skills) ? job.skills : (job.skill ? [job.skill] : []);
  const enabled = Boolean(job.enabled);
  const state = job.state || (enabled ? 'scheduled' : 'paused');
  const lastStatus = job.last_status || null;
  const uiStatus = deriveUiStatus(job);

  return {
    id: job.id,
    name: job.name || job.id,
    schedule: job.schedule_display || job.schedule?.display || job.schedule?.expr || '—',
    scheduleLabel: describeCronSchedule(job.schedule?.expr || job.schedule_display || job.schedule?.display || job.schedule),
    repeat: repeat.label,
    completedRuns: repeat.completed,
    enabled,
    state,
    statusGroup: uiStatus.group,
    statusLabel: uiStatus.label,
    lastStatus,
    lastError: job.last_error || null,
    lastDeliveryError: job.last_delivery_error || null,
    createdAt: job.created_at || null,
    nextRunAt: job.next_run_at || null,
    lastRunAt: job.last_run_at || null,
    pausedAt: job.paused_at || null,
    pausedReason: job.paused_reason || null,
    deliver: job.deliver || 'local',
    deliverLabel: formatDeliverTarget(job.deliver),
    provider: job.provider || null,
    model: job.model || null,
    skills,
    script: job.script || null,
    origin: job.origin ? {
      platform: job.origin.platform || null,
      chatId: job.origin.chat_id || null,
      chatName: job.origin.chat_name || null,
      threadId: job.origin.thread_id || null,
    } : null,
  };
};

let jobs = [];
let updatedAt = null;
let readError = null;

if (existsSync(cronPath)) {
  try {
    const raw = JSON.parse(readFileSync(cronPath, 'utf8'));
    updatedAt = raw.updated_at || null;
    jobs = (raw.jobs || []).map(summarizeJob);
  } catch (error) {
    readError = error.message;
  }
} else {
  readError = `Cron jobs file not found: ${cronPath}`;
}

jobs.sort((a, b) => {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return String(a.nextRunAt || '9999').localeCompare(String(b.nextRunAt || '9999'));
});

const summary = {
  total: jobs.length,
  active: jobs.filter((job) => job.enabled && job.state !== 'paused').length,
  paused: jobs.filter((job) => !job.enabled || job.state === 'paused').length,
  ok: jobs.filter((job) => ['scheduled', 'pending', 'completed'].includes(job.statusGroup)).length,
  error: jobs.filter((job) => ['failed', 'delivery_failed'].includes(job.statusGroup)).length,
  withDeliveryError: jobs.filter((job) => Boolean(job.lastDeliveryError)).length,
};

const payload = {
  generatedAt: new Date().toISOString(),
  source: {
    path: cronPath,
    updatedAt,
    readError,
  },
  summary,
  jobs,
};

const output = `${JSON.stringify(payload, null, 2)}\n`;
const outPaths = [publicOutPath];
if (existsSync(resolve(root, 'dist'))) outPaths.push(distOutPath);

for (const outPath of outPaths) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, output);
}

console.log(`Generated Hermes cron status: ${jobs.length} jobs -> ${outPaths.join(', ')}`);
if (readError) console.warn(readError);
