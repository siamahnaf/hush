export function originUrl(config: string): string | undefined {
  let current: string | undefined;
  let first: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const section = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (section) {
      current = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = undefined;
      continue;
    }
    const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (!url || !current) continue;
    if (current === "origin") return url[1];
    first ??= url[1];
  }
  return first;
}

//git@github.com:acme/app.git, https://github.com/acme/app → github.com/acme/app
export function normalizeRemote(url: string): string {
  let value = url.trim();
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/);
  if (scp && !/^[a-z+]+:\/\//i.test(value)) {
    value = `${scp[1]}/${scp[2]}`;
  } else {
    value = value.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  }
  value = value.replace(/\.git$/i, "").replace(/\/+$/, "");
  const [host, ...rest] = value.split("/");
  return [host.replace(/:\d+$/, ""), ...rest].join("/").toLowerCase();
}
