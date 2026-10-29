import { api } from './api';

const PERSONAL_SECTIONS = new Set(['密码门', 'Password Gate']);
const SETTINGS_NAV = 'nav:has([data-slot="settings.header"])';
const CSS = `
html[data-dshpw-subuser-menus] .dcu-sb-pinned-section,
html[data-dshpw-subuser-menus] .dcu-sb-more-section,
html[data-dshpw-subuser-menus] [data-slot="sidebar.footer.action"],
html[data-dshpw-subuser-menus] nav:has([data-slot="sidebar.panellist"]),
html[data-dshpw-subuser-menus] ${SETTINGS_NAV} button[data-dshpw-menu-hidden],
html[data-dshpw-subuser-menus] ${SETTINGS_NAV} .dcu-settings-nav-group-header {
  display: none !important;
}
`;

/** Presentation only: keep every client module and the existing gateway policy intact. */
export function startSubuserMenuVisibility(): () => void {
  if (typeof document === 'undefined') return () => {};
  const abort = new AbortController();
  let observer: MutationObserver | undefined;
  let style: HTMLStyleElement | undefined;
  const update = () => {
    for (const nav of document.querySelectorAll(SETTINGS_NAV)) {
      const rows = Array.from(nav.querySelectorAll<HTMLButtonElement>('button[class*="_navCell"]'));
      for (const row of rows) {
        const hide = !PERSONAL_SECTIONS.has(row.textContent?.trim() ?? '');
        row.toggleAttribute('data-dshpw-menu-hidden', hide);
      }
      // A previously selected management section can survive a page reload.
      if (rows.some(row => row.hasAttribute('data-dshpw-menu-hidden') && row.getAttribute('aria-current') === 'true')) {
        rows.find(row => !row.hasAttribute('data-dshpw-menu-hidden'))?.click();
      }
    }
  };
  void api<{ me: { role: string } }>('/api/dsh-passwords/state', undefined, abort.signal).then(state => {
    if (abort.signal.aborted || state.me.role !== 'user') return;
    style = document.createElement('style'); style.textContent = CSS;
    document.head.appendChild(style);
    document.documentElement.setAttribute('data-dshpw-subuser-menus', '');
    update();
    observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }).catch(() => { /* The existing gateway handles expired login and authorization. */ });
  return () => {
    abort.abort(); observer?.disconnect(); style?.remove();
    document.documentElement.removeAttribute('data-dshpw-subuser-menus');
    for (const row of document.querySelectorAll('[data-dshpw-menu-hidden]')) row.removeAttribute('data-dshpw-menu-hidden');
  };
}
