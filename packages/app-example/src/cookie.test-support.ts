/** The `name=value` pair a browser sends back for a `Set-Cookie` header. */
export function cookieOf(setCookie: string): string {
  return setCookie.split(";")[0] as string;
}

/** The value a `Set-Cookie` header sets. */
export function tokenOf(setCookie: string): string {
  const cookie = cookieOf(setCookie);
  return cookie.slice(cookie.indexOf("=") + 1);
}
