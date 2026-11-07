// .syncignore: gitignore-style globs for paths that stay Drive-only
// (never published to GitHub). Supports *, **, ?, leading "!" negation, # comments.

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

export function compileIgnore(text = '') {
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const negate = l.startsWith('!');
      let g = negate ? l.slice(1) : l;
      const anchored = g.startsWith('/') || g.includes('/');
      g = g.replace(/^\//, '').replace(/\/$/, '/**');
      const body = globToRegex(g);
      return { negate, re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`, 'i') };
    });
  return (path) => {
    let ignored = false;
    for (const r of rules) if (r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
}
