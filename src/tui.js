import { homedir } from 'node:os';
import { leaves } from './capture.js';
import { ago } from './util.js';

// Interactive board: a searchable list of parked spaces with a detail panel for the selected one.
// Pure rendering (toItem / filterItems / renderFrame) is separate from the key loop (runTui).

const ESC = '\x1b[';
const STYLES = {
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  accent: `${ESC}1;36m`,
  warn: `${ESC}33m`,
  error: `${ESC}31m`,
  claude: `${ESC}38;5;208m`,
  codex: `${ESC}38;5;45m`,
  agent: `${ESC}38;5;250m`,
};
const RESET = `${ESC}0m`;
const ICONS = { claude: '●', codex: '◆' };
const HELP = '↑↓ move · Enter resume · / search · d delete · q close';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const paint = (text, style) => (style && STYLES[style] ? `${STYLES[style]}${text}${RESET}` : text);
const width = (text) => [...text].length;
const icon = (agent) => ICONS[agent] ?? '▪';

function tilde(path) {
  const home = homedir();
  return path && path.startsWith(home) ? `~${path.slice(home.length)}` : (path ?? '');
}

function formatDate(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function attention(record) {
  switch (record.state) {
    case 'parked':
      return null;
    case 'resume_failed':
      return `resume failed: ${record.error ?? 'unknown error'}`;
    case 'cleanup_failed':
      return `cleanup incomplete: ${(record.pending_reap ?? []).length} process(es) still running`;
    case 'resuming':
      return 'being resumed right now';
    default:
      return 'park did not finish';
  }
}

// One bold line per tab, then one line per pane: agent with its conversation title, or a shell
// with what it was running, plus the pane's folder when it differs from the space's.
export function tabsDetail(tabs, cwd) {
  const lines = [];
  tabs.forEach((tab, index) => {
    lines.push({ text: '' });
    lines.push({ text: tab.label ? `Tab "${tab.label}"` : `Tab ${index + 1}`, style: 'bold' });
    for (const leaf of leaves(tab.root)) {
      const where = leaf.cwd && leaf.cwd !== cwd ? ` · in ${leaf.cwd.startsWith(`${cwd}/`) ? leaf.cwd.slice(cwd.length + 1) : tilde(leaf.cwd)}` : '';
      if (leaf.agent) {
        const title = leaf.title ? `  "${leaf.title}"` : '';
        lines.push({ text: `  ${icon(leaf.agent)} ${leaf.agent}${title}${where}`, style: leaf.agent in ICONS ? leaf.agent : 'agent' });
      } else {
        const running = leaf.was_running ? ` · was running: ${leaf.was_running}` : '';
        lines.push({ text: `  $ shell${running}${where}`, style: 'dim' });
      }
    }
  });
  return lines;
}

export function toItem(record, now = Date.now()) {
  const allLeaves = record.tabs.flatMap((tab) => leaves(tab.root));
  const agents = allLeaves.map((leaf) => leaf.agent).filter(Boolean);
  const detail = [
    { text: record.label, style: 'bold' },
    { text: tilde(record.cwd), style: 'dim' },
  ];
  if (record.git) {
    const dirty = record.git.dirty_files ? ` · ${record.git.dirty_files} uncommitted file${record.git.dirty_files === 1 ? '' : 's'}` : ' · clean';
    detail.push({ text: `${record.git.branch}${dirty}` });
  }
  detail.push({ text: `parked ${formatDate(record.parked_at)} · ${ago(record.parked_at, now)}`, style: 'dim' });
  const issue = attention(record);
  if (issue) detail.push({ text: `⚠ ${issue}`, style: 'warn' });

  detail.push(...tabsDetail(record.tabs, record.cwd));
  for (const warning of record.warnings ?? []) detail.push({ text: `⚠ ${warning}`, style: 'warn' });

  const search = [
    record.label,
    record.cwd,
    record.git?.branch,
    ...record.tabs.map((tab) => tab.label),
    ...allLeaves.flatMap((leaf) => [leaf.title, leaf.agent, leaf.was_running]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return { id: record.id, label: record.label, age: ago(record.parked_at, now), agents, state: record.state, detail, search };
}

export function filterItems(items, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length === 0 ? items : items.filter((item) => words.every((word) => item.search.includes(word)));
}

// Lays out styled parts in exactly `size` columns, truncating with an ellipsis.
function cell(parts, size) {
  let out = '';
  let used = 0;
  for (const part of parts) {
    if (used >= size) break;
    const room = size - used;
    let text = part.text;
    if (width(text) > room) text = room > 1 ? `${[...text].slice(0, room - 1).join('')}…` : [...text].slice(0, room).join('');
    out += paint(text, part.style);
    used += width(text);
  }
  return out + ' '.repeat(Math.max(0, size - used));
}

function listCell(item, selected, size, marks) {
  const ageWidth = Math.max(8, width(item.age));
  const age = item.age.padStart(ageWidth);
  const box = marks ? (marks.has(item.id) ? '[x] ' : '[ ] ') : '';
  const icons = item.agents.map((agent) => ({ text: icon(agent), style: agent in ICONS ? agent : 'agent' }));
  const iconsWidth = icons.length > 0 ? icons.length * 2 - 1 : 0;
  const labelWidth = Math.max(1, size - 2 - width(box) - ageWidth - iconsWidth - 2);
  const flag = item.state === 'parked' ? '' : '!';
  const parts = [
    { text: selected ? '▸ ' : '  ', style: selected ? 'accent' : null },
    { text: box, style: marks?.has(item.id) ? 'accent' : 'dim' },
    { text: cell([{ text: `${item.label}${flag ? ` ${flag}` : ''}` }], labelWidth), style: selected ? 'bold' : null },
    { text: '  ' },
  ];
  icons.forEach((part, i) => parts.push(i > 0 ? { text: ' ' } : { text: '' }, part));
  parts.push({ text: age, style: item.age.startsWith('⚠') ? 'warn' : 'dim' });
  return cell(parts, size);
}

export function renderFrame(view, { columns, rows }) {
  const { items, total, selected = 0, query = '', searching = false, confirm = null, message = null, messageStyle = null, marks = null, help = HELP } = view;
  const title = view.title ?? ` Parked spaces (${total})`;
  const wide = columns >= 90;
  const listWidth = wide ? Math.min(46, Math.floor(columns * 0.42)) : columns;
  const detailWidth = wide ? columns - listWidth - 3 : columns;
  const bodyRows = Math.max(1, rows - 4);
  const listRows = wide ? bodyRows : Math.max(3, Math.floor(bodyRows / 2));

  const right = [searching ? `/ ${query}█` : query ? `/ ${query}` : '', marks ? `${marks.size} selected` : '', items.length > 0 ? `${selected + 1}/${items.length}` : '']
    .filter(Boolean)
    .join('   ');
  const header = cell([{ text: title, style: 'bold' }, { text: ' '.repeat(Math.max(1, columns - width(title) - width(right) - 1)) }, { text: right, style: searching ? 'accent' : 'dim' }, { text: ' ' }], columns);

  const offset = Math.min(Math.max(0, selected - listRows + 1), Math.max(0, items.length - listRows));
  const listLines = [];
  if (items.length === 0) listLines.push(cell([{ text: query ? `  No parked space matches "${query}"` : '  No parked spaces.', style: 'dim' }], listWidth));
  for (let i = offset; i < Math.min(items.length, offset + listRows); i++) listLines.push(listCell(items[i], i === selected, listWidth, marks));

  const detail = items[selected]?.detail ?? [];
  const detailLines = detail.map((line) => cell([{ text: ` ${line.text}`, style: line.style }], detailWidth));
  const blank = (size) => ' '.repeat(size);

  const lines = [header];
  if (wide) {
    lines.push(paint(`${'─'.repeat(listWidth + 1)}┬${'─'.repeat(detailWidth + 1)}`, 'dim'));
    for (let r = 0; r < bodyRows; r++) lines.push(`${listLines[r] ?? blank(listWidth)} ${paint('│', 'dim')}${detailLines[r] ?? blank(detailWidth)} `);
    lines.push(paint(`${'─'.repeat(listWidth + 1)}┴${'─'.repeat(detailWidth + 1)}`, 'dim'));
  } else {
    lines.push(paint('─'.repeat(columns), 'dim'));
    for (let r = 0; r < listRows; r++) lines.push(listLines[r] ?? blank(columns));
    lines.push(paint('─'.repeat(columns), 'dim'));
    for (let r = 0; r < bodyRows - listRows - 1; r++) lines.push(detailLines[r] ?? blank(columns));
    lines.push(paint('─'.repeat(columns), 'dim'));
  }

  let footer = { text: ` ${help}`, style: 'dim' };
  if (confirm) footer = { text: ` Delete '${confirm}'? Its project and conversations stay on disk. y/N`, style: 'warn' };
  else if (message) footer = { text: ` ${message}`, style: messageStyle };
  lines.push(cell([footer], columns));
  return lines.slice(0, rows).join('\n');
}

const KEYS = {
  '\x1b[A': 'up', '\x1bOA': 'up',
  '\x1b[B': 'down', '\x1bOB': 'down',
  '\x1b[5~': 'pageup', '\x1b[6~': 'pagedown',
  '\x1b[H': 'home', '\x1b[1~': 'home', '\x1bOH': 'home',
  '\x1b[F': 'end', '\x1b[4~': 'end', '\x1bOF': 'end',
  '\r': 'enter', '\n': 'enter',
  '\x7f': 'backspace', '\b': 'backspace',
  '\x1b': 'escape', '\x03': 'interrupt',
};

function keysOf(chunk) {
  if (KEYS[chunk]) return [KEYS[chunk]];
  if (chunk.startsWith('\x1b')) return [];
  return [...chunk].map((ch) => KEYS[ch] ?? ch);
}

export function runTui({ load, input, output, actions, size, idleMs = 0, now = () => Date.now() }) {
  return new Promise((resolve) => {
    let all = load().map((record) => toItem(record, now()));
    let query = '';
    let searching = false;
    let selected = 0;
    let confirm = null;
    let message = null;
    let messageStyle = null;
    let busy = false;
    let idleTimer = null;

    const visible = () => filterItems(all, query);
    const clamp = () => {
      selected = Math.max(0, Math.min(selected, visible().length - 1));
    };
    const draw = () => {
      clamp();
      const frame = renderFrame({ items: visible(), total: all.length, selected, query, searching, confirm: confirm?.label, message, messageStyle }, size());
      output.write(`${ESC}H${frame.split('\n').map((line) => `${line}${ESC}K`).join('\r\n')}${ESC}J`);
    };

    const finish = (result) => {
      clearTimeout(idleTimer);
      input.off('data', onData);
      output.off?.('resize', draw);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      if (output.isTTY) output.write(`${ESC}?25h${ESC}?1049l`);
      resolve(result);
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      if (idleMs > 0) idleTimer = setTimeout(() => finish('idle'), idleMs);
    };

    async function act(key) {
      const items = visible();
      const page = Math.max(1, size().rows - 5);
      message = null;
      if (confirm) {
        const target = confirm;
        confirm = null;
        if (key === 'y' || key === 'Y') {
          busy = true;
          const result = await actions.remove(target.id);
          busy = false;
          all = load().map((record) => toItem(record, now()));
          message = result.status === 'deleted' ? `Deleted ${target.label}` : result.error;
          messageStyle = result.status === 'deleted' ? 'dim' : 'error';
        }
        return;
      }
      if (searching) {
        if (key === 'enter') searching = false;
        else if (key === 'escape') { searching = false; query = ''; }
        else if (key === 'backspace') query = query.slice(0, -1);
        else if (key === 'up') selected -= 1;
        else if (key === 'down') selected += 1;
        else if (key.length === 1 && key >= ' ') { query += key; selected = 0; }
        return;
      }
      switch (key) {
        case 'up': case 'k': selected -= 1; break;
        case 'down': case 'j': selected += 1; break;
        case 'pageup': selected -= page; break;
        case 'pagedown': selected += page; break;
        case 'home': case 'g': selected = 0; break;
        case 'end': case 'G': selected = items.length - 1; break;
        case '/': searching = true; break;
        case 'd': if (items[selected]) confirm = { id: items[selected].id, label: items[selected].label }; break;
        case 'escape': if (query) { query = ''; } else { finish('closed'); return 'done'; } break;
        case 'q': case 'interrupt': finish('closed'); return 'done';
        case 'enter': {
          const target = items[selected];
          if (!target) break;
          message = `Resuming ${target.label}…`;
          messageStyle = 'accent';
          draw();
          busy = true;
          const result = await actions.resume(target.id);
          busy = false;
          if (result.status === 'resumed') { finish('resumed'); return 'done'; }
          message = `Resume failed: ${result.error}`;
          messageStyle = 'error';
          all = load().map((record) => toItem(record, now()));
          break;
        }
        default: break;
      }
      return undefined;
    }

    async function onData(chunk) {
      if (busy) return;
      armIdle();
      for (const key of keysOf(String(chunk))) {
        if ((await act(key)) === 'done') return;
      }
      draw();
    }

    if (input.isTTY) input.setRawMode(true);
    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.resume();
    output.on?.('resize', draw);
    if (output.isTTY) output.write(`${ESC}?1049h${ESC}?25l`);
    armIdle();
    draw();
  });
}

const SELECT_HELP = '↑↓ move · Space select · a all idle · / search · Enter park · q close';

function screenWriter(output, size) {
  return (view) => {
    const frame = renderFrame(view, size());
    output.write(`${ESC}H${frame.split('\n').map((line) => `${line}${ESC}K`).join('\r\n')}${ESC}J`);
  };
}

// Multi-select park: mark spaces, Enter parks them (via `park`) and shows a summary.
// Resolves with the park results, or [] when closed without parking.
export function runSelect({ load, input, output, size, park }) {
  return new Promise((resolve) => {
    const write = screenWriter(output, size);
    let all = [];
    let query = '';
    let searching = false;
    let selected = 0;
    const marks = new Set();
    let phase = 'loading';
    let message = 'Checking spaces…';
    let messageStyle = 'dim';
    let results = [];

    const visible = () => filterItems(all, query);
    const draw = () => {
      const items = visible();
      selected = Math.max(0, Math.min(selected, items.length - 1));
      const title = phase === 'summary' ? ' Park spaces · done' : ' Park spaces';
      write({ title, items, total: all.length, selected, query, searching, marks: phase === 'summary' ? null : marks, message, messageStyle, help: SELECT_HELP });
    };
    const finish = (value) => {
      input.off('data', onData);
      output.off?.('resize', draw);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      if (output.isTTY) output.write(`${ESC}?25h${ESC}?1049l`);
      resolve(value);
    };

    async function startParking() {
      const items = visible();
      const chosen = marks.size > 0 ? all.filter((item) => marks.has(item.id)) : items[selected] ? [items[selected]] : [];
      if (chosen.length === 0) return;
      phase = 'parking';
      const outcome = await park(chosen.map(({ id, label }) => ({ id, label })), (done, total, label) => {
        message = `Parked ${done}/${total}: ${label}`;
        messageStyle = 'accent';
        draw();
      });
      // The caller took the job elsewhere (a detached process reporting through notifications).
      if (outcome?.background) { finish('background'); return; }
      results = outcome;
      const parkedCount = results.filter((r) => r.status === 'parked' || r.status === 'cleanup_failed').length;
      all = results.map((r) => {
        const ok = r.status === 'parked' || r.status === 'cleanup_failed';
        return {
          id: r.id,
          label: r.label,
          age: ok ? 'parked' : 'not parked',
          agents: [],
          state: 'parked',
          detail: [{ text: r.label, style: 'bold' }, { text: ok ? 'Parked.' : `Not parked: ${r.reason}`, style: ok ? 'dim' : 'warn' }],
          search: r.label.toLowerCase(),
        };
      });
      query = '';
      selected = 0;
      phase = 'summary';
      message = `${parkedCount} parked · ${results.length - parkedCount} not parked · any key to close`;
      messageStyle = parkedCount === results.length ? 'accent' : 'warn';
      draw();
    }

    async function onData(chunk) {
      if (phase === 'loading' || phase === 'parking') return;
      if (phase === 'summary') { finish(results); return; }
      for (const key of keysOf(String(chunk))) {
        const items = visible();
        if (searching) {
          if (key === 'enter') searching = false;
          else if (key === 'escape') { searching = false; query = ''; }
          else if (key === 'backspace') query = query.slice(0, -1);
          else if (key === 'up') selected -= 1;
          else if (key === 'down') selected += 1;
          else if (key.length === 1 && key >= ' ') { query += key; selected = 0; }
          continue;
        }
        switch (key) {
          case 'up': case 'k': selected -= 1; break;
          case 'down': case 'j': selected += 1; break;
          case 'home': case 'g': selected = 0; break;
          case 'end': case 'G': selected = items.length - 1; break;
          case '/': searching = true; break;
          case ' ': {
            const item = items[selected];
            if (item) (marks.has(item.id) ? marks.delete(item.id) : marks.add(item.id));
            break;
          }
          case 'a': {
            const idle = items.filter((item) => item.age === 'idle').map((item) => item.id);
            const allMarked = idle.length > 0 && idle.every((id) => marks.has(id));
            marks.clear();
            if (!allMarked) idle.forEach((id) => marks.add(id));
            break;
          }
          case 'escape': if (query) { query = ''; break; } finish([]); return;
          case 'q': case 'interrupt': finish([]); return;
          case 'enter': await startParking(); return;
          default: break;
        }
      }
      message = null;
      draw();
    }

    if (input.isTTY) input.setRawMode(true);
    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.resume();
    output.on?.('resize', draw);
    if (output.isTTY) output.write(`${ESC}?1049h${ESC}?25l`);
    draw();
    load().then((items) => {
      all = items;
      phase = 'select';
      message = all.length === 0 ? 'No spaces to park.' : null;
      draw();
    });
  });
}
