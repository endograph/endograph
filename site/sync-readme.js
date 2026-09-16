// Run with `bun site/sync-readme.js` after editing the repository README.
// The generated HTML is committed, so the site needs no build or runtime fetch.
const root = new URL('../', import.meta.url);
const readme = await Bun.file(new URL('README.md', root)).text();
const html = Bun.markdown.html(readme).replace(/href="([^"#][^"]*)"/g, (match, href) => {
  const url = /^[a-z][a-z\d+.-]*:/i.test(href)
    ? href
    : `https://github.com/endograph/endograph/blob/main/${href}`;
  return `href="${url}" target="_blank" rel="noopener noreferrer"`;
});
const file = Bun.file(new URL('index.html', import.meta.url));
const page = await file.text();
const start = '<!-- readme:start -->';
const end = '<!-- readme:end -->';
if (!page.includes(start) || !page.includes(end)) throw new Error('README markers missing');
await Bun.write(file, page.replace(new RegExp(`${start}[\\s\\S]*?${end}`), () => `${start}\n${html}\n        ${end}`));
