/** 浏览器端只做目录标识比较；实际目录授权仍由网关执行。 */
export function workspacePathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
