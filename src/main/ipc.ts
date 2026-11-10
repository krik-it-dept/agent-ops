/** Compare the trusted renderer document exactly; hash routes carry no additional authority. */
export function isRendererURL(actual: string, expected: string): boolean {
  try {
    const url = new URL(actual),
      target = new URL(expected);
    url.hash = '';
    target.hash = '';
    return url.href === target.href;
  } catch {
    return false;
  }
}
