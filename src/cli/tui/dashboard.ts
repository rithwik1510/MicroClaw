import fs from 'fs';
import path from 'path';

import blessed from 'neo-blessed';

import { LOG_DIR } from '../../config.js';
import { listAuthProfiles } from '../../auth/auth-manager.js';
import {
  collectDoctorReport,
  collectLaunchCheckReport,
  collectStatusSnapshot,
  LaunchCheckReport,
} from '../health.js';
import { listToolServices } from '../../tools/service-supervisor.js';

function readTail(filePath: string, lines: number): string {
  if (!fs.existsSync(filePath)) return '';
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').slice(-lines).join('\n').trim();
}

function formatRuntimeEvents(
  status: ReturnType<typeof collectStatusSnapshot>,
  max = 8,
): string {
  if (status.recentRuntimeEvents.length === 0) {
    return 'No runtime events yet.';
  }
  return status.recentRuntimeEvents
    .slice(0, max)
    .map(
      (evt) =>
        `${evt.timestamp.slice(11, 19)} ${evt.eventType} ${evt.profileId} ${evt.chatJid}`,
    )
    .join('\n');
}

function formatLaunch(report: LaunchCheckReport | undefined): string {
  if (!report) {
    return 'Run Launch Check with `l` or `:` + `launch-check`.';
  }
  const lines = [
    `Result: ${report.pass ? 'PASS' : 'FAIL'}  (${report.checkedAt})`,
    '',
  ];
  for (const item of report.items) {
    lines.push(`${item.ok ? '[PASS]' : '[FAIL]'} ${item.key}`);
    lines.push(`  ${item.detail}`);
  }
  return lines.join('\n');
}

function formatDoctor(report: ReturnType<typeof collectDoctorReport>): string {
  if (report.healthy) return 'Doctor: healthy';
  return report.issues.map((issue) => `- ${issue}`).join('\n');
}

export async function runDashboardTui(): Promise<void> {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'MicroClaw Control Center',
    fullUnicode: true,
  });

  const root = blessed.box({
    parent: screen,
    width: '100%',
    height: '100%',
    style: { bg: '#12181f', fg: '#d7e0ea' },
  });

  const header = blessed.box({
    parent: root,
    top: 0,
    left: 0,
    width: '100%',
    height: 3,
    tags: true,
    content:
      ' {bold}MicroClaw Local Ops{/bold}  |  {cyan-fg}r{/cyan-fg} refresh  {cyan-fg}d{/cyan-fg} doctor  {cyan-fg}l{/cyan-fg} launch-check  {cyan-fg}:{/cyan-fg} palette  {cyan-fg}q{/cyan-fg} quit',
    style: { bg: '#1f2a36', fg: '#f2f6fa' },
    padding: { left: 1, top: 1 },
  });

  const statusBox = blessed.box({
    parent: root,
    label: ' Status ',
    top: 3,
    left: 0,
    width: '50%',
    height: '40%',
    border: 'line',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: { border: { fg: '#4e6b87' }, bg: '#16212b', fg: '#d7e0ea' },
    padding: { left: 1, right: 1 },
  });

  const eventsBox = blessed.box({
    parent: root,
    label: ' Runtime Events ',
    top: 3,
    left: '50%',
    width: '50%',
    height: '40%',
    border: 'line',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: { border: { fg: '#4e6b87' }, bg: '#16212b', fg: '#d7e0ea' },
    padding: { left: 1, right: 1 },
  });

  const doctorBox = blessed.box({
    parent: root,
    label: ' Doctor ',
    top: '43%',
    left: 0,
    width: '50%',
    height: '32%',
    border: 'line',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: { border: { fg: '#4e6b87' }, bg: '#101923', fg: '#ffe9d6' },
    padding: { left: 1, right: 1 },
  });

  const launchBox = blessed.box({
    parent: root,
    label: ' Launch Check ',
    top: '43%',
    left: '50%',
    width: '50%',
    height: '32%',
    border: 'line',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: { border: { fg: '#4e6b87' }, bg: '#101923', fg: '#d8fdd5' },
    padding: { left: 1, right: 1 },
  });

  const logBox = blessed.box({
    parent: root,
    label: ' Logs Tail ',
    bottom: 1,
    left: 0,
    width: '100%',
    height: '24%',
    border: 'line',
    tags: false,
    scrollable: true,
    alwaysScroll: true,
    style: { border: { fg: '#4e6b87' }, bg: '#0c141d', fg: '#b8c6d7' },
    padding: { left: 1, right: 1 },
  });

  const footer = blessed.box({
    parent: root,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    style: { bg: '#1f2a36', fg: '#d7e0ea' },
    content: ' Ready',
  });

  const prompt = blessed.prompt({
    parent: screen,
    border: 'line',
    width: '60%',
    height: 8,
    top: 'center',
    left: 'center',
    label: ' Command Palette ',
    tags: true,
    style: {
      bg: '#1a2632',
      fg: '#eff6ff',
      border: { fg: '#86a5c3' },
    },
  });

  let latestLaunch: LaunchCheckReport | undefined;

  const refresh = (): void => {
    const authProfiles = listAuthProfiles();
    const status = collectStatusSnapshot(authProfiles.length);
    const doctor = collectDoctorReport({
      hasClaudeAuthProfile: authProfiles.some(
        (p) => p.provider === 'anthropic_setup_token',
      ),
    });
    const toolServices = listToolServices();
    const toolSummary =
      toolServices.length === 0
        ? ['Tool services: none']
        : toolServices.map((svc) => {
            const status = svc.state?.status || 'unknown';
            return `tool:${svc.profile.id} ${svc.profile.enabled ? 'on' : 'off'} ${status}`;
          });

    statusBox.setContent(
      [
        `Time: ${status.timestamp}`,
        `Runtime profiles: ${status.runtimeProfilesCount}`,
        `Auth profiles: ${status.authProfilesCount}`,
        `Local endpoints: ${status.localEndpointsCount}`,
        `Registered groups: ${status.registeredGroupsCount}`,
        '',
        ...status.runtimeProfiles.map((rp) => {
          const state = rp.enabled ? 'active' : 'disabled';
          return `${rp.id}: ${rp.provider}/${rp.model} (${state})`;
        }),
        '',
        ...toolSummary,
      ].join('\n'),
    );
    eventsBox.setContent(formatRuntimeEvents(status));
    doctorBox.setContent(formatDoctor(doctor));
    launchBox.setContent(formatLaunch(latestLaunch));

    const logFile = path.join(LOG_DIR, 'microclaw.log');
    const tail = readTail(logFile, 40);
    logBox.setContent(tail || `No logs at ${logFile}`);
    footer.setContent(' Refreshed');
    screen.render();
  };

  const runLaunch = (): void => {
    latestLaunch = collectLaunchCheckReport();
    launchBox.setContent(formatLaunch(latestLaunch));
    footer.setContent(
      latestLaunch.pass
        ? ' Launch-check passed'
        : ` Launch-check failed: ${latestLaunch.failedKeys.join(', ')}`,
    );
    screen.render();
  };

  const runPalette = (): void => {
    prompt.input(
      'Command (refresh | doctor | launch-check | logs | quit)',
      '',
      (_, value) => {
        const cmd = (value || '').trim().toLowerCase();
        if (!cmd) {
          screen.render();
          return;
        }
        if (cmd === 'refresh') refresh();
        else if (cmd === 'doctor') {
          const report = collectDoctorReport({
            hasClaudeAuthProfile: listAuthProfiles().some(
              (p) => p.provider === 'anthropic_setup_token',
            ),
          });
          doctorBox.setContent(formatDoctor(report));
          footer.setContent(' Doctor check complete');
          screen.render();
        } else if (cmd === 'launch-check') {
          runLaunch();
        } else if (cmd === 'logs') {
          const logFile = path.join(LOG_DIR, 'microclaw.log');
          const tail = readTail(logFile, 120);
          logBox.setContent(tail || `No logs at ${logFile}`);
          footer.setContent(' Extended logs loaded');
          screen.render();
        } else if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
          process.exit(0);
        } else {
          footer.setContent(` Unknown command: ${cmd}`);
          screen.render();
        }
      },
    );
  };

  screen.key(['q', 'C-c'], () => process.exit(0));
  screen.key(['r'], () => refresh());
  screen.key(['d'], () => {
    const report = collectDoctorReport({
      hasClaudeAuthProfile: listAuthProfiles().some(
        (p) => p.provider === 'anthropic_setup_token',
      ),
    });
    doctorBox.setContent(formatDoctor(report));
    footer.setContent(' Doctor check complete');
    screen.render();
  });
  screen.key(['l'], () => runLaunch());
  screen.key([':'], () => runPalette());

  refresh();
  screen.render();

  const timer = setInterval(refresh, 5000);
  screen.on('destroy', () => {
    clearInterval(timer);
  });
}
