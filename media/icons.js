(function (root) {
  'use strict';

  // One set of vector icons for the extension host and the webview.
  const paths = {
    brand: '<path d="M3.5 18V6l10 12V6" stroke-width="2.8"/><path d="m18 7 5 5-5 5Z" fill="currentColor" stroke="none"/>',
    phone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10 18h4M10 5.5h4"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
    play: '<path d="m8 5 11 7-11 7Z"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    build: '<path d="m14 4 6 6-4 4-6-6ZM12 10l-8 8 2 2 8-8M17 3l4 4"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
    log: '<path d="m5 6 5 5-5 5m8 1h6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    doctor: '<path d="m9 4-5 2v6c0 4 8 9 8 9s8-5 8-9V6l-5-2M8 11l3 3 5-5"/>',
    settings: '<path d="M4 6h16M4 12h16M4 18h16"/><rect x="8" y="4" width="4" height="4" rx="1" fill="var(--surface, currentColor)"/><rect x="14" y="10" width="4" height="4" rx="1" fill="var(--surface, currentColor)"/><rect x="6" y="16" width="4" height="4" rx="1" fill="var(--surface, currentColor)"/>',
    trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
    clear: '<path d="m15 3 7 7-11 11H5l-3-3ZM8 12l7 7M11 21h10"/>',
    folder: '<path d="M3 7V4h7l2 3h9v13H3ZM3 10h18"/>',
    warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.2"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>'
  };

  function icon(name, className) {
    return '<svg class="icon' + (className ? ' ' + className : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (paths[name] || paths.info) + '</svg>';
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = icon;
  } else {
    root.runnerIcon = icon;
  }
})(typeof window !== 'undefined' ? window : this);
