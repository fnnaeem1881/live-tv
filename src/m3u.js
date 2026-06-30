// Minimal M3U / M3U8 (Extended) playlist parser for IPTV channel lists.
export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const attrs = {};
      const attrRegex = /([a-zA-Z0-9-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRegex.exec(line))) {
        attrs[m[1].toLowerCase()] = m[2];
      }
      const nameMatch = line.match(/,(.*)$/);
      const tvgId = attrs['tvg-id'] || '';
      const countryMatch = tvgId.match(/\.([a-z]{2})(?:@|$)/i);
      const rawGroup = attrs['group-title'] || 'Uncategorized';
      const categories = rawGroup
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      current = {
        name: nameMatch ? nameMatch[1].trim() : 'Unknown Channel',
        logo: attrs['tvg-logo'] || '',
        group: categories[0] || 'Uncategorized',
        categories: categories.length ? categories : ['Uncategorized'],
        country: countryMatch ? countryMatch[1].toUpperCase() : '',
        tvgId,
        url: '',
      };
    } else if (line.startsWith('#')) {
      // ignore other directives (#EXTM3U, #EXTGRP, #EXTVLCOPT, etc.)
      continue;
    } else {
      if (current) {
        current.url = line;
        channels.push(current);
        current = null;
      }
    }
  }
  return channels;
}
