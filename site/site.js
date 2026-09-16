const themeButton = document.querySelector('#theme-toggle');
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const themeModes = ['system', 'light', 'dark', 'ink'];
let chosenTheme;
try { chosenTheme = localStorage.getItem('endograph-theme'); } catch {}
if (!themeModes.includes(chosenTheme)) chosenTheme = 'ink';

function applyTheme(mode) {
  chosenTheme = mode;
  const theme = mode === 'system' ? (systemTheme.matches ? 'dark' : 'light') : mode;
  const root = document.documentElement;
  if (theme === 'ink' && (root.dataset.theme !== 'ink' || !root.style.getPropertyValue('--ink-hue'))) {
    const previous = Number(root.style.getPropertyValue('--ink-hue'));
    let hue = Math.floor(Math.random() * 360);
    if (hue === previous) hue = (hue + 137) % 360;
    root.style.setProperty('--ink-hue', hue);
  }
  root.dataset.theme = theme;
  themeButton.dataset.mode = mode;
  themeButton.setAttribute('aria-label', `Theme: ${mode}`);
  themeButton.title = `Theme: ${mode}`;
  document.querySelector('meta[name="theme-color"]').content = theme === 'ink' ? `hsl(${root.style.getPropertyValue('--ink-hue')} 72% 85%)` : theme === 'dark' ? '#000000' : '#faf8f4';
}
applyTheme(chosenTheme);
themeButton.addEventListener('click', () => {
  applyTheme(themeModes[(themeModes.indexOf(chosenTheme) + 1) % themeModes.length]);
  try { localStorage.setItem('endograph-theme', chosenTheme); } catch {}
});
systemTheme.addEventListener('change', () => {
  if (chosenTheme === 'system') applyTheme('system');
});

const panel = document.querySelector('#details');
const stages = document.querySelector('.stages');
const triggers = [...document.querySelectorAll('[data-panel]')];
const sections = [...document.querySelectorAll('[data-content]')];
const label = document.querySelector('#panel-label');
let activeTrigger;

function positionPanel() {
  const top = stages.getBoundingClientRect().bottom + 24;
  document.documentElement.style.setProperty('--panel-top', `${top}px`);
}

function openPanel(trigger) {
  const name = trigger.dataset.panel;
  const changed = activeTrigger !== trigger;
  activeTrigger = trigger;
  positionPanel();
  for (const button of triggers) button.setAttribute('aria-expanded', String(button === trigger));
  for (const section of sections) section.hidden = section.dataset.content !== name;
  label.textContent = { install: '', github: 'README.md' }[name] ?? `${String(['manifest', 'incept', 'evolve'].indexOf(name) + 1).padStart(2, '0')} / ${name}`;
  panel.setAttribute('aria-label', `${name} details`);
  panel.setAttribute('aria-hidden', 'false');
  panel.inert = false;
  panel.classList.add('is-open');
  if (changed) panel.scrollTop = 0;
}

function closePanel() {
  const focusWasInside = panel.contains(document.activeElement);
  panel.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  panel.inert = true;
  for (const trigger of triggers) trigger.setAttribute('aria-expanded', 'false');
  if (focusWasInside) activeTrigger?.focus();
  activeTrigger = undefined;
}

for (const trigger of triggers) {
  // The GitHub anchor keeps its native new-tab navigation.
  if (trigger.tagName !== 'A') trigger.addEventListener('click', () => openPanel(trigger));
  else trigger.addEventListener('focus', () => {
    if (activeTrigger !== trigger) openPanel(trigger);
  });
  trigger.addEventListener('pointerenter', (event) => {
    // Touch opens on click. Keep the panel open while readers move into it.
    if (event.pointerType === 'mouse' && !panel.contains(document.activeElement)) openPanel(trigger);
  });
}
document.querySelector('.close').addEventListener('click', closePanel);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && activeTrigger) closePanel();
});
window.addEventListener('resize', positionPanel);
window.addEventListener('scroll', positionPanel, { passive: true });
new ResizeObserver(positionPanel).observe(document.querySelector('.page'));

const networkExamples = {
  offline: ['"offline"', "The agent's code cannot access the network. The host still handles model requests."],
  loopback: ['"loopback"', "The agent's code can connect to services on localhost."],
  hosts: ['["api.github.com"]', "The agent's code can connect only to the listed hosts. This example allows the GitHub API."],
  full: ['"full"', "The agent's code can connect to any host."],
};
for (const button of document.querySelectorAll('[data-network]')) {
  button.addEventListener('click', () => {
    const [value, note] = networkExamples[button.dataset.network];
    document.querySelector('#network-value').textContent = value;
    document.querySelector('#network-note').textContent = note;
    for (const choice of document.querySelectorAll('[data-network]')) choice.setAttribute('aria-pressed', String(choice === button));
  });
}
const copyButton = document.querySelector('#copy-prompt');
const copyStatus = document.querySelector('#copy-status');
let copyReset;

function copyWithSelection(text) {
  // Clipboard API is unavailable on HTTP previews such as http://fox:4173/.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;';
  panel.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand('copy');
  } finally {
    textarea.remove();
    copyButton.focus({ preventScroll: true });
  }
}

copyButton.addEventListener('click', async () => {
  clearTimeout(copyReset);
  copyButton.classList.remove('is-copied');
  copyStatus.textContent = '';
  const prompt = document.querySelector('#install-prompt');
  const text = prompt.textContent;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch { /* Try selection-based copying if clipboard access is refused. */ }
  if (!copied) {
    try { copied = copyWithSelection(text); } catch { /* Offer manual copying below. */ }
  }
  if (copied) {
    copyButton.classList.add('is-copied');
    copyButton.setAttribute('aria-label', 'Prompt copied');
    copyReset = setTimeout(() => {
      copyButton.classList.remove('is-copied');
      copyButton.setAttribute('aria-label', 'Copy prompt');
      copyStatus.textContent = '';
    }, 2000);
  } else {
    const range = document.createRange();
    range.selectNodeContents(prompt);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatus.textContent = 'Press ⌘C or Ctrl+C to copy';
  }
});
positionPanel();
